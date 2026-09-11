/* FileDrop — P2P file transfer (Cloudflare Pages static-only).
 * Signaling: public PeerJS cloud. Data: WebRTC DataConnection (SCTP, reliable).
 * No backend, no storage. Both peers must keep the tab open during transfer.
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
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function code6() {
    var c = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    var s = "";
    for (var i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
    return s;
  }

  // ---------- SENDER ----------
  var dz = document.getElementById("dropzone");
  var fi = document.getElementById("file-input");
  var sendPanel = document.getElementById("send-panel");
  var sendPeer = null, sendConn = null, sendCancelled = false;

  dz.addEventListener("dragover", function (e) { e.preventDefault(); dz.classList.add("over"); });
  dz.addEventListener("dragleave", function () { dz.classList.remove("over"); });
  dz.addEventListener("drop", function (e) {
    e.preventDefault(); dz.classList.remove("over");
    if (e.dataTransfer.files.length) startSend(e.dataTransfer.files[0]);
  });
  fi.addEventListener("change", function () { if (fi.files.length) startSend(fi.files[0]); });

  function cleanupSend() {
    sendCancelled = true;
    try { if (sendConn) sendConn.close(); } catch (e) {}
    try { if (sendPeer) sendPeer.destroy(); } catch (e) {}
    sendConn = null; sendPeer = null;
  }
  document.getElementById("send-cancel").onclick = function () {
    cleanupSend();
    document.getElementById("send-status").textContent = "Cancelled.";
  };

  function startSend(file) {
    cleanupSend();
    sendCancelled = false;
    var code = code6();
    var peerId = PREFIX + code;
    document.getElementById("send-filename").textContent = file.name;
    document.getElementById("send-filesize").textContent = fmt(file.size);
    document.getElementById("share-code").textContent = code;
    var link = location.origin + location.pathname + "?code=" + code;
    // file:// or sandboxed preview has opaque origin — fall back to href base
    if (!/^https?:/.test(link)) link = location.href.split("?")[0] + "?code=" + code;
    document.getElementById("share-link").value = link;
    var qr = document.getElementById("share-qr");
    qr.src = "https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=" + encodeURIComponent(link);
    qr.hidden = false;
    sendPanel.hidden = false;
    setSend(0, "Waiting for receiver… share the code/link.");
    dz.style.display = "none";

    sendPeer = new Peer(peerId, { debug: 0 });
    sendPeer.on("error", function (err) {
      var t = (err && err.type) || "";
      if (t === "unavailable-id") {
        document.getElementById("send-status").textContent = "Code collision — pick the file again to retry.";
      } else {
        document.getElementById("send-status").textContent = "Peer error: " + t;
      }
    });
    sendPeer.on("connection", function (conn) {
      sendConn = conn;
      document.getElementById("send-status").textContent = "Receiver connected — sending…";
      conn.on("open", function () { pump(conn, file); });
      conn.on("error", function () {
        document.getElementById("send-status").textContent = "Connection lost.";
      });
    });
  }

  function setSend(pct, msg) {
    document.getElementById("send-progress").value = pct;
    document.getElementById("send-pct").textContent = pct.toFixed(0) + "%";
    if (msg) document.getElementById("send-status").textContent = msg;
  }

  function pump(conn, file) {
    var total = Math.max(1, Math.ceil(file.size / CHUNK));
    var t0 = Date.now();
    conn.send({ t: "meta", name: file.name, size: file.size, mime: file.type || "application/octet-stream", total: total });
    var i = 0;
    function next() {
      if (sendCancelled) return;
      if (i >= total) {
        conn.send({ t: "done" });
        var secs = Math.max(0.1, (Date.now() - t0) / 1000);
        setSend(100, "Sent " + fmt(file.size) + " in " + secs.toFixed(1) + "s (" + fmt(file.size / secs) + "/s). You can close this tab.");
        return;
      }
      // backpressure: don't buffer more than ~4MB
      if (conn.bufferSize > 4 * 1048576) { setTimeout(next, 120); return; }
      var blob = file.slice(i * CHUNK, (i + 1) * CHUNK);
      var rd = new FileReader();
      rd.onload = function () {
        if (sendCancelled) return;
        conn.send({ t: "data", i: i, buf: rd.result });
        i++;
        var pct = (i / total) * 100;
        var el = Math.max(0.1, (Date.now() - t0) / 1000);
        setSend(pct, "Sending… " + fmt(Math.min(file.size, i * CHUNK)) + " / " + fmt(file.size) + " (" + fmt((i * CHUNK) / el) + "/s)");
        setTimeout(next, 0);
      };
      rd.onerror = function () {
        document.getElementById("send-status").textContent = "Failed reading file.";
      };
      rd.readAsArrayBuffer(blob);
    }
    next();
  }

  function copyText(id) {
    var el = document.getElementById(id);
    var v = el.tagName === "INPUT" ? el.value : el.textContent;
    navigator.clipboard.writeText(v).catch(function () {
      el.select && el.select();
      document.execCommand("copy");
    });
  }
  document.getElementById("copy-code").onclick = function () { copyText("share-code"); };
  document.getElementById("copy-link").onclick = function () { copyText("share-link"); };

  // ---------- RECEIVER ----------
  var recvPeer = null, recvConn = null;
  var chunks = [], expected = 0, got = 0, meta = null, t0r = 0;

  document.getElementById("receive-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var code = document.getElementById("receive-code").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length < 4) { setRecv("Enter the 6-character code from the sender."); return; }
    connectRecv(code);
  });
  document.getElementById("receive-cancel").onclick = function () {
    try { if (recvConn) recvConn.close(); } catch (e) {}
    try { if (recvPeer) recvPeer.destroy(); } catch (e) {}
    setRecv("Cancelled.");
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
    chunks = []; expected = 0; got = 0; meta = null; t0r = Date.now();
    document.getElementById("download-link").hidden = true;
    document.getElementById("receive-cancel").hidden = false;
    setRecv("Connecting to sender…", 0);

    recvPeer = new Peer({ debug: 0 });
    recvPeer.on("open", function () {
      recvConn = recvPeer.connect(PREFIX + code, { reliable: true });
      recvConn.on("open", function () { setRecv("Connected — waiting for file…", 0); });
      recvConn.on("data", onData);
      recvConn.on("close", function () {
        if (!meta || got < expected) setRecv("Sender disconnected" + (meta ? " at " + got + "/" + expected + " chunks." : "."));
      });
      recvConn.on("error", function () { setRecv("Connection error."); });
    });
    recvPeer.on("error", function (err) {
      var t = (err && err.type) || "";
      if (t === "peer-unavailable") setRecv("Sender not found. Check the code — sender tab must stay open.");
      else setRecv("Peer error: " + t);
    });
    // timeout if sender never sends meta
    setTimeout(function () {
      if (!meta) { /* keep waiting, sender may connect later */ }
    }, 30000);
  }

  function onData(d) {
    if (!d || !d.t) return;
    if (d.t === "meta") {
      meta = d; expected = d.total; got = 0; chunks = new Array(expected);
      t0r = Date.now();
      setRecv("Receiving “" + d.name + "” (" + fmt(d.size) + ")…", 0);
    } else if (d.t === "data") {
      if (!meta) return;
      chunks[d.i] = d.buf;
      got++;
      var bytes = Math.min(meta.size, got * CHUNK);
      var el = Math.max(0.1, (Date.now() - t0r) / 1000);
      setRecv("Receiving… " + fmt(bytes) + " / " + fmt(meta.size) + " (" + fmt(bytes / el) + "/s)", (got / expected) * 100);
    } else if (d.t === "done") {
      finish();
    }
  }

  function finish() {
    document.getElementById("receive-cancel").hidden = true;
    if (!meta) { setRecv("Transfer ended with no file."); return; }
    var blob = new Blob(chunks, { type: meta.mime });
    var url = URL.createObjectURL(blob);
    var a = document.getElementById("download-link");
    a.href = url;
    a.download = meta.name;
    a.textContent = "⬇ Download " + meta.name + " (" + fmt(meta.size) + ")";
    a.hidden = false;
    setRecv("Done — " + meta.name + " (" + fmt(meta.size) + ").", 100);
    // try auto-download (may be blocked — link remains)
    try { a.click(); } catch (e) {}
  }

  // deep-link ?code=XXX → receive tab
  if (/[?&]code=/.test(location.search)) show("receive");
})();
