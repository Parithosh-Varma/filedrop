/* FileDrop — P2P bulk file transfer (Cloudflare Pages static-only).
 * Signaling: public PeerJS cloud. Data: WebRTC DataConnection (SCTP, reliable).
 * No backend, no storage. One code carries a queue of files, sent in order
 * over a single connection. Both peers must keep the tab open during transfer.
 */
(function () {
  "use strict";

  var CHUNK = 64 * 1024;
  var PREFIX = "filedrop-v1-";

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
  function setActive(v) { transferActive = v; }
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

  // ---------- SENDER ----------
  var dz = document.getElementById("dropzone");
  var fi = document.getElementById("file-input");
  var sendPanel = document.getElementById("send-panel");
  var sendPeer = null, sendConn = null, sendCancelled = false;
  var sendAlive = false, sendComplete = false, sendTotalBytes = 0, sendDoneBytes = 0;

  dz.addEventListener("dragover", function (e) { e.preventDefault(); dz.classList.add("over"); });
  dz.addEventListener("dragleave", function () { dz.classList.remove("over"); });
  dz.addEventListener("drop", function (e) {
    e.preventDefault(); dz.classList.remove("over");
    if (e.dataTransfer.files.length) startSend(e.dataTransfer.files);
  });
  fi.addEventListener("change", function () { if (fi.files.length) startSend(fi.files); });

  function cleanupSend() {
    sendCancelled = true;
    try { if (sendConn) sendConn.close(); } catch (e) {}
    try { if (sendPeer) sendPeer.destroy(); } catch (e) {}
    sendConn = null; sendPeer = null;
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
      sendConn = conn;
      sendAlive = true;
      document.getElementById("send-status").textContent = "Other side connected — sending…";
      document.getElementById("send-progress").classList.remove("busy");
      conn.on("open", function () { setActive(true); pokeLive("send"); pump(conn, files, rows); });
      conn.on("close", onSendDead);
      conn.on("error", onSendDead);
    });
  }

  // The other side is gone: freeze the pump where it stands. No fake 100%,
  // no spinning into the void. The code is deliberately kept so a reconnect
  // restarts the batch from zero on a fresh connection.
  function onSendDead() {
    if (sendComplete || sendCancelled || !sendAlive) return;
    sendAlive = false;
    setActive(false);
    // Math.round matches setSend's toFixed(0), so the number never jumps back.
    var pct = sendTotalBytes ? Math.round((sendDoneBytes / sendTotalBytes) * 100) : 0;
    setSend(pct, "Other side disconnected — transfer stopped at " + pct +
      "%. Ask them to tap Reconnect to restart the batch.");
    document.getElementById("send-progress").classList.remove("busy");
  }

  function safeSend(conn, msg) {
    try { conn.send(msg); return true; }
    catch (e) { onSendDead(); return false; }
  }

  function setSend(pct, msg) {
    document.getElementById("send-progress").value = pct;
    document.getElementById("send-pct").textContent = pct.toFixed(0) + "%";
    if (msg) document.getElementById("send-status").textContent = msg;
  }

  function metaMsg(f, idx, count) {
    return {
      t: "meta", fi: idx, fn: count,
      name: f.name, size: f.size,
      mime: f.type || "application/octet-stream",
      total: Math.max(1, Math.ceil(f.size / CHUNK))
    };
  }

  function pump(conn, files, rows) {
    var t0 = Date.now();
    var totalBytes = sendTotalBytes;
    var doneBytes = 0;
    sendDoneBytes = 0;
    var fi = 0, i = 0, total = metaMsg(files[0], 0, files.length).total;
    if (!safeSend(conn, metaMsg(files[0], 0, files.length))) return;
    setRow(rows[0], "sending");

    function speed() {
      var el = Math.max(0.1, (Date.now() - t0) / 1000);
      return fmt(doneBytes / el) + "/s";
    }
    function next() {
      if (sendCancelled || !sendAlive) return;
      if (i >= total) {
        if (!safeSend(conn, { t: "fdone" })) return;
        setRow(rows[fi], "sent");
        fi++;
        if (fi >= files.length) {
          if (!safeSend(conn, { t: "done" })) return;
          sendComplete = true;
          store.del("fd-code");
          setActive(false);
          var secs = Math.max(0.1, (Date.now() - t0) / 1000);
          setSend(100, "Sent " + plural(files.length, "file", "files") +
            " (" + fmt(totalBytes) + ") in " + secs.toFixed(1) + "s. You can close this tab.");
          return;
        }
        i = 0;
        total = metaMsg(files[fi], fi, files.length).total;
        if (!safeSend(conn, metaMsg(files[fi], fi, files.length))) return;
        setRow(rows[fi], "sending");
        setTimeout(next, 0);
        return;
      }
      // backpressure: don't buffer more than ~4MB
      if (conn.bufferSize > 4 * 1048576) { setTimeout(next, 120); return; }
      var file = files[fi];
      var blob = file.slice(i * CHUNK, (i + 1) * CHUNK);
      var rd = new FileReader();
      rd.onload = function () {
        if (sendCancelled || !sendAlive) return;
        if (!safeSend(conn, { t: "data", i: i, buf: rd.result })) return;
        doneBytes += rd.result.byteLength;
        sendDoneBytes = doneBytes;
        i++;
        pokeLive("send");
        var pct = totalBytes ? (doneBytes / totalBytes) * 100 : 100;
        setSend(pct, "Sending file " + (fi + 1) + " of " + files.length +
          " — " + fmt(doneBytes) + " / " + fmt(totalBytes) + " (" + speed() + ")");
        setTimeout(next, 0);
      };
      rd.onerror = function () {
        document.getElementById("send-status").textContent = "Could not read “" + file.name + "”.";
      };
      rd.readAsArrayBuffer(blob);
    }
    next();
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
  var recvPeer = null, recvConn = null;
  var rfiles = [], cur = -1, rTotalBytes = 0, rDoneBytes = 0, t0r = 0, rCount = 0;
  var lastCode = null;

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
    try { if (recvConn) recvConn.close(); } catch (e) {}
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

  function connectRecv(code) {
    try { if (recvPeer) recvPeer.destroy(); } catch (e) {}
    rfiles = []; cur = -1; rTotalBytes = 0; rDoneBytes = 0; rCount = 0; t0r = Date.now();
    lastCode = code;
    document.getElementById("receive-filelist").innerHTML = "";
    document.getElementById("receive-cancel").hidden = false;
    document.getElementById("receive-progress").classList.add("busy");
    setActive(true);
    setRecv("Connecting… look for the code turning live below.", 0);

    recvPeer = new Peer({ debug: 0 });
    recvPeer.on("open", function () {
      recvConn = recvPeer.connect(PREFIX + code, { reliable: true });
      recvConn.on("open", function () { setRecv("Connected — waiting for the first file…", 0); });
      recvConn.on("data", onData);
      recvConn.on("close", function () {
        document.getElementById("receive-progress").classList.remove("busy");
        var pending = rfiles.some(function (f) { return !f.complete; });
        if (cur < 0 || pending) {
          setActive(false);
          rfiles.forEach(function (f) {
            if (!f.complete) {
              f.li.querySelector(".fstate").textContent = "stopped";
              f.li.setAttribute("data-state", "stopped");
            }
          });
          setRecv("Sender left before everything arrived. Finished files are kept below — tap Reconnect to restart the batch.");
          document.getElementById("receive-reconnect").hidden = false;
        }
      });
      recvConn.on("error", function () { setRecv("Connection error."); });
    });
    recvPeer.on("error", function (err) {
      var t = (err && err.type) || "";
      if (t === "peer-unavailable") setRecv("Sender not found. Check the code — the sender tab must stay open.");
      else setRecv("Peer error: " + t);
    });
  }

  function recvRow(meta) {
    var li = document.createElement("li");
    li.innerHTML = '<span class="fname"></span> <span class="bytes"></span> <span class="fstate">receiving</span>';
    li.querySelector(".fname").textContent = meta.name;
    li.querySelector(".bytes").textContent = fmt(meta.size);
    li.setAttribute("data-state", "receiving");
    document.getElementById("receive-filelist").appendChild(li);
    return li;
  }

  function onData(d) {
    if (!d || !d.t) return;
    if (d.t === "meta") {
      rCount = d.fn;
      rTotalBytes += d.size;
      rfiles.push({ meta: d, chunks: new Array(d.total), got: 0, complete: false, li: recvRow(d) });
      cur = rfiles.length - 1;
      if (t0r === 0 || rfiles.length === 1) t0r = Date.now();
      document.getElementById("receive-progress").classList.remove("busy");
      pokeLive("receive");
      setRecv("Receiving file " + (cur + 1) + " of " + d.fn + " — “" + d.name + "”…", rTotalBytes ? (rDoneBytes / rTotalBytes) * 100 : 0);
    } else if (d.t === "data") {
      var f = rfiles[cur];
      if (!f || f.complete) return;
      f.chunks[d.i] = d.buf;
      f.got++;
      rDoneBytes += d.buf.byteLength;
      pokeLive("receive");
      var el = Math.max(0.1, (Date.now() - t0r) / 1000);
      setRecv("Receiving… " + fmt(Math.min(rTotalBytes, rDoneBytes)) + " / " + fmt(rTotalBytes) +
        " (" + fmt(rDoneBytes / el) + "/s)", rTotalBytes ? (rDoneBytes / rTotalBytes) * 100 : 100);
    } else if (d.t === "fdone") {
      finishFile(rfiles[cur]);
    } else if (d.t === "done") {
      finishAll();
    }
  }

  function finishFile(f) {
    if (!f || f.complete) return;
    f.complete = true;
    var blob = new Blob(f.chunks, { type: f.meta.mime });
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

  function finishAll() {
    document.getElementById("receive-cancel").hidden = true;
    document.getElementById("receive-reconnect").hidden = true;
    setActive(false);
    if (!rfiles.length) { setRecv("Transfer ended with nothing received."); return; }
    setRecv("Done — " + plural(rfiles.length, "file", "files") +
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
