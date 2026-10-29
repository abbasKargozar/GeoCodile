/**
 * manager.js
 * Main Application Bootstrapper — coordinates and initializes all UI modules once.
 */
(function (window, document) {
    'use strict';

    function bootstrap() {
        // 1. Sync theme checkmarks in the View -> Theme menu
        if (window.ThemeManager && typeof window.ThemeManager.syncIndicators === 'function') {
            window.ThemeManager.syncIndicators();
        }

        // 2. Initialize top menu bar and nested submenus
        if (window.MenuController && typeof window.MenuController.init === 'function') {
            window.MenuController.init();
        }

        // 3. Initialize sidebar collapse button and stage tabs
        if (window.ThemeToggle && typeof window.ThemeToggle.init === 'function') {
            window.ThemeToggle.init();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }
})(window, document);
