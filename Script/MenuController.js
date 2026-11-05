/**
 * MenuController.js
 * Controls the desktop header menu and its nested dropdowns.
 */
(function (window, document) {
    'use strict';

    const OPEN_CLASS = 'is-open';
    const ROOT_SELECTOR = '#main-menu';
    let initialized = false;

    const direct = (parent, selector) => parent ? parent.querySelector(`:scope > ${selector}`) : null;
    const all = (parent, selector) => parent ? Array.from(parent.querySelectorAll(selector)) : [];

    function setExpanded(item, expanded) {
        const title = direct(item, item.classList.contains('menu-item') ? '.menu-title' : '.submenu-title');
        if (title) title.setAttribute('aria-expanded', String(expanded));
    }

    function closeItem(item) {
        if (!item) return;
        item.classList.remove(OPEN_CLASS);
        setExpanded(item, false);
        all(item, `.${OPEN_CLASS}`).forEach(child => {
            child.classList.remove(OPEN_CLASS);
            setExpanded(child, false);
        });
    }

    function closeAll(root) {
        all(root, `.${OPEN_CLASS}`).forEach(item => {
            if (item.classList.contains('menu-item') || item.classList.contains('submenu-item')) {
                closeItem(item);
            }
        });
    }

    function closeSiblings(item) {
        const parent = item && item.parentElement;
        if (!parent) return;
        Array.from(parent.children).forEach(sibling => {
            if (sibling !== item && sibling.matches('.menu-item.is-open, .submenu-item.is-open')) {
                closeItem(sibling);
            }
        });
    }

    function toggleItem(item) {
        const isOpen = item.classList.contains(OPEN_CLASS);
        closeSiblings(item);
        if (isOpen) {
            closeItem(item);
        } else {
            item.classList.add(OPEN_CLASS);
            setExpanded(item, true);
        }
    }

    function prepareTitle(title) {
        title.setAttribute('role', 'button');
        title.setAttribute('tabindex', '0');
        title.setAttribute('aria-haspopup', 'true');
        title.setAttribute('aria-expanded', 'false');
    }

    function init() {
        if (initialized) return;
        const root = document.querySelector(ROOT_SELECTOR);
        if (!root) return;
        initialized = true;

        const topItems = all(root, ':scope > .menu-item.has-submenu');
        const nestedItems = all(root, '.submenu-item.has-submenu');
        const titles = [
            ...topItems.map(item => ({ item, title: direct(item, '.menu-title') })),
            ...nestedItems.map(item => ({ item, title: direct(item, '.submenu-title') }))
        ].filter(entry => entry.title);

        titles.forEach(({ item, title }) => {
            prepareTitle(title);
            title.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                toggleItem(item);
            });
            title.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    toggleItem(item);
                } else if (event.key === 'Escape') {
                    event.preventDefault();
                    closeAll(root);
                    title.focus();
                }
            });
        });

        all(root, '[data-action]').forEach(actionItem => {
            if (actionItem.matches('.menu-title, .submenu-title')) return;
            actionItem.setAttribute('role', 'menuitem');
            actionItem.setAttribute('tabindex', '0');
            actionItem.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    actionItem.click();
                }
            });
        });

        root.addEventListener('click', event => {
            const actionItem = event.target.closest('[data-action]');
            if (!actionItem || !root.contains(actionItem)) return;
            if (actionItem.matches('.menu-title, .submenu-title')) return;
            const action = actionItem.getAttribute('data-action');
            if (action && action.startsWith('theme:set-') && window.ThemeManager) {
                window.ThemeManager.setMode(action.slice('theme:set-'.length));
            }
            closeAll(root);
            const actionEvent = new CustomEvent('geocodile:action', {
                bubbles: true,
                cancelable: true,
                detail: { action, source: actionItem }
            });
            window.dispatchEvent(actionEvent);
            document.dispatchEvent(actionEvent);
        });

        document.addEventListener('pointerdown', event => {
            if (!root.contains(event.target)) closeAll(root);
        });

        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') closeAll(root);
        });
    }

    window.MenuController = { init };
})(window, document);
