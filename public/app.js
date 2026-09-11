/* FileDrop — P2P bulk file transfer (Cloudflare Pages static-only).
 * Signaling: public PeerJS cloud. Data: parallel WebRTC DataConnections
 * (SCTP, reliable), raw-binary framed chunks with positional writes.
 * No backend, no storage. One code carries a queue of files, striped in
 * order across channels. Both peers must keep the tab open during transfer.
 *
 * Protocol v3 (prefix filedrop-v3-, 12-char codes). Receiver still accepts
 * v2 (filedrop-v2-, 6-char) for backwards compatibility with old links.
 *  - control (JSON objects on first open channel): meta / fdone / done
 *  - data (ArrayBuffer): [fi:uint16][i:uint32][payload...]
 * Chunks of a file may arrive out of order across channels; the receiver
 * reassembles by (fi, i) and only finishes a file after meta + fdone +
 * all chunks are stored.
 *
 * Security hardening (static-only, no backend):
 *  - 12-char crypto-random codes (~62 bits), 30-min expiry, single-receiver
 *    binding while a transfer is live, receiver rate-limiting, generic
 *    connect errors (no peer-unavailable oracle detail in UI).
 *  - Strict receiver-side validation of all sender-controlled fields
 *    (file count, size, chunk counts, indexes, payload sizes) with abort on
 *    violation; caps to bound memory/disk/DOM use.
 *  - No auto-download: every file requires an explicit user click. Risky
 *    extensions get a visible warning. Download names are sanitized
 *    (RTL/control chars stripped).
 *  - QR codes are rendered locally (vendored qrcode lib) — claim codes never
 *    leave the tab via third-party pixels.
 *  - Finished files are vaulted in IndexedDB (7-day expiry, size caps) and
 *    OPFS temp files are swept on load + deleted on clear.
 */
(function () {
  "use strict";

  var DEFAULT_PAYLOAD = 250 * 1024;
  var MAX_PAYLOAD = 256 * 1024 - 6;
  var MAX_BIN_SLOP = 4096; // tolerate SCTP negotiation differences
  var HEADER = 6;
  var PREFIX_V3 = "filedrop-v3-";
  var PREFIX_V2 = "filedrop-v2-";
  var NUM_CHANNELS = 4;
  var PER_CONN_CAP = 2 * 1048576;
  var TOTAL_INFLIGHT_CAP = 8 * 1048576;
  var LOW_WATERMARK = 1 * 1048576;
  var PREFETCH = 4;
  var UI_MS = 150;

  // ---------- security limits ----------
  var CODE_LEN = 12;
  var CODE_TTL_MS = 30 * 60 * 1000; // sender code expires after 30 min
  var MAX_FILES = 50;
  var MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GiB per file
  var MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB per batch
  var MAX_CHUNKS_PER_FILE = 16384; // 2 GiB / 128 KiB headroom
  var MIN_CHUNK = 1024;
  var MAX_CHUNK = 1024 * 1024;
  var MAX_PENDING_TOTAL = 2000; // chunks buffered before meta/writer ready
  var MAX_PENDING_PER_FILE = 500;
  var MAX_NAME_LEN = 255;
  var MAX_MIME_LEN = 128;
  var VAULT_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
  var VAULT_MAX_FILES = 100;
  var VAULT_MAX_BYTES = 500 * 1024 * 1024;
  var RECV_MAX_ATTEMPTS = 5;
  var RECV_WINDOW_MS = 60 * 1000;
  var RISKY_EXTS = {
    exe: "executable", msi: "executable", bat: "executable", cmd: "executable",
    com: "executable", scr: "executable", pif: "executable", ps1: "script",
    vbs: "script", vbe: "script", js: "script", jse: "script", wsf: "script",
    wsh: "script", jar: "executable", dll: "executable", sys: "executable",
    html: "web page", htm: "web page", xhtml: "web page", svg: "web page",
    swf: "web page", xml: "web page"
  };

  // ---------- tabs ----------
  var tabSend = document.getElementById("tab-send");
  var tabReceive = document.getElementById("tab-receive");
  var viewSend = document.getElementById("view-send");
  var viewReceive = document.getElementById("view-receive");
  function show(which) {
    var send = which === "send";
    tabSend.classList.toggle("active", send);
    tabReceive.classList.toggle("active", !send);
    viewSend.hidden = !send;
    viewReceive.hidden = send;
    if (!send) {
      var m = /[?&]code=([A-Za-z0-9]{4,16})/.exec(location.search);
      if (m) document.getElementById("receive-code").value = m[1].toUpperCase().slice(0, 16);
    }
  }
  tabSend.onclick = function () { show("send"); };
  tabReceive.onclick = function () { show("receive"); };

  function fmt(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }
  function makeCode() {
    var c = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    var s = "";
    try {
      if (window.crypto && window.crypto.getRandomValues) {
        var rnd = new Uint32Array(CODE_LEN);
        window.crypto.getRandomValues(rnd);
        for (var i = 0; i < CODE_LEN; i++) s += c[rnd[i] % c.length];
        return s;
      }
    } catch (e) {}
    // Fallback (should not happen on modern browsers): Math.random.
    for (var j = 0; j < CODE_LEN; j++) s += c[Math.floor(Math.random() * c.length)];
    return s;
  }
  function prefixForCode(code) {
    // Old 6-8 char codes -> v2 prefix; new 12+ char codes -> v3 prefix.
    return (code && code.length <= 8) ? PREFIX_V2 : PREFIX_V3;
  }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function sanitize(name) {
    return String(name || "file").replace(/[\\/:*?"<>|]/g, "_").slice(0, 100) || "file";
  }
  // Strip path separators, control chars, RTL overrides and leading dots so
  // the download attribute cannot spoof extensions or hide payloads.
  function sanitizeDownloadName(name) {
    var s = String(name || "file");
    // eslint-disable-next-line no-control-regex
    s = s.replace(/[\x00-\x1f\x7f]/g, "_");
    s = s.replace(/[‮‭‫⁦⁧⁨⁩\u202A-\u202E\u2066-\u2069]/g, "_");
    s = s.replace(/[\\/:*?"<>|]/g, "_");
    s = s.replace(/^\.+/, "_");
    s = s.trim() || "file";
    if (s.length > MAX_NAME_LEN) {
      var dot = s.lastIndexOf(".");
      if (dot > 0 && s.length - dot <= 16) s = s.slice(0, MAX_NAME_LEN - (s.length - dot)) + s.slice(dot);
      else s = s.slice(0, MAX_NAME_LEN);
    }
    return s || "file";
  }
  function riskyKind(name) {
    var m = /\.([A-Za-z0-9]{1,10})$/.exec(String(name || ""));
    if (!m) return null;
    return RISKY_EXTS[m[1].toLowerCase()] || null;
  }

  // ---------- shared conn helpers ----------
  function connBuffered(c) {
    try {
      if (c && typeof c.bufferSize === "number") return c.bufferSize;
      if (c && c.dataChannel && typeof c.dataChannel.bufferedAmount === "number") {
        return c.dataChannel.bufferedAmount;
      }
    } catch (e) {}
    return 0;
  }
  function connOpen(c) {
    try { return !!(c && c.open); } catch (e) { return false; }
  }
  function negotiatePayload(conns) {
    try {
      var pc = conns[0] && conns[0].peerConnection;
      var sctp = pc && pc.sctp;
      var m = sctp && sctp.maxMessageSize;
      if (m && m > 8192) {
        return Math.max(16 * 1024, Math.min(MAX_PAYLOAD, m - 2048 - HEADER));
      }
    } catch (e) {}
    return DEFAULT_PAYLOAD;
  }

  // ---------- session store + leave guard ----------
  // Survives reloads in the SAME tab (sessionStorage). Never the file bytes —
  // those can't outlive the tab — just the code, so a re-drop after an
  // accidental refresh reuses it and a waiting receiver reconnects untouched.
  // Codes expire after CODE_TTL_MS (see sender expiry timer).
  var store = {
    get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { sessionStorage.removeItem(k); } catch (e) {} }
  };
  var transferActive = false;
  function setActive(v) {
    transferActive = v;
    try { if (v) startFaviconStrobe(); else stopFaviconStrobe(); } catch (e) { /* favicon is best-effort */ }
  }
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("beforeunload", function (e) {
      if (!transferActive) return;
      e.preventDefault();
      e.returnValue = "";
    });
  }

  // ---------- liveness pulse ----------
  // Flips a [data-live] dot on while bytes are actually flowing, so a stalled
  // connection reads as stalled instead of silently stuck at a number.
  var liveTimers = {};
  function pokeLive(which) {
    var el = document.getElementById(which === "send" ? "send-live" : "receive-live");
    if (!el) return;
    el.setAttribute("data-live", "on");
    if (liveTimers[which]) clearTimeout(liveTimers[which]);
    liveTimers[which] = setTimeout(function () { el.setAttribute("data-live", "off"); }, 2500);
  }

  // ---------- favicon strobe (tab icon flashes while a transfer is live) ----------
  // Alternates the red/blue airmail colors so a transfer in progress is visible
  // even when the tab is backgrounded. Restores the original icon when done.
  var faviconLink = document.querySelector('link[rel="icon"]');
  var faviconHrefOrig = faviconLink ? faviconLink.href : "";
  var faviconTimer = null;
  var faviconFrame = 0;
  var reduceMotion = false;
  try { reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
  function paintFavicon(bg) {
    try {
      var c = document.createElement("canvas");
      c.width = 64; c.height = 64;
      var g = c.getContext("2d");
      if (!g || !faviconLink) return;
      g.clearRect(0, 0, 64, 64);
      g.fillStyle = bg;
      g.beginPath();
      if (g.roundRect) g.roundRect(2, 2, 60, 60, 14);
      else g.rect(2, 2, 60, 60);
      g.fill();
      // white paper plane (simplified — reads at 16px)
      g.fillStyle = "#ffffff";
      g.strokeStyle = "#ffffff";
      g.lineWidth = 7;
      g.lineJoin = "round";
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(12, 33);
      g.lineTo(52, 13);
      g.lineTo(37, 52);
      g.lineTo(29, 36);
      g.closePath();
      g.fill();
      g.stroke();
      // hollow cutout
      g.fillStyle = bg;
      g.beginPath();
      g.moveTo(25, 31);
      g.lineTo(41, 23);
      g.lineTo(32, 40);
      g.closePath();
      g.fill();
      faviconLink.href = c.toDataURL("image/png");
    } catch (e) {}
  }
  function startFaviconStrobe() {
    if (faviconTimer || !faviconLink) return;
    if (reduceMotion) { paintFavicon("#2456c8"); return; }
    faviconFrame = 0;
    paintFavicon("#d43d2a");
    faviconTimer = setInterval(function () {
      faviconFrame++;
      paintFavicon(faviconFrame % 2 ? "#2456c8" : "#d43d2a");
    }, 450);
  }
  function stopFaviconStrobe() {
    if (faviconTimer) { clearInterval(faviconTimer); faviconTimer = null; }
    try { if (faviconLink) faviconLink.href = faviconHrefOrig; } catch (e) {}
  }

  // ---------- local QR (no third-party leak) ----------
  function renderQrLocal(link) {
    var qr = document.getElementById("share-qr");
    if (!qr) return;
    try {
      if (typeof qrcode === "undefined") throw new Error("qr lib missing");
      if (!/^https?:/.test(link) && link.indexOf("file:") !== 0) throw new Error("bad link");
      if (link.length > 512) throw new Error("link too long for QR");
      var gen = qrcode(0, "M");
      gen.addData(link);
      gen.make();
      // createDataURL(cellSize, margin) — 148px target.
      qr.src = gen.createDataURL(4, 2);
      qr.hidden = false;
    } catch (e) {
      try { qr.hidden = true; qr.removeAttribute("src"); } catch (e2) {}
    }
  }

  // ---------- SENDER ----------
  var dz = document.getElementById("dropzone");
  var fi = document.getElementById("file-input");
  var sendPanel = document.getElementById("send-panel");
  var sendPeer = null, sendConns = [], sendCancelled = false;
  var sendAlive = false, sendComplete = false, sendTotalBytes = 0, sendDoneBytes = 0;
  var pumpStarted = false;
  var sendOwnerPeer = null;
  var sendExpiryTimer = null;

  dz.addEventListener("dragover", function (e) { e.preventDefault(); dz.classList.add("over"); });
  dz.addEventListener("dragleave", function () { dz.classList.remove("over"); });
  dz.addEventListener("drop", function (e) {
    e.preventDefault(); dz.classList.remove("over");
    if (e.dataTransfer.files.length) startSend(e.dataTransfer.files);
  });
  fi.addEventListener("change", function () { if (fi.files.length) startSend(fi.files); });

  function openSendConns() {
    return sendConns.filter(connOpen);
  }
  function inflightBytes() {
    var s = 0, cons = openSendConns();
    for (var i = 0; i < cons.length; i++) s += connBuffered(cons[i]);
    return s;
  }
  // Event-driven backpressure: wake as soon as any channel drains below the
  // low watermark instead of polling on a fixed sleep.
  function waitForCapacity() {
    return new Promise(function (resolve) {
      var cons = openSendConns();
      function hasRoom() {
        if (inflightBytes() >= TOTAL_INFLIGHT_CAP) return false;
        for (var i = 0; i < cons.length; i++) {
          if (connOpen(cons[i]) && connBuffered(cons[i]) < PER_CONN_CAP) return true;
        }
        return false;
      }
      if (hasRoom()) return resolve();
      var settled = false;
      function done() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (var i = 0; i < cons.length; i++) {
          try { if (cons[i].dataChannel) cons[i].dataChannel.onbufferedamountlow = null; } catch (e) {}
        }
        resolve();
      }
      var timer = setTimeout(done, 80);
      for (var j = 0; j < cons.length; j++) {
        try {
          if (cons[j].dataChannel) {
            cons[j].dataChannel.bufferedAmountLowThreshold = LOW_WATERMARK;
            cons[j].dataChannel.onbufferedamountlow = done;
          }
        } catch (e) {}
      }
    });
  }
  function clearSendExpiry() {
    if (sendExpiryTimer) { try { clearTimeout(sendExpiryTimer); } catch (e) {} sendExpiryTimer = null; }
  }
  function cleanupSend() {
    sendCancelled = true;
    pumpStarted = false;
    sendOwnerPeer = null;
    clearSendExpiry();
    try {
      for (var i = 0; i < sendConns.length; i++) { try { sendConns[i].close(); } catch (e) {} }
    } catch (e) {}
    try { if (sendPeer) sendPeer.destroy(); } catch (e) {}
    sendConns = []; sendPeer = null;
  }
  document.getElementById("send-cancel").onclick = function () {
    cleanupSend();
    store.del("fd-code");
    store.del("fd-code-ts");
    setActive(false);
    document.getElementById("send-status").textContent = "Stopped. Code discarded.";
  };

  function validStoredCode(c, ts) {
    if (!c || !/^[A-Z0-9]{12}$/.test(c)) return null;
    var age = Date.now() - (Number(ts) || 0);
    if (!(age >= 0 && age < CODE_TTL_MS)) return null;
    return c;
  }

  function startSend(fileList) {
    cleanupSend();
    sendCancelled = false;
    sendAlive = false;
    sendComplete = false;
    sendDoneBytes = 0;
    var files = Array.prototype.slice.call(fileList);
    // Sender-side caps (fail fast, before allocating a peer).
    if (!files.length) return;
    if (files.length > MAX_FILES) {
      document.getElementById("send-status").textContent =
        "Too many files (max " + MAX_FILES + "). Send in smaller batches.";
      sendPanel.hidden = false;
      dz.style.display = "none";
      return;
    }
    var total = 0;
    for (var vi = 0; vi < files.length; vi++) {
      var vf = files[vi];
      if (typeof vf.size !== "number" || vf.size < 0 || vf.size > MAX_FILE_SIZE) {
        document.getElementById("send-status").textContent =
          "“" + (vf.name || "file") + "” is too large (max " + fmt(MAX_FILE_SIZE) + " per file).";
        sendPanel.hidden = false;
        dz.style.display = "none";
        return;
      }
      if (String(vf.name || "").length > 512) {
        document.getElementById("send-status").textContent = "File names must be shorter than 512 characters.";
        sendPanel.hidden = false;
        dz.style.display = "none";
        return;
      }
      total += vf.size;
      if (total > MAX_TOTAL_BYTES) {
        document.getElementById("send-status").textContent =
          "Batch too large (max " + fmt(MAX_TOTAL_BYTES) + " total). Send fewer files.";
        sendPanel.hidden = false;
        dz.style.display = "none";
        return;
      }
    }
    // Reuse the tab's code if it survived a reload and is still fresh;
    // otherwise mint a 12-char crypto-random code.
    var stored = validStoredCode(store.get("fd-code"), store.get("fd-code-ts"));
    var code = stored || makeCode();
    store.set("fd-code", code);
    store.set("fd-code-ts", String(Date.now()));
    sendTotalBytes = total;
    var peerId = PREFIX_V3 + code;

    document.getElementById("send-filecount").textContent = plural(files.length, "file", "files");
    document.getElementById("send-filesize").textContent = "(" + fmt(sendTotalBytes) + " total)";
    var ul = document.getElementById("send-filelist");
    ul.innerHTML = "";
    var rows = files.map(function (f) {
      var li = document.createElement("li");
      var s1 = document.createElement("span"); s1.className = "fname";
      var s2 = document.createElement("span"); s2.className = "bytes";
      var s3 = document.createElement("span"); s3.className = "fstate"; s3.textContent = "queued";
      s1.textContent = String(f.name || "file").slice(0, MAX_NAME_LEN);
      s2.textContent = fmt(f.size);
      li.appendChild(s1); li.appendChild(document.createTextNode(" "));
      li.appendChild(s2); li.appendChild(document.createTextNode(" "));
      li.appendChild(s3);
      ul.appendChild(li);
      var kind = riskyKind(f.name);
      if (kind) {
        var w = document.createElement("span"); w.className = "filewarn";
        w.textContent = "⚠ " + kind + " — receiver will be warned";
        li.appendChild(w);
      }
      return li;
    });

    document.getElementById("share-code").textContent = code;
    var link = location.origin + location.pathname + "?code=" + code;
    // file:// or sandboxed preview has opaque origin — fall back to href base
    if (!/^https?:/.test(link)) link = location.href.split("?")[0] + "?code=" + code;
    document.getElementById("share-link").value = link;
    renderQrLocal(link);
    sendPanel.hidden = false;
    setSend(0, "Waiting for the other side… share the code or link. Expires in 30 min.");
    document.getElementById("send-progress").classList.add("busy");
    dz.style.display = "none";

    // Code expiry: discard peer after TTL so brute-force window is bounded.
    clearSendExpiry();
    sendExpiryTimer = setTimeout(function () {
      if (sendComplete || sendCancelled) return;
      cleanupSend();
      store.del("fd-code");
      store.del("fd-code-ts");
      setActive(false);
      setSend(0, "Code expired after 30 minutes. Drop the files again for a fresh code.");
    }, CODE_TTL_MS);

    sendPeer = new Peer(peerId, { debug: 0 });
    sendPeer.on("error", function (err) {
      var t = (err && err.type) || "";
      if (t === "unavailable-id") {
        document.getElementById("send-status").textContent = "Code collision — drop the files again to retry.";
      } else {
        document.getElementById("send-status").textContent = "Peer error: " + String(t).slice(0, 64);
      }
    });
    sendPeer.on("connection", function (conn) {
      // Single-receiver binding: while a receiver owns the batch, concurrent
      // peers from a different browser are rejected (prevents a second party
      // who guessed the code from silently joining mid-transfer).
      var peer = null;
      try { peer = conn.peer; } catch (e) { peer = null; }
      if (sendOwnerPeer && peer && peer !== sendOwnerPeer) {
        try { conn.close(); } catch (e) {}
        return;
      }
      if (!sendOwnerPeer && peer) sendOwnerPeer = peer;
      sendConns.push(conn);
      try {
        if (conn.dataChannel) conn.dataChannel.bufferedAmountLowThreshold = LOW_WATERMARK;
      } catch (e) {}
      sendAlive = true;
      // A fresh connection after a clean finish means "send it all again".
      if (sendComplete) { sendComplete = false; pumpStarted = false; }
      document.getElementById("send-status").textContent = "Other side connected — sending…";
      document.getElementById("send-progress").classList.remove("busy");
      conn.on("open", function () { maybeStartPump(files, rows); });
      conn.on("close", onSendDead);
      conn.on("error", onSendDead);
      // Some PeerJS versions deliver 'connection' already open.
      if (connOpen(conn)) maybeStartPump(files, rows);
    });
  }

  function maybeStartPump(files, rows) {
    if (pumpStarted || sendCancelled) return;
    if (!openSendConns().length) return;
    pumpStarted = true;
    setActive(true);
    pokeLive("send");
    pump(files, rows).catch(function (err) {
      setActive(false);
      if (!sendCancelled && sendAlive) {
        document.getElementById("send-status").textContent =
          "Send failed: " + String((err && err.message) || err).slice(0, 120);
      }
    });
  }

  // The other side is gone: freeze the pump where it stands. No fake 100%,
  // no spinning into the void. The code is deliberately kept so a reconnect
  // restarts the batch from zero on a fresh connection.
  function onSendDead() {
    if (openSendConns().length) return; // other channels still alive
    if (sendComplete || sendCancelled || !sendAlive) return;
    sendAlive = false;
    pumpStarted = false; // a later fresh connection restarts the pump from zero
    sendOwnerPeer = null; // release binding so the same receiver can reconnect
    setActive(false);
    // Math.round matches setSend's toFixed(0), so the number never jumps back.
    var pct = sendTotalBytes ? Math.round((sendDoneBytes / sendTotalBytes) * 100) : 0;
    setSend(pct, "Other side disconnected — transfer stopped at " + pct +
      "%. Ask them to tap Reconnect to restart the batch.");
    document.getElementById("send-progress").classList.remove("busy");
  }

  // Control messages go on the first open channel. Trips the honest-halt
  // path when nothing is left to send on.
  function ctrlSend(msg) {
    var cons = openSendConns();
    if (!cons.length) { onSendDead(); return false; }
    try { cons[0].send(msg); return true; }
    catch (e) { onSendDead(); return false; }
  }

  function setSend(pct, msg) {
    document.getElementById("send-progress").value = pct;
    document.getElementById("send-pct").textContent = pct.toFixed(0) + "%";
    if (msg) document.getElementById("send-status").textContent = msg;
  }

  function metaMsg(f, idx, count, payload, total) {
    return {
      t: "meta", fi: idx, fn: count,
      name: String(f.name || "file").slice(0, MAX_NAME_LEN), size: f.size,
      mime: String(f.type || "application/octet-stream").slice(0, MAX_MIME_LEN),
      total: total, chunk: payload, v: 3
    };
  }

  function frameChunk(fidx, i, buf) {
    var out = new Uint8Array(HEADER + buf.byteLength);
    var dv = new DataView(out.buffer);
    dv.setUint16(0, fidx);
    dv.setUint32(2, i);
    out.set(new Uint8Array(buf), HEADER);
    return out.buffer;
  }

  async function pump(files, rows) {
    var t0 = Date.now();
    var totalBytes = sendTotalBytes;
    var payload = negotiatePayload(openSendConns());
    var totals = files.map(function (f) { return Math.max(1, Math.ceil(f.size / payload)); });
    var sentPerFile = files.map(function () { return 0; });
    var fdoneSent = files.map(function () { return false; });
    var doneBytes = 0;
    sendDoneBytes = 0;
    var queue = [];
    var rfi = 0, rdi = 0, eof = false;
    var lastUi = 0;

    function speed() {
      var el = Math.max(0.1, (Date.now() - t0) / 1000);
      return fmt(doneBytes / el) + "/s";
    }
    function ui(pct, msg, force) {
      var now = Date.now();
      if (!force && now - lastUi < UI_MS && pct < 100) return;
      lastUi = now;
      pokeLive("send");
      setSend(pct, msg);
    }
    async function readNext() {
      while (rfi < files.length) {
        if (rdi >= totals[rfi]) { rfi++; rdi = 0; continue; }
        var file = files[rfi], idx = rdi, fidx = rfi;
        rdi++;
        try {
          var buf = await file.slice(idx * payload, (idx + 1) * payload).arrayBuffer();
        } catch (e) {
          setActive(false);
          document.getElementById("send-status").textContent = "Could not read a file.";
          throw e;
        }
        if (sendCancelled) return null;
        return { fi: fidx, i: idx, buf: buf };
      }
      return null;
    }

    // First file header goes out before any of its bytes.
    if (!ctrlSend(metaMsg(files[0], 0, files.length, payload, totals[0]))) return;
    setRow(rows[0], "sending");

    while (true) {
      while (queue.length < PREFETCH && !eof) {
        var nxt = await readNext();
        if (sendCancelled || !sendAlive) return;
        if (!nxt) { eof = true; break; }
        queue.push(nxt);
      }
      if (!queue.length) break; // fully read and drained
      var cons = openSendConns();
      if (!cons.length) { onSendDead(); return; }
      while (!sendCancelled && sendAlive &&
             (inflightBytes() >= TOTAL_INFLIGHT_CAP ||
              !cons.some(function (c) { return connOpen(c) && connBuffered(c) < PER_CONN_CAP; }))) {
        await waitForCapacity();
        cons = openSendConns();
        if (!cons.length) { onSendDead(); return; }
      }
      if (sendCancelled || !sendAlive) return;
      cons.sort(function (a, b) { return connBuffered(a) - connBuffered(b); });
      var item = queue.shift();
      try {
        cons[0].send(frameChunk(item.fi, item.i, item.buf));
      } catch (e) {
        queue.unshift(item);
        await waitForCapacity();
        continue;
      }
      doneBytes += item.buf.byteLength;
      sendDoneBytes = doneBytes; // Math.round-compatible with onSendDead's frozen pct
      sentPerFile[item.fi]++;
      if (sentPerFile[item.fi] === totals[item.fi] && !fdoneSent[item.fi]) {
        fdoneSent[item.fi] = true;
        if (!ctrlSend({ t: "fdone", fi: item.fi })) return;
        setRow(rows[item.fi], "sent");
        var nx = item.fi + 1;
        if (nx < files.length) {
          if (!ctrlSend(metaMsg(files[nx], nx, files.length, payload, totals[nx]))) return;
          setRow(rows[nx], "sending");
        }
      }
      var pct = totalBytes ? (doneBytes / totalBytes) * 100 : 100;
      ui(pct, "Sending file " + (item.fi + 1) + " of " + files.length +
        " — " + fmt(doneBytes) + " / " + fmt(totalBytes) + " (" + speed() + ")", false);
    }

    if (sendCancelled || !sendAlive) return;
    if (!ctrlSend({ t: "done" })) return;
    sendComplete = true;
    store.del("fd-code");
    store.del("fd-code-ts");
    clearSendExpiry();
    setActive(false);
    var secs = Math.max(0.1, (Date.now() - t0) / 1000);
    setSend(100, "Sent " + plural(files.length, "file", "files") +
      " (" + fmt(totalBytes) + ") in " + secs.toFixed(1) + "s (" + fmt(totalBytes / secs) + "/s). You can close this tab.");
  }

  function setRow(li, state) {
    li.querySelector(".fstate").textContent = state;
    li.setAttribute("data-state", state);
  }

  function copyText(id) {
    var el = document.getElementById(id);
    var v = el.tagName === "INPUT" ? el.value : el.textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(v).catch(function () { fallbackCopy(el); });
    } else fallbackCopy(el);
  }
  function fallbackCopy(el) {
    try {
      if (el.select) el.select();
      document.execCommand("copy");
    } catch (e) {}
  }
  document.getElementById("copy-code").onclick = function () { copyText("share-code"); };
  document.getElementById("copy-link").onclick = function () { copyText("share-link"); };

  // ---------- RECEIVER ----------
  var recvPeer = null, recvConns = [];
  var rfiles = {}, rTotalBytes = 0, rDoneBytes = 0, t0r = 0, rCount = 0;
  var lastCode = null;
  var recvSession = "", recvOpfsRoot = null, recvOpfsTried = false;
  var allDoneMsg = false, firstMetaSeen = false, lastRecvUi = 0;
  var recvAttempts = [];
  var recvAborted = false;

  document.getElementById("receive-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var code = document.getElementById("receive-code").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
    if (code.length < 6 || code.length > 16) { setRecv("Enter the code from the sender (6–16 characters)."); return; }
    if (!checkRecvRateLimit()) return;
    document.getElementById("receive-reconnect").hidden = true;
    connectRecv(code);
  });
  document.getElementById("receive-reconnect").onclick = function () {
    if (lastCode) {
      if (!checkRecvRateLimit()) return;
      document.getElementById("receive-reconnect").hidden = true;
      connectRecv(lastCode);
    }
  };
  document.getElementById("receive-cancel").onclick = function () {
    try { for (var i = 0; i < recvConns.length; i++) recvConns[i].close(); } catch (e) {}
    try { if (recvPeer) recvPeer.destroy(); } catch (e) {}
    setActive(false);
    setRecv("Stopped.");
  };

  function checkRecvRateLimit() {
    var now = Date.now();
    recvAttempts = recvAttempts.filter(function (t) { return now - t < RECV_WINDOW_MS; });
    if (recvAttempts.length >= RECV_MAX_ATTEMPTS) {
      setRecv("Too many attempts — wait 60 seconds, double-check the code, then try again.");
      return false;
    }
    recvAttempts.push(now);
    return true;
  }

  function setRecv(msg, pct) {
    document.getElementById("receive-status").textContent = msg;
    var bar = document.getElementById("receive-progress");
    if (pct == null) return;
    bar.hidden = false;
    bar.value = pct;
    document.getElementById("receive-pct").textContent = pct.toFixed(0) + "%";
  }

  function setRecvThrottled(msg, pct, force) {
    var now = Date.now();
    if (!force && now - lastRecvUi < UI_MS) return;
    lastRecvUi = now;
    if (pct < 100) pokeLive("receive");
    setRecv(msg, pct);
  }

  function recvProgressMsg() {
    var el = Math.max(0.1, (Date.now() - t0r) / 1000);
    var denom = Math.max(rTotalBytes, rDoneBytes, 1);
    return {
      msg: "Receiving… " + fmt(Math.min(denom, rDoneBytes)) + " / " + fmt(rTotalBytes || rDoneBytes) +
        " (" + fmt(rDoneBytes / el) + "/s)",
      pct: rTotalBytes ? (rDoneBytes / rTotalBytes) * 100 : 100
    };
  }

  function connectRecv(code) {
    try { if (recvPeer) recvPeer.destroy(); } catch (e) {}
    recvConns = [];
    rfiles = {}; rTotalBytes = 0; rDoneBytes = 0; rCount = 0; t0r = Date.now();
    lastCode = code;
    recvAborted = false;
    recvSession = Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
    recvOpfsRoot = null; recvOpfsTried = false;
    allDoneMsg = false; firstMetaSeen = false; lastRecvUi = 0;
    document.getElementById("receive-filelist").innerHTML = "";
    document.getElementById("receive-cancel").hidden = false;
    document.getElementById("receive-progress").classList.add("busy");
    setActive(true);
    setRecv("Connecting… keep this tab open.", 0);

    var prefix = prefixForCode(code);
    recvPeer = new Peer({ debug: 0 });
    recvPeer.on("open", function () {
      if (recvAborted) return;
      var opened = 0;
      for (var k = 0; k < NUM_CHANNELS; k++) {
        (function (k) {
          var conn = recvPeer.connect(prefix + code, { reliable: true, label: "filedrop-v3-d" + k });
          recvConns.push(conn);
          conn.on("open", function () {
            opened++;
            if (opened === 1) setRecv("Connected — waiting for the first file…", 0);
          });
          conn.on("data", onData);
          conn.on("close", onRecvDead);
          conn.on("error", function () {});
        })(k);
      }
    });
    recvPeer.on("error", function (err) {
      // Deliberately generic: do not distinguish "not found" from other
      // failures in UI (avoids a code-enumeration oracle). Details to console.
      try { if (window.console) window.console.warn("peer error", err && err.type); } catch (e) {}
      if (recvAborted) return;
      setActive(false);
      setRecv("Could not connect. Check the code — the sender tab must stay open — then try again.");
    });
  }

  function abortRecv(msg) {
    if (recvAborted) return;
    recvAborted = true;
    try { for (var i = 0; i < recvConns.length; i++) { try { recvConns[i].close(); } catch (e) {} } } catch (e) {}
    try { if (recvPeer) recvPeer.destroy(); } catch (e) {}
    setActive(false);
    try { document.getElementById("receive-progress").classList.remove("busy"); } catch (e) {}
    setRecv(msg || "Transfer stopped: invalid data from sender.");
    try { document.getElementById("receive-reconnect").hidden = false; } catch (e) {}
  }

  // Honest-halt, multi-channel edition: only when every channel is down.
  function onRecvDead() {
    if (recvAborted) return;
    if (recvConns.some(connOpen)) return;
    document.getElementById("receive-progress").classList.remove("busy");
    var keys = Object.keys(rfiles);
    var pending = keys.some(function (k) { return !rfiles[k].complete; });
    if (!keys.length || pending) {
      setActive(false);
      keys.forEach(function (k) {
        var f = rfiles[k];
        if (!f.complete) {
          f.li.querySelector(".fstate").textContent = "stopped";
          f.li.setAttribute("data-state", "stopped");
        }
      });
      setRecv("Sender left before everything arrived. Finished files are kept below — tap Reconnect to restart the batch.");
      document.getElementById("receive-reconnect").hidden = false;
    }
  }

  function pendingTotal() {
    var n = 0, keys = Object.keys(rfiles);
    for (var i = 0; i < keys.length; i++) n += Object.keys(rfiles[keys[i]].pending).length;
    return n;
  }

  function ensureEntry(fidx) {
    if (!Number.isFinite(fidx) || Math.floor(fidx) !== fidx || fidx < 0 || fidx >= MAX_FILES) {
      abortRecv("Transfer stopped: invalid file index from sender.");
      return null;
    }
    var f = rfiles[fidx];
    if (!f) {
      if (Object.keys(rfiles).length >= MAX_FILES) {
        abortRecv("Transfer stopped: too many files (max " + MAX_FILES + ").");
        return null;
      }
      f = {
        fi: fidx, meta: null, total: 0, chunk: 0,
        chunks: null, written: {}, pending: {}, got: 0,
        complete: false, sealing: false, fdone: false, li: recvRowPlaceholder(fidx),
        useOpfs: false, writer: null, opfsHandle: null, opfsName: "",
        opfsReady: null, writeChain: Promise.resolve()
      };
      rfiles[fidx] = f;
    }
    return f;
  }

  function recvRowPlaceholder(fidx) {
    var li = document.createElement("li");
    var s1 = document.createElement("span"); s1.className = "fname";
    var s2 = document.createElement("span"); s2.className = "bytes";
    var s3 = document.createElement("span"); s3.className = "fstate";
    s1.textContent = "File " + (fidx + 1);
    s3.textContent = "receiving";
    li.appendChild(s1); li.appendChild(document.createTextNode(" "));
    li.appendChild(s2); li.appendChild(document.createTextNode(" "));
    li.appendChild(s3);
    li.setAttribute("data-state", "receiving");
    document.getElementById("receive-filelist").appendChild(li);
    return li;
  }
  function fillRow(f, meta) {
    var safe = sanitizeDownloadName(meta.name);
    f.li.querySelector(".fname").textContent = safe;
    f.li.querySelector(".bytes").textContent = fmt(meta.size);
    var kind = riskyKind(safe);
    if (kind && !f.li.querySelector(".filewarn")) {
      var w = document.createElement("span");
      w.className = "filewarn";
      w.textContent = "⚠ " + kind + " — only open if you trust the sender";
      w.title = "This file type can contain code. Download it only if you expected it.";
      f.li.appendChild(w);
    }
  }

  function getOpfsRoot() {
    if (recvOpfsTried) return Promise.resolve(recvOpfsRoot);
    recvOpfsTried = true;
    try {
      if (!(navigator.storage && navigator.storage.getDirectory)) return Promise.resolve(null);
      return navigator.storage.getDirectory().then(function (d) {
        recvOpfsRoot = d;
        return d;
      }).catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  // Stream-to-disk when possible (constant memory, no 2x Blob spike at the
  // end); falls back to in-memory chunks. Early chunks wait in `pending`
  // until the meta + writer are ready.
  function setupOpfs(f, meta) {
    f.opfsReady = getOpfsRoot().then(function (root) {
      if (!root || recvAborted) return false;
      if (meta.size > MAX_FILE_SIZE) return false;
      f.opfsName = ("fd-" + recvSession + "-" + f.fi + "-" + sanitize(meta.name)).slice(0, 120);
      return root.getFileHandle(f.opfsName, { create: true }).then(function (fh) {
        f.opfsHandle = fh;
        return fh.createWritable();
      }).then(function (w) {
        f.writer = w;
        f.useOpfs = true;
        return true;
      }).catch(function () { return false; });
    }).then(function (ok) {
      if (recvAborted) return ok;
      if (!ok) {
        f.useOpfs = false;
        if (f.total > MAX_CHUNKS_PER_FILE) { abortRecv("Transfer stopped: file too fragmented."); return ok; }
        if (!f.chunks) {
          try { f.chunks = new Array(f.total); }
          catch (e) { abortRecv("Transfer stopped: file too large to buffer."); return ok; }
        }
      }
      flushPending(f);
      checkEntry(f);
      return ok;
    });
    return f.opfsReady;
  }

  function flushPending(f) {
    var keys = Object.keys(f.pending);
    for (var k = 0; k < keys.length; k++) {
      var i = Number(keys[k]);
      var buf = f.pending[i];
      delete f.pending[i];
      storeChunk(f, i, buf);
      if (recvAborted) return;
    }
  }

  function storeChunk(f, i, payload) {
    if (recvAborted || f.complete || f.written[i]) return;
    if (!Number.isFinite(i) || Math.floor(i) !== i || i < 0) return;
    if (payload.byteLength === 0 || payload.byteLength > MAX_PAYLOAD + MAX_BIN_SLOP) {
      abortRecv("Transfer stopped: invalid chunk size from sender.");
      return;
    }
    if (!f.meta) {
      if (Object.keys(f.pending).length >= MAX_PENDING_PER_FILE || pendingTotal() >= MAX_PENDING_TOTAL) {
        abortRecv("Transfer stopped: sender sent data too early.");
        return;
      }
      f.pending[i] = payload;
      return;
    }
    if (i >= f.total) return;
    if (f.useOpfs || (f.opfsReady && !f.chunks)) {
      if (!f.writer) {
        if (Object.keys(f.pending).length >= MAX_PENDING_PER_FILE || pendingTotal() >= MAX_PENDING_TOTAL) {
          abortRecv("Transfer stopped: sender sent data too early.");
          return;
        }
        f.pending[i] = payload;
        return;
      }
      var pos = i * f.meta.chunk;
      if (pos < 0 || pos >= MAX_FILE_SIZE + MAX_CHUNK) {
        abortRecv("Transfer stopped: invalid chunk offset.");
        return;
      }
      if (rDoneBytes + payload.byteLength > MAX_TOTAL_BYTES + MAX_BIN_SLOP) {
        abortRecv("Transfer stopped: batch too large (max " + fmt(MAX_TOTAL_BYTES) + ").");
        return;
      }
      var view = new Uint8Array(payload);
      f.writeChain = f.writeChain.then(function () {
        return f.writer.write({ type: "write", position: pos, data: view });
      }).then(function () {
        if (recvAborted || f.complete) return;
        f.written[i] = true;
        f.got++;
        rDoneBytes += payload.byteLength;
        var p = recvProgressMsg();
        setRecvThrottled(p.msg, p.pct, false);
        checkEntry(f);
      }).catch(function () {
        if (!f.complete && !recvAborted) {
          f.li.querySelector(".fstate").textContent = "write failed";
          f.li.setAttribute("data-state", "error");
        }
      });
      return;
    }
    if (!f.chunks) {
      if (f.total > MAX_CHUNKS_PER_FILE) { abortRecv("Transfer stopped: file too fragmented."); return; }
      try { f.chunks = new Array(f.total); }
      catch (e) { abortRecv("Transfer stopped: out of memory."); return; }
    }
    if (rDoneBytes + payload.byteLength > MAX_TOTAL_BYTES + MAX_BIN_SLOP) {
      abortRecv("Transfer stopped: batch too large.");
      return;
    }
    if (!f.chunks[i]) {
      f.chunks[i] = payload;
      f.written[i] = true;
      f.got++;
      rDoneBytes += payload.byteLength;
      var p2 = recvProgressMsg();
      setRecvThrottled(p2.msg, p2.pct, false);
    }
    checkEntry(f);
  }

  function onData(d) {
    if (recvAborted || !d) return;
    if (typeof ArrayBuffer !== "undefined" && d instanceof ArrayBuffer) { onBinary(d); return; }
    if (typeof Uint8Array !== "undefined" && d instanceof Uint8Array) {
      if (d.byteLength > MAX_PAYLOAD + MAX_BIN_SLOP + HEADER) {
        abortRecv("Transfer stopped: oversized message from sender.");
        return;
      }
      onBinary(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
      return;
    }
    if (typeof Blob !== "undefined" && d instanceof Blob) {
      if (d.size > MAX_PAYLOAD + MAX_BIN_SLOP + HEADER) {
        abortRecv("Transfer stopped: oversized message from sender.");
        return;
      }
      d.arrayBuffer().then(function (b) { if (!recvAborted) onBinary(b); }).catch(function () {});
      return;
    }
    if (typeof d === "object" && d.t) onControl(d);
  }

  function onBinary(buf) {
    if (recvAborted) return;
    if (!buf || buf.byteLength < HEADER + 1) return;
    if (buf.byteLength > MAX_PAYLOAD + MAX_BIN_SLOP + HEADER) {
      abortRecv("Transfer stopped: oversized message from sender.");
      return;
    }
    var dv;
    try { dv = new DataView(buf); } catch (e) { return; }
    var fidx = dv.getUint16(0);
    var i = dv.getUint32(2);
    if (i >= MAX_CHUNKS_PER_FILE) { abortRecv("Transfer stopped: invalid chunk index."); return; }
    var payload = buf.slice(HEADER);
    var f = ensureEntry(fidx);
    if (!f) return; // ensureEntry already aborted
    if (f.total && i >= f.total) return;
    storeChunk(f, i, payload);
  }

  function validMeta(d) {
    if (!d || typeof d !== "object") return "bad header";
    if (!Number.isFinite(d.fi) || Math.floor(d.fi) !== d.fi || d.fi < 0 || d.fi >= MAX_FILES) return "bad file index";
    if (!Number.isFinite(d.fn) || Math.floor(d.fn) !== d.fn || d.fn < 1 || d.fn > MAX_FILES) return "bad file count";
    if (typeof d.name !== "string" || d.name.length < 1 || d.name.length > 512) return "bad file name";
    if (typeof d.size !== "number" || !(d.size >= 0) || d.size > MAX_FILE_SIZE) return "file too large (max " + fmt(MAX_FILE_SIZE) + ")";
    if (!Number.isFinite(d.total) || Math.floor(d.total) !== d.total || d.total < 1 || d.total > MAX_CHUNKS_PER_FILE) return "bad chunk count";
    if (!Number.isFinite(d.chunk) || Math.floor(d.chunk) !== d.chunk || d.chunk < MIN_CHUNK || d.chunk > MAX_CHUNK) return "bad chunk size";
    if (d.mime != null && (typeof d.mime !== "string" || d.mime.length > MAX_MIME_LEN)) return "bad file type";
    // Cross-check: total must match size/chunk (prevents lying to force huge allocations).
    var expected = Math.max(1, Math.ceil(d.size / d.chunk));
    if (d.total !== expected) return "inconsistent file header";
    if (d.fi >= d.fn) return "bad file index";
    return null;
  }

  function onControl(d) {
    if (recvAborted) return;
    if (d.t === "meta") {
      var err = validMeta(d);
      if (err) { abortRecv("Transfer stopped: " + err + "."); return; }
      if (rCount && d.fn !== rCount) { abortRecv("Transfer stopped: inconsistent batch."); return; }
      if (rTotalBytes + d.size > MAX_TOTAL_BYTES) {
        abortRecv("Transfer stopped: batch too large (max " + fmt(MAX_TOTAL_BYTES) + ").");
        return;
      }
      var f = ensureEntry(d.fi);
      if (!f) return;
      if (f.meta) { abortRecv("Transfer stopped: duplicate file header."); return; }
      // Normalize to safe values before storing.
      f.meta = {
        name: sanitizeDownloadName(d.name),
        size: d.size,
        mime: String(d.mime || "application/octet-stream").slice(0, MAX_MIME_LEN) || "application/octet-stream"
      };
      f.total = d.total;
      f.chunk = d.chunk;
      if (!rCount) rCount = d.fn;
      rTotalBytes += d.size;
      if (t0r === 0) t0r = Date.now();
      fillRow(f, { name: f.meta.name, size: f.meta.size });
      if (!firstMetaSeen) {
        firstMetaSeen = true;
        document.getElementById("receive-progress").classList.remove("busy");
      }
      pokeLive("receive");
      setRecvThrottled("Receiving file " + (d.fi + 1) + " of " + d.fn + " — “" + f.meta.name.slice(0, 80) + "”…",
        rTotalBytes ? (rDoneBytes / rTotalBytes) * 100 : 0, true);
      setupOpfs(f, { name: f.meta.name, size: f.meta.size });
    } else if (d.t === "fdone") {
      if (!Number.isFinite(d.fi) || Math.floor(d.fi) !== d.fi || d.fi < 0 || d.fi >= MAX_FILES) {
        abortRecv("Transfer stopped: invalid file index.");
        return;
      }
      var f2 = ensureEntry(d.fi);
      if (!f2) return;
      f2.fdone = true;
      checkEntry(f2);
    } else if (d.t === "done") {
      allDoneMsg = true;
      maybeFinishAll();
    }
  }

  function checkEntry(f) {
    if (recvAborted || f.complete || !f.meta || !f.fdone) return;
    if (f.got !== f.total) return;
    if (f.useOpfs) {
      if (!f.writer || f.sealing) return;
      f.sealing = true;
      // Drain outstanding positional writes before sealing the file.
      f.writeChain.then(function () { sealOpfsFile(f); }).catch(function () {});
      return;
    }
    if (f.opfsReady && !f.chunks) return; // setup still in flight
    finishMemoryFile(f);
  }

  function sealOpfsFile(f) {
    if (recvAborted || f.complete) return;
    if (f.meta.size > MAX_FILE_SIZE) { abortRecv("Transfer stopped: file too large."); return; }
    f.writer.truncate(f.meta.size).then(function () {
      return f.writer.close();
    }).then(function () {
      return f.opfsHandle.getFile();
    }).then(function (file) {
      if (recvAborted || f.complete) return;
      f.complete = true;
      // Drop OPFS temp handle ASAP; blob holds the bytes.
      var tmpName = f.opfsName;
      f.writer = null;
      deleteTempOpfs(tmpName);
      finishWithBlob(f, file);
      maybeFinishAll();
    }).catch(function () {
      if (!recvAborted) {
        f.li.querySelector(".fstate").textContent = "write failed";
        f.li.setAttribute("data-state", "error");
      }
    });
  }

  function finishMemoryFile(f) {
    if (recvAborted || f.complete) return;
    f.complete = true;
    var blob = new Blob(f.chunks || [], { type: f.meta.mime });
    f.chunks = null;
    finishWithBlob(f, blob);
    maybeFinishAll();
  }

  function finishWithBlob(f, blob) {
    // Clamp vault writes; oversized batches still download but are not persisted.
    saveVaultFile(f.meta, blob);
    var url = URL.createObjectURL(blob);
    var st = f.li.querySelector(".fstate");
    st.textContent = "";
    var a = document.createElement("a");
    a.href = url;
    a.download = sanitizeDownloadName(f.meta.name);
    a.textContent = "Download";
    a.className = "minilink";
    a.rel = "noopener";
    st.appendChild(a);
    f.li.setAttribute("data-state", "done");
    // No auto-download: user must click. Browsers may block multiples and
    // silent drive-by drops are a malware vector.
  }

  function maybeFinishAll() {
    if (recvAborted || !allDoneMsg) return;
    var keys = Object.keys(rfiles);
    if (rCount && keys.length !== rCount) return;
    if (!keys.length) { setRecv("Transfer ended with nothing received."); return; }
    for (var i = 0; i < keys.length; i++) {
      if (!rfiles[keys[i]].complete) return;
    }
    document.getElementById("receive-cancel").hidden = true;
    document.getElementById("receive-reconnect").hidden = true;
    setActive(false);
    setRecv("Done — " + plural(keys.length, "file", "files") +
      " received (" + fmt(rTotalBytes) + "). Use the per-file Download links above; copies are also saved on this device below.", 100);
  }

  // ---------- OPFS temp cleanup ----------
  function opfsRoot() {
    try {
      if (navigator.storage && navigator.storage.getDirectory) return navigator.storage.getDirectory();
    } catch (e) {}
    return Promise.resolve(null);
  }
  function deleteTempOpfs(name) {
    if (!name) return;
    opfsRoot().then(function (root) {
      if (!root) return;
      return root.removeEntry(name).catch(function () {});
    }).catch(function () {});
  }
  function clearAllTempOpfs() {
    return opfsRoot().then(function (root) {
      if (!root || !root.values) return;
      var pending = [];
      try {
        var it = root.values();
        var step = function () {
          return it.next().then(function (r) {
            if (r.done) return;
            var h = r.value;
            if (h && h.kind === "file" && h.name.indexOf("fd-") === 0) {
              pending.push(root.removeEntry(h.name).catch(function () {}));
            }
            return step();
          }).catch(function () {});
        };
        return step().then(function () { return Promise.all(pending); });
      } catch (e) { return null; }
    }).catch(function () {});
  }
  function sweepOldTempOpfs() {
    opfsRoot().then(function (root) {
      if (!root || !root.values) return;
      try {
        var it = root.values();
        var step = function () {
          return it.next().then(function (r) {
            if (r.done) return;
            var h = r.value;
            if (h && h.kind === "file" && h.name.indexOf("fd-") === 0) {
              return h.getFile().then(function (f) {
                if (Date.now() - (f.lastModified || 0) > VAULT_MAX_AGE_MS) {
                  return root.removeEntry(h.name).catch(function () {});
                }
              }).catch(function () {}).then(step);
            }
            return step();
          }).catch(function () {});
        };
        return step();
      } catch (e) {}
    }).catch(function () {});
  }

  // ---------- on-device vault ----------
  // Finished files are kept in IndexedDB so a refresh (or a dead tab) never
  // loses them. Best-effort: quota or private mode just means no vault.
  // Entries expire after 7 days; clearing deletes IDB + OPFS temps.
  var vaultDb = null;
  function vaultOpen() {
    return new Promise(function (resolve) {
      if (vaultDb) return resolve(vaultDb);
      if (!("indexedDB" in window)) return resolve(null);
      try {
        var req = window.indexedDB.open("filedrop", 1);
        req.onupgradeneeded = function () {
          req.result.createObjectStore("files", { keyPath: "id", autoIncrement: true });
        };
        req.onsuccess = function () { vaultDb = req.result; resolve(vaultDb); };
        req.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }
  function saveVaultFile(meta, blob) {
    var safeName = sanitizeDownloadName(meta.name);
    if (blob.size > MAX_FILE_SIZE) return;
    vaultOpen().then(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction("files", "readwrite");
        var os = tx.objectStore("files");
        var countReq = os.count();
        countReq.onsuccess = function () {
          try {
            if ((countReq.result || 0) >= VAULT_MAX_FILES) return; // cap count
            os.add({
              name: safeName,
              mime: String(meta.mime || "application/octet-stream").slice(0, MAX_MIME_LEN),
              size: blob.size, blob: blob, ts: Date.now()
            });
          } catch (e) {}
        };
      } catch (e) {}
    });
  }
  function renderVault() {
    vaultOpen().then(function (db) {
      if (!db) return;
      try {
        var req = db.transaction("files", "readonly").objectStore("files").getAll();
        req.onsuccess = function () {
          var items = req.result || [];
          pruneExpiredVault(db, items);
          paintVault(items.filter(function (it) {
            return Date.now() - (it.ts || 0) <= VAULT_MAX_AGE_MS;
          }));
        };
        req.onerror = function () {};
      } catch (e) {}
    });
  }
  function pruneExpiredVault(db, items) {
    try {
      var now = Date.now();
      var expired = items.filter(function (it) { return now - (it.ts || 0) > VAULT_MAX_AGE_MS; });
      if (!expired.length) return;
      var tx = db.transaction("files", "readwrite");
      var os = tx.objectStore("files");
      expired.forEach(function (it) { try { os.delete(it.id); } catch (e) {} });
    } catch (e) {}
  }
  function paintVault(items) {
    var sec = document.getElementById("vault");
    var ul = document.getElementById("vault-list");
    ul.innerHTML = "";
    if (!items.length) { sec.hidden = true; return; }
    // Enforce display cap; oldest beyond cap are hidden (pruned on next save/clear).
    items.sort(function (a, b) { return b.ts - a.ts; });
    items.slice(0, VAULT_MAX_FILES).forEach(function (it) {
      var li = document.createElement("li");
      var s1 = document.createElement("span"); s1.className = "fname";
      var s2 = document.createElement("span"); s2.className = "bytes";
      var s3 = document.createElement("span"); s3.className = "fstate";
      var safe = sanitizeDownloadName(it.name);
      s1.textContent = safe;
      s2.textContent = fmt(it.size);
      var a = document.createElement("a");
      a.href = URL.createObjectURL(it.blob);
      a.download = safe;
      a.textContent = "Download";
      a.className = "minilink";
      a.rel = "noopener";
      s3.appendChild(a);
      li.appendChild(s1); li.appendChild(document.createTextNode(" "));
      li.appendChild(s2); li.appendChild(document.createTextNode(" "));
      li.appendChild(s3);
      var kind = riskyKind(safe);
      if (kind) {
        var w = document.createElement("span");
        w.className = "filewarn";
        w.textContent = "⚠ " + kind;
        w.title = "Only open if you trust the sender.";
        li.appendChild(w);
      }
      ul.appendChild(li);
    });
    sec.hidden = false;
  }
  document.getElementById("vault-clear").onclick = function () {
    vaultOpen().then(function (db) {
      if (db) {
        try {
          var tx = db.transaction("files", "readwrite");
          tx.objectStore("files").clear();
          tx.oncomplete = renderVault;
        } catch (e) {}
      }
    });
    clearAllTempOpfs().then(renderVault).catch(function () {});
    try { renderVault(); } catch (e) {}
  };
  renderVault();
  sweepOldTempOpfs();

  // deep-link ?code=XXX → receive tab
  if (/[?&]code=/.test(location.search)) show("receive");
})();
