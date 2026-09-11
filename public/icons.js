/* FileDrop custom SVG icons — one source for every UI glyph (no emoji).
 * Loads before app.js so transfer UI can stamp warning badges with icons.
 * Exposes window.FDIcon.svg(name) -> markup string and
 * window.FDIcon.el(name) -> inline <svg> element. All icons inherit
 * currentColor, so they follow their badge/button text color.
 */
(function () {
  "use strict";
  var PATHS = {
    warn: '<path d="M12 3.5 2.8 19.5h18.4L12 3.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' +
      '<path d="M12 9.5v4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
      '<circle cx="12" cy="16.8" r="1.2" fill="currentColor"/>',
    check: '<path d="M4.5 12.5 10 18 19.5 6.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
    soundOn: '<path d="M4 9.5v5h3.5L13 19V5L7.5 9.5H4z" fill="currentColor"/>' +
      '<path d="M15.5 9a4.5 4.5 0 0 1 0 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
      '<path d="M18 6.3a8.2 8.2 0 0 1 0 11.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    soundOff: '<path d="M4 9.5v5h3.5L13 19V5L7.5 9.5H4z" fill="currentColor"/>' +
      '<path d="M15.5 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
  };
  function svg(name, cls) {
    return '<svg class="fd-icon ' + (cls || "") + '" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">' +
      (PATHS[name] || "") + "</svg>";
  }
  function el(name, cls) {
    var t = document.createElement("span");
    t.innerHTML = svg(name, cls);
    return t.firstChild;
  }
  window.FDIcon = { svg: svg, el: el };
})();
