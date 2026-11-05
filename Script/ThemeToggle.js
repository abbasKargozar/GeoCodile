/**
 * ThemeToggle.js
 * Manages workspace UI state: Sidebar collapsing and Stage Tab switching.
 */
(function (window, document) {
    'use strict';

    let initialized = false;

    function initSidebarCollapse() {
        const btn = document.getElementById('btn-toggle-sidebar');
        const sidebar = document.getElementById('options-sidebar');
        if (!btn || !sidebar) return;

        // Clear text content so CSS ::before chevron renders cleanly
        btn.textContent = '';
        btn.setAttribute('aria-controls', 'options-sidebar');

        const syncState = () => {
            const isCollapsed = sidebar.classList.contains('collapsed');
            btn.setAttribute('aria-expanded', String(!isCollapsed));
            btn.setAttribute('aria-label', isCollapsed ? 'Expand options panel' : 'Collapse options panel');
            btn.title = isCollapsed ? 'Expand Options Panel' : 'Collapse Options Panel';
        };

        syncState();

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            sidebar.classList.toggle('collapsed');
            syncState();
        });
    }

    function initTabs() {
        const tabs = document.querySelectorAll('.stage-tab[data-target-view]');
        const viewports = document.querySelectorAll('.stage-viewport');
        const optionPanels = document.querySelectorAll('.options-context-container');

        if (!tabs.length) return;

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const target = tab.getAttribute('data-target-view');
                if (!target) return;

                // 1. Update active state on stage tabs
                tabs.forEach(t => {
                    const active = (t === tab);
                    t.classList.toggle('is-active', active);
                    t.setAttribute('aria-selected', String(active));
                });

                // 2. Toggle corresponding central viewports
                viewports.forEach(vp => {
                    const match = (vp.id === `viewport-${target}`);
                    vp.classList.toggle('is-active', match);
                    if (match) {
                        vp.removeAttribute('hidden');
                    } else {
                        vp.setAttribute('hidden', '');
                    }
                });

                // 3. Toggle corresponding sidebar option panels
                optionPanels.forEach(panel => {
                    const match = (panel.id === `options-panel-${target}`);
                    panel.classList.toggle('is-active', match);
                    if (match) {
                        panel.removeAttribute('hidden');
                    } else {
                        panel.setAttribute('hidden', '');
                    }
                });
            });
        });
    }

    function init() {
        if (initialized) return;
        initialized = true;
        initSidebarCollapse();
        initTabs();
    }

    window.ThemeToggle = { init };
})(window, document);
