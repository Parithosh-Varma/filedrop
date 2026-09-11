/* FileDrop fx — GSAP + anime.js animation flood (static-only, no build).
 * Vendored locally: vendor/gsap.min.js (GSAP 3.12.5, https://gsap.com/docs/v3/Installation/)
 * + vendor/anime.min.js (anime.js v3.2.1, https://github.com/juliangarnier/anime).
 * Purely visual: never touches transfer state. All hooks are additive
 * (MutationObserver + extra listeners). If both libs fail to load, the CSS
 * keyframes in styles.css still carry ambient motion and nothing breaks.
 * Respects prefers-reduced-motion: exits early, site works as before.
 */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) {}
  if (reduceMotion) return;

  var hasGsap = typeof window.gsap !== "undefined" && window.gsap;
  var hasAnime = typeof window.anime === "function" || (typeof window.anime === "object" && window.anime);
  function animeFn() { return (typeof window.anime === "function") ? window.anime : null; }
  var finePointer = false;
  try {
    finePointer = window.matchMedia && window.matchMedia("(pointer: fine)").matches;
  } catch (e) {}

  document.documentElement.classList.add("fx-on");

  // ---------- tiny confetti engine (anime.js first, GSAP / WAAPI fallback) ----------
  var COLORS = ["#d43d2a", "#2456c8", "#1a2b4a", "#e8b93e", "#1e7d32"];
  function burst(x, y, n) {
    var layer = $("fx-confetti");
    if (!layer) return;
    n = n || 70;
    var vw = Math.max(320, window.innerWidth || 640);
    var pieces = [];
    for (var i = 0; i < n; i++) {
      var s = document.createElement("span");
      s.className = "cfetti";
      s.style.background = COLORS[i % COLORS.length];
      s.style.left = x + "px";
      s.style.top = y + "px";
      if (i % 3 === 0) s.style.borderRadius = "50%";
      if (i % 4 === 0) { s.style.width = "6px"; s.style.height = "6px"; }
      layer.appendChild(s);
      pieces.push(s);
    }
    function cleanup() {
      for (var k = 0; k < pieces.length; k++) {
        if (pieces[k].parentNode) pieces[k].parentNode.removeChild(pieces[k]);
      }
    }
    var dx = pieces.map(function () { return (Math.random() - 0.5) * Math.min(vw * 0.7, 560); });
    var dy = pieces.map(function () { return -(60 + Math.random() * 260) + (Math.random() * 420); });
    var rot = pieces.map(function () { return (Math.random() - 0.5) * 720; });
    var A = animeFn();
    if (A) {
      try {
        A({
          targets: pieces,
          translateX: function (el, i) { return dx[i]; },
          translateY: function (el, i) { return dy[i]; },
          rotate: function (el, i) { return rot[i]; },
          opacity: [1, 0],
          duration: function () { return 1100 + Math.random() * 900; },
          easing: "easeOutExpo",
          delay: A.stagger(8),
          complete: cleanup
        });
        return;
      } catch (e) { /* fall through */ }
    }
    if (hasGsap) {
      try {
        hasGsap.to(pieces, {
          x: function (i) { return dx[i]; },
          y: function (i) { return dy[i]; },
          rotation: function (i) { return rot[i]; },
          opacity: 0,
          duration: 1.4 + Math.random() * 0.6,
          ease: "expo.out",
          stagger: 0.008,
          onComplete: cleanup
        });
        return;
      } catch (e) { /* fall through */ }
    }
    // WAAPI last resort
    try {
      var done = 0;
      pieces.forEach(function (el, i) {
        var anim = el.animate([
          { transform: "translate(0,0) rotate(0deg)", opacity: 1 },
          { transform: "translate(" + dx[i] + "px," + dy[i] + "px) rotate(" + rot[i] + "deg)", opacity: 0 }
        ], { duration: 1200 + Math.random() * 800, easing: "cubic-bezier(.2,.7,.2,1)", delay: i * 8 });
        anim.onfinish = function () { if (++done === pieces.length) cleanup(); };
      });
    } catch (e) { cleanup(); }
  }
  function celebrateAt(el, n) {
    var x = window.innerWidth / 2, y = window.innerHeight * 0.3;
    try {
      if (el && el.getBoundingClientRect) {
        var r = el.getBoundingClientRect();
        x = r.left + r.width / 2;
        y = Math.max(80, r.top + r.height * 0.3);
      }
    } catch (e) {}
    burst(x, y, n || 80);
  }

  // ---------- wordmark split (stagger base for GSAP + anime) ----------
  (function splitWordmark() {
    var wm = $all(".wordmark")[0];
    if (!wm || wm.querySelector(".wm-char")) return;
    var text = wm.textContent;
    wm.setAttribute("aria-label", text);
    wm.textContent = "";
    for (var i = 0; i < text.length; i++) {
      var ch = document.createElement("span");
      ch.className = "wm-char";
      ch.textContent = text[i];
      ch.setAttribute("aria-hidden", "true");
      wm.appendChild(ch);
    }
  })();

  // ---------- entrance choreography (GSAP timeline, anime assist) ----------
  (function entrance() {
    if (!hasGsap) return;
    try {
      var vs = $("view-send"), vr = $("view-receive");
      if (!vs || !vr) return;
      var recvVisible = !vr.hidden;
      var tl = hasGsap.timeline({ defaults: { ease: "power3.out" } });
      tl.from(".stripe", { scaleX: 0, transformOrigin: "0 50%", duration: 0.7, ease: "expo.out" }, 0)
        .from(".brandmark", { scale: 0, rotation: -30, duration: 0.7, ease: "back.out(1.8)" }, 0.1)
        .from(".wordmark .wm-char", { y: 26, opacity: 0, rotation: 8, duration: 0.55, stagger: 0.045 }, 0.15)
        .from(".lede", { y: 16, opacity: 0, duration: 0.6 }, 0.35)
        .from(".switch", { y: 14, opacity: 0, scale: 0.96, duration: 0.5 }, 0.45)
        .from(recvVisible ? "#view-receive" : "#view-send", { y: 22, opacity: 0, duration: 0.65 }, 0.55)
        .from("footer", { opacity: 0, y: 10, duration: 0.5 }, 0.8);
      // counter icon gets a friendly hello-wave via anime.js
      var A = animeFn();
      var icon = $all(".counter-icon")[0];
      if (A && icon) {
        A({ targets: icon, rotate: [0, -12, 10, -6, 0], duration: 900, delay: 900, easing: "easeInOutSine" });
      }
    } catch (e) {}
  })();

  // wordmark hover wave (anime.js)
  (function wordmarkWave() {
    var A = animeFn();
    var brand = $all(".brand")[0];
    if (!A || !brand) return;
    brand.addEventListener("mouseenter", function () {
      try {
        A({ targets: ".wordmark .wm-char", translateY: [0, -9, 0], duration: 550, delay: A.stagger(35), easing: "easeInOutSine" });
      } catch (e) {}
    });
  })();

  // ---------- ambient planes drift (anime.js infinite) + container parallax (GSAP) ----------
  (function ambient() {
    var A = animeFn();
    if (A) {
      try {
        A({ targets: ".fx-plane.p1", translateX: [0, 60, 0], translateY: [0, -26, 0], rotate: [0, 12, 0], duration: 11000, loop: true, easing: "easeInOutSine" });
        A({ targets: ".fx-plane.p2", translateX: [0, -48, 0], translateY: [0, 22, 0], rotate: [0, -10, 0], duration: 14000, loop: true, easing: "easeInOutSine", delay: 800 });
        A({ targets: ".fx-plane.p3", translateX: [0, 36, 0], translateY: [0, -18, 0], rotate: [0, 8, 0], duration: 17000, loop: true, easing: "easeInOutSine", delay: 1600 });
        A({ targets: ".counter-icon", translateY: [0, -5, 0], duration: 2600, loop: true, direction: "alternate", easing: "easeInOutSine" });
      } catch (e) {}
    }
    if (hasGsap && finePointer) {
      try {
        var qx = hasGsap.quickTo(".fx-ambient", "x", { duration: 0.9, ease: "power2.out" });
        var qy = hasGsap.quickTo(".fx-ambient", "y", { duration: 0.9, ease: "power2.out" });
        window.addEventListener("mousemove", function (e) {
          var nx = (e.clientX / window.innerWidth - 0.5) * 18;
          var ny = (e.clientY / window.innerHeight - 0.5) * 14;
          qx(nx); qy(ny);
        }, { passive: true });
      } catch (e) {}
    }
  })();

  // ---------- magnetic buttons + ripple + press pop ----------
  (function buttons() {
    var btns = $all("button.primary, button.ghost, button.quiet, .switch button");
    btns.forEach(function (b) {
      // Segmented toggle must stay pixel-locked: any transform on its halves
      // reopens hairline gaps at the rounded corners. Ripple only for those.
      var isSwitch = !!(b.closest && b.closest(".switch"));
      // ripple
      b.addEventListener("click", function (e) {
        if (!isSwitch) {
          b.classList.remove("fx-press");
          void b.offsetWidth;
          b.classList.add("fx-press");
        }
        try {
          var r = b.getBoundingClientRect();
          var d = Math.max(r.width, r.height) * 2;
          var rip = document.createElement("span");
          rip.className = "fx-ripple";
          rip.style.width = rip.style.height = d + "px";
          rip.style.left = ((e.clientX || r.left + r.width / 2) - r.left - d / 2) + "px";
          rip.style.top = ((e.clientY || r.top + r.height / 2) - r.top - d / 2) + "px";
          b.appendChild(rip);
          var A = animeFn();
          if (A) {
            A({ targets: rip, scale: [0, 1], opacity: [0.3, 0], duration: 650, easing: "easeOutExpo", complete: function () { rip.remove(); } });
          } else if (hasGsap) {
            hasGsap.fromTo(rip, { scale: 0, opacity: 0.3 }, { scale: 1, opacity: 0, duration: 0.65, ease: "expo.out", onComplete: function () { rip.remove(); } });
          } else {
            setTimeout(function () { rip.remove(); }, 600);
          }
        } catch (err) {}
      });
      // magnetic drift on fine pointers (never on the segmented toggle)
      if (hasGsap && finePointer && !isSwitch) {
        try {
          b.addEventListener("mousemove", function (e) {
            var r = b.getBoundingClientRect();
            var mx = (e.clientX - (r.left + r.width / 2)) / r.width;
            var my = (e.clientY - (r.top + r.height / 2)) / r.height;
            hasGsap.to(b, { x: mx * 5, y: my * 4, duration: 0.3, ease: "power2.out", overwrite: "auto" });
          });
          b.addEventListener("mouseleave", function () {
            hasGsap.to(b, { x: 0, y: 0, duration: 0.45, ease: "elastic.out(1,0.5)", overwrite: "auto" });
          });
        } catch (err) {}
      }
    });
  })();

  // ---------- 3D tilt on counter + ticket ----------
  (function tilt() {
    if (!hasGsap || !finePointer) return;
    [["dropzone", 7], [$("send-panel") ? $("send-panel").querySelector(".ticket") : null, 5]].forEach(function (pair) {
      var el = typeof pair[0] === "string" ? $(pair[0]) : pair[0];
      var max = pair[1];
      if (!el) return;
      el.addEventListener("mousemove", function (e) {
        try {
          var r = el.getBoundingClientRect();
          var rx = ((e.clientY - r.top) / r.height - 0.5) * -max;
          var ry = ((e.clientX - r.left) / r.width - 0.5) * max;
          hasGsap.to(el, { rotateX: rx, rotateY: ry, transformPerspective: 700, duration: 0.4, ease: "power2.out", overwrite: "auto" });
        } catch (err) {}
      });
      el.addEventListener("mouseleave", function () {
        try { hasGsap.to(el, { rotateX: 0, rotateY: 0, duration: 0.7, ease: "elastic.out(1,0.55)" }); } catch (err) {}
      });
    });
  })();

  // ---------- tab switch transitions ----------
  (function tabs() {
    if (!hasGsap) return;
    ["tab-send", "tab-receive"].forEach(function (id) {
      var t = $(id);
      if (!t) return;
      t.addEventListener("click", function () {
        requestAnimationFrame(function () {
          try {
            var incoming = id === "tab-send" ? $("view-send") : $("view-receive");
            if (incoming && !incoming.hidden) {
              hasGsap.fromTo(incoming, { y: 16, opacity: 0, scale: 0.985 }, { y: 0, opacity: 1, scale: 1, duration: 0.45, ease: "power3.out", overwrite: "auto", clearProps: "transform,opacity" });
            }
            // No scale pop on the tab itself — transforms on the toggle halves
            // leak hairline gaps at the rounded corners.
          } catch (e) {}
        });
      });
    });
  })();

  // ---------- dropzone dragover pulse + drop burst ----------
  (function dropzone() {
    var dz = $("dropzone");
    if (!dz) return;
    dz.addEventListener("dragenter", function () {
      var A = animeFn();
      if (A) { try { A({ targets: dz, scale: [1, 1.025], duration: 220, easing: "easeOutQuad" }); } catch (e) {} }
    });
    dz.addEventListener("drop", function (e) {
      try {
        var x = e.clientX || window.innerWidth / 2, y = e.clientY || window.innerHeight * 0.35;
        burst(x, y, 36);
        var A = animeFn();
        if (A) A({ targets: ".counter-icon", scale: [1, 1.35, 1], rotate: [0, -14, 0], duration: 550, easing: "easeOutBack" });
        else if (hasGsap) hasGsap.fromTo(".counter-icon", { scale: 1 }, { scale: 1.3, duration: 0.18, yoyo: true, repeat: 1, ease: "power2.out" });
      } catch (err) {}
    });
    var fi = $("file-input");
    if (fi) fi.addEventListener("change", function () {
      if (fi.files && fi.files.length) celebrateAt(dz, 30);
    });
  })();

  // ---------- code scramble (decodes the claim code digit by digit) ----------
  var scrambling = false;
  function scrambleCode(el) {
    if (!el || scrambling) return;
    var final = el.textContent.trim();
    if (!final || final === "—") return;
    scrambling = true;
    var GLYPHS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    var t0 = null, DUR = 650;
    function frame(t) {
      if (!t0) t0 = t;
      var p = Math.min(1, (t - t0) / DUR);
      var out = "";
      for (var i = 0; i < final.length; i++) {
        out += (i / final.length < p) ? final[i] : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }
      el.textContent = out;
      if (p < 1) requestAnimationFrame(frame);
      else { el.textContent = final; scrambling = false; popChars(el); }
    }
    requestAnimationFrame(frame);
  }
  function popChars(el) {
    // wrap chars once, then stagger-pop with anime.js
    if (el.querySelector(".code-char")) return;
    var text = el.textContent;
    el.textContent = "";
    for (var i = 0; i < text.length; i++) {
      var s = document.createElement("span");
      s.className = "code-char";
      s.textContent = text[i];
      el.appendChild(s);
    }
    var A = animeFn();
    if (A) {
      try { A({ targets: el.querySelectorAll(".code-char"), translateY: [14, 0], opacity: [0, 1], duration: 420, delay: A.stagger(55), easing: "easeOutBack" }); } catch (e) {}
    }
  }

  // ---------- ticket reveal ----------
  (function ticketReveal() {
    var panel = $("send-panel");
    if (!panel) return;
    function play() {
      var ticket = panel.querySelector(".ticket");
      var code = $("share-code");
      if (hasGsap && ticket) {
        try {
          hasGsap.fromTo(ticket,
            { y: 30, opacity: 0, rotateX: -12, scale: 0.96 },
            { y: 0, opacity: 1, rotateX: 0, scale: 1, duration: 0.75, ease: "expo.out", overwrite: "auto", clearProps: "opacity" });
          hasGsap.fromTo(panel.querySelectorAll(".linkrow, .progressline, .fileline, .hint"),
            { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, stagger: 0.07, delay: 0.25, ease: "power3.out", overwrite: "auto", clearProps: "all" });
        } catch (e) {}
      }
      if (code) scrambleCode(code);
      var A = animeFn();
      var rows = $all("#send-filelist li");
      if (A && rows.length) {
        try { A({ targets: rows, translateX: [-18, 0], opacity: [0, 1], duration: 450, delay: A.stagger(70), easing: "easeOutQuad" }); } catch (e) {}
      }
    }
    if ("MutationObserver" in window) {
      new MutationObserver(function () {
        if (!panel.hidden) play();
      }).observe(panel, { attributes: true, attributeFilter: ["hidden"] });
    }
    if (!panel.hidden) play();
  })();

  // ---------- generic file-row animator (send / receive / vault) ----------
  var seenRows = new WeakMap();
  function animateNewRows(ul) {
    if (!ul) return;
    var A = animeFn();
    $all("li", ul).forEach(function (li) {
      if (seenRows.get(li)) return;
      seenRows.set(li, true);
      li.classList.remove("fx-enter");
      void li.offsetWidth;
      li.classList.add("fx-enter");
    });
    if (A) {
      try {
        var fresh = $all("li", ul).slice(-6);
        A({ targets: fresh, translateX: [-14, 0], opacity: [0, 1], duration: 380, delay: A.stagger(50), easing: "easeOutQuad" });
      } catch (e) {}
    }
  }
  ["send-filelist", "receive-filelist", "vault-list"].forEach(function (id) {
    var ul = $(id);
    if (!ul || !("MutationObserver" in window)) return;
    animateNewRows(ul);
    new MutationObserver(function (muts) {
      var added = false;
      muts.forEach(function (m) {
        if (m.type === "childList" && m.addedNodes.length) added = true;
        if (m.type === "attributes" && m.attributeName === "data-state") {
          var li = m.target;
          if (li && li.querySelector) {
            var st = li.querySelector(".fstate");
            if (st) {
              if (hasGsap) { try { hasGsap.fromTo(st, { scale: 0.7 }, { scale: 1, duration: 0.35, ease: "back.out(2)" }); } catch (e) {} }
              if (li.getAttribute("data-state") === "done" || li.getAttribute("data-state") === "sent") {
                try { var r = li.getBoundingClientRect(); burst(r.left + r.width - 40, r.top + 10, 14); } catch (e) {}
              }
            }
          }
        }
      });
      if (added) animateNewRows(ul);
    }).observe(ul, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state"] });
  });

  // ---------- status text swap (fade/slide on change) ----------
  function watchStatus(id) {
    var el = $(id);
    if (!el || !("MutationObserver" in window)) return;
    var ticking = false;
    new MutationObserver(function () {
      if (ticking || !hasGsap) return;
      ticking = true;
      requestAnimationFrame(function () {
        try { hasGsap.fromTo(el, { y: 5, opacity: 0.2 }, { y: 0, opacity: 1, duration: 0.35, ease: "power2.out", overwrite: "auto", clearProps: "all" }); } catch (e) {}
        setTimeout(function () { ticking = false; }, 220);
      });
    }).observe(el, { childList: true, characterData: true, subtree: true });
  }
  watchStatus("send-status");
  watchStatus("receive-status");

  // ---------- progress: glow while live + pct pop + celebration ----------
  function watchProgress(pctId, barId, liveId) {
    var pct = $(pctId), bar = $(barId);
    if (!pct || !("MutationObserver" in window)) return;
    var lastBand = -1;
    new MutationObserver(function () {
      var txt = pct.textContent.trim();
      var v = parseInt(txt, 10);
      if (isNaN(v)) return;
      var band = Math.floor(v / 10);
      if (band !== lastBand) {
        lastBand = band;
        if (hasGsap && v < 100) {
          try { hasGsap.fromTo(pct, { scale: 1.22 }, { scale: 1, duration: 0.3, ease: "power2.out", overwrite: "auto" }); } catch (e) {}
        }
      }
      if (bar && liveId) {
        var live = $(liveId);
        var on = live && live.getAttribute("data-live") === "on";
        var line = bar.closest ? bar.closest(".progressline") : null;
        if (line) line.classList.toggle("live-flow", !!on);
      }
    }).observe(pct, { childList: true, characterData: true, subtree: true });
  }
  watchProgress("send-pct", "send-progress", "send-live");
  watchProgress("receive-pct", "receive-progress", "receive-live");

  // live-dot ignition pulse
  ["send-live", "receive-live"].forEach(function (id) {
    var el = $(id);
    if (!el || !("MutationObserver" in window)) return;
    new MutationObserver(function () {
      if (el.getAttribute("data-live") === "on" && hasGsap) {
        try { hasGsap.fromTo(el, { scale: 1.25 }, { scale: 1, duration: 0.35, ease: "back.out(2)", overwrite: "auto" }); } catch (e) {}
      }
    }).observe(el, { attributes: true, attributeFilter: ["data-live"] });
  });

  // ---------- send 100%: stamp + confetti + ticket glow ----------
  (function sendDone() {
    var pct = $("send-pct");
    if (!pct || !("MutationObserver" in window)) return;
    var fired = false;
    new MutationObserver(function () {
      if (pct.textContent.trim() !== "100%" || fired) return;
      fired = true;
      setTimeout(function () { fired = false; }, 5000);
      var ticket = $all(".ticket")[0];
      celebrateAt(ticket || pct, 110);
      if (ticket) {
        ticket.classList.add("sent-glow");
        if (!$all(".fx-stamp", ticket).length) {
          var stamp = document.createElement("span");
          stamp.className = "fx-stamp";
          if (window.FDIcon) stamp.appendChild(window.FDIcon.el("check"));
          stamp.appendChild(document.createTextNode("SENT"));
          ticket.appendChild(stamp);
          if (hasGsap) {
            try { hasGsap.from(stamp, { scale: 2.2, opacity: 0, rotation: -18, duration: 0.5, ease: "expo.out" }); } catch (e) {}
          } else {
            var A = animeFn();
            if (A) { try { A({ targets: stamp, scale: [2.2, 1], opacity: [0, 1], duration: 500, easing: "easeOutExpo" }); } catch (e) {} }
          }
        }
        if (hasGsap) { try { hasGsap.fromTo(ticket, { scale: 1 }, { scale: 1.015, duration: 0.16, yoyo: true, repeat: 1, ease: "power2.inOut" }); } catch (e) {} }
      }
    }).observe(pct, { childList: true, characterData: true, subtree: true });
  })();

  // ---------- receive: error shake + Done celebration ----------
  (function receiveFx() {
    var status = $("receive-status");
    var form = $("receive-form");
    var input = $("receive-code");
    if (status && "MutationObserver" in window) {
      new MutationObserver(function () {
        var msg = status.textContent || "";
        if (/not found|peer error|enter the|check the code/i.test(msg)) {
          if (form) {
            var A = animeFn();
            if (A) { try { A({ targets: form, translateX: [0, -9, 8, -5, 4, 0], duration: 420, easing: "easeInOutSine" }); } catch (e) {} }
          }
          if (input) {
            input.classList.remove("fx-shake");
            void input.offsetWidth;
            input.classList.add("fx-shake");
            setTimeout(function () { input.classList.remove("fx-shake"); }, 600);
          }
        }
        if (/^done —/i.test(msg.trim())) {
          celebrateAt($("receive-filelist") || status, 120);
          var rows = $all("#receive-filelist li");
          var A2 = animeFn();
          if (A2 && rows.length) {
            try { A2({ targets: rows, scale: [0.96, 1], duration: 450, delay: A2.stagger(60), easing: "easeOutBack" }); } catch (e) {}
          }
        }
      }).observe(status, { childList: true, characterData: true, subtree: true });
    }
    if (form) form.addEventListener("submit", function () {
      if (hasGsap) { try { hasGsap.fromTo(form, { x: 0 }, { x: 4, duration: 0.07, yoyo: true, repeat: 3, ease: "power1.inOut", clearProps: "x" }); } catch (e) {} }
    });
    // reconnect button attention loop
    var rec = $("receive-reconnect");
    if (rec && "MutationObserver" in window) {
      new MutationObserver(function () {
        rec.classList.toggle("fx-attn", !rec.hidden);
        if (!rec.hidden && hasGsap) {
          try { hasGsap.from(rec, { y: 10, opacity: 0, scale: 0.94, duration: 0.45, ease: "back.out(1.8)" }); } catch (e) {}
        }
      }).observe(rec, { attributes: true, attributeFilter: ["hidden"] });
      rec.classList.toggle("fx-attn", !rec.hidden);
    }
  })();

  // ---------- copy buttons: morph to "Copied!" + micro-burst ----------
  [["copy-code", "share-code"], ["copy-link", "share-link"]].forEach(function (pair) {
    var btn = $(pair[0]);
    if (!btn) return;
    btn.addEventListener("click", function (e) {
      var orig = btn.textContent;
      btn.textContent = "Copied!";
      btn.classList.add("fx-copied");
      try {
        var x = e.clientX || window.innerWidth / 2, y = e.clientY || 200;
        burst(x, y, 18);
      } catch (err) {}
      if (hasGsap) { try { hasGsap.fromTo(btn, { scale: 0.9 }, { scale: 1, duration: 0.4, ease: "back.out(3)" }); } catch (err) {} }
      setTimeout(function () { btn.textContent = orig; btn.classList.remove("fx-copied"); }, 1400);
    });
  });

  // ---------- QR pop ----------
  (function qrPop() {
    var qr = $("share-qr");
    if (!qr || !("MutationObserver" in window)) return;
    function play() {
      qr.classList.remove("fx-pop");
      void qr.offsetWidth;
      qr.classList.add("fx-pop");
      if (hasGsap) { try { hasGsap.from(qr, { scale: 0.6, rotation: -5, opacity: 0, duration: 0.55, ease: "back.out(1.7)", clearProps: "all" }); } catch (e) {} }
    }
    new MutationObserver(function () { if (!qr.hidden) play(); }).observe(qr, { attributes: true, attributeFilter: ["hidden"] });
    qr.addEventListener("load", play);
  })();

  // ---------- vault reveal ----------
  (function vault() {
    var sec = $("vault");
    if (!sec || !("MutationObserver" in window)) return;
    new MutationObserver(function () {
      if (!sec.hidden) {
        animateNewRows($("vault-list"));
        if (hasGsap) { try { hasGsap.from(sec, { y: 14, opacity: 0, duration: 0.5, ease: "power3.out", clearProps: "all" }); } catch (e) {} }
      }
    }).observe(sec, { attributes: true, attributeFilter: ["hidden"] });
  })();

  // ---------- deep-link arrival: sweep the receive view in ----------
  (function deeplink() {
    if (!/[?&]code=/.test(location.search) || !hasGsap) return;
    try {
      hasGsap.fromTo("#view-receive", { x: 26, opacity: 0 }, { x: 0, opacity: 1, duration: 0.6, delay: 0.35, ease: "power3.out", clearProps: "all" });
      var A = animeFn();
      if (A && $("receive-code")) A({ targets: "#receive-code", scale: [0.97, 1], duration: 600, delay: 700, easing: "easeOutBack" });
    } catch (e) {}
  })();
})();
