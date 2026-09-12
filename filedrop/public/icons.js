/* FileDrop custom SVG icons — one source for every UI glyph (no emoji).
 * Loads before app.js so transfer UI can stamp warning badges with icons.
 * Exposes window.FDIcon.el(name) -> inline <svg> element only (real DOM
 * nodes, no innerHTML sink anywhere). All icons inherit currentColor, so
 * they follow their badge/button text color.
 *
 * Hardened: `name` is allowlisted to PATHS keys and `cls` to
 * [A-Za-z0-9-_ ] (max 64 chars), so neither can break out of the
 * class attribute. Unknown names fall back to "warn" so a typo renders a
 * visible badge instead of silently dropping the warning.
 */
(function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";
  // Path data only — no markup, so names cannot inject attributes.
  var PATHS = {
    warn: [
      { t: "path", d: "M12 3.5 2.8 19.5h18.4L12 3.5z", w: "2", j: true },
      { t: "path", d: "M12 9.5v4.5", w: "2" },
      { t: "circle", cx: "12", cy: "16.8", r: "1.2", fill: true }
    ],
    check: [{ t: "path", d: "M4.5 12.5 10 18 19.5 6.5", w: "2.6", j: true }],
    info: [
      { t: "path", d: "M12 3.5a8.5 8.5 0 1 0 0.001 0", w: "2" },
      { t: "path", d: "M12 11v5", w: "2" },
      { t: "circle", cx: "12", cy: "7.8", r: "1.2", fill: true }
    ],
    soundOn: [
      { t: "path", d: "M4 9.5v5h3.5L13 19V5L7.5 9.5H4z", fill: true },
      { t: "path", d: "M15.5 9a4.5 4.5 0 0 1 0 6", w: "1.8" },
      { t: "path", d: "M18 6.3a8.2 8.2 0 0 1 0 11.4", w: "1.8" }
    ],
    soundOff: [
      { t: "path", d: "M4 9.5v5h3.5L13 19V5L7.5 9.5H4z", fill: true },
      { t: "path", d: "M15.5 9.5l5 5m0-5l-5 5", w: "1.8" }
    ]
  };
  function cleanCls(cls) {
    return String(cls || "").replace(/[^A-Za-z0-9\-_ ]/g, "").slice(0, 64).trim();
  }
  function hasIcon(name) {
    return Object.prototype.hasOwnProperty.call(PATHS, name);
  }
  function paintShape(svgEl, shape) {
    var n;
    if (shape.t === "circle") {
      n = document.createElementNS(NS, "circle");
      n.setAttribute("cx", shape.cx);
      n.setAttribute("cy", shape.cy);
      n.setAttribute("r", shape.r);
      n.setAttribute("fill", "currentColor");
    } else {
      n = document.createElementNS(NS, "path");
      n.setAttribute("d", shape.d);
      if (shape.fill) {
        n.setAttribute("fill", "currentColor");
      } else {
        n.setAttribute("fill", "none");
        n.setAttribute("stroke", "currentColor");
        n.setAttribute("stroke-width", shape.w || "1.8");
        n.setAttribute("stroke-linecap", "round");
        if (shape.j) n.setAttribute("stroke-linejoin", "round");
      }
    }
    svgEl.appendChild(n);
  }
  function makeSvg(name, cls) {
    var svgEl = document.createElementNS(NS, "svg");
    svgEl.setAttribute("viewBox", "0 0 24 24");
    svgEl.setAttribute("width", "16");
    svgEl.setAttribute("height", "16");
    svgEl.setAttribute("aria-hidden", "true");
    var c = "fd-icon" + (cleanCls(cls) ? " " + cleanCls(cls) : "");
    svgEl.setAttribute("class", c);
    if (!hasIcon(name)) return svgEl;
    var shapes = PATHS[name];
    for (var i = 0; i < shapes.length; i++) paintShape(svgEl, shapes[i], i);
    return svgEl;
  }
  function el(name, cls) {
    return makeSvg(hasIcon(name) ? name : "warn", cls);
  }
  window.FDIcon = { el: el };
})();
