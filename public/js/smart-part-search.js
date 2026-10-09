(function (root) {
  'use strict';
  const instances = new WeakMap();
  let nextId = 0;

  function bind(input, options) {
    if (!input || instances.has(input)) return instances.get(input);
    const menu = document.createElement('div');
    menu.className = 'smart-part-menu';
    menu.id = `smart-part-menu-${++nextId}`;
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', 'Matching master parts');
    menu.hidden = true;
    // A modal dialog's top layer must also contain its suggestion popup.
    (input.closest('dialog') || document.body).appendChild(menu);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', menu.id);
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('autocomplete', 'off');
    let sequence = 0, timer, controller, rows = [], active = -1, composing = false, displayedScope = '';
    const scope = () => String(options.getScope?.() || '');

    function position() {
      if (menu.hidden) return;
      const rect = input.getBoundingClientRect();
      const viewport = root.visualViewport;
      const top = viewport?.offsetTop || 0;
      const bottom = top + (viewport?.height || root.innerHeight);
      const below = Math.max(0, bottom - rect.bottom - 8);
      const above = Math.max(0, rect.top - top - 8);
      const flip = below < 100 && above > below;
      const height = Math.min(300, flip ? above : below);
      menu.style.left = `${Math.max(4, rect.left)}px`;
      menu.style.width = `${Math.min(rect.width, (viewport?.width || root.innerWidth) - 8)}px`;
      menu.style.maxHeight = `${height}px`;
      menu.style.top = `${flip ? Math.max(top + 4, rect.top - Math.min(menu.scrollHeight, height) - 4) : rect.bottom + 4}px`;
    }

    function close() {
      clearTimeout(timer);
      controller?.abort();
      sequence++;
      rows = [];
      active = -1;
      menu.hidden = true;
      menu.replaceChildren();
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }

    function choose(index) {
      if (displayedScope !== scope() || input.disabled || options.isEnabled?.() === false) { close(); return; }
      const part = rows[index];
      if (!part) return;
      close();
      input.value = part.partNumber;
      input.focus({ preventScroll: true });
      options.onSelect?.(part);
      // Deliberately do not emit input/change or submit a form.
      input.dispatchEvent(new CustomEvent('smartpartselect', { bubbles: true, detail: part }));
    }

    function render(parts, message = '') {
      displayedScope = scope();
      rows = parts.slice(0, 10);
      active = -1;
      input.removeAttribute('aria-activedescendant');
      menu.replaceChildren();
      rows.forEach((part, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.id = `${menu.id}-${index}`;
        button.className = 'smart-part-option';
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', 'false');
        button.tabIndex = -1;
        const number = document.createElement('strong');
        number.textContent = part.partNumber;
        const details = document.createElement('span');
        details.textContent = [part.partDescription, Number(part.mrp) > 0 ? `MRP ₹${Number(part.mrp).toFixed(2)}` : ''].filter(Boolean).join(' · ');
        button.append(number, details);
        button.addEventListener('pointerdown', event => event.preventDefault());
        button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); choose(index); });
        menu.appendChild(button);
      });
      if (message) {
        const status = document.createElement('div');
        status.className = 'smart-part-status';
        status.setAttribute('role', 'status');
        status.textContent = message;
        menu.appendChild(status);
      }
      menu.hidden = !rows.length && !message;
      input.setAttribute('aria-expanded', String(!menu.hidden));
      position();
    }

    function search() {
      close();
      if (composing || input.disabled || options.isEnabled?.() === false) return;
      const q = input.value.trim().toUpperCase();
      if (!q) return;
      const version = sequence, dealerScope = scope();
      timer = setTimeout(async () => {
        const requestController = new AbortController();
        controller = requestController;
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; requestController.abort(); }, 5000);
        try {
          const data = await options.fetchSuggestions(q, { signal: requestController.signal });
          if (version !== sequence || input.value.trim().toUpperCase() !== q || dealerScope !== scope() || document.activeElement !== input) return;
          render(data.suggestions || [], (data.suggestions || []).length ? '' : 'No matching master parts');
          options.onResults?.(data.suggestions || [], q);
        } catch (error) {
          if (version !== sequence || dealerScope !== scope() || (error.name === 'AbortError' && !timedOut) || document.activeElement !== input) return;
          render([], 'Suggestions unavailable. Keep typing or retry.');
        } finally {
          clearTimeout(timeout);
        }
      }, 200);
    }

    input.addEventListener('input', search);
    input.addEventListener('focus', search);
    input.addEventListener('compositionstart', () => { composing = true; close(); });
    input.addEventListener('compositionend', () => { composing = false; search(); });
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') { close(); return; }
      if (menu.hidden || !rows.length) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopImmediatePropagation();
        active = event.key === 'ArrowDown' ? (active + 1) % rows.length : (active <= 0 ? rows.length - 1 : active - 1);
        [...menu.children].forEach((child, index) => child.setAttribute('aria-selected', String(index === active)));
        input.setAttribute('aria-activedescendant', menu.children[active].id);
        menu.children[active].scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'Enter' && active >= 0) {
        event.preventDefault(); event.stopImmediatePropagation(); choose(active);
      }
    }, true);
    input.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== input) close(); }, 0); });
    input.form?.addEventListener('reset', close);
    document.addEventListener('pointerdown', event => { if (event.target !== input && !menu.contains(event.target)) close(); });
    document.addEventListener('change', () => { if (!menu.hidden) close(); });
    root.addEventListener('resize', position);
    root.addEventListener('scroll', position, true);
    root.visualViewport?.addEventListener('resize', position);
    root.visualViewport?.addEventListener('scroll', position);
    const instance = { close, search };
    instances.set(input, instance);
    return instance;
  }
  root.SmartPartSearch = { bind };
})(window);
