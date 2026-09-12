/* FileDrop UI helpers — extracted from inline <script> for strict CSP.
 * Owns: resend affordance (100% -> show button), tab aria-pressed sync,
 * receive progress wrapper mirroring. Transfer state lives in app.js.
 * IDs must stay in sync with index.html / app.js.
 */
(function () {
  "use strict";
  var pct = document.getElementById("send-pct");
  var again = document.getElementById("send-again");
  if (pct && again && ("MutationObserver" in window)) {
    new MutationObserver(function () {
      // Numeric (>=100), not exact-string: immune to whitespace/format drift.
      var v = parseFloat((pct.textContent || "").replace("%", ""));
      if (Number.isFinite(v) && v >= 100) again.hidden = false;
    }).observe(pct, { childList: true, characterData: true, subtree: true });
    again.addEventListener("click", function () {
      // Prefer the in-place reset (no PeerJS/IDB reopen, no scroll loss);
      // reload only if app.js never booted.
      try {
        if (window.FDReset && window.FDReset.send) { window.FDReset.send(); return; }
      } catch (e) {}
      location.reload();
    });
  }

  var s = document.getElementById("tab-send"), r = document.getElementById("tab-receive");
  if (s && r) {
    var sync = function () {
      s.setAttribute("aria-pressed", s.classList.contains("active") ? "true" : "false");
      r.setAttribute("aria-pressed", r.classList.contains("active") ? "true" : "false");
    };
    s.addEventListener("click", sync);
    r.addEventListener("click", sync);
  }

  var bar = document.getElementById("receive-progress");
  var wrap = document.getElementById("receive-progressline");
  if (bar && wrap) {
    // Initial sync (both start hidden) + mirror on change.
    wrap.hidden = bar.hidden;
    if ("MutationObserver" in window) {
      new MutationObserver(function () { wrap.hidden = bar.hidden; })
        .observe(bar, { attributes: true, attributeFilter: ["hidden"] });
    }
  }
})();
