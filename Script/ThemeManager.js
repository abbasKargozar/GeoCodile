/**
 * ThemeManager.js
 * Manages application theme (light / dark / auto) with pre-paint initialization.
 */
(function (window, document) {
    'use strict';

    const STORAGE_KEY = 'app-theme';
    const VALID_MODES = ['light', 'dark', 'auto'];
    const DEFAULT_MODE = 'auto';

    const root = document.documentElement;
    const mediaQuery = window.matchMedia
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;

    function getStoredMode() {
        try {
            const val = localStorage.getItem(STORAGE_KEY);
            return VALID_MODES.includes(val) ? val : DEFAULT_MODE;
        } catch (_) {
            return DEFAULT_MODE;
        }
    }

    function saveMode(mode) {
        try {
            localStorage.setItem(STORAGE_KEY, mode);
        } catch (_) {
            /* Ignore storage errors in private browsing */
        }
    }

    function resolveEffectiveTheme(mode) {
        if (mode === 'auto') {
            return (mediaQuery && mediaQuery.matches) ? 'dark' : 'light';
        }
        return mode;
    }

    function updateMenuIndicators(mode, effective) {
        const items = document.querySelectorAll('[data-action^="theme:set-"]');
        items.forEach(item => {
            const action = item.getAttribute('data-action');
            const itemMode = action.replace('theme:set-', '');
            const isActive = (itemMode === mode) || (mode === 'auto' && itemMode === effective);

            item.setAttribute('aria-checked', isActive ? 'true' : 'false');
            item.classList.toggle('is-checked', isActive);
        });
    }

    function applyTheme(mode) {
        const validMode = VALID_MODES.includes(mode) ? mode : DEFAULT_MODE;
        const effective = resolveEffectiveTheme(validMode);

        root.setAttribute('data-theme-mode', validMode);
        root.setAttribute('data-theme', effective);

        updateMenuIndicators(validMode, effective);

        window.dispatchEvent(new CustomEvent('themeChanged', {
            detail: { mode: validMode, effective: effective }
        }));
    }

    function setMode(mode) {
        if (!VALID_MODES.includes(mode)) return;
        saveMode(mode);
        applyTheme(mode);
    }

    // Immediate execution before first paint to prevent white flash
    applyTheme(getStoredMode());

    // Listen for OS theme changes when in 'auto' mode
    if (mediaQuery) {
        const handleSystemChange = () => {
            if (getStoredMode() === 'auto') {
                applyTheme('auto');
            }
        };
        if (typeof mediaQuery.addEventListener === 'function') {
            mediaQuery.addEventListener('change', handleSystemChange);
        } else if (typeof mediaQuery.addListener === 'function') {
            mediaQuery.addListener(handleSystemChange);
        }
    }

    window.ThemeManager = {
        setMode: setMode,
        getMode: getStoredMode,
        getEffectiveTheme: () => resolveEffectiveTheme(getStoredMode()),
        toggle: function () {
            const current = resolveEffectiveTheme(getStoredMode());
            setMode(current === 'dark' ? 'light' : 'dark');
        },
        syncIndicators: () => updateMenuIndicators(getStoredMode(), resolveEffectiveTheme(getStoredMode()))
    };
})(window, document);
