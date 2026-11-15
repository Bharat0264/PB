/* "Switch portal" menu: shown only for portals the signed-in person actually has.
 * Any element with data-portal-switch="<this portal>" is filled in. The server decides the list
 * (GET /api/auth/me) and re-issues the right session on a switch (POST /api/auth/switch), so
 * there is no second sign-in. Nothing is rendered for people with a single role.
 */
(() => {
  'use strict';
  let me;

  async function load() {
    if (!me) me = fetch('/api/auth/me', {cache: 'no-store'}).then(response => response.json()).catch(() => ({portals: []}));
    return me;
  }

  async function go(role, fallback) {
    try {
      const response = await fetch('/api/auth/switch', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({portal: role}),
      });
      const data = await response.json();
      location.href = response.ok ? data.path : fallback;
    } catch {
      location.href = fallback;
    }
  }

  async function render() {
    const data = await load();
    for (const mount of document.querySelectorAll('[data-portal-switch]')) {
      const others = (data.portals || []).filter(portal => portal.role !== mount.dataset.portalSwitch);
      mount.replaceChildren();
      mount.hidden = !others.length;
      if (!others.length) continue;
      const title = document.createElement('p');
      title.className = 'pb-switch-title';
      title.textContent = 'Switch portal';
      const list = document.createElement('div');
      list.className = 'pb-switch-list';
      list.setAttribute('role', 'group');
      list.setAttribute('aria-label', 'Switch portal');
      for (const portal of others) {
        const link = document.createElement('a');
        link.className = 'pb-switch-link';
        link.href = portal.path;
        link.textContent = portal.label;
        link.addEventListener('click', event => { event.preventDefault(); go(portal.role, portal.path); });
        list.append(link);
      }
      mount.append(title, list);
    }
  }

  window.PrintBeePortals = {render, reload() { me = null; return render(); }};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render, {once: true});
  else render();
})();
