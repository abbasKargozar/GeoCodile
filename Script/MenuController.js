/**
 * MenuController.js
 * Accessible desktop menu bar with reliable nested submenus and keyboard navigation.
 */
(function (window, document) {
    'use strict';

    const OPEN_CLASS = 'is-open';
    const SUB_TIMER = new WeakMap();
    let initialized = false;

    const qsa = (s, c = document) => Array.from(c.querySelectorAll(s));
    const isRTL = () => getComputedStyle(document.documentElement).direction === 'rtl';

    function clearSubTimer(li) {
        if (SUB_TIMER.has(li)) {
            clearTimeout(SUB_TIMER.get(li));
            SUB_TIMER.delete(li);
        }
    }

    function place(panel, anchor, topLevel) {
        if (!panel || !anchor) return;
        panel.style.left = panel.style.right = panel.style.top = '';
        const a = anchor.getBoundingClientRect();
        const vw = document.documentElement.clientWidth;
        const vh = document.documentElement.clientHeight;
        const rtl = isRTL();

        if (topLevel) {
            const r = panel.getBoundingClientRect();
            if (!rtl && a.left + r.width > vw - 8) {
                panel.style.left = 'auto';
                panel.style.right = '0';
            } else if (rtl && a.right - r.width < 8) {
                panel.style.right = 'auto';
                panel.style.left = '0';
            }
        } else {
            panel.style.top = '-4px';
            panel.style.left = rtl ? 'auto' : '100%';
            panel.style.right = rtl ? '100%' : 'auto';
            const r = panel.getBoundingClientRect();

            if (!rtl && r.right > vw - 8) {
                panel.style.left = 'auto';
                panel.style.right = '100%';
            } else if (rtl && r.left < 8) {
                panel.style.right = 'auto';
                panel.style.left = '100%';
            }
            if (r.bottom > vh - 8) {
                panel.style.top = Math.max(-a.top + 8, vh - r.bottom - 8) + 'px';
            }
        }
    }

    function setOpen(li, open, topLevel) {
        if (!li) return;
        clearSubTimer(li);
        const trig = li.querySelector(topLevel ? ':scope > .menu-trigger' : ':scope > .submenu-link');
        const panel = li.querySelector(':scope > .submenu');
        if (!panel) return;

        li.classList.toggle(OPEN_CLASS, open);
        if (trig) trig.setAttribute('aria-expanded', String(open));

        if (open) {
            place(panel, li, topLevel);
        } else {
            qsa('.' + OPEN_CLASS, panel).forEach(n => setOpen(n, false, false));
        }
    }

    function closeSiblings(li, topLevel) {
        if (!li || !li.parentElement) return;
        qsa(':scope > .' + OPEN_CLASS, li.parentElement).forEach(s => {
            if (s !== li) setOpen(s, false, topLevel);
        });
    }

    function init() {
        if (initialized) return;
        const bar = document.querySelector('.menu-bar');
        if (!bar) return;
        initialized = true;

        const tops = qsa(':scope > .menu-item', bar);
        const anyTopOpen = () => tops.some(t => t.classList.contains(OPEN_CLASS));
        const closeAll = () => tops.forEach(t => setOpen(t, false, true));

        // Top-level menu items
        tops.forEach(li => {
            const trig = li.querySelector(':scope > .menu-trigger');
            if (!trig) return;

            trig.addEventListener('click', e => {
                e.stopPropagation();
                const open = !li.classList.contains(OPEN_CLASS);
                closeSiblings(li, true);
                setOpen(li, open, true);
            });

            li.addEventListener('mouseenter', () => {
                if (anyTopOpen() && !li.classList.contains(OPEN_CLASS)) {
                    closeSiblings(li, true);
                    setOpen(li, true, true);
                }
            });
        });

        // Nested submenus (e.g., Export)
        qsa('.submenu-item', bar).forEach(li => {
            const sub = li.querySelector(':scope > .submenu');
            if (!sub) return;
            const trig = li.querySelector(':scope > .submenu-link');

            li.addEventListener('mouseenter', () => {
                clearSubTimer(li);
                closeSiblings(li, false);
                setOpen(li, true, false);
            });

            li.addEventListener('mouseleave', () => {
                clearSubTimer(li);
                SUB_TIMER.set(li, setTimeout(() => setOpen(li, false, false), 300));
            });

            if (trig) {
                trig.addEventListener('click', e => {
                    e.preventDefault();
                    e.stopPropagation();
                    clearSubTimer(li);
                    const isOpen = li.classList.contains(OPEN_CLASS);
                    closeSiblings(li, false);
                    setOpen(li, !isOpen, false);
                });
            }
        });

        // Action clicks (leaf items)
        bar.addEventListener('click', e => {
            const link = e.target.closest('.submenu-link[data-action]');
            if (!link) return;
            const li = link.parentElement;
            if (li && li.querySelector(':scope > .submenu')) return; // Ignore parent triggers

            const action = link.getAttribute('data-action');
            if (action && action.startsWith('theme:set-') && window.ThemeManager) {
                window.ThemeManager.setMode(action.replace('theme:set-', ''));
            }

            closeAll();
            window.dispatchEvent(new CustomEvent('app:action', {
                detail: { action, trigger: link }
            }));
        });

        // Close only when clicking outside the menu bar
        document.addEventListener('pointerdown', e => {
            if (!bar.contains(e.target)) closeAll();
        });

        // Keyboard navigation
        bar.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                closeAll();
                return;
            }
            const item = e.target.closest('.submenu-link, .menu-trigger');
            if (!item) return;

            const list = item.closest('.submenu, .menu-bar');
            const items = qsa(':scope > li > .submenu-link:not(:disabled), :scope > li > .menu-trigger', list);
            const i = items.indexOf(item);

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                items[(i + 1) % items.length]?.focus();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                items[(i - 1 + items.length) % items.length]?.focus();
            } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                const subLi = item.parentElement;
                const hasSub = subLi?.querySelector(':scope > .submenu');
                const forward = (e.key === 'ArrowRight') !== isRTL();

                if (forward && hasSub) {
                    e.preventDefault();
                    setOpen(subLi, true, false);
                    hasSub.querySelector('.submenu-link')?.focus();
                } else if (!forward && list.classList.contains('submenu')) {
                    const parentLi = list.parentElement;
                    if (parentLi?.classList.contains('submenu-item')) {
                        e.preventDefault();
                        setOpen(parentLi, false, false);
                        parentLi.querySelector(':scope > .submenu-link')?.focus();
                    }
                }
            }
        });

        window.addEventListener('resize', closeAll, { passive: true });
    }

    window.MenuController = { init };
})(window, document);
