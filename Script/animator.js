/**
 * animator.js
 * Standalone smooth animations for:
 * 1. Sidebar collapse / expand (#options-sidebar & #btn-toggle-sidebar)
 * 2. Stage tabs & sidebar context panels (.stage-tab, .stage-viewport, .options-context-container)
 * 3. Theme switching (Light <-> Dark smooth crossfade + icon spin)
 */
(function (window, document) {
    'use strict';

    const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    function injectAnimationStyles() {
        if (document.getElementById('geocodile-animator-styles')) return;

        const style = document.createElement('style');
        style.id = 'geocodile-animator-styles';
        style.textContent = `
            /* 1. Smooth Sidebar Collapse / Expand */
            #options-sidebar.sidebar-panel {
                transition: width 0.32s cubic-bezier(0.22, 1, 0.36, 1) !important;
                overflow: hidden !important;
            }
            #options-sidebar .sidebar-header {
                transition: padding 0.28s cubic-bezier(0.22, 1, 0.36, 1) !important;
                overflow: hidden;
            }
            #options-sidebar .sidebar-title,
            #options-sidebar .sidebar-header h2 {
                display: block !important;
                white-space: nowrap;
                overflow: hidden;
                max-width: 220px;
                opacity: 1;
                transform: translateX(0);
                transition: max-width 0.28s cubic-bezier(0.22, 1, 0.36, 1),
                            opacity 0.2s ease,
                            transform 0.25s ease !important;
            }
            #options-sidebar.collapsed .sidebar-title,
            #options-sidebar.collapsed .sidebar-header h2 {
                max-width: 0 !important;
                opacity: 0 !important;
                transform: translateX(-8px) !important;
                pointer-events: none !important;
            }
            /* Override instant display:none on .sidebar-body so it can fade/slide smoothly */
            #options-sidebar .sidebar-body {
                display: block !important;
                min-width: calc(var(--sidebar-w, 280px) - 1px);
                opacity: 1;
                transform: translateX(0);
                transition: opacity 0.22s ease,
                            transform 0.28s cubic-bezier(0.22, 1, 0.36, 1),
                            visibility 0s linear 0s !important;
            }
            #options-sidebar.collapsed .sidebar-body {
                opacity: 0 !important;
                transform: translateX(-14px) !important;
                visibility: hidden !important;
                pointer-events: none !important;
                transition: opacity 0.16s ease,
                            transform 0.22s ease,
                            visibility 0s linear 0.22s !important;
            }
            #btn-toggle-sidebar::before {
                transition: transform 0.32s cubic-bezier(0.22, 1, 0.36, 1) !important;
            }

            /* 2. Tab Button Hover & Active Indicator Smoothness */
            .stage-tab {
                transition: color 0.22s ease,
                            background-color 0.22s ease,
                            border-bottom-color 0.25s ease !important;
            }

            /* 3. Smooth Theme Transition Class (applied temporarily during theme toggle) */
            html.theme-animating,
            html.theme-animating body,
            html.theme-animating .main-header,
            html.theme-animating .sidebar-panel,
            html.theme-animating .sidebar-header,
            html.theme-animating .sidebar-body,
            html.theme-animating .options-group,
            html.theme-animating .stage-area,
            html.theme-animating .stage-tabs-header,
            html.theme-animating .stage-tab,
            html.theme-animating .stage-viewport,
            html.theme-animating .sheet-toolbar,
            html.theme-animating .plot-toolbar,
            html.theme-animating .logs-toolbar,
            html.theme-animating .onboarding-card,
            html.theme-animating .btn-onboarding-card,
            html.theme-animating .app-footer,
            html.theme-animating .submenu,
            html.theme-animating .submenu-level-2,
            html.theme-animating button,
            html.theme-animating input,
            html.theme-animating select,
            html.theme-animating table,
            html.theme-animating th,
            html.theme-animating td {
                transition: background-color 0.38s cubic-bezier(0.4, 0, 0.2, 1),
                            color 0.38s cubic-bezier(0.4, 0, 0.2, 1),
                            border-color 0.38s cubic-bezier(0.4, 0, 0.2, 1),
                            box-shadow 0.38s cubic-bezier(0.4, 0, 0.2, 1) !important;
            }
        `;
        document.head.appendChild(style);
    }

    function animateElement(el, keyframes, options) {
        if (!el || reduceMotionQuery.matches || typeof el.animate !== 'function') return;
        try {
            el.getAnimations().forEach(anim => anim.cancel());
            el.animate(keyframes, options);
        } catch (_) {}
    }

    function initAnimator() {
        if (document.documentElement.dataset.animatorReady === 'true') return;
        document.documentElement.dataset.animatorReady = 'true';

        injectAnimationStyles();

        /* ---------- 1. Tab & Sidebar Context Panel Entrance Animation ---------- */
        const tabBar = document.querySelector('.stage-tabs-header') || document;

        tabBar.addEventListener('click', (e) => {
            const tab = e.target.closest('.stage-tab[data-target-view]');
            if (!tab) return;

            const target = tab.getAttribute('data-target-view');
            if (!target) return;

            // Wait one micro-frame so manager.js finishes toggling .is-active and [hidden]
            requestAnimationFrame(() => {
                const viewport = document.getElementById('viewport-' + target);
                if (viewport && viewport.classList.contains('is-active')) {
                    animateElement(
                        viewport,
                        [
                            { opacity: 0, transform: 'translateY(8px) scale(0.995)' },
                            { opacity: 1, transform: 'translateY(0) scale(1)' }
                        ],
                        { duration: 280, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' }
                    );
                }

                const sidePanel = document.getElementById('options-panel-' + target);
                const sidebar = document.getElementById('options-sidebar');
                if (sidePanel && !sidePanel.classList.contains('hidden') && (!sidebar || !sidebar.classList.contains('collapsed'))) {
                    animateElement(
                        sidePanel,
                        [
                            { opacity: 0, transform: 'translateX(-10px)' },
                            { opacity: 1, transform: 'translateX(0)' }
                        ],
                        { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' }
                    );
                }
            });
        });

        /* ---------- 2. Sidebar Expand Inner Content Animation ---------- */
        const sidebarBtn = document.getElementById('btn-toggle-sidebar');
        const sidebar = document.getElementById('options-sidebar');

        if (sidebarBtn && sidebar) {
            sidebarBtn.addEventListener('click', () => {
                requestAnimationFrame(() => {
                    const isCollapsed = sidebar.classList.contains('collapsed');
                    if (!isCollapsed) {
                        const activePanel = sidebar.querySelector('.options-context-container:not(.hidden)');
                        if (activePanel) {
                            animateElement(
                                activePanel,
                                [
                                    { opacity: 0, transform: 'translateX(-12px)' },
                                    { opacity: 1, transform: 'translateX(0)' }
                                ],
                                { duration: 300, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' }
                            );
                        }
                    }
                });
            });
        }

        /* ---------- 3. Theme Toggle Smooth Crossfade & Icon Spin ---------- */
        let themeTimer = null;
        const root = document.documentElement;

        function triggerThemeTransition() {
            if (reduceMotionQuery.matches) return;
            root.classList.add('theme-animating');
            clearTimeout(themeTimer);
            themeTimer = setTimeout(() => {
                root.classList.remove('theme-animating');
            }, 420);

            const themeBtn = document.getElementById('btn-theme-toggle');
            if (themeBtn) {
                animateElement(
                    themeBtn,
                    [
                        { transform: 'rotate(-75deg) scale(0.75)', opacity: 0.4 },
                        { transform: 'rotate(0deg) scale(1)', opacity: 1 }
                    ],
                    { duration: 340, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
                );
            }
        }

        // Observe changes to data-theme attribute on <html> (works with any ThemeManager or header.js)
        let lastTheme = root.getAttribute('data-theme');
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.attributeName === 'data-theme') {
                    const currentTheme = root.getAttribute('data-theme');
                    if (currentTheme !== lastTheme) {
                        lastTheme = currentTheme;
                        triggerThemeTransition();
                    }
                }
            }
        });
        observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });

        // Pre-arm transition right on pointerdown so the browser catches the start state before data-theme flips
        document.addEventListener('pointerdown', (e) => {
            const trigger = e.target.closest('#btn-theme-toggle, [data-action^="theme:"]');
            if (trigger && !reduceMotionQuery.matches) {
                root.classList.add('theme-animating');
            }
        }, true);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initAnimator);
    } else {
        initAnimator();
    }
})(window, document);
