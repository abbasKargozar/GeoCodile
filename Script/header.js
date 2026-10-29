/**
 * header.js
 * Standalone controller for #app-header:
 * Handles #main-menu (.menu-root), nested .submenu-level-2, and #btn-theme-toggle.
 * Zero modification required to existing scripts.
 */
(function (window, document) {
    'use strict';

    const OPEN_CLASS = 'is-open';
    const FLIP_CLASS = 'flip-x';
    const HOVER_CLOSE_DELAY = 280;

    function initHeader() {
        const header = document.getElementById('app-header') || document.querySelector('.main-header');
        const menuRoot = document.getElementById('main-menu') || document.querySelector('.menu-root');
        if (!menuRoot) return;

        // Prevent duplicate binding if already initialized
        if (menuRoot.dataset.headerReady === 'true') return;
        menuRoot.dataset.headerReady = 'true';

        const topItems = Array.from(menuRoot.querySelectorAll(':scope > .menu-item.has-submenu'));
        const nestedItems = Array.from(menuRoot.querySelectorAll('.submenu-item.has-submenu'));
        const closeTimers = new WeakMap();

        /* ---------- Helper Functions ---------- */

        function clearTimer(el) {
            if (closeTimers.has(el)) {
                clearTimeout(closeTimers.get(el));
                closeTimers.delete(el);
            }
        }

        function adjustViewportPosition(panel, isNested) {
            if (!panel) return;
            panel.classList.remove(FLIP_CLASS);
            const rect = panel.getBoundingClientRect();
            const vw = document.documentElement.clientWidth;
            const isRTL = getComputedStyle(header || document.documentElement).direction === 'rtl';

            if (!isRTL && rect.right > vw - 8) {
                panel.classList.add(FLIP_CLASS);
            } else if (isRTL && rect.left < 8) {
                panel.classList.add(FLIP_CLASS);
            }

            if (isNested) {
                panel.style.top = '';
                const updatedRect = panel.getBoundingClientRect();
                const vh = document.documentElement.clientHeight;
                if (updatedRect.bottom > vh - 8) {
                    const shift = vh - updatedRect.bottom - 10;
                    panel.style.top = `${shift}px`;
                }
            }
        }

        function setTopOpen(item, open) {
            const title = item.querySelector(':scope > .menu-title');
            const panel = item.querySelector(':scope > .submenu');
            if (!panel) return;

            item.classList.toggle(OPEN_CLASS, open);
            if (title) title.setAttribute('aria-expanded', String(open));

            if (open) {
                adjustViewportPosition(panel, false);
            } else {
                // Close any open nested submenus inside
                item.querySelectorAll('.' + OPEN_CLASS).forEach(sub => {
                    clearTimer(sub);
                    sub.classList.remove(OPEN_CLASS);
                    const subTitle = sub.querySelector(':scope > .submenu-title');
                    if (subTitle) subTitle.setAttribute('aria-expanded', 'false');
                });
            }
        }

        function setNestedOpen(subItem, open) {
            clearTimer(subItem);
            const title = subItem.querySelector(':scope > .submenu-title');
            const panel = subItem.querySelector(':scope > .submenu-level-2');
            if (!panel) return;

            subItem.classList.toggle(OPEN_CLASS, open);
            if (title) title.setAttribute('aria-expanded', String(open));

            if (open) {
                adjustViewportPosition(panel, true);
            }
        }

        function closeAllMenus() {
            topItems.forEach(item => setTopOpen(item, false));
        }

        function isAnyTopOpen() {
            return topItems.some(item => item.classList.contains(OPEN_CLASS));
        }

        /* ---------- 1. Top-Level Menu Bar (File, Classification, etc.) ---------- */

        topItems.forEach(item => {
            const title = item.querySelector(':scope > .menu-title');
            if (!title) return;

            title.setAttribute('tabindex', '0');
            title.setAttribute('role', 'menuitem');
            title.setAttribute('aria-haspopup', 'true');
            title.setAttribute('aria-expanded', 'false');

            // Click on top menu title toggles dropdown
            title.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const willOpen = !item.classList.contains(OPEN_CLASS);
                topItems.forEach(other => {
                    if (other !== item) setTopOpen(other, false);
                });
                setTopOpen(item, willOpen);
            });

            // Desktop hover-switch when one menu is already open
            item.addEventListener('mouseenter', () => {
                if (isAnyTopOpen() && !item.classList.contains(OPEN_CLASS)) {
                    topItems.forEach(other => {
                        if (other !== item) setTopOpen(other, false);
                    });
                    setTopOpen(item, true);
                }
            });
        });

        /* ---------- 2. Nested Submenus (e.g., Export -> PNG/SVG/PDF/CSV) ---------- */

        nestedItems.forEach(subItem => {
            // Ensure proper anchor positioning even if CSS rule was missed
            if (getComputedStyle(subItem).position === 'static') {
                subItem.style.position = 'relative';
            }

            const subTitle = subItem.querySelector(':scope > .submenu-title');
            if (subTitle) {
                subTitle.setAttribute('tabindex', '0');
                subTitle.setAttribute('aria-haspopup', 'true');
                subTitle.setAttribute('aria-expanded', 'false');
            }

            const closeSiblingNested = () => {
                if (!subItem.parentElement) return;
                Array.from(subItem.parentElement.children).forEach(sibling => {
                    if (sibling !== subItem && sibling.classList.contains(OPEN_CLASS)) {
                        setNestedOpen(sibling, false);
                    }
                });
            };

            subItem.addEventListener('mouseenter', () => {
                clearTimer(subItem);
                closeSiblingNested();
                setNestedOpen(subItem, true);
            });

            subItem.addEventListener('mouseleave', () => {
                clearTimer(subItem);
                const timer = setTimeout(() => setNestedOpen(subItem, false), HOVER_CLOSE_DELAY);
                closeTimers.set(subItem, timer);
            });

            if (subTitle) {
                subTitle.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const willOpen = !subItem.classList.contains(OPEN_CLASS);
                    closeSiblingNested();
                    setNestedOpen(subItem, willOpen);
                });
            }
        });

        /* ---------- 3. Menu Item Action Clicks ---------- */

        menuRoot.addEventListener('click', (e) => {
            const actionEl = e.target.closest('[data-action]');
            if (!actionEl) return;

            // Ignore clicks on parent submenu triggers
            if (actionEl.classList.contains('has-submenu')) return;

            const action = actionEl.getAttribute('data-action');

            // Handle theme selection items inside menu (if clicked)
            if (action && action.startsWith('theme:set-')) {
                const mode = action.replace('theme:set-', '');
                applyHeaderTheme(mode);
            }

            closeAllMenus();

            // Broadcast standard event for the rest of the application
            window.dispatchEvent(new CustomEvent('geocodile:action', {
                detail: { action: action, source: actionEl }
            }));
        });

        /* ---------- 4. Header Moon/Sun Theme Button (#btn-theme-toggle) ---------- */

        const themeBtn = document.getElementById('btn-theme-toggle') ||
                         (header && header.querySelector('[data-action="theme:toggle"]'));

        function applyHeaderTheme(targetMode) {
            if (window.ThemeManager && typeof window.ThemeManager.setMode === 'function') {
                window.ThemeManager.setMode(targetMode);
                return;
            }
            const root = document.documentElement;
            const resolved = targetMode === 'auto'
                ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
                : targetMode;
            root.setAttribute('data-theme-mode', targetMode);
            root.setAttribute('data-theme', resolved);
            try { localStorage.setItem('app-theme', targetMode); } catch (_) {}
        }

        if (themeBtn && themeBtn.dataset.headerThemeBound !== 'true') {
            themeBtn.dataset.headerThemeBound = 'true';
            themeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (window.ThemeManager && typeof window.ThemeManager.toggle === 'function') {
                    window.ThemeManager.toggle();
                } else {
                    const current = document.documentElement.getAttribute('data-theme') || 'light';
                    applyHeaderTheme(current === 'dark' ? 'light' : 'dark');
                }
            });
        }

        /* ---------- 5. Outside Click & Escape Key ---------- */

        document.addEventListener('pointerdown', (e) => {
            if (!menuRoot.contains(e.target)) {
                closeAllMenus();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && isAnyTopOpen()) {
                closeAllMenus();
            }
        });

        window.addEventListener('resize', closeAllMenus, { passive: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initHeader);
    } else {
        initHeader();
    }
})(window, document);
