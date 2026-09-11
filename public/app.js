/* FileDrop — P2P bulk file transfer (Cloudflare Pages static-only).
 * Signaling: public PeerJS cloud. Data: parallel WebRTC DataConnections
 * (SCTP, reliable), raw-binary framed chunks with positional writes.
 * No backend, no storage. One code carries a queue of files, striped in
 * order across channels. Both peers must keep the tab open during transfer.
 *
 * Protocol v3 (prefix filedrop-v3-, 12-char codes). v2 6-char codes are
 * no longer accepted (30-bit space was enumerable).
 *  - control (JSON objects on first open channel): meta / fdone / done
 *  - ack (receiver -> sender, any channel): {t:"received"} once every byte
 *    is saved; the sender shows 100% only after it (99% + waiting until
 *    then), so "done" always means the other side actually has the files.
 *  - cancel (either direction, best-effort): {t:"cancelled"} ahead of
 *    teardown (250ms flush delay) so the far side can toast "stopped"
 *    instead of guessing a network drop; close-detection stays the fallback.
 *  - data (ArrayBuffer): [fi:uint16][i:uint32][payload...]
 *  - progress (receiver -> sender, ~4/s): {t:"progress", pct, done, total}
 *    so both tabs show the same number; the sender mirrors it while fresh
 *    (2s) and falls back to bytes-pushed estimates when stale. Capped at 99
 *    until receipt is confirmed, like everything else.
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
  var NUM_CHANNELS = 4;
  var PER_CONN_CAP = 2 * 1048576;
  var TOTAL_INFLIGHT_CAP = 8 * 1048576;
  var LOW_WATERMARK = 1 * 1048576;
  var PREFETCH = 4;
  var UI_MS = 150;

  // ---------- security limits ----------
  var CODE_LEN = 12;
  var CODE_TTL_MS = 30 * 60 * 1000; // sender code expires after 30 min
  // Product cap on file count (DoS bound: each file costs a DOM row plus
  // reassembly state). The u16 frame index is only a backstop below.
  var MAX_FILES = 50;
  // No index may exceed the 16-bit file index in the binary frame
  // ([fi:uint16]) — past 65535, indexes would collide.
  var MAX_FILE_INDEX = 65535;
  var MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GiB per file
  var MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB per batch
  var MAX_CHUNKS_PER_FILE = 16384; // 2 GiB / 128 KiB headroom
  var MIN_CHUNK = 1024;
  var MAX_CHUNK = 1024 * 1024;
  var MAX_PENDING_TOTAL = 2000; // chunks buffered before meta/writer ready
  var MAX_PENDING_PER_FILE = 500;
  var MAX_PENDING_BYTES = 32 * 1024 * 1024; // ...and never more than 32 MiB of them
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
    // Switching views while idle resets the abandoned view to pristine (never
    // mid-transfer). The vault is NOT wiped here — it persists up to 7 days
    // and is only cleared when a NEW transfer starts or the user clears it.
    if (!transferActive) {
      if (send) resetReceiveView();
      else resetSendView();
    }
    tabSend.classList.toggle("active", send);
    tabReceive.classList.toggle("active", !send);
    try {
      tabSend.setAttribute("aria-pressed", send ? "true" : "false");
      tabReceive.setAttribute("aria-pressed", !send ? "true" : "false");
    } catch (e) {}
    viewSend.hidden = !send;
    viewReceive.hidden = send;
    if (!send) {
      // Prefill the deep link, but never clobber something the user typed.
      var codeEl = document.getElementById("receive-code");
      if (codeEl && !codeEl.value) {
        var m = /[?&]code=([A-Za-z0-9]{6,16})/.exec(location.search);
        if (m) codeEl.value = m[1].toUpperCase().slice(0, 12);
      }
    }
  }
  tabSend.onclick = function () { show("send"); };
  tabReceive.onclick = function () { show("receive"); };

  // Pristine send view: tears down an idle finished/waiting batch (peer,
  // code, rows, share UI) so nothing stale lingers. Caller guards liveness.
  function resetSendView() {
    cleanupSend();
    if (sendStopTimer) { try { clearTimeout(sendStopTimer); } catch (e) {} sendStopTimer = null; }
    store.del("fd-code");
    store.del("fd-code-ts");
    store.del("fd-code-fp");
    setActive(false);
    try { revokeBlobUrlsIn(document.getElementById("send-filelist")); } catch (e) {}
    document.getElementById("send-filelist").innerHTML = "";
    document.getElementById("send-filecount").textContent = "";
    document.getElementById("send-filesize").textContent = "";
    document.getElementById("share-code").textContent = "—";
    document.getElementById("share-link").value = "";
    var qr = document.getElementById("share-qr");
    qr.removeAttribute("src");
    qr.hidden = true;
    document.getElementById("send-progress").classList.remove("busy");
    document.getElementById("send-progress").value = 0;
    document.getElementById("send-pct").textContent = "0%";
    document.getElementById("send-status").textContent = "";
    document.getElementById("send-again").hidden = true;
    try { fi.value = ""; } catch (e) {}
    sendPanel.hidden = true;
    dz.style.display = "";
  }

  // Pristine receive view: tears down an idle finished/stopped batch. Keeps
  // lastCode + the typed code so Reconnect/Connect still work right after.
  function resetReceiveView() {
    try { if (recvPeer) recvPeer.destroy(); } catch (e) {}
    hideSas();
    recvGen++;
    try { cleanupRecvOpfs(); } catch (e) {}
    try { revokeBlobUrlsIn(document.getElementById("receive-filelist")); } catch (e) {}
    try { revokeBlobUrlsIn(document.getElementById("vault-list")); } catch (e) {}
    recvConns = [];
    rfiles = {}; rTotalBytes = 0; rDoneBytes = 0; rCount = 0;
    pendingBytes = 0;
    rGrandTotal = 0; lastProgSent = 0;
    recvAborted = false;
    recvCancelNoted = false;
    if (recvStopTimer) { try { clearTimeout(recvStopTimer); } catch (e) {} recvStopTimer = null; }
    recvSession = "";
    recvOpfsRoot = null; recvOpfsTried = false;
    allDoneMsg = false; firstMetaSeen = false; lastRecvUi = 0;
    setActive(false);
    document.getElementById("receive-filelist").innerHTML = "";
    document.getElementById("receive-status").textContent = "";
    var bar = document.getElementById("receive-progress");
    bar.classList.remove("busy");
    bar.value = 0;
    bar.hidden = true;
    try { document.getElementById("receive-progressline").hidden = true; } catch (e) {}
    document.getElementById("receive-pct").textContent = "";
    document.getElementById("receive-reconnect").hidden = true;
    document.getElementById("receive-cancel").hidden = true;
  }

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
        // Rejection sampling to avoid modulo bias (2^32 % 31 != 0).
        var limit = Math.floor(4294967296 / c.length) * c.length;
        var rnd = new Uint32Array(CODE_LEN * 2);
        window.crypto.getRandomValues(rnd);
        var ri = 0;
        while (s.length < CODE_LEN) {
          if (ri >= rnd.length) {
            rnd = new Uint32Array(CODE_LEN * 2);
            window.crypto.getRandomValues(rnd);
            ri = 0;
          }
          var v = rnd[ri++];
          if (v >= limit) continue;
          s += c[v % c.length];
        }
        return s;
      }
    } catch (e) {}
    // No predictable fallback: codes must be unguessable. Caller treats null
    // as a hard failure with a retry prompt.
    return null;
  }
  function prefixForCode(code) {
    // v3 only: 6-char v2 codes are no longer accepted (enumerable 30-bit
    // space). Kept as a function so call sites stay readable.
    return PREFIX_V3;
  }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  // Short authentication string: 6 digits from SHA-256(code|sender|receiver).
  // Both tabs derive the same value; users compare it over a second channel
  // (voice/video) to detect a signaling MITM. Async (WebCrypto) with a
  // deterministic FNV-1a fallback for very old browsers.
  var sasToken = 0;
  function fallbackSas6(input) {
    var h = 0x811c9dc5;
    for (var i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    var n = h % 1000000;
    return ("00" + Math.floor(n / 1000)).slice(-3) + "-" + ("00" + (n % 1000)).slice(-3);
  }
  function showSas(which, code, senderId, receiverId) {
    var my = ++sasToken;
    var el = document.getElementById(which === "send" ? "send-sas" : "receive-sas");
    if (!el) return;
    var input = code + "|" + senderId + "|" + receiverId;
    function paint(s) {
      if (my !== sasToken) return; // superseded (new transfer / cleanup)
      var c = el.querySelector(".sas-code");
      if (c) c.textContent = s;
      el.hidden = false;
    }
    try {
      if (window.crypto && crypto.subtle && crypto.subtle.digest && typeof TextEncoder !== "undefined") {
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)).then(function (buf) {
          var b = new Uint8Array(buf);
          var n = ((b[0] << 12) | (b[1] << 4) | (b[2] >> 4)) % 1000000;
          paint(("00" + Math.floor(n / 1000)).slice(-3) + "-" + ("00" + (n % 1000)).slice(-3));
        }).catch(function () { paint(fallbackSas6(input)); });
        return;
      }
    } catch (e) {}
    paint(fallbackSas6(input));
  }
  function hideSas() {
    sasToken++;
    try {
      document.getElementById("send-sas").hidden = true;
      document.getElementById("receive-sas").hidden = true;
    } catch (e) {}
  }
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

  // ---------- sender auto-zip ----------
  // Big or many-file batches go out as ONE STORE (uncompressed) .zip, so the
  // receiver clicks a single download instead of one per file (v3 has no
  // auto-download — every file costs an explicit click). STORE = no
  // compression pass; packing runs at disk speed after one CRC read pass.
  // The receiver needs no changes — it just gets a file ending in .zip.
  // Rule: 6+ files (any size) OR 2+ files totaling 1+ GiB. Single files
  // never zip (same click count plus an unzip step = pure loss).
  // Bounds: the zip is itself one file, so it must fit MAX_FILE_SIZE, the
  // zip32 32-bit fields, and the batch cap with room for container overhead.
  var ZIP_MIN_FILES = 6;
  var ZIP_MIN_BYTES = 1073741824; // 1 GiB total
  var ZIP32_MAX = 4294967295;
  var ZIP_HEADROOM = 65536;

  var _crcTable = null;
  function crc32Table() {
    if (_crcTable) return _crcTable;
    var t = new Uint32Array(256), c, i, j;
    for (i = 0; i < 256; i++) {
      c = i;
      for (j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    _crcTable = t;
    return t;
  }

  // Exact on-wire size + UTF-8 names (encoded once, reused by the facade).
  function zipPlan(files) {
    var enc = new TextEncoder();
    var names = files.map(function (f) { return enc.encode(String(f.name || "file")); });
    var size = 22; // end record
    for (var i = 0; i < files.length; i++) {
      var nl = names[i].length;
      size += 30 + nl + files[i].size; // local header + name + data
      size += 46 + nl;                 // central entry + name
    }
    return { names: names, size: size };
  }
  function zipShouldPack(files, total) {
    var many = files.length >= ZIP_MIN_FILES;
    var heavy = files.length >= 2 && total >= ZIP_MIN_BYTES;
    if (!many && !heavy) return null;
    if (files.length > MAX_FILE_INDEX) return null; // zip entry counts are u16
    var plan = zipPlan(files);
    if (plan.size > MAX_FILE_SIZE || plan.size > ZIP32_MAX) return null;
    if (plan.size + ZIP_HEADROOM > MAX_TOTAL_BYTES) return null;
    return plan;
  }

  // CRC read pass (chunked, async). Headers carry real CRC/sizes (no data
  // descriptors) for maximum unzip compatibility.
  function packZipFiles(files, statusEl, done) {
    var table = crc32Table();
    var crcs = new Array(files.length);
    var myGen = sendActiveGen;
    var fi = 0;
    function stale() { return sendCancelled || myGen !== sendGen || myGen !== sendActiveGen; }
    function nextFile() {
      if (stale()) return;
      if (fi >= files.length) { done(crcs); return; }
      var f = files[fi];
      statusEl.textContent = "Packing file " + (fi + 1) + " of " + files.length + " into one zip…";
      if (!f.size) { crcs[fi] = 0; fi++; setTimeout(nextFile, 0); return; }
      var crc = 0xFFFFFFFF, off = 0;
      (function stride() {
        if (stale()) return;
        var end = Math.min(off + 2097152, f.size);
        f.slice(off, end).arrayBuffer().then(function (buf) {
          if (stale()) return;
          var b = new Uint8Array(buf), i;
          for (i = 0; i < b.length; i++) crc = table[(crc ^ b[i]) & 0xFF] ^ (crc >>> 8);
          off = end;
          if (off < f.size) setTimeout(stride, 0);
          else { crcs[fi] = (crc ^ 0xFFFFFFFF) >>> 0; fi++; setTimeout(nextFile, 0); }
        }).catch(function () {
          if (stale()) return;
          cleanupSend();
          store.del("fd-code");
          store.del("fd-code-ts");
          store.del("fd-code-fp");
          setActive(false);
          statusEl.textContent = "Could not read “" + String(f.name || "file").slice(0, 80) + "” while packing. Drop the files again to retry.";
          try {
            sendPanel.hidden = true;
            dz.style.display = "";
          } catch (e) {}
        });
      })();
    }
    nextFile();
  }

  // Static-segment facade: quacks like a File ({name,size,type,slice}) so the
  // pump sends it untouched. Zero-copy: data segments reference the originals.
  function makeZipFacade(files, names, crcs, zipName, packedCount) {
    function field(n) { var b = new ArrayBuffer(n); return { b: b, v: new DataView(b) }; }
    var segs = [];
    var central = [];
    var offset = 0, i, nl;
    for (i = 0; i < files.length; i++) {
      nl = names[i].length;
      var lh = field(30), L = lh.v;
      L.setUint32(0, 0x04034b50, true);
      L.setUint16(4, 20, true);
      L.setUint16(6, 0x0800, true); // UTF-8 names
      L.setUint16(8, 0, true);      // STORE
      L.setUint16(10, 0, true);
      L.setUint16(12, 0, true);     // DOS time/date: 1980-01-01
      L.setUint32(14, crcs[i] >>> 0, true);
      L.setUint32(18, files[i].size, true);
      L.setUint32(22, files[i].size, true);
      L.setUint16(26, nl, true);
      L.setUint16(28, 0, true);
      segs.push({ blob: new Blob([lh.b]), size: 30 });
      segs.push({ blob: new Blob([names[i]]), size: nl });
      segs.push({ blob: files[i], size: files[i].size });
      var ch = field(46), C = ch.v;
      C.setUint32(0, 0x02014b50, true);
      C.setUint16(4, 20, true);
      C.setUint16(6, 20, true);
      C.setUint16(8, 0x0800, true);
      C.setUint16(10, 0, true);
      C.setUint16(12, 0, true);
      C.setUint32(16, crcs[i] >>> 0, true);
      C.setUint32(20, files[i].size, true);
      C.setUint32(24, files[i].size, true);
      C.setUint16(28, nl, true);
      C.setUint16(30, 0, true);
      C.setUint16(32, 0, true);
      C.setUint16(34, 0, true);
      C.setUint16(36, 0, true);
      C.setUint32(38, 0, true);
      C.setUint32(42, offset, true);
      central.push({ blob: new Blob([ch.b]), size: 46 });
      central.push({ blob: new Blob([names[i]]), size: nl });
      offset += 30 + nl + files[i].size;
    }
    var cdSize = 0, k;
    for (k = 0; k < central.length; k++) cdSize += central[k].size;
    var er = field(22), E = er.v;
    E.setUint32(0, 0x06054b50, true);
    E.setUint16(4, 0, true);
    E.setUint16(6, 0, true);
    E.setUint16(8, files.length, true);
    E.setUint16(10, files.length, true);
    E.setUint32(12, cdSize, true);
    E.setUint32(16, offset, true);
    E.setUint16(20, 0, true);
    var all = segs.concat(central);
    all.push({ blob: new Blob([er.b]), size: 22 });
    var totalSize = offset + cdSize + 22;
    function sliceRange(s, e) {
      s = Math.max(0, s);
      e = Math.min(totalSize, e == null ? totalSize : e);
      var parts = [], pos = 0, j, seg, a, b;
      for (j = 0; j < all.length && pos < e; j++) {
        seg = all[j];
        a = Math.max(s - pos, 0);
        b = Math.min(e - pos, seg.size);
        if (b > a) parts.push(seg.blob.slice(a, b));
        pos += seg.size;
      }
      return new Blob(parts, { type: "application/zip" });
    }
    return {
      name: zipName, type: "application/zip", size: totalSize, packedCount: packedCount,
      slice: function (s, e) { return sliceRange(s, e); }
    };
  }

  // ---------- shared conn helpers ----------
  // Inflight accounting in BYTES. PeerJS conn.bufferSize counts queued
  // MESSAGES (vendored peerjs eK: _bufferSize = _buffer.length), while every
  // cap here is bytes — comparing the two disables backpressure entirely.
  // So: SCTP bufferedAmount first, plus any bytes still sitting in PeerJS's
  // internal (pre-flush) queue; the message count is only a last-resort
  // estimate via the known payload size.
  function connBuffered(c) {
    var bytes = 0;
    try {
      if (c && c.dataChannel && typeof c.dataChannel.bufferedAmount === "number") {
        bytes += c.dataChannel.bufferedAmount;
      }
    } catch (e) {}
    try {
      var q = c && c._buffer;
      if (q && q.length) {
        for (var i = 0; i < q.length; i++) {
          var m = q[i];
          if (m && typeof m.byteLength === "number") bytes += m.byteLength;
          else bytes += 1024;
        }
      }
    } catch (e) {}
    if (!bytes) {
      try {
        if (c && typeof c.bufferSize === "number" && c.bufferSize > 0) {
          bytes = c.bufferSize * (lastPayload || DEFAULT_PAYLOAD);
        }
      } catch (e) {}
    }
    return bytes;
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
        var room = m - 2048 - HEADER;
        // Tiny SCTP ceiling (old stacks): stay strictly under it instead of
        // flooring up past it, which would make every send throw.
        if (room < 16 * 1024) return Math.max(1024, room);
        return Math.min(MAX_PAYLOAD, room);
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

  // ---------- favicon signal (red→blue gradient tile while a transfer is live) ----------
  // Shows a red-to-blue gradient version of the mark so a transfer in progress
  // is visible even when the tab is backgrounded. Restores the original icon
  // when done.
  var faviconLink = document.querySelector('link[rel="icon"]');
  var faviconHrefOrig = faviconLink ? faviconLink.href : "";
  function paintFaviconBusy() {
    try {
      var c = document.createElement("canvas");
      c.width = 64; c.height = 64;
      var g = c.getContext("2d");
      if (!g || !faviconLink) return;
      var grad = g.createLinearGradient(0, 0, 64, 64);
      grad.addColorStop(0, "#d43d2a");
      grad.addColorStop(1, "#2456c8");
      g.clearRect(0, 0, 64, 64);
      g.fillStyle = grad;
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
      // hollow cutout (same gradient, aligned to canvas space)
      g.fillStyle = grad;
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
    if (!faviconLink) return;
    paintFaviconBusy();
  }
  function stopFaviconStrobe() {
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

  // ---------- toast notifications ----------
  // Stacked, auto-dismissing, theme-matched. Used when the FAR side stops
  // the transfer (explicit {t:"cancelled"}), so the event is unmissable even
  // if the inline status scrolled out of view. Vanilla + CSS only: works
  // even if the animation libs fail to load.
  var lastToastAt = {};
  function toast(msg, kind) {
    try {
      var box = document.getElementById("toasts");
      if (!box) return;
      // Throttle identical flood (e.g. repeated {t:"cancelled"} spam): one
      // per message per 3s so legit warnings are never evicted.
      var now = Date.now();
      if (lastToastAt[msg] && now - lastToastAt[msg] < 3000) return;
      lastToastAt[msg] = now;
      while (box.children.length >= 3) box.removeChild(box.firstChild);
      var t = document.createElement("div");
      t.className = "toast " + (kind || "info");
      // Parent #toasts is aria-live=polite; no nested role to avoid double
      // screen-reader announcements.
      if (window.FDIcon) t.appendChild(window.FDIcon.el(kind === "warn" ? "warn" : "info"));
      var s = document.createElement("span");
      s.textContent = msg;
      t.appendChild(s);
      var gone = false;
      function dismiss() {
        if (gone) return;
        gone = true;
        try { t.classList.add("leaving"); } catch (e0) {}
        setTimeout(function () { try { if (t.parentNode) t.parentNode.removeChild(t); } catch (e1) {} }, 260);
      }
      var x = document.createElement("button");
      x.type = "button";
      x.className = "toast-x";
      x.setAttribute("aria-label", "Dismiss notification");
      x.textContent = "×";
      x.onclick = function () { dismiss(); };
      t.appendChild(x);
      box.appendChild(t);
      setTimeout(dismiss, 6500);
    } catch (e) {}
  }

  // Sender-side cap violation: toast it (unmissable) + inline error state in
  // the send view. Never the share ticket (no code exists) and never hide the
  // dropzone — the fix is "drop fewer files", one step away.
  function rejectBatch(msg) {
    toast(msg, "warn");
    setActive(false);
    var err = document.getElementById("send-error");
    if (err) { err.textContent = msg; err.hidden = false; }
    sendPanel.hidden = true;
    dz.style.display = "";
  }

  // ---------- SENDER ----------
  var dz = document.getElementById("dropzone");
  var fi = document.getElementById("file-input");
  var sendPanel = document.getElementById("send-panel");
  var sendPeer = null, sendConns = [], sendCancelled = false;
  var sendAlive = false, sendComplete = false, sendTotalBytes = 0, sendDoneBytes = 0;
  var pumpStarted = false;
  // Last negotiated data payload size: only used to interpret PeerJS's
  // message-count bufferSize when no byte counters are visible (tests).
  var lastPayload = 0;
  // Receiver mirror: its {t:"progress"} reports (pct/done/total + arrival
  // time). While fresh, the sender displays these so both tabs show the
  // same number; stale (>2s) falls back to bytes-pushed estimates.
  var mirPct = -1, mirAt = 0, mirDone = 0, mirTotal = 0;
  // sendComplete = all bytes pushed + {t:"done"} flushed. sendAcked = the
  // receiver confirmed every byte saved (its {t:"received"}). 100% requires
  // BOTH; until the ack the UI parks at 99% + "waiting".
  var sendAcked = false, sendAckTimer = null, sendT0 = 0;
  var sendStopTimer = null;
  var sendOwnerPeer = null;
  var sendExpiryTimer = null;
  // Generation guard: every startSend/cleanup bumps sendGen; pending async
  // pack/pump continuations capture their generation and bail when stale, so
  // a rapid re-drop cannot send old files on the new batch's connections.
  var sendGen = 0;
  var sendActiveGen = 0;

  dz.addEventListener("dragover", function (e) { e.preventDefault(); dz.classList.add("over"); });
  dz.addEventListener("dragleave", function () { dz.classList.remove("over"); });
  dz.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); try { fi.click(); } catch (err) {} }
  });
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
    sendGen++;
    hideSas();
    pumpStarted = false;
    sendOwnerPeer = null;
    sendAcked = false;
    mirPct = -1; mirAt = 0; mirDone = 0; mirTotal = 0;
    clearSendAckTimer();
    clearSendExpiry();
    if (sendStopTimer) { try { clearTimeout(sendStopTimer); } catch (e) {} sendStopTimer = null; }
    try {
      for (var i = 0; i < sendConns.length; i++) { try { sendConns[i].close(); } catch (e) {} }
    } catch (e) {}
    try { if (sendPeer) sendPeer.destroy(); } catch (e) {}
    sendConns = []; sendPeer = null;
  }
  document.getElementById("send-cancel").onclick = function () {
    // Best-effort heads-up so the receiver toasts "stopped" instead of
    // guessing a network drop. Brief delay lets the reliable channel flush
    // it before teardown (cleanupSend cancels the timer on re-drop).
    try { ctrlSend({ t: "cancelled" }); } catch (e) {}
    if (sendStopTimer) { try { clearTimeout(sendStopTimer); } catch (e2) {} }
    sendStopTimer = setTimeout(function () {
      sendStopTimer = null;
      cleanupSend();
      store.del("fd-code");
      store.del("fd-code-ts");
      store.del("fd-code-fp");
      setActive(false);
      document.getElementById("send-status").textContent = "Stopped. Code discarded.";
    }, 250);
  };

  function validStoredCode(c, ts) {
    if (!c || !/^[A-Z0-9]{12}$/.test(c)) return null;
    var age = Date.now() - (Number(ts) || 0);
    if (!(age >= 0 && age < CODE_TTL_MS)) return null;
    return c;
  }

  function batchFingerprint(files) {
    try {
      return files.length + "|" + files.map(function (f) {
        return String(f.name || "file") + "|" + (f.size || 0);
      }).join(";").slice(0, 2048);
    } catch (e) { return ""; }
  }

  function armSendExpiry() {
    clearSendExpiry();
    sendExpiryTimer = setTimeout(function () {
      if (sendComplete || sendCancelled) return;
      cleanupSend();
      store.del("fd-code");
      store.del("fd-code-ts");
      store.del("fd-code-fp");
      setActive(false);
      setSend(0, "Code expired after 30 minutes. Drop the files again for a fresh code.");
    }, CODE_TTL_MS);
  }

  function startSend(fileList) {
    cleanupSend();
    try { document.getElementById("send-error").hidden = true; } catch (e) {}
    sendCancelled = false;
    sendAlive = false;
    sendComplete = false;
    sendDoneBytes = 0;
    mirPct = -1; mirAt = 0; mirDone = 0; mirTotal = 0;
    sendAcked = false;
    clearSendAckTimer();
    sendT0 = Date.now();
    var files = Array.prototype.slice.call(fileList);
    // Smallest-first: cheap wins land early, and a mid-batch drop leaves the
    // most files complete. Stable sort keeps drop order within equal sizes.
    files.sort(function (a, b) { return (a.size || 0) - (b.size || 0); });
    // Sender-side caps (fail fast, before allocating a peer).
    if (!files.length) return;
    if (files.length > MAX_FILES) {
      rejectBatch("Too many files (max " + MAX_FILES + "). Send in smaller batches.");
      return;
    }
    var total = 0;
    for (var vi = 0; vi < files.length; vi++) {
      var vf = files[vi];
      if (typeof vf.size !== "number" || !Number.isFinite(vf.size) || Math.floor(vf.size) !== vf.size || vf.size < 0 || vf.size > MAX_FILE_SIZE) {
        rejectBatch("“" + (vf.name || "file") + "” is too large (max " + fmt(MAX_FILE_SIZE) + " per file).");
        return;
      }
      if (String(vf.name || "").length > 512) {
        rejectBatch("File names must be shorter than 512 characters.");
        return;
      }
      total += vf.size;
      if (total > MAX_TOTAL_BYTES) {
        rejectBatch("Batch too large (max " + fmt(MAX_TOTAL_BYTES) + " total). Send fewer files.");
        return;
      }
    }
    // Reuse the tab's code only when the same files are re-dropped after a
    // reload (same fingerprint) and it is still fresh — otherwise mint fresh
    // so a new batch never inherits the previous batch's code. Reuse keeps
    // the original expiry; minting starts a new 30-min window immediately so
    // zip packing time is covered.
    var fp = batchFingerprint(files);
    var stored = validStoredCode(store.get("fd-code"), store.get("fd-code-ts"));
    var code;
    if (stored && store.get("fd-code-fp") === fp) {
      code = stored;
    } else {
      code = makeCode();
      if (!code) {
        setActive(false);
        rejectBatch("Could not generate a secure code (crypto unavailable). Reload over HTTPS and try again.");
        return;
      }
      store.set("fd-code", code);
      store.set("fd-code-ts", String(Date.now()));
      store.set("fd-code-fp", fp);
    }
    sendTotalBytes = total;
    var peerId = PREFIX_V3 + code;
    sendActiveGen = sendGen;
    armSendExpiry();

    // New batch = clean slate (only when nothing is live): drop the vault
    // and any stale receive list from a previous transfer.
    if (!transferActive) {
      clearHistory();
      document.getElementById("receive-filelist").innerHTML = "";
      document.getElementById("receive-reconnect").hidden = true;
      document.getElementById("receive-cancel").hidden = true;
    }

    // Large batches go out as one zip (receiver just sees a single .zip).
    var zipPlan = zipShouldPack(files, total);
    if (zipPlan) { startZippedSend(files, zipPlan, code, peerId); return; }
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
        if (window.FDIcon) w.appendChild(window.FDIcon.el("warn"));
        w.appendChild(document.createTextNode(kind + " — receiver will be warned"));
        li.appendChild(w);
      }
      return li;
    });

    shareSendUi(code);
    startPeer(files, rows, code, peerId);
  }

  function shareSendUi(code) {
    document.getElementById("share-code").textContent = code;
    var link = location.origin + location.pathname + "?code=" + code;
    // file:// or sandboxed preview has opaque origin — fall back to href base
    if (!/^https?:/.test(link)) link = location.href.split("?")[0] + "?code=" + code;
    document.getElementById("share-link").value = link;
    // QR scans auto-start (&auto=1); the copied link stays manual.
    renderQrLocal(link + "&auto=1");
    sendPanel.hidden = false;
    // Mark active while the code is live so closing/packing warns via
    // beforeunload and tab switches don't wipe the waiting batch.
    setActive(true);
    setSend(0, "Waiting for the other side… share the code or link. Expires in 30 min.");
    document.getElementById("send-progress").classList.add("busy");
    dz.style.display = "none";
  }

  function startZippedSend(files, plan, code, peerId) {
    sendTotalBytes = plan.size;
    var zipName = "filedrop-" + code + ".zip";
    document.getElementById("send-filecount").textContent =
      plural(files.length, "file", "files") + " → 1 zip";
    document.getElementById("send-filesize").textContent = "(" + fmt(plan.size) + " zipped)";
    var ul = document.getElementById("send-filelist");
    ul.innerHTML = "";
    var li = document.createElement("li");
    var s1 = document.createElement("span"); s1.className = "fname";
    var s2 = document.createElement("span"); s2.className = "bytes";
    var s3 = document.createElement("span"); s3.className = "fstate"; s3.textContent = "packing…";
    s1.textContent = zipName;
    s2.textContent = fmt(plan.size);
    li.appendChild(s1); li.appendChild(document.createTextNode(" "));
    li.appendChild(s2); li.appendChild(document.createTextNode(" "));
    li.appendChild(s3);
    var kinds = {};
    files.forEach(function (f) { var k = riskyKind(f.name); if (k) kinds[k] = 1; });
    kinds = Object.keys(kinds);
    if (kinds.length) {
      var w = document.createElement("span"); w.className = "filewarn";
      if (window.FDIcon) w.appendChild(window.FDIcon.el("warn"));
      w.appendChild(document.createTextNode("contains " + kinds.join(", ") + " — packed, open the zip carefully"));
      li.appendChild(w);
    }
    ul.appendChild(li);
    // Share UI first so the other side can connect while we pack; expiry was
    // already armed at code creation so packing time is covered.
    shareSendUi(code);
    setSend(0, "Packing " + files.length + " files into one zip…");
    packZipFiles(files, document.getElementById("send-status"), function (crcs) {
      if (sendCancelled || sendGen !== sendActiveGen) return;
      s3.textContent = "queued";
      var facade = makeZipFacade(files, plan.names, crcs, zipName, files.length);
      startPeer([facade], [li], code, peerId);
    });
  }

  function startPeer(sendFiles, rows, code, peerId) {
    // Expiry was armed at code creation (covers packing). Do not re-arm here
    // or a collision path would extend the window for a code that never lived.
    if (!sendExpiryTimer) armSendExpiry();

    if (typeof Peer === "undefined") {
      setActive(false);
      document.getElementById("send-status").textContent = "Could not start: networking library failed to load. Reload the page and try again.";
      return;
    }
    sendPeer = new Peer(peerId, { debug: 0 });
    sendPeer.on("error", function (err) {
      var t = (err && err.type) || "";
      if (t === "unavailable-id") {
        // Drop the colliding code so the next drop mints fresh instead of
        // deterministically retrying the same peerId. Generic message: do not
        // reveal whether the code exists (code-enumeration oracle).
        store.del("fd-code");
        store.del("fd-code-ts");
        store.del("fd-code-fp");
        document.getElementById("send-status").textContent = "Could not start — drop the files again to retry.";
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
      if (!peer) {
        try { conn.close(); } catch (e) {}
        return;
      }
      if (sendOwnerPeer && peer !== sendOwnerPeer) {
        try { conn.close(); } catch (e) {}
        return;
      }
      if (!sendOwnerPeer) sendOwnerPeer = peer;
      // SAS for MITM detection: both sides derive it from the same triple.
      if (peer && sendOwnerPeer) {
        try { showSas("send", code, peerId, sendOwnerPeer); } catch (e) {}
      }
      sendConns.push(conn);
      try {
        if (conn.dataChannel) conn.dataChannel.bufferedAmountLowThreshold = LOW_WATERMARK;
      } catch (e) {}
      sendAlive = true;
      // A fresh connection after a clean finish means "send it all again".
      if (sendComplete) { sendComplete = false; pumpStarted = false;     sendAcked = false;
    mirPct = -1; mirAt = 0; mirDone = 0; mirTotal = 0;
    clearSendAckTimer();
    if (sendStopTimer) { try { clearTimeout(sendStopTimer); } catch (e0) {} sendStopTimer = null; } }
      document.getElementById("send-status").textContent = "Other side connected — sending…";
      document.getElementById("send-progress").classList.remove("busy");
      conn.on("open", function () { maybeStartPump(sendFiles, rows); });
      // Only the bound owner may steer the sender (received/cancelled/progress).
      // PeerJS data callbacks carry no conn handle, so bind the check here.
      (function (ownerAtAccept, c) {
        c.on("data", function (d) {
          if (ownerAtAccept !== sendOwnerPeer) return;
          onSendData(d);
        });
      })(peer, conn);
      conn.on("close", onSendDead);
      conn.on("error", onSendDead);
      // Some PeerJS versions deliver 'connection' already open.
      if (connOpen(conn)) maybeStartPump(sendFiles, rows);
    });
  }

  function maybeStartPump(files, rows) {
    if (pumpStarted || sendCancelled) return;
    if (!openSendConns().length) return;
    pumpStarted = true;
    setActive(true);
    pokeLive("send");
    pump(files, rows).catch(function (err) {
      // Allow a later fresh connection to restart; otherwise the receiver
      // waits forever after a local read failure.
      pumpStarted = false;
      if (sendCancelled) { setActive(false); return; }
      if (sendAlive) {
        // Local read failure: name it on both tabs (far side would otherwise
        // hang at its last number) and restore the send view for retry.
        abortBatchLocally("Send failed: " + String((err && err.message) || err).slice(0, 120));
      } else {
        // A disconnect already named it via onSendDead; just release the guard.
        setActive(false);
      }
    });
  }

  // The other side is gone: freeze the pump where it stands. No fake 100%,
  // no spinning into the void. The code is deliberately kept so a reconnect
  // restarts the batch from zero on a fresh connection.
  function onSendDead() {
    if (openSendConns().length) return; // other channels still alive
    if (sendAcked || sendCancelled || !sendAlive) return;
    sendAlive = false;
    pumpStarted = false; // a later fresh connection restarts the pump from zero
    sendOwnerPeer = null; // release binding so the same receiver can reconnect
    setActive(false);
    hideSas();
    document.getElementById("send-progress").classList.remove("busy");
    if (sendComplete && !sendAcked) {
      // Everything was pushed but receipt was never confirmed.
      clearSendAckTimer();
      setSend(99, "The other side disconnected before confirming receipt — ask them to tap Reconnect to restart the batch.");
      return;
    }
    // Math.round matches setSend's toFixed(0), so the number never jumps back.
    var pct = sendTotalBytes ? Math.round((sendDoneBytes / sendTotalBytes) * 100) : 0;
    setSend(pct, "Other side disconnected — transfer stopped at " + pct +
      "%. Ask them to tap Reconnect to restart the batch.");
  }

  // Local abort with a name: tell the far side (best-effort, so it toasts
  // instead of hanging), tear down, and restore the send view for retry.
  function abortBatchLocally(msg) {
    try { ctrlSend({ t: "cancelled" }); } catch (e) {}
    cleanupSend();
    store.del("fd-code");
    store.del("fd-code-ts");
    store.del("fd-code-fp");
    setActive(false);
    document.getElementById("send-progress").classList.remove("busy");
    document.getElementById("send-status").textContent = msg;
    sendPanel.hidden = true;
    dz.style.display = "";
  }
  // Control messages go on the first open channel that takes them. A single
  // channel can die between open-check and send (PeerJS drops its unsent
  // queue on close), so retry across the rest before declaring the batch
  // dead — otherwise one flaky channel stalls everything with no message.
  function ctrlSend(msg) {
    var cons = openSendConns();
    if (!cons.length) { onSendDead(); return false; }
    for (var i = 0; i < cons.length; i++) {
      try { cons[i].send(msg); return true; }
      catch (e) {}
    }
    onSendDead();
    return false;
  }

  function setSend(pct, msg) {
    document.getElementById("send-progress").value = pct;
    document.getElementById("send-pct").textContent = pct.toFixed(0) + "%";
    if (msg) document.getElementById("send-status").textContent = msg;
  }

  function clearSendAckTimer() {
    if (sendAckTimer) { try { clearTimeout(sendAckTimer); } catch (e) {} sendAckTimer = null; }
  }
  // The receiver confirmed every byte landed AND was saved to disk/blob.
  // Only now is 100% honest: before this, megabytes can still sit in SCTP
  // send buffers plus the receiver's OPFS seal. Old receivers never send
  // this message; the timer in waitForRecvAck keeps the UI honest (99% +
  // waiting) instead of hanging silently for them.
  function onRecvAck() {
    if (sendAcked || sendCancelled) return;
    sendAcked = true;
    clearSendAckTimer();
    // Only now is the code truly spent: deleting it at push-complete meant a
    // receiver drop between done-flush and ack plus a sender reload lost the
    // code the 99%-message still promises for Reconnect.
    store.del("fd-code");
    store.del("fd-code-ts");
    store.del("fd-code-fp");
    setActive(false);
    var secs = Math.max(0.1, (Date.now() - (sendT0 || Date.now())) / 1000);
    setSend(100, "The other side confirmed receipt (" + fmt(sendTotalBytes) + " in " +
      secs.toFixed(1) + "s). You can close this tab.");
    // Graceful teardown: the batch is durably saved on the far side, so
    // release signaling + DataConnections without touching the 100% UI.
    try {
      setTimeout(function () {
        try {
          for (var i = 0; i < sendConns.length; i++) { try { sendConns[i].close(); } catch (e) {} }
        } catch (e) {}
        try { if (sendPeer) sendPeer.destroy(); } catch (e) {}
        sendConns = []; sendPeer = null;
        sendOwnerPeer = null;
      }, 2000);
    } catch (e) {}
  }
  function waitForRecvAck() {
    clearSendAckTimer();
    // transferActive stays on: closing now can still strand in-flight bytes.
    setSend(99, "All bytes sent — waiting for the other side to finish saving…");
    sendAckTimer = setTimeout(function () {
      sendAckTimer = null;
      if (sendAcked || sendCancelled) return;
      if (!openSendConns().length) {
        setActive(false);
        setSend(99, "Sent everything, but the other side left before confirming. Ask them to tap Reconnect to restart the batch.");
      } else {
        // One best-effort retransmit for a dropped {t:"done"}; old receivers
        // without an ack path still park honestly at 99%.
        try { ctrlSend({ t: "done" }); } catch (e) {}
        setSend(99, "Sent everything — still waiting for the other side's confirmation. If their tab is old, ask them whether it shows Done.");
      }
    }, 45000);
  }
  function onSendData(d) {
    if (!d || typeof d !== "object") return;
    if (d.t === "received") onRecvAck();
    else if (d.t === "cancelled") onRecvCancelled();
    else if (d.t === "progress") onRecvProgress(d);
  }

  // Display-only mirror of the receiver's number. Never aborts or steers
  // the pump — garbage is silently ignored, staleness falls back inside ui().
  function onRecvProgress(d) {
    if (!Number.isFinite(d.done) || d.done < 0) return;
    if (!Number.isFinite(d.total) || d.total < 0) return;
    if (d.total > MAX_TOTAL_BYTES + MAX_BIN_SLOP) return;
    if (d.done > d.total + MAX_BIN_SLOP) return;
    if (d.done > sendTotalBytes + MAX_TOTAL_BYTES + MAX_BIN_SLOP) return;
    // Total should never exceed this batch's own total (old receivers report
    // accumulated metas early, which is <= final; new ones report tb).
    if (sendTotalBytes && d.total > sendTotalBytes + MAX_BIN_SLOP) return;
    // Recompute pct locally instead of trusting the reported value.
    var pct = d.total ? (d.done / d.total) * 100 : 0;
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return;
    mirPct = pct; mirDone = d.done; mirTotal = d.total; mirAt = Date.now();
  }

  // The receiver pressed Stop: freeze honestly like a disconnect, but name
  // it and toast it. Pump checkpoints on sendAlive and exits quietly; the
  // closing conns then hit onSendDead, which returns early via !sendAlive.
  function onRecvCancelled() {
    if (sendAcked || sendCancelled || !sendAlive) return;
    sendAlive = false;
    pumpStarted = false;
    setActive(false);
    hideSas();
    clearSendAckTimer();
    document.getElementById("send-progress").classList.remove("busy");
    var pct = sendTotalBytes ? Math.round((sendDoneBytes / sendTotalBytes) * 100) : 0;
    setSend(pct, "The other side stopped the transfer at " + pct + "%.");
    toast("Receiver stopped the transfer", "warn");
  }

  function metaMsg(f, idx, count, payload, total) {
    return {
      t: "meta", fi: idx, fn: count,
      name: String(f.name || "file").slice(0, MAX_NAME_LEN), size: f.size,
      mime: String(f.type || "application/octet-stream").slice(0, MAX_MIME_LEN),
      total: total, chunk: payload, tb: sendTotalBytes, v: 3
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
    var myGen = sendActiveGen;
    var payload = negotiatePayload(openSendConns());
    lastPayload = payload;
    var totals = files.map(function (f) { return Math.max(1, Math.ceil(f.size / payload)); });
    // Fail fast on a doomed batch: the receiver caps chunks per file, and
    // without this we'd stream megabytes it must abort on.
    for (var vi = 0; vi < totals.length; vi++) {
      if (totals[vi] > MAX_CHUNKS_PER_FILE) {
        abortBatchLocally("“" + String(files[vi].name || "file").slice(0, 80) +
          "” would need " + totals[vi] + " chunks (max " + MAX_CHUNKS_PER_FILE + "). Split it up.");
        return;
      }
    }
    var sentPerFile = files.map(function () { return 0; });
    var fdoneSent = files.map(function () { return false; });
    var doneBytes = 0;
    sendDoneBytes = 0;
    var sendFailCount = 0;
    var queue = [];
    var rfi = 0, rdi = 0, eof = false;
    var lastUi = 0;
    function genStale() { return myGen !== sendGen || myGen !== sendActiveGen || sendCancelled; }

    function speed() {
      var el = Math.max(0.1, (Date.now() - t0) / 1000);
      return fmt(doneBytes / el) + "/s";
    }
    function ui(pct, msg, force) {
      var now = Date.now();
      // 100% is reserved for the receiver's confirmation (onRecvAck).
      if (!sendAcked && pct > 99) pct = 99;
      if (!force && now - lastUi < UI_MS && pct < 100) return;
      lastUi = now;
      pokeLive("send");
      // Same number on both tabs: mirror the receiver's stored/total while
      // its reports are fresh. 100% still waits for the ack (receiver caps
      // its own reports at 99 until everything truly landed).
      if (mirPct >= 0 && now - mirAt < 2000) {
        var dpct = (!sendAcked && mirPct > 99) ? 99 : mirPct;
        setSend(dpct, "Sending — " + fmt(mirDone) + " / " + fmt(mirTotal || totalBytes) +
          " (" + speed() + ")");
        return;
      }
      setSend(pct, msg);
    }
    async function readNext() {
      while (rfi < files.length) {
        if (genStale() || !sendAlive) return null;
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
        if (genStale()) return null;
        return { fi: fidx, i: idx, buf: buf };
      }
      return null;
    }

    // First file header goes out before any of its bytes.
    if (genStale() || !sendAlive) return;
    if (!ctrlSend(metaMsg(files[0], 0, files.length, payload, totals[0]))) return;
    setRow(rows[0], "sending");

    while (true) {
      while (queue.length < PREFETCH && !eof) {
        var nxt = await readNext();
        if (genStale() || !sendAlive) return;
        if (!nxt) { eof = true; break; }
        queue.push(nxt);
      }
      if (genStale()) return;
      if (!queue.length) break; // fully read and drained
      var cons = openSendConns();
      if (!cons.length) { onSendDead(); return; }
      while (!genStale() && sendAlive &&
             (inflightBytes() >= TOTAL_INFLIGHT_CAP ||
              !cons.some(function (c) { return connOpen(c) && connBuffered(c) < PER_CONN_CAP; }))) {
        await waitForCapacity();
        cons = openSendConns();
        if (!cons.length) { onSendDead(); return; }
      }
      if (genStale() || !sendAlive) return;
      cons.sort(function (a, b) { return connBuffered(a) - connBuffered(b); });
      var item = queue.shift();
      try {
        cons[0].send(frameChunk(item.fi, item.i, item.buf));
        sendFailCount = 0;
      } catch (e) {
        queue.unshift(item);
        sendFailCount = (sendFailCount || 0) + 1;
        // Persistent send errors (e.g. payload exceeds the remote
        // maxMessageSize) would otherwise spin forever on the 80ms timer.
        if (sendFailCount > 20 || !openSendConns().length) { onSendDead(); return; }
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

    if (genStale() || !sendAlive) return;
    if (!ctrlSend({ t: "done" })) return;
    sendComplete = true;
    clearSendExpiry();
    // Code is deleted only in onRecvAck: until the receipt lands, a receiver
    // drop + sender reload must still find this code for Reconnect.
    // Bytes may still sit in SCTP buffers and the receiver's OPFS seal, so
    // this parks at 99% + waiting: 100% waits for {t:"received"} (onRecvAck).
    // transferActive stays on so closing the tab now still warns.
    waitForRecvAck();
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
  var rGrandTotal = 0; // grand total from the sender's meta.tb (falls back to accumulated)
  var lastProgSent = 0; // throttle for {t:"progress"} mirror reports
  var lastCode = null;
  var recvSession = "", recvOpfsRoot = null, recvOpfsTried = false;
  // Receive epoch: bumped on every teardown/new session. Async continuations
  // (OPFS writes, seals, Blob conversions) capture their entry's gen and bail
  // when stale, so a reconnect/cancel can never corrupt the new session's
  // counters, rows, or vault.
  var recvGen = 0;
  var allDoneMsg = false, firstMetaSeen = false, lastRecvUi = 0;
  var recvAttempts = [];
  var recvAborted = false;
  var pendingBytes = 0; // bytes parked in per-file `pending` (pre-meta/writer)
  var recvCancelNoted = false, recvStopTimer = null;

  document.getElementById("receive-form").addEventListener("submit", function (e) {
    e.preventDefault();
    submitReceive();
  });
  function submitReceive() {
    var raw = document.getElementById("receive-code").value.trim();
    // Accept a pasted share link (…?code=XXXX) as well as a bare code.
    var m = /[?&]code=([A-Za-z0-9]{6,16})/.exec(raw);
    var code = (m ? m[1] : raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length > 12) { setRecv("That code is too long — enter the 12-character code (or paste the share link)."); return; }
    if (/^[A-Z0-9]{6,8}$/.test(code)) {
      setRecv("That looks like an old 6-character code, which is no longer supported. Ask the sender to re-share for a new 12-character code.");
      return;
    }
    if (!/^[A-Z0-9]{12}$/.test(code)) { setRecv("Enter the 12-character code from the sender (or paste the full share link)."); return; }
    if (!checkRecvRateLimit()) return;
    document.getElementById("receive-reconnect").hidden = true;
    connectRecv(code);
  }
  document.getElementById("receive-reconnect").onclick = function () {
    if (lastCode) {
      if (!checkRecvRateLimit()) return;
      document.getElementById("receive-reconnect").hidden = true;
      connectRecv(lastCode);
    }
  };
  document.getElementById("receive-cancel").onclick = function () {
    // Best-effort heads-up so the sender toasts "stopped" instead of
    // guessing a network drop. Brief delay lets the reliable channels flush
    // it before teardown (guarded: a reconnect in between clears the timer).
    try {
      for (var i = 0; i < recvConns.length; i++) {
        try { if (recvConns[i] && recvConns[i].open) recvConns[i].send({ t: "cancelled" }); } catch (e2) {}
      }
    } catch (e) {}
    // Freeze this session now: late completions must not vault files or touch
    // counters after the user stopped. The epoch bump retires every pending
    // continuation even if it outlives the delayed teardown below.
    recvAborted = true;
    recvGen++;
    if (recvStopTimer) { try { clearTimeout(recvStopTimer); } catch (e3) {} }
    recvStopTimer = setTimeout(function () {
      recvStopTimer = null;
      try { cleanupRecvOpfs(); } catch (e6) {}
      try { for (var j = 0; j < recvConns.length; j++) recvConns[j].close(); } catch (e4) {}
      try { if (recvPeer) recvPeer.destroy(); } catch (e5) {}
      setActive(false);
      setRecv("Stopped.");
    }, 250);
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
    // Unhide wrapper directly too — do not rely solely on ui.js observer
    // (it may load late/fail, which previously left the bar invisible).
    try { document.getElementById("receive-progressline").hidden = false; } catch (e) {}
    bar.value = pct;
    document.getElementById("receive-pct").textContent = pct.toFixed(0) + "%";
  }

  function setRecvThrottled(msg, pct, force) {
    var now = Date.now();
    if (!force && now - lastRecvUi < UI_MS) return;
    lastRecvUi = now;
    if (pct < 100) pokeLive("receive");
    setRecv(msg, pct);
    reportProgress(false);
  }

  // Grand-total denominator: the sender's meta.tb when sane, else the
  // accumulated metas. Both sides divide by the same number, so the % matches.
  function recvDenom() {
    return rGrandTotal || rTotalBytes;
  }

  function recvCtrlSend(msg) {
    for (var i = 0; i < recvConns.length; i++) {
      try { if (recvConns[i] && recvConns[i].open) { recvConns[i].send(msg); return true; } } catch (e) {}
    }
    return false;
  }

  // Mirror our number to the sender (~4/s max). Capped at 99 until everything
  // truly landed; maybeFinishAll forces the final 100 just before {t:"received"}.
  function reportProgress(force) {
    if (recvAborted) return;
    var now = Date.now();
    if (!force && now - lastProgSent < 250) return;
    lastProgSent = now;
    var base = recvDenom();
    var raw = base ? (rDoneBytes / base) * 100 : 0;
    var pct = recvAllComplete() ? 100 : Math.min(raw, 99);
    recvCtrlSend({ t: "progress", pct: pct, done: rDoneBytes, total: base || 0 });
  }

  function recvAllComplete() {
    if (recvAborted || !allDoneMsg) return false;
    var keys = Object.keys(rfiles).filter(function (k) { return rfiles[k].meta; });
    if (rCount && keys.length !== rCount) return false;
    if (!keys.length) return false;
    for (var i = 0; i < keys.length; i++) {
      if (!rfiles[keys[i]].complete) return false;
    }
    return true;
  }

  function recvProgressMsg() {
    var el = Math.max(0.1, (Date.now() - t0r) / 1000);
    var base = recvDenom();
    var denom = Math.max(base, rDoneBytes, 1);
    // base only counts metas seen so far when tb is absent: finishing file 1
    // of 3 would otherwise flash a bogus 100%. Cap at 99 until truly landed.
    var raw = base ? (rDoneBytes / base) * 100 : 100;
    return {
      msg: "Receiving… " + fmt(Math.min(denom, rDoneBytes)) + " / " + fmt(base || rDoneBytes) +
        " (" + fmt(rDoneBytes / el) + "/s)",
      pct: (raw >= 100 && !recvAllComplete()) ? 99 : raw
    };
  }

  function connectRecv(code) {
    try { if (recvPeer) recvPeer.destroy(); } catch (e) {}
    hideSas();
    // New epoch first: any continuation from the previous session bails
    // instead of corrupting the counters/vault about to be reset below.
    recvGen++;
    // Drop previous session's partial OPFS temps + blob URLs before wiping
    // state, or every retry orphans fd-* files and leaks object URLs.
    try { cleanupRecvOpfs(); } catch (e) {}
    try { revokeBlobUrlsIn(document.getElementById("receive-filelist")); } catch (e) {}
    if (typeof Peer === "undefined") {
      setActive(false);
      setRecv("Could not start: networking library failed to load. Reload the page and try again.");
      return;
    }
    recvConns = [];
    rfiles = {}; rTotalBytes = 0; rDoneBytes = 0; rCount = 0; t0r = Date.now();
    pendingBytes = 0;
    // New code = new transfer = clean slate. Same-code reconnects keep the
    // vault ("finished files are kept below") — only the row list resets.
    if (code !== lastCode) clearHistory();
    lastCode = code;
    recvAborted = false;
    recvCancelNoted = false;
    if (recvStopTimer) { try { clearTimeout(recvStopTimer); } catch (e0) {} recvStopTimer = null; }
    recvSession = Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
    recvOpfsRoot = null; recvOpfsTried = false;
    rGrandTotal = 0; lastProgSent = 0;
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
      // SAS for MITM detection (sender shows the same value).
      try { showSas("receive", code, prefix + code, recvPeer.id); } catch (e) {}
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
    recvGen++;
    hideSas();
    cleanupRecvOpfs();
    try { for (var i = 0; i < recvConns.length; i++) { try { recvConns[i].close(); } catch (e) {} } } catch (e) {}
    try { if (recvPeer) recvPeer.destroy(); } catch (e) {}
    setActive(false);
    try { document.getElementById("receive-progress").classList.remove("busy"); } catch (e) {}
    setRecv(msg || "Transfer stopped: invalid data from sender.");
    try { document.getElementById("receive-reconnect").hidden = false; } catch (e) {}
  }

  // Honest-halt, multi-channel edition: only when every channel is down.
  // The sender pressed Stop: name it (vs. a network drop), toast it, and
  // remember it so the inevitable conn closes don't clobber the message
  // via onRecvDead (guarded there by recvCancelNoted).
  function onSenderCancelled() {
    if (recvAborted) return;
    recvCancelNoted = true;
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
      setRecv("Sender stopped sending. Finished files are kept below — tap Reconnect if they resume, or ask for a fresh code.");
      document.getElementById("receive-reconnect").hidden = false;
    }
    toast("Sender stopped sending", "warn");
  }

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
      if (!recvCancelNoted) {
        setRecv("Sender left before everything arrived. Finished files are kept below — tap Reconnect to restart the batch.");
      }
      document.getElementById("receive-reconnect").hidden = false;
    }
  }

  function pendingTotal() {
    var n = 0, keys = Object.keys(rfiles);
    for (var i = 0; i < keys.length; i++) n += Object.keys(rfiles[keys[i]].pending).length;
    return n;
  }

  // Receive epoch (see recvGen): stale-entry guard used by continuations.
  function entryLive(f) {
    return !!(f && f.gen === recvGen && !recvAborted && !f.complete);
  }
  function ensureEntry(fidx) {
    if (!Number.isFinite(fidx) || Math.floor(fidx) !== fidx || fidx < 0 || fidx > MAX_FILE_INDEX) {
      abortRecv("Transfer stopped: invalid file index from sender.");
      return null;
    }
    if (fidx >= MAX_FILES) {
      abortRecv("Transfer stopped: too many files (max " + MAX_FILES + ").");
      return null;
    }
    if (Object.keys(rfiles).length >= MAX_FILES && !rfiles[fidx]) {
      abortRecv("Transfer stopped: too many files (max " + MAX_FILES + ").");
      return null;
    }
    var f = rfiles[fidx];
    // Stale entry from a previous session (same index, old epoch): replace,
    // don't reuse — old continuations bail on the gen mismatch instead of
    // corrupting this session.
    if (f && f.gen !== recvGen) f = null;
    if (!f) {
      f = {
        fi: fidx, gen: recvGen, meta: null, total: 0, chunk: 0,
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
      if (window.FDIcon) w.appendChild(window.FDIcon.el("warn"));
      w.appendChild(document.createTextNode(kind + " — only open if you trust the sender"));
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
  // Blob-URL leaks are handled by revokeBlobUrlsIn sweeps wherever a list is
  // discarded (connectRecv, resetReceiveView, paintVault repaint).
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
      if (f.gen !== recvGen || recvAborted) return ok;
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
      if (f.gen !== recvGen || recvAborted) return;
      var i = Number(keys[k]);
      var buf = f.pending[i];
      delete f.pending[i];
      pendingBytes = Math.max(0, pendingBytes - buf.byteLength);
      storeChunk(f, i, buf);
      if (recvAborted) return;
    }
  }

  // Park an early chunk (meta/writer not ready yet). Count caps stop
  // descriptor floods; the byte cap stops RAM floods (2000 × 1 MiB would
  // otherwise approach 2 GiB before any file header arrives).
  function pendingPut(f, i, payload) {
    if (Object.keys(f.pending).length >= MAX_PENDING_PER_FILE || pendingTotal() >= MAX_PENDING_TOTAL) {
      abortRecv("Transfer stopped: sender sent data too early.");
      return;
    }
    if (pendingBytes + payload.byteLength > MAX_PENDING_BYTES) {
      abortRecv("Transfer stopped: sender sent too much early data.");
      return;
    }
    // Overwrite of the same index must not double-count bytes.
    if (f.pending[i]) {
      pendingBytes = Math.max(0, pendingBytes - f.pending[i].byteLength);
    }
    pendingBytes += payload.byteLength;
    f.pending[i] = payload;
  }

  function expectedChunkLen(f, i) {
    if (!f.meta) return -1;
    if (i < 0 || i >= f.total) return -1;
    if (f.total === 1) return f.meta.size;
    if (i < f.total - 1) return f.chunk;
    return f.meta.size - (f.total - 1) * f.chunk;
  }

  function storeChunk(f, i, payload) {
    if (recvAborted || f.complete || f.written[i]) return;
    if (!Number.isFinite(i) || Math.floor(i) !== i || i < 0) return;
    if (payload.byteLength > MAX_PAYLOAD + MAX_BIN_SLOP) {
      abortRecv("Transfer stopped: invalid chunk size from sender.");
      return;
    }
    if (!f.meta) {
      // Size unknown yet: park (including 0-byte for a possible empty file).
      // Exact-length check happens once the meta arrives and flushes.
      if (payload.byteLength === 0) {
        if (Object.keys(f.pending).length >= MAX_PENDING_PER_FILE || pendingTotal() >= MAX_PENDING_TOTAL) {
          abortRecv("Transfer stopped: sender sent data too early.");
          return;
        }
        if (f.pending[i]) {
          pendingBytes = Math.max(0, pendingBytes - f.pending[i].byteLength);
        }
        f.pending[i] = payload;
        return;
      }
      pendingPut(f, i, payload);
      return;
    }
    if (i >= f.total) return;
    // Exact-size integrity: every chunk except the last must equal f.chunk;
    // the last must equal the remainder (0 only for an empty file).
    var exp = expectedChunkLen(f, i);
    if (exp < 0 || payload.byteLength !== exp) {
      abortRecv("Transfer stopped: invalid chunk size from sender.");
      return;
    }
    if (f.useOpfs || (f.opfsReady && !f.chunks)) {
      if (!f.writer) {
        pendingPut(f, i, payload);
        return;
      }
      var pos = i * f.chunk;
      if (!Number.isFinite(pos) || pos < 0 || pos >= MAX_FILE_SIZE + MAX_CHUNK) {
        abortRecv("Transfer stopped: invalid chunk offset.");
        return;
      }
      if (rDoneBytes + payload.byteLength > MAX_TOTAL_BYTES + MAX_BIN_SLOP) {
        abortRecv("Transfer stopped: batch too large (max " + fmt(MAX_TOTAL_BYTES) + ").");
        return;
      }
      // Claim the index synchronously so parallel duplicates cannot
      // double-count got/rDoneBytes in the async completion below.
      f.written[i] = true;
      var view = new Uint8Array(payload);
      f.writeChain = f.writeChain.then(function () {
        if (f.gen !== recvGen) throw new Error("stale session");
        return f.writer.write({ type: "write", position: pos, data: view });
      }).then(function () {
        if (f.gen !== recvGen || recvAborted || f.complete) return;
        f.got++;
        rDoneBytes += payload.byteLength;
        var p = recvProgressMsg();
        setRecvThrottled(p.msg, p.pct, false);
        checkEntry(f);
      }).catch(function () {
        if (f.gen !== recvGen) return;
        if (!f.complete && !recvAborted) {
          f.li.querySelector(".fstate").textContent = "write failed";
          f.li.setAttribute("data-state", "error");
        }
        abortRecv("Transfer stopped: could not save the file on this device.");
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
      var g = recvGen;
      d.arrayBuffer().then(function (b) { if (g === recvGen && !recvAborted) onBinary(b); }).catch(function () {});
      return;
    }
    if (typeof d === "object" && d.t) onControl(d);
  }

  function onBinary(buf) {
    if (recvAborted) return;
    if (!buf || buf.byteLength < HEADER) return;
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
    if (!Number.isFinite(d.fi) || Math.floor(d.fi) !== d.fi || d.fi < 0 || d.fi > MAX_FILE_INDEX) return "bad file index";
    if (d.fi >= MAX_FILES) return "too many files (max " + MAX_FILES + ")";
    if (!Number.isFinite(d.fn) || Math.floor(d.fn) !== d.fn || d.fn < 1 || d.fn > MAX_FILE_INDEX + 1) return "bad file count";
    if (d.fn > MAX_FILES) return "too many files (max " + MAX_FILES + ")";
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
      // Grand total for the shared denominator. Sender-controlled: on any
      // inconsistency fall back to accumulated metas (display-only, no abort).
      // Legit senders repeat the same tb on every meta, so changing values
      // are ignored to stop a malicious sender from yanking progress around.
      if (typeof d.tb === "number" && d.tb >= rTotalBytes && d.tb <= MAX_TOTAL_BYTES) {
        if (!rGrandTotal) rGrandTotal = d.tb;
        else if (d.tb !== rGrandTotal) { /* keep first, ignore change */ }
      }
      if (t0r === 0) t0r = Date.now();
      fillRow(f, { name: f.meta.name, size: f.meta.size });
      if (!firstMetaSeen) {
        firstMetaSeen = true;
        document.getElementById("receive-progress").classList.remove("busy");
      }
      pokeLive("receive");
      var mbase = recvDenom();
      setRecvThrottled("Receiving file " + (d.fi + 1) + " of " + d.fn + " — “" + f.meta.name.slice(0, 80) + "”…",
        mbase ? (rDoneBytes / mbase) * 100 : 0, true);
      setupOpfs(f, { name: f.meta.name, size: f.meta.size });
    } else if (d.t === "fdone") {
      if (!Number.isFinite(d.fi) || Math.floor(d.fi) !== d.fi || d.fi < 0 || d.fi > MAX_FILE_INDEX) {
        abortRecv("Transfer stopped: invalid file index.");
        return;
      }
      if (d.fi >= MAX_FILES) {
        abortRecv("Transfer stopped: too many files (max " + MAX_FILES + ").");
        return;
      }
      // fdone travels on the same ordered control channel as its meta, so a
      // fdone for an unknown file is never legitimate — ignore it instead of
      // creating a phantom entry that would wedge completion.
      var f2 = rfiles[d.fi];
      if (!f2 || !f2.meta) return;
      f2.fdone = true;
      checkEntry(f2);
    } else if (d.t === "cancelled") {
      onSenderCancelled();
    } else if (d.t === "done") {
      allDoneMsg = true;
      maybeFinishAll();
    }
  }

  function checkEntry(f) {
    if (!entryLive(f) || !f.meta || !f.fdone) return;
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
    if (!entryLive(f)) return;
    if (f.meta.size > MAX_FILE_SIZE) { abortRecv("Transfer stopped: file too large."); return; }
    f.writer.truncate(f.meta.size).then(function () {
      if (f.gen !== recvGen) return null;
      return f.writer.close();
    }).then(function () {
      if (f.gen !== recvGen) return null;
      return f.opfsHandle.getFile();
    }).then(function (file) {
      if (!file || !entryLive(f)) return;
      f.complete = true;
      // Drop OPFS temp handle ASAP; blob holds the bytes.
      var tmpName = f.opfsName;
      f.writer = null;
      deleteTempOpfs(tmpName);
      finishWithBlob(f, file);
      maybeFinishAll();
    }).catch(function () {
      if (f.gen !== recvGen) return;
      if (!recvAborted) {
        f.li.querySelector(".fstate").textContent = "write failed";
        f.li.setAttribute("data-state", "error");
      }
      abortRecv("Transfer stopped: could not save the file on this device.");
    });
  }

  function finishMemoryFile(f) {
    if (!entryLive(f)) return;
    f.complete = true;
    var blob = new Blob(f.chunks || [], { type: f.meta.mime });
    f.chunks = null;
    finishWithBlob(f, blob);
    maybeFinishAll();
  }

  function finishWithBlob(f, blob) {
    if (!entryLive(f)) return;
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
    var keys = Object.keys(rfiles).filter(function (k) { return rfiles[k].meta; });
    if (rCount && keys.length !== rCount) return;
    if (!keys.length) {
      // A bare {t:"done"} with no files: don't strand the tab in active state.
      setActive(false);
      setRecv("Transfer ended with nothing received.");
      try { document.getElementById("receive-reconnect").hidden = false; } catch (e) {}
      return;
    }
    for (var i = 0; i < keys.length; i++) {
      if (!rfiles[keys[i]].complete) return;
    }
    document.getElementById("receive-cancel").hidden = true;
    document.getElementById("receive-reconnect").hidden = true;
    // Confirm receipt so the sender may honestly show 100%. Best-effort and
    // one-way: senders without a data listener (older tabs) just ignore it,
    // and then park at 99% + waiting instead of ever faking 100%.
    // Report 100 first so both tabs flip together, then confirm.
    reportProgress(true);
    try {
      for (var ai = 0; ai < recvConns.length; ai++) {
        try { if (recvConns[ai] && recvConns[ai].open) recvConns[ai].send({ t: "received" }); } catch (e2) {}
      }
    } catch (e) {}
    setActive(false);
    setRecv("Done — " + plural(keys.length, "file", "files") +
      " received (" + fmt(rTotalBytes) + "). Use the per-file Download links above; copies are also saved on this device below.", 100);
  }

  // ---------- OPFS temp cleanup ----------
  function revokeBlobUrlsIn(el) {
    try {
      if (!el || !el.querySelectorAll) return;
      var as = el.querySelectorAll('a[href^="blob:"]');
      for (var i = 0; i < as.length; i++) {
        try { URL.revokeObjectURL(as[i].href); } catch (e) {}
      }
    } catch (e) {}
  }
  // Close writers and delete temp files for the current receive session.
  // Used on abort/reconnect/reset so partial fd-* files never accumulate.
  function cleanupRecvOpfs() {
    try {
      var keys = Object.keys(rfiles || {});
      for (var i = 0; i < keys.length; i++) {
        var f = rfiles[keys[i]];
        if (!f) continue;
        try { if (f.writer) { try { f.writer.close().catch(function () {}); } catch (e) { try { f.writer.abort().catch(function () {}); } catch (e2) {} } } } catch (e) {}
        f.writer = null;
        if (f.opfsName) deleteTempOpfs(f.opfsName);
      }
    } catch (e) {}
  }
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
  // Epoch guard: clearHistory bumps vaultEpoch; a saveVaultFile that was
  // already in flight aborts instead of resurrecting stale files after clear.
  var vaultEpoch = 0;
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
  function deleteVaultEntry(id) {
    vaultOpen().then(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction("files", "readwrite");
        tx.objectStore("files").delete(id);
      } catch (e) {}
    });
  }
  function saveVaultFile(meta, blob) {
    try {
      // Ephemeral mode: user opted out of on-device persistence.
      if (document.getElementById("vault-off") && document.getElementById("vault-off").checked) return;
    } catch (e) {}
    var safeName = sanitizeDownloadName(meta.name);
    if (blob.size > VAULT_MAX_BYTES) return; // never vault huge files
    var myEpoch = vaultEpoch;
    vaultOpen().then(function (db) {
      if (!db || myEpoch !== vaultEpoch) return;
      try {
        var tx = db.transaction("files", "readwrite");
        var os = tx.objectStore("files");
        var allReq = os.getAll();
        allReq.onsuccess = function () {
          try {
            if (myEpoch !== vaultEpoch) return;
            var items = allReq.result || [];
            var now = Date.now();
            items = items.filter(function (it) { return now - (it.ts || 0) <= VAULT_MAX_AGE_MS; });
            // Evict oldest first so the newest file wins (LRU), keeping both
            // count and total bytes under cap.
            items.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
            var total = items.reduce(function (s, it) { return s + (it.size || 0); }, 0);
            while (items.length && ((items.length >= VAULT_MAX_FILES) || (total + blob.size > VAULT_MAX_BYTES))) {
              var old = items.shift();
              total -= (old.size || 0);
              try { os.delete(old.id); } catch (e) {}
            }
            if (total + blob.size > VAULT_MAX_BYTES) return;
            var addReq = os.add({
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
    revokeBlobUrlsIn(ul);
    ul.innerHTML = "";
    if (!items.length) { sec.hidden = true; return; }
    // Enforce display cap; oldest beyond cap are hidden (pruned on next save/clear).
    items.sort(function (a, b) { return b.ts - a.ts; });
    items.slice(0, VAULT_MAX_FILES).forEach(function (it) {
      try {
        if (!it || !it.blob || !(it.blob instanceof Blob)) throw new Error("bad vault entry");
        if (typeof it.name !== "string") it.name = "file";
      } catch (e) { try { if (it && it.id != null) deleteVaultEntry(it.id); } catch (e2) {} return; }
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
        if (window.FDIcon) w.appendChild(window.FDIcon.el("warn"));
        w.appendChild(document.createTextNode(kind));
        w.title = "Only open if you trust the sender.";
        li.appendChild(w);
      }
      ul.appendChild(li);
    });
    sec.hidden = false;
  }
  // Wipe past history when a NEW transfer starts while idle: clears the
  // vault (IndexedDB) and repaints. Deliberately OPFS-touch-free — another
  // tab may be mid-receive. In-flight completions re-vault afterwards, so a
  // live transfer is never harmed by this.
  function clearHistory() {
    vaultEpoch++;
    try { revokeBlobUrlsIn(document.getElementById("vault-list")); } catch (e) {}
    try { revokeBlobUrlsIn(document.getElementById("receive-filelist")); } catch (e) {}
    vaultOpen().then(function (db) {
      if (!db) { try { renderVault(); } catch (e) {} return; }
      try {
        var tx = db.transaction("files", "readwrite");
        tx.objectStore("files").clear();
        tx.oncomplete = renderVault;
      } catch (e) {}
    });
  }
  document.getElementById("vault-clear").onclick = function () {
    clearHistory();
    clearAllTempOpfs().then(renderVault).catch(function () {});
    try { renderVault(); } catch (e) {}
  };
  renderVault();
  sweepOldTempOpfs();

  // Background tabs get throttled (timers → 1Hz, SCTP stalls). Warn once per
  // transfer so large files are kept in the foreground.
  try {
    var bgWarned = false;
    document.addEventListener("visibilitychange", function () {
      if (document.hidden && transferActive && !bgWarned) {
        bgWarned = true;
        try { toast("Keep this tab in the foreground — background tabs may stall the transfer.", "warn"); } catch (e) {}
      }
      if (!document.hidden) bgWarned = false;
    });
  } catch (e) {}

  // deep-link ?code=XXX → receive tab; &auto=1 (QR scans) connects immediately
  (function () {
    var m = /[?&]code=([A-Za-z0-9]{6,16})/.exec(location.search);
    if (!m) return;
    show("receive");
    try {
      document.getElementById("receive-code").value = m[1].toUpperCase().slice(0, 12);
      document.getElementById("receive-code").focus();
    } catch (e) {}
    if (/[?&]auto=1/.test(location.search)) {
      setTimeout(submitReceive, 400);
    }
  })();
})();
