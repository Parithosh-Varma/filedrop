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
      if (pct.textContent.trim() === "100%") again.hidden = false;
    }).observe(pct, { childList: true, characterData: true, subtree: true });
    again.addEventListener("click", function () { location.reload(); });
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

  // Companion ad: first dropzone interaction per session opens the sponsor
  // Direct Link in a new tab. Runs synchronously inside the real gesture so
  // popup blockers allow it; never preventDefault — the file picker opens
  // normally alongside. Session-gated, storage failures never break the UI.
  try {
    var dz = document.getElementById("dropzone");
    if (dz && !sessionStorage.getItem("fd-adlink")) {
      dz.addEventListener("click", function () {
        try { sessionStorage.setItem("fd-adlink", "1"); } catch (e) {}
        window.open("https://www.profitableratecpmnetwork.com/dg954971g?key=2d939674709ef50262fff58454043ed6", "_blank", "noopener");
      });
    }
  } catch (e) { /* ad companion must never break the UI */ }
})();
