/* FileDrop sounds — synthesized Web Audio cues for transfer milestones.
 * No audio files, no network, no CSP change: every cue is an oscillator
 * envelope built at play time. Purely additive: hooks observe the same DOM
 * state app.js already publishes (status text, pct, row data-state), so
 * transfer logic is untouched. AudioContext is created lazily on the first
 * user gesture (autoplay policy) and every cue resumes it if suspended.
 * Mute toggle persists in localStorage ("fd-sound" = "off").
 */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  var soundOn = true;
  try { soundOn = localStorage.getItem("fd-sound") !== "off"; } catch (e) {}

  var ctx = null;
  function ensureCtx() {
    if (ctx) return ctx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    } catch (e) { ctx = null; }
    return ctx;
  }
  // Unlock on first gesture anywhere (send drop / connect click both qualify).
  // Never instantiate while muted: the persisted off-switch means no context.
  function unlock() {
    if (!soundOn) return;
    var c = ensureCtx();
    if (c && c.state === "suspended") {
      try { var r = c.resume(); if (r && r.catch) r.catch(function () {}); } catch (e) {}
    }
  }
  ["pointerdown", "keydown", "touchstart"].forEach(function (ev) {
    window.addEventListener(ev, unlock, { passive: true });
  });

  // Last-play guard per cue so batch completions don't stack harshly.
  var lastPlay = {};
  function throttle(name, ms) {
    var now = Date.now();
    if (lastPlay[name] && now - lastPlay[name] < ms) return false;
    lastPlay[name] = now;
    return true;
  }

  function tone(o) {
    if (!soundOn) return;
    var c = ensureCtx();
    if (!c) return;
    if (c.state === "suspended") {
      try { var r = c.resume(); if (r && r.catch) r.catch(function () {}); } catch (e) {}
      if (c.state === "suspended") return; // schedule nothing into silence
    }
    try {
      var t0 = c.currentTime + (o.delay || 0);
      var osc = c.createOscillator();
      var g = c.createGain();
      osc.type = o.type || "sine";
      osc.frequency.setValueAtTime(o.freq, t0);
      if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(o.freqEnd, t0 + o.dur);
      var vol = o.gain || 0.14;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
      osc.connect(g);
      g.connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + o.dur + 0.05);
    } catch (e) {}
  }

  // ---------- milestone cues ----------
  function connectPop() {
    if (!throttle("pop", 800)) return;
    tone({ freq: 520, freqEnd: 780, dur: 0.12 });
  }
  function fileBlip() {
    if (!throttle("blip", 120)) return;
    tone({ freq: 880, dur: 0.1 });
    tone({ freq: 1318, dur: 0.14, delay: 0.08 });
  }
  function successFanfare() {
    if (!throttle("fanfare", 2500)) return;
    var notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    for (var i = 0; i < notes.length; i++) {
      tone({ freq: notes[i], dur: 0.22, delay: i * 0.11, gain: 0.13 });
    }
  }
  function errorBuzz() {
    if (!throttle("error", 1000)) return;
    tone({ freq: 170, freqEnd: 120, type: "square", dur: 0.28, gain: 0.06 });
  }
  function disconnectTone() {
    if (!throttle("dropped", 1500)) return;
    tone({ freq: 420, freqEnd: 240, dur: 0.25, gain: 0.1 });
  }
  function copyTick() {
    if (!throttle("tick", 300)) return;
    tone({ freq: 1250, dur: 0.05, gain: 0.08 });
  }
  function dropPop() {
    if (!throttle("drop", 500)) return;
    tone({ freq: 340, freqEnd: 620, dur: 0.14 });
  }

  // ---------- mute toggle ----------
  (function toggle() {
    var btn = $("sound-toggle");
    if (!btn) return;
    function paint() {
      var iconOn = btn.querySelector(".snd-on");
      var iconOff = btn.querySelector(".snd-off");
      var label = btn.querySelector("#sound-label");
      if (iconOn) iconOn.hidden = !soundOn;
      if (iconOff) iconOff.hidden = soundOn;
      if (label) label.textContent = soundOn ? "Sound on" : "Sound off";
      btn.setAttribute("aria-pressed", soundOn ? "true" : "false");
    }
    btn.addEventListener("click", function () {
      soundOn = !soundOn;
      try { localStorage.setItem("fd-sound", soundOn ? "on" : "off"); } catch (e) {}
      paint();
      if (soundOn) { unlock(); copyTick(); }
      else if (ctx) { try { var s = ctx.suspend(); if (s && s.catch) s.catch(function () {}); } catch (e) {} }
    });
    paint();
  })();

  // Interaction ticks need no MutationObserver — wire them before the MO gate
  // below so no-MO browsers still get copy/drop feedback.
  // ---------- small interaction ticks ----------
  [["copy-code"], ["copy-link"]].forEach(function (pair) {
    var b = $(pair[0]);
    if (b) b.addEventListener("click", copyTick);
  });
  var dz = $("dropzone"), fi = $("file-input");
  if (dz) dz.addEventListener("drop", dropPop);
  if (fi) fi.addEventListener("change", function () { if (fi.files && fi.files.length) dropPop(); });
  // Release the audio thread on teardown; a fresh gesture re-creates it.
  try {
    window.addEventListener("pagehide", function () {
      try { if (ctx && ctx.state === "running") ctx.suspend(); } catch (e) {}
    });
  } catch (e) {}

  function pctDone(el) {
    var v = parseFloat(((el && el.textContent) || "").replace("%", ""));
    return Number.isFinite(v) && v >= 100;
  }

  if (!("MutationObserver" in window)) return;

  // ---------- sender milestones ----------
  var sendStatus = $("send-status"), sendPct = $("send-pct");
  if (sendStatus) {
    new MutationObserver(function () {
      var msg = sendStatus.textContent || "";
      if (/other side connected/i.test(msg)) connectPop();
      else if (/other side disconnected|stopped the transfer/i.test(msg)) disconnectTone();
    }).observe(sendStatus, { childList: true, characterData: true, subtree: true });
  }
  if (sendPct) {
    var sendArmed = true;
    new MutationObserver(function () {
      var done = pctDone(sendPct);
      if (done && sendArmed) { sendArmed = false; successFanfare(); }
      else if (!done) sendArmed = true;
    }).observe(sendPct, { childList: true, characterData: true, subtree: true });
  }

  // Per-file blips, both sides (rows flip to sent/done exactly once each).
  [["send-filelist", "sent"], ["receive-filelist", "done"]].forEach(function (pair) {
    var ul = $(pair[0]), state = pair[1];
    if (!ul) return;
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === "attributes" && m.attributeName === "data-state" &&
            m.target.getAttribute("data-state") === state) {
          fileBlip();
        }
      }
    }).observe(ul, { subtree: true, attributes: true, attributeFilter: ["data-state"] });
  });

  // ---------- receiver milestones ----------
  var recvStatus = $("receive-status"), recvPct = $("receive-pct");
  if (recvStatus) {
    new MutationObserver(function () {
      var msg = (recvStatus.textContent || "").trim();
      if (/^done —/i.test(msg)) successFanfare();
      else if (/could not connect|check the code|peer error/i.test(msg)) errorBuzz();
      else if (/sender left before everything arrived|sender stopped sending/i.test(msg)) disconnectTone();
      else if (/connected — waiting/i.test(msg)) connectPop();
    }).observe(recvStatus, { childList: true, characterData: true, subtree: true });
  }
  if (recvPct) {
    var recvArmed = true;
    new MutationObserver(function () {
      var done = pctDone(recvPct);
      if (done && recvArmed) { recvArmed = false; successFanfare(); }
      else if (!done) recvArmed = true;
    }).observe(recvPct, { childList: true, characterData: true, subtree: true });
  }
})();
