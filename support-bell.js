/* The customer's support bell: "staff replied", "status changed", "resolved". Added to the header of every customer page.
 *
 * A notification only ever says what happened and to which ticket NUMBER. It never shows the subject or the conversation, so
 * it is safe on a shared screen; the text is set with textContent. Nothing is shown to signed-out visitors.
 */
(() => {
  'use strict';
  const actions = document.querySelector('.customer-header-actions');
  if (!actions || document.querySelector('.support-bell')) return;
  const embedded = window.parent !== window;
  const KINDS = {staff_reply: 'M4 5h16v11H9l-5 4z', status: 'M5 12l4 4L19 6', resolved: 'M5 12l4 4L19 6'};
  const style = document.createElement('style');
  style.textContent = `
  .support-bell-wrap { position: relative; display: inline-flex; }
  .support-bell { position: relative; display: grid; place-items: center; width: 46px; height: 46px; padding: 0; border: 0; border-radius: 50%; cursor: pointer;
    background: var(--hv-surface, #fff); color: var(--hv-ink, #2a2112); box-shadow: var(--hv-sh-1, 0 2px 6px rgba(110,80,28,.2)); }
  .support-bell svg { width: 22px; height: 22px; display: block; }
  .support-bell-badge { position: absolute; top: -3px; right: -3px; min-width: 20px; height: 20px; padding: 0 5px; box-sizing: border-box; border-radius: 999px; display: grid; place-items: center;
    background: #d64545; color: #fff; font: 800 11.5px/1 Manrope, system-ui, sans-serif; box-shadow: 0 0 0 2px var(--hv-page-bg, #ece4d3); }
  .support-bell-badge[hidden] { display: none; }
  .support-bell-panel { position: absolute; z-index: 90; top: calc(100% + 10px); right: 0; width: min(340px, calc(100vw - 24px)); max-height: min(70vh, 460px); overflow: auto; padding: 14px;
    border-radius: 24px; background: var(--hv-surface, #fff); color: var(--hv-ink, #2a2112); box-shadow: var(--hv-sh-3, 0 12px 40px rgba(60,45,15,.25)); text-align: start; }
  .support-bell-panel[hidden] { display: none; }
  .support-bell-panel h2 { margin: 2px 6px 10px; font-size: 16px; }
  .support-bell-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
  .support-bell-item { display: flex; align-items: center; gap: 12px; width: 100%; box-sizing: border-box; padding: 10px 12px; border: 0; border-radius: 16px; cursor: pointer; text-align: start;
    background: var(--hv-surface-2, #fff6dd); color: inherit; font: 600 14px/1.35 Manrope, system-ui, sans-serif; text-decoration: none; }
  .support-bell-item.is-unread { background: color-mix(in srgb, var(--hv-honey-300, #fbe08a) 40%, var(--hv-surface, #fff)); font-weight: 800; }
  .support-bell-item .dot { flex: none; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; background: var(--hv-honey-grad, #f5c542); color: #2a2112; }
  .support-bell-item .dot svg { width: 18px; height: 18px; }
  .support-bell-item small { display: block; font-weight: 600; color: var(--hv-muted, #6e5e3e); }
  .support-bell-empty { margin: 8px 6px 14px; color: var(--hv-muted, #6e5e3e); }
  @media (max-width: 560px) { .support-bell-panel { position: fixed; left: 12px; right: 12px; top: 76px; width: auto; max-height: calc(100vh - 160px); } }
  .support-bell-foot { display: flex; justify-content: space-between; gap: 8px; margin-top: 10px; }
  .support-bell-foot a, .support-bell-foot button { border: 0; background: none; padding: 8px 10px; border-radius: 999px; cursor: pointer; font: 800 13px Manrope, system-ui, sans-serif; color: var(--hv-honey-ink, #7a5208); text-decoration: none; }
  .support-bell-foot button:disabled { opacity: .45; cursor: default; }`;
  document.head.append(style);

  const ns = 'http://www.w3.org/2000/svg';
  const icon = (path, label) => {
    const svg = document.createElementNS(ns, 'svg');
    for (const [k, v] of Object.entries({viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'})) svg.setAttribute(k, v);
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', path);
    svg.append(p);
    return svg;
  };
  const wrap = document.createElement('span');
  wrap.className = 'support-bell-wrap';
  const bell = document.createElement('button');
  bell.type = 'button';
  bell.className = 'support-bell';
  bell.setAttribute('aria-label', 'Support notifications');
  bell.setAttribute('aria-haspopup', 'true');
  bell.setAttribute('aria-expanded', 'false');
  bell.append(icon('M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M10 20a2 2 0 0 0 4 0'));
  const badge = document.createElement('span');
  badge.className = 'support-bell-badge';
  badge.hidden = true;
  bell.append(badge);
  const panel = document.createElement('div');
  panel.className = 'support-bell-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Support notifications');
  wrap.append(bell, panel);

  const api = async (path, body) => {
    const response = await fetch(path, {method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'same-origin',
      headers: body ? {'Content-Type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
    if (response.status === 401) return null;
    if (!response.ok) throw new Error('unavailable');
    return response.json();
  };
  const when = seconds => new Date(seconds * 1000).toLocaleString(undefined, {day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'});
  let data = null;

  function draw() {
    const unread = data.unread;
    badge.hidden = !unread;
    badge.textContent = unread > 99 ? '99+' : String(unread);
    bell.setAttribute('aria-label', unread ? `Support notifications, ${unread} unread` : 'Support notifications');
    const heading = Object.assign(document.createElement('h2'), {textContent: 'Support'});
    const list = document.createElement('ul');
    list.className = 'support-bell-list';
    for (const n of data.notifications.slice(0, 12)) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.className = 'support-bell-item' + (n.read ? '' : ' is-unread');
      link.href = '/help.html#/ticket/' + n.ticketId;
      if (embedded) link.target = '_top';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.append(icon(KINDS[n.kind] || KINDS.status));
      const text = document.createElement('span');
      text.append(document.createTextNode(n.text));
      const time = document.createElement('small');
      time.textContent = when(n.created);
      text.append(time);
      link.append(dot, text);
      link.addEventListener('click', () => { if (!n.read) api('/api/support/notifications/read', {id: n.id}).catch(() => {}); });
      item.append(link);
      list.append(item);
    }
    const empty = Object.assign(document.createElement('p'), {className: 'support-bell-empty', textContent: 'No news yet. Replies to your tickets will show up here.'});
    const markAll = Object.assign(document.createElement('button'), {type: 'button', textContent: 'Mark all as read', disabled: !unread});
    markAll.addEventListener('click', async () => { data = await api('/api/support/notifications/read', {all: true}); if (data) draw(); });
    const all = Object.assign(document.createElement('a'), {href: '/help.html#/tickets', textContent: 'All tickets'});
    if (embedded) all.target = '_top';
    const foot = document.createElement('div');
    foot.className = 'support-bell-foot';
    foot.append(markAll, all);
    panel.replaceChildren(heading, data.notifications.length ? list : empty, foot);
  }

  async function load() {
    try {
      const fresh = await api('/api/support/notifications');
      if (!fresh) { wrap.remove(); return; }          // signed out: no bell
      data = fresh;
      if (!wrap.isConnected) actions.prepend(wrap);
      draw();
    } catch { /* keep what is shown */ }
  }
  bell.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    bell.setAttribute('aria-expanded', String(open));
    if (open) load();
  });
  document.addEventListener('click', event => { if (!panel.hidden && !wrap.contains(event.target)) { panel.hidden = true; bell.setAttribute('aria-expanded', 'false'); } });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) { panel.hidden = true; bell.setAttribute('aria-expanded', 'false'); bell.focus(); } });
  load();
  setInterval(() => { if (!document.hidden) load(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
