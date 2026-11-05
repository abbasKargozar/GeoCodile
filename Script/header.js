/**
 * header.js
 * Handles actions outside the dropdown controller, including the header theme button.
 */
(function (window, document) {
  "use strict";

  function initHeader() {
    const themeButton = document.getElementById("btn-theme-toggle");
    if (!themeButton) return;

    themeButton.addEventListener("click", (event) => {
      event.preventDefault();
      if (window.ThemeManager && typeof window.ThemeManager.toggle === "function") {
        window.ThemeManager.toggle();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initHeader, { once: true });
  } else {
    initHeader();
  }
})(window, document);
