/* FileDrop — P2P bulk file transfer (Cloudflare Pages static-only).
 * Signaling: public PeerJS cloud. Data: parallel WebRTC DataConnections
 * (SCTP, reliable), raw-binary framed chunks with positional writes.
 * No backend, no storage. One code carries a queue of files, striped in
 * order across channels. Both peers must keep the tab open during transfer.
 *
 * Protocol v2 (prefix filedrop-v2-):
 *  - control (JSON objects on first open channel): meta / fdone / done
 *  - data (ArrayBuffer): [fi:uint16][i:uint32][payload...]
 * Chunks of a file may arrive out of order across channels; the receiver
 * reassembles by (fi, i) and only finishes a file after meta + fdone +
 * all chunks are stored.
 */
(function () {
  "use strict";

  var DEFAULT_PAYLOAD = 250 * 1024;
  var MAX_PAYLOAD = 256 * 1024 - 6;
  var HEADER = 6;
  var PREFIX = "filedrop-v2-";
  var NUM_CHANNELS = 4;
  var PER_CONN_CAP = 2 * 1048576;
  var TOTAL_INFLIGHT_CAP = 8 * 1048576;
  var LOW_WATERMARK = 1 * 1048576;
  var PREFETCH = 4;
  var UI_MS = 150;

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
      var m = /[?&]code=([A-Za-z0-9]{4,8})/.exec(location.search);
      if (m) document.getElementById("receive-code").value = m[1].toUpperCase();
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
  function code6() {
    var c = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    var s = "";
    for (var i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
    return s;
  }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function sanitize(name) {
    return String(name || "file").replace(/[\\/:*?"<>|]/g, "_").slice(0, 100) || "file";
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

  // ---------- SENDER ----------
  var dz = document.getElementById("dropzone");
  var fi = document.getElementById("file-input");
  var sendPanel = document.getElementById("send-panel");
  var sendPeer = null, sendConns = [], sendCancelled = false;
  var sendAlive = false, sendComplete = false, sendTotalBytes = 0, sendDoneBytes = 0;
  var pumpStarted = false;

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
  function cleanupSend() {
    sendCancelled = true;
    pumpStarted = false;
    try {
      for (var i = 0; i < sendConns.length; i++) { try { sendConns[i].close(); } catch (e) {} }
    } catch (e) {}
    try { if (sendPeer) sendPeer.destroy(); } catch (e) {}
    sendConns = []; sendPeer = null;
  }
  document.getElementById("send-cancel").onclick = function () {
    cleanupSend();
    store.del("fd-code");
    setActive(false);
    document.getElementById("send-status").textContent = "Stopped.";
  };

  function startSend(fileList) {
    cleanupSend();
    sendCancelled = false;
    sendAlive = false;
    sendComplete = false;
    sendDoneBytes = 0;
    var files = Array.prototype.slice.call(fileList);
    // Reuse the tab's code if it survived a reload; otherwise mint one.
    var code = store.get("fd-code") || code6();
    store.set("fd-code", code);
    sendTotalBytes = files.reduce(function (a, f) { return a + f.size; }, 0);
    var peerId = PREFIX + code;

    document.getElementById("send-filecount").textContent = plural(files.length, "file", "files");
    document.getElementById("send-filesize").textContent = "(" + fmt(sendTotalBytes) + " total)";
    var ul = document.getElementById("send-filelist");
    ul.innerHTML = "";
    var rows = files.map(function (f) {
      var li = document.createElement("li");
      li.innerHTML = '<span class="fname"></span> <span class="bytes"></span> <span class="fstate">queued</span>';
      li.querySelector(".fname").textContent = f.name;
      li.querySelector(".bytes").textContent = fmt(f.size);
      ul.appendChild(li);
      return li;
    });

    document.getElementById("share-code").textContent = code;
    var link = location.origin + location.pathname + "?code=" + code;
    // file:// or sandboxed preview has opaque origin — fall back to href base
    if (!/^https?:/.test(link)) link = location.href.split("?")[0] + "?code=" + code;
    document.getElementById("share-link").value = link;
    var qr = document.getElementById("share-qr");
    qr.src = "https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=" + encodeURIComponent(link);
    qr.hidden = false;
    sendPanel.hidden = false;
    setSend(0, "Waiting for the other side… share the code or link.");
    document.getElementById("send-progress").classList.add("busy");
    dz.style.display = "none";

    sendPeer = new Peer(peerId, { debug: 0 });
    sendPeer.on("error", function (err) {
      var t = (err && err.type) || "";
      if (t === "unavailable-id") {
        document.getElementById("send-status").textContent = "Code collision — drop the files again to retry.";
      } else {
        document.getElementById("send-status").textContent = "Peer error: " + t;
      }
    });
    sendPeer.on("connection", function (conn) {
      sendConns.push(conn);
      try {
        if (conn.dataChannel) conn.dataChannel.bufferedAmountLowThreshold = LOW_WATERMARK;
      } catch (e) {}
      sendAlive = true;
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
          "Send failed: " + ((err && err.message) || err);
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
      name: f.name, size: f.size,
      mime: f.type || "application/octet-stream",
      total: total, chunk: payload
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
          document.getElementById("send-status").textContent = "Could not read “" + file.name + "”.";
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
    navigator.clipboard.writeText(v).catch(function () {
      if (el.select) el.select();
      document.execCommand("copy");
    });
  }
  document.getElementById("copy-code").onclick = function () { copyText("share-code"); };
  document.getElementById("copy-link").onclick = function () { copyText("share-link"); };

  // ---------- RECEIVER ----------
  var recvPeer = null, recvConns = [];
  var rfiles = {}, rTotalBytes = 0, rDoneBytes = 0, t0r = 0, rCount = 0;
  var lastCode = null;
  var recvSession = "", recvOpfsRoot = null, recvOpfsTried = false;
  var allDoneMsg = false, firstMetaSeen = false, lastRecvUi = 0;

  document.getElementById("receive-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var code = document.getElementById("receive-code").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length < 4) { setRecv("Enter the 6-character code from the sender."); return; }
    document.getElementById("receive-reconnect").hidden = true;
    connectRecv(code);
  });
  document.getElementById("receive-reconnect").onclick = function () {
    if (lastCode) {
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
    recvSession = Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
    recvOpfsRoot = null; recvOpfsTried = false;
    allDoneMsg = false; firstMetaSeen = false; lastRecvUi = 0;
    document.getElementById("receive-filelist").innerHTML = "";
    document.getElementById("receive-cancel").hidden = false;
    document.getElementById("receive-progress").classList.add("busy");
    setActive(true);
    setRecv("Connecting… look for the code turning live below.", 0);

    recvPeer = new Peer({ debug: 0 });
    recvPeer.on("open", function () {
      var opened = 0;
      for (var k = 0; k < NUM_CHANNELS; k++) {
        (function (k) {
          var conn = recvPeer.connect(PREFIX + code, { reliable: true, label: "filedrop-v2-d" + k });
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
      var t = (err && err.type) || "";
      setActive(false);
      if (t === "peer-unavailable") setRecv("Sender not found. Check the code — the sender tab must stay open.");
      else setRecv("Peer error: " + t);
    });
  }

  // Honest-halt, multi-channel edition: only when every channel is down.
  function onRecvDead() {
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

  function ensureEntry(fidx) {
    var f = rfiles[fidx];
    if (!f) {
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
    li.innerHTML = '<span class="fname"></span> <span class="bytes"></span> <span class="fstate">receiving</span>';
    li.querySelector(".fname").textContent = "File " + (fidx + 1);
    li.querySelector(".bytes").textContent = "";
    li.setAttribute("data-state", "receiving");
    document.getElementById("receive-filelist").appendChild(li);
    return li;
  }
  function fillRow(f, meta) {
    f.li.querySelector(".fname").textContent = meta.name;
    f.li.querySelector(".bytes").textContent = fmt(meta.size);
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
      if (!root) return false;
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
      if (!ok) {
        f.useOpfs = false;
        if (!f.chunks) f.chunks = new Array(f.total);
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
    }
  }

  function storeChunk(f, i, payload) {
    if (f.complete || f.written[i]) return;
    if (!f.meta) { f.pending[i] = payload; return; }
    if (f.useOpfs || (f.opfsReady && !f.chunks)) {
      if (!f.writer) { f.pending[i] = payload; return; }
      var pos = i * f.meta.chunk;
      var view = new Uint8Array(payload);
      f.writeChain = f.writeChain.then(function () {
        return f.writer.write({ type: "write", position: pos, data: view });
      }).then(function () {
        f.written[i] = true;
        f.got++;
        rDoneBytes += payload.byteLength;
        var p = recvProgressMsg();
        setRecvThrottled(p.msg, p.pct, false);
        checkEntry(f);
      }).catch(function () {
        if (!f.complete) {
          f.li.querySelector(".fstate").textContent = "write failed";
          f.li.setAttribute("data-state", "error");
        }
      });
      return;
    }
    if (!f.chunks) f.chunks = new Array(f.total);
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
    if (!d) return;
    if (typeof ArrayBuffer !== "undefined" && d instanceof ArrayBuffer) { onBinary(d); return; }
    if (typeof Uint8Array !== "undefined" && d instanceof Uint8Array) {
      onBinary(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
      return;
    }
    if (typeof Blob !== "undefined" && d instanceof Blob) {
      d.arrayBuffer().then(onBinary).catch(function () {});
      return;
    }
    if (typeof d === "object" && d.t) onControl(d);
  }

  function onBinary(buf) {
    if (!buf || buf.byteLength < HEADER + 1) return;
    var dv = new DataView(buf);
    var fidx = dv.getUint16(0);
    var i = dv.getUint32(2);
    var payload = buf.slice(HEADER);
    var f = ensureEntry(fidx);
    if (f.total && i >= f.total) return;
    storeChunk(f, i, payload);
  }

  function onControl(d) {
    if (d.t === "meta") {
      var f = ensureEntry(d.fi);
      f.meta = d;
      f.total = d.total;
      f.chunk = d.chunk || DEFAULT_PAYLOAD;
      if (!rCount) rCount = d.fn;
      rTotalBytes += d.size;
      if (t0r === 0) t0r = Date.now();
      fillRow(f, d);
      if (!firstMetaSeen) {
        firstMetaSeen = true;
        document.getElementById("receive-progress").classList.remove("busy");
      }
      pokeLive("receive");
      setRecvThrottled("Receiving file " + (d.fi + 1) + " of " + d.fn + " — “" + d.name + "”…",
        rTotalBytes ? (rDoneBytes / rTotalBytes) * 100 : 0, true);
      setupOpfs(f, d);
    } else if (d.t === "fdone") {
      var f2 = ensureEntry(d.fi);
      f2.fdone = true;
      checkEntry(f2);
    } else if (d.t === "done") {
      allDoneMsg = true;
      maybeFinishAll();
    }
  }

  function checkEntry(f) {
    if (f.complete || !f.meta || !f.fdone) return;
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
    if (f.complete) return;
    f.writer.truncate(f.meta.size).then(function () {
      return f.writer.close();
    }).then(function () {
      return f.opfsHandle.getFile();
    }).then(function (file) {
      if (f.complete) return;
      f.complete = true;
      finishWithBlob(f, file);
      maybeFinishAll();
    }).catch(function () {
      f.li.querySelector(".fstate").textContent = "write failed";
      f.li.setAttribute("data-state", "error");
    });
  }

  function finishMemoryFile(f) {
    if (f.complete) return;
    f.complete = true;
    var blob = new Blob(f.chunks || [], { type: f.meta.mime });
    f.chunks = null;
    finishWithBlob(f, blob);
    maybeFinishAll();
  }

  function finishWithBlob(f, blob) {
    saveVaultFile(f.meta, blob);
    var url = URL.createObjectURL(blob);
    var st = f.li.querySelector(".fstate");
    st.textContent = "";
    var a = document.createElement("a");
    a.href = url;
    a.download = f.meta.name;
    a.textContent = "Download";
    a.className = "minilink";
    st.appendChild(a);
    f.li.setAttribute("data-state", "done");
    // try auto-download (browsers may block multiples — the link stays)
    try { a.click(); } catch (e) {}
  }

  function maybeFinishAll() {
    if (!allDoneMsg) return;
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
      " received (" + fmt(rTotalBytes) + "). Copies are also saved on this device below.", 100);
  }

  // ---------- on-device vault ----------
  // Finished files are kept in IndexedDB so a refresh (or a dead tab) never
  // loses them. Best-effort: quota or private mode just means no vault.
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
    vaultOpen().then(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction("files", "readwrite");
        tx.objectStore("files").add({
          name: meta.name, mime: meta.mime, size: meta.size,
          blob: blob, ts: Date.now()
        });
      } catch (e) {}
    });
  }
  function renderVault() {
    vaultOpen().then(function (db) {
      if (!db) return;
      try {
        var req = db.transaction("files", "readonly").objectStore("files").getAll();
        req.onsuccess = function () { paintVault(req.result || []); };
        req.onerror = function () {};
      } catch (e) {}
    });
  }
  function paintVault(items) {
    var sec = document.getElementById("vault");
    var ul = document.getElementById("vault-list");
    ul.innerHTML = "";
    if (!items.length) { sec.hidden = true; return; }
    items.sort(function (a, b) { return b.ts - a.ts; });
    items.forEach(function (it) {
      var li = document.createElement("li");
      li.innerHTML = '<span class="fname"></span> <span class="bytes"></span> <span class="fstate"></span>';
      li.querySelector(".fname").textContent = it.name;
      li.querySelector(".bytes").textContent = fmt(it.size);
      var a = document.createElement("a");
      a.href = URL.createObjectURL(it.blob);
      a.download = it.name;
      a.textContent = "Download";
      a.className = "minilink";
      li.querySelector(".fstate").appendChild(a);
      ul.appendChild(li);
    });
    sec.hidden = false;
  }
  document.getElementById("vault-clear").onclick = function () {
    vaultOpen().then(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction("files", "readwrite");
        tx.objectStore("files").clear();
        tx.oncomplete = renderVault;
      } catch (e) {}
    });
  };
  renderVault();

  // deep-link ?code=XXX → receive tab
  if (/[?&]code=/.test(location.search)) show("receive");
})();
