/* Buzz, the PrintBee support bee: a floating chat button and sheet for the customer site only.
 *
 * Added to the customer pages and the phone tab shell (never to the admin, warehouse or Bee Runner portals). The widget lives
 * once, in the top document; pages shown inside the tab shell only expose PrintBeeBuzz.open(), which asks the top document.
 * Every piece of text, from the customer or from Buzz, is set with textContent, never as HTML.
 */
(() => {
  'use strict';
  const isTop = window.parent === window;
  if (!isTop) {
    window.PrintBeeBuzz = {open: options => { try { return Boolean(window.top.PrintBeeBuzz && window.top.PrintBeeBuzz.open(options)); } catch { return false; } }};
    return;
  }
  if (window.PrintBeeBuzz) return;

  const CHIPS = [
    {label: 'Check my order', text: 'Where is my order?'},
    {label: 'Pricing', text: 'How much does printing cost?'},
    {label: 'Upload help', text: 'What files can I upload and what are the limits?'},
    {label: 'Payment issue', text: 'I have a payment problem.'},
    {label: 'Talk to a human', human: true},
  ];
  const state = {sessionId: null, orderNumber: null, busy: false, ticketOffered: false};

  const style = document.createElement('style');
  style.textContent = `
  .buzz-root { --buzz-lift: 0px; font-family: Manrope, system-ui, sans-serif; color: var(--hv-ink, #2a2112); }
  .buzz-fab { position: fixed; z-index: 80; right: 18px; bottom: calc(var(--buzz-lift) + 18px + env(safe-area-inset-bottom, 0px)); width: 76px; height: 76px; padding: 6px; border: 0; border-radius: 50%;
    display: block; cursor: pointer; animation: buzz-bob 3.2s ease-in-out infinite; transition: transform .18s ease, box-shadow .18s ease;
    background: var(--hv-honey-grad, linear-gradient(180deg, #ffe495, #f5c542 70%, #edb52f));
    box-shadow: 0 10px 16px -4px rgba(150,100,10,.34), 0 3px 6px rgba(150,100,10,.16), inset 0 3px 3px rgba(255,255,255,.85), inset 0 -5px 8px rgba(190,120,10,.34); }
  .buzz-fab::after { content: ""; position: absolute; inset: 6px; border-radius: 50%; pointer-events: none;
    box-shadow: inset 0 5px 7px rgba(255,255,255,.5), inset 0 -9px 13px rgba(190,115,0,.28), inset 0 0 0 1px rgba(190,120,10,.12); }
  .buzz-fab:hover { transform: scale(1.05); }
  .buzz-fab:active { transform: scale(.96); box-shadow: 0 5px 9px -3px rgba(150,100,10,.34), inset 0 3px 3px rgba(255,255,255,.7), inset 0 -3px 6px rgba(190,120,10,.34); }
  .buzz-fab img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; display: block; pointer-events: none; }
  [data-theme="dark"] .buzz-fab { box-shadow: 0 10px 18px -4px rgba(0,0,0,.55), 0 0 24px rgba(255,170,40,.10), inset 0 2px 2px rgba(255,236,170,.55), inset 0 -5px 8px rgba(160,95,0,.45); }
  .buzz-fab:focus-visible, .buzz-chip:focus-visible, .buzz-send:focus-visible, .buzz-close:focus-visible, .buzz-btn:focus-visible, .buzz-thumb:focus-visible, .buzz-input:focus-visible { outline: 3px solid var(--hv-honey-700, #b9831a); outline-offset: 2px; }
  .buzz-fab[hidden] { display: none; }
  .buzz-sheet { position: fixed; z-index: 85; right: 24px; bottom: 24px; width: min(400px, calc(100vw - 32px)); height: min(640px, calc(100dvh - 48px)); display: flex; flex-direction: column; overflow: hidden;
    border-radius: 28px; background: var(--hv-surface, #fff); color: var(--hv-ink, #2a2112); box-shadow: var(--hv-sh-3, 0 12px 40px rgba(60,45,15,.25)); }
  .buzz-sheet[hidden] { display: none; }
  @media (max-width: 600px) { .buzz-sheet { inset: 0; width: auto; height: 100dvh; border-radius: 0; padding-bottom: env(safe-area-inset-bottom, 0px); } }
  .buzz-head { flex: none; display: flex; align-items: center; gap: 10px; padding: 12px 14px 12px 16px; background: var(--hv-surface-2, #fff6dd); padding-top: calc(12px + env(safe-area-inset-top, 0px)); }
  .buzz-head img { width: 44px; height: 44px; padding: 3px; box-sizing: border-box; object-fit: cover; flex: none; border-radius: 50%;
    background: var(--hv-honey-grad, #f5c542); box-shadow: 0 3px 6px rgba(150,100,10,.22), inset 0 2px 2px rgba(255,255,255,.8), inset 0 -3px 4px rgba(190,120,10,.3); }
  .buzz-head h2 { flex: 1; margin: 0; font-size: 16px; line-height: 1.2; font-weight: 800; }
  .buzz-close { flex: none; width: 40px; height: 40px; border: 0; border-radius: 50%; cursor: pointer; font-size: 22px; line-height: 1; background: var(--hv-surface, #fff); color: inherit; }
  .buzz-context { flex: none; display: flex; align-items: center; gap: 8px; margin: 10px 14px 0; padding: 6px 6px 6px 12px; border-radius: 999px; font-size: 13px; font-weight: 700; background: var(--hv-surface-3, #ffefc7); }
  .buzz-context[hidden] { display: none; }
  .buzz-context span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .buzz-context button { flex: none; width: 28px; height: 28px; border: 0; border-radius: 50%; cursor: pointer; background: var(--hv-surface, #fff); color: inherit; font-size: 16px; line-height: 1; }
  .buzz-log { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; overscroll-behavior: contain; }
  .buzz-notice { align-self: center; max-width: 92%; margin: 0; padding: 6px 12px; border-radius: 999px; font-size: 12px; text-align: center; color: var(--hv-muted, #6e5e3e); background: var(--hv-surface-2, #fff6dd); }
  .buzz-msg { max-width: 88%; display: flex; flex-direction: column; gap: 6px; }
  .buzz-msg p { margin: 0; padding: 10px 14px; border-radius: 20px; font-size: 14.5px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  .buzz-msg.bee { align-self: flex-start; }
  .buzz-msg.bee p { background: var(--hv-surface-2, #fff6dd); border-bottom-left-radius: 8px; }
  .buzz-msg.you { align-self: flex-end; }
  .buzz-msg.you p { background: var(--hv-honey-grad, #f5c542); color: #2a2112; border-bottom-right-radius: 8px; font-weight: 600; }
  .buzz-msg.problem p { background: color-mix(in srgb, #d64545 14%, var(--hv-surface, #fff)); }
  .buzz-thumbs { display: flex; gap: 6px; }
  .buzz-thumb { width: 34px; height: 34px; padding: 0; border: 0; border-radius: 50%; cursor: pointer; display: grid; place-items: center; background: var(--hv-surface-2, #fff6dd); color: var(--hv-muted, #6e5e3e); }
  .buzz-thumb svg { width: 17px; height: 17px; }
  .buzz-thumb[aria-pressed="true"] { background: var(--hv-honey-grad, #f5c542); color: #2a2112; }
  .buzz-card { align-self: stretch; padding: 14px; border-radius: 22px; display: grid; gap: 8px; background: var(--hv-surface, #fff); box-shadow: var(--hv-sh-1, 0 0 0 1px #f0e3be); }
  .buzz-card h3 { margin: 0; font-size: 15px; display: flex; justify-content: space-between; gap: 8px; align-items: center; }
  .buzz-pill { padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 800; background: var(--hv-honey-grad, #f5c542); color: #2a2112; white-space: nowrap; }
  .buzz-pill.urgent { background: #d64545; color: #fff; }
  .buzz-card p { margin: 0; font-size: 13.5px; line-height: 1.4; color: var(--hv-muted, #6e5e3e); overflow-wrap: anywhere; }
  .buzz-card .quote { color: inherit; padding: 8px 10px; border-radius: 14px; background: var(--hv-surface-2, #fff6dd); }
  .buzz-card ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; font-size: 12.5px; color: var(--hv-muted, #6e5e3e); }
  .buzz-card li::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 8px; border-radius: 50%; background: var(--hv-honey-600, #e0a91e); }
  .buzz-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .buzz-btn { min-height: 40px; padding: 8px 16px; border: 0; border-radius: 999px; cursor: pointer; font: 800 13.5px Manrope, system-ui, sans-serif; text-decoration: none; display: inline-flex; align-items: center;
    background: var(--hv-surface-2, #fff6dd); color: var(--hv-honey-ink, #7a5208); }
  .buzz-btn.primary { background: var(--hv-honey-grad, #f5c542); color: #2a2112; }
  .buzz-btn:disabled { opacity: .55; cursor: default; }
  .buzz-typing { align-self: flex-start; display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 20px; font-size: 13px; color: var(--hv-muted, #6e5e3e); background: var(--hv-surface-2, #fff6dd); }
  .buzz-typing svg { width: 32px; height: 22px; }
  .buzz-wing { transform-box: fill-box; transform-origin: 50% 100%; animation: buzz-flap .22s ease-in-out infinite alternate; }
  .buzz-wing.b { animation-delay: .11s; }
  .buzz-chips { flex: none; display: flex; gap: 8px; padding: 6px 14px 4px; overflow-x: auto; scrollbar-width: none; }
  .buzz-chips::-webkit-scrollbar { display: none; }
  .buzz-chip { flex: none; min-height: 38px; padding: 6px 14px; border: 0; border-radius: 999px; cursor: pointer; font: 700 13px Manrope, system-ui, sans-serif; background: var(--hv-surface-2, #fff6dd); color: var(--hv-honey-ink, #7a5208); box-shadow: 0 0 0 1px var(--hv-border, #f0e3be); }
  .buzz-chip:disabled { opacity: .55; cursor: default; }
  .buzz-form { flex: none; display: flex; gap: 8px; padding: 8px 14px 14px; }
  .buzz-input { flex: 1; min-width: 0; height: 46px; padding: 0 16px; border: 0; border-radius: 999px; font: 600 15px Manrope, system-ui, sans-serif; color: inherit; background: var(--hv-surface-2, #fff6dd); box-shadow: inset 0 0 0 1px var(--hv-border, #f0e3be); }
  .buzz-send { flex: none; width: 46px; height: 46px; padding: 0; border: 0; border-radius: 50%; cursor: pointer; display: grid; place-items: center; background: var(--hv-honey-grad, #f5c542); color: #2a2112; }
  .buzz-send:disabled { opacity: .55; cursor: default; }
  .buzz-send svg { width: 20px; height: 20px; }
  html.buzz-open { overflow: hidden; }
  @keyframes buzz-bob { 0%, 100% { translate: 0 0; } 50% { translate: 0 -3px; } }
  @keyframes buzz-flap { from { transform: scaleY(.25); } to { transform: scaleY(1); } }
  @media (prefers-reduced-motion: reduce) { .buzz-fab, .buzz-wing { animation: none; } }`;
  document.head.append(style);

  const ns = 'http://www.w3.org/2000/svg';
  const svg = (paths, extra = {}) => {
    const node = document.createElementNS(ns, 'svg');
    for (const [key, value] of Object.entries({viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', ...extra})) node.setAttribute(key, value);
    for (const d of paths) { const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); node.append(path); }
    return node;
  };
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'text') node.textContent = value;
      else if (key in node && key !== 'list') node[key] = value;
      else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  };

  const root = el('div', {className: 'buzz-root'});
  const fab = el('button', {type: 'button', className: 'buzz-fab', 'aria-label': 'Chat with Buzz, PrintBee support', 'aria-haspopup': 'dialog', 'aria-expanded': 'false'},
    el('img', {src: '/buzz-bee.webp', alt: '', width: 72, height: 72}));
  const title = el('h2', {id: 'buzz-title', text: 'Buzz - PrintBee support'});
  const close = el('button', {type: 'button', className: 'buzz-close', 'aria-label': 'Close chat', text: '×'});
  const contextText = el('span');
  const contextClear = el('button', {type: 'button', 'aria-label': 'Stop talking about this order', text: '×'});
  const context = el('div', {className: 'buzz-context', hidden: true}, contextText, contextClear);
  const log = el('div', {className: 'buzz-log', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': 'Conversation with Buzz'});
  const chips = el('div', {className: 'buzz-chips', role: 'group', 'aria-label': 'Quick questions'});
  const input = el('input', {type: 'text', className: 'buzz-input', maxLength: 800, autocomplete: 'off', enterKeyHint: 'send', placeholder: 'Ask Buzz anything about PrintBee', 'aria-label': 'Message Buzz'});
  const send = el('button', {type: 'submit', className: 'buzz-send', 'aria-label': 'Send message'}, svg(['M4 12l16-8-6 16-3-6z']));
  const form = el('form', {className: 'buzz-form'}, input, send);
  const sheet = el('section', {className: 'buzz-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'buzz-title', hidden: true},
    el('header', {className: 'buzz-head'}, el('img', {src: '/buzz-bee.webp', alt: '', width: 38, height: 38}), title, close), context, log, chips, form);
  root.append(fab, sheet);

  // ---- placing the button above the phone dock ----
  function place() {
    const nav = document.querySelector('.bottom-nav');
    let lift = 0;
    if (nav) {
      const box = nav.getBoundingClientRect();
      if (box.height > 0 && getComputedStyle(nav).display !== 'none') lift = Math.max(0, innerHeight - box.top);
    }
    root.style.setProperty('--buzz-lift', Math.round(lift) + 'px');
  }

  // ---- messages ----
  const scroll = () => { log.scrollTop = log.scrollHeight; };
  function bubble(who, text, extra = '') {
    const wrap = el('div', {className: `buzz-msg ${who} ${extra}`.trim()}, el('p', {text}));
    log.append(wrap);
    scroll();
    return wrap;
  }
  function thumbs(wrap, messageId) {
    const up = el('button', {type: 'button', className: 'buzz-thumb', 'aria-label': 'This helped', 'aria-pressed': 'false'}, svg(['M7 11v9H4v-9zM7 11l4-8c1.5 0 2.5 1 2.5 2.5V9h5.2a2 2 0 0 1 2 2.3l-1 6.5a2 2 0 0 1-2 1.7H7']));
    const down = el('button', {type: 'button', className: 'buzz-thumb', 'aria-label': 'This did not help', 'aria-pressed': 'false'}, svg(['M7 13V4H4v9zM7 13l4 8c1.5 0 2.5-1 2.5-2.5V15h5.2a2 2 0 0 0 2-2.3l-1-6.5A2 2 0 0 0 17.7 4.5H7']));
    const rate = async (button, other, rating) => {
      button.setAttribute('aria-pressed', 'true');
      other.setAttribute('aria-pressed', 'false');
      try {
        const result = await call('/api/support/chat/feedback', {sessionId: state.sessionId, messageId, rating});
        if (result.offerTicket) offerTicket();
      } catch { /* the thumb is only a hint; nothing to tell the customer */ }
    };
    up.addEventListener('click', () => rate(up, down, 1));
    down.addEventListener('click', () => rate(down, up, -1));
    wrap.append(el('div', {className: 'buzz-thumbs'}, up, down));
  }
  function offerTicket() {
    if (state.ticketOffered) return;
    state.ticketOffered = true;
    const button = el('button', {type: 'button', className: 'buzz-btn primary', text: 'Create a ticket'});
    button.addEventListener('click', () => { button.disabled = true; humanTicket().finally(() => { state.ticketOffered = false; }); });
    log.append(el('div', {className: 'buzz-msg bee'}, el('p', {text: 'Sorry I have not been much help. I can hand this to a person.'}), el('div', {className: 'buzz-actions'}, button)));
    scroll();
  }
  const when = seconds => new Date(seconds * 1000).toLocaleString(undefined, {day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'});
  function orderCard(order) {
    const card = el('div', {className: 'buzz-card'}, el('h3', {}, el('span', {text: order.order_number}), el('span', {className: 'buzz-pill', text: order.status_label})));
    if (order.eta_minutes) card.append(el('p', {text: `About ${order.eta_minutes} min to your door.`}));
    if (order.timeline && order.timeline.length) card.append(el('ul', {}, ...order.timeline.map(step => el('li', {text: `${step.event} (${when(step.at)})`}))));
    const actions = el('div', {className: 'buzz-actions'}, el('a', {className: 'buzz-btn', href: '/orders/' + encodeURIComponent(order.id), target: '_top', text: 'Track order'}));
    card.append(actions);
    log.append(card);
    scroll();
  }
  function draftCard(draft) {
    const card = el('div', {className: 'buzz-card', 'aria-label': 'Ticket draft'}, el('h3', {}, el('span', {text: 'Ticket draft'}),
      el('span', {className: 'buzz-pill' + (draft.escalation ? ' urgent' : ''), text: draft.escalation ? 'Urgent' : draft.categoryLabel})));
    card.append(el('p', {text: draft.subject}));
    card.append(el('p', {className: 'quote', text: draft.message}));
    if (draft.orderNumber) card.append(el('p', {text: 'Order ' + draft.orderNumber}));
    const confirm = el('button', {type: 'button', className: 'buzz-btn primary', text: 'Confirm and send'});
    const cancel = el('button', {type: 'button', className: 'buzz-btn', text: 'Not now'});
    const actions = el('div', {className: 'buzz-actions'}, confirm, cancel);
    card.append(actions);
    cancel.addEventListener('click', () => { card.remove(); bubble('bee', 'No problem. I did not send anything.'); });
    confirm.addEventListener('click', async () => {
      confirm.disabled = cancel.disabled = true;
      try {
        const result = await call('/api/support/chat', {action: 'confirm', sessionId: state.sessionId, draftId: draft.id}, {'Idempotency-Key': `buzz-${draft.id}-confirm`});
        actions.replaceChildren(el('a', {className: 'buzz-btn primary', href: '/help.html#/ticket/' + result.ticket.id, target: '_top', text: 'Open ' + result.ticket.number}));
        bubble('bee', result.reply);
      } catch (error) {
        confirm.disabled = cancel.disabled = false;
        bubble('bee', error.message, 'problem');
      }
    });
    log.append(card);
    scroll();
  }
  function typing(on) {
    const existing = log.querySelector('.buzz-typing');
    if (!on) { if (existing) existing.remove(); return; }
    if (existing) return;
    const wings = document.createElementNS(ns, 'svg');
    wings.setAttribute('viewBox', '0 0 32 22');
    wings.setAttribute('aria-hidden', 'true');
    const make = (name, attrs) => { const node = document.createElementNS(ns, name); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); return node; };
    wings.append(make('ellipse', {class: 'buzz-wing', cx: 11, cy: 8, rx: 5, ry: 7, fill: '#bfe3ff', opacity: '.85'}), make('ellipse', {class: 'buzz-wing b', cx: 19, cy: 8, rx: 5, ry: 7, fill: '#bfe3ff', opacity: '.85'}),
      make('ellipse', {cx: 15, cy: 15, rx: 9, ry: 5.5, fill: '#f5c542'}), make('path', {d: 'M11 10.5v9M15 10v10M19 10.5v9', stroke: '#2a2112', 'stroke-width': 1.8, 'stroke-linecap': 'round'}));
    log.append(el('div', {className: 'buzz-typing', role: 'status'}, wings, el('span', {text: 'Buzz is typing'})));
    scroll();
  }

  // ---- talking to the server ----
  async function call(path, body, headers = {}) {
    let response;
    try {
      response = await fetch(path, {method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: {'Content-Type': 'application/json', ...headers}, body: JSON.stringify(body)});
    } catch { throw new Error('I could not reach PrintBee. Check your connection and try again.'); }
    let data = {};
    try { data = await response.json(); } catch { /* not JSON */ }
    if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }
  function busy(on) {
    state.busy = on;
    input.disabled = send.disabled = on;
    for (const chip of chips.children) chip.disabled = on;
  }
  function show(result) {
    state.sessionId = result.sessionId || state.sessionId;
    const wrap = bubble('bee', result.reply);
    if (result.messageId) thumbs(wrap, result.messageId);
    if (result.orderCard) orderCard(result.orderCard);
    if (result.draft && !result.draft.created) draftCard(result.draft);
    if (result.offerTicket && !result.draft) offerTicket();
  }
  async function run(request, shownText) {
    if (state.busy) return;
    if (shownText) bubble('you', shownText);
    busy(true);
    typing(true);
    try { show(await request()); }
    catch (error) { bubble('bee', error.message, 'problem'); }
    finally { typing(false); busy(false); if (!sheet.hidden) input.focus(); }
  }
  const ask = text => run(() => call('/api/support/chat', {message: text, sessionId: state.sessionId, orderNumber: state.orderNumber}), text);
  const humanTicket = () => run(() => call('/api/support/chat', {action: 'human', sessionId: state.sessionId, orderNumber: state.orderNumber}), 'I would like to talk to a person.');

  // ---- opening, closing, focus ----
  function setOrder(number) {
    state.orderNumber = number || null;
    context.hidden = !number;
    contextText.textContent = number ? 'About order ' + number : '';
  }
  function focusables() { return [...sheet.querySelectorAll('button, a[href], input')].filter(node => !node.disabled && node.offsetParent !== null); }
  function open(options = {}) {
    if (typeof options.orderNumber === 'string' && /^[A-Za-z0-9-]{3,40}$/.test(options.orderNumber)) setOrder(options.orderNumber.toUpperCase());
    sheet.hidden = false;
    fab.hidden = true;
    fab.setAttribute('aria-expanded', 'true');
    document.documentElement.classList.add('buzz-open');
    input.focus();
    if (options.orderNumber && !log.querySelector('.buzz-asked-' + state.orderNumber)) {
      const marker = el('span', {className: 'buzz-asked-' + state.orderNumber, hidden: true});
      log.append(marker);
      bubble('bee', `Hi! I see you want help with order ${state.orderNumber}. What is going on?`);
    }
    return true;
  }
  function shut() {
    sheet.hidden = true;
    fab.hidden = false;
    fab.setAttribute('aria-expanded', 'false');
    document.documentElement.classList.remove('buzz-open');
    fab.focus();
  }
  fab.addEventListener('click', () => open());
  close.addEventListener('click', shut);
  contextClear.addEventListener('click', () => { setOrder(null); input.focus(); });
  sheet.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); shut(); return; }
    if (event.key !== 'Tab') return;
    const nodes = focusables();
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (event.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || state.busy) return;
    input.value = '';
    ask(text);
  });
  for (const chip of CHIPS) {
    const button = el('button', {type: 'button', className: 'buzz-chip', text: chip.label});
    button.addEventListener('click', () => (chip.human ? humanTicket() : ask(chip.text)));
    chips.append(button);
  }

  log.append(el('p', {className: 'buzz-notice', text: "AI assistant. Please don't share personal or payment details."}));
  bubble('bee', 'Hi, I am Buzz, PrintBee’s helper bee. Ask me about prices, uploads or your orders, or tap a quick question below.');

  const mount = () => {
    document.body.append(root);
    place();
    // The phone dock is created by another script after this one, so look again as the page settles and when it resizes.
    for (const event of ['load', 'resize', 'orientationchange', 'pageshow']) addEventListener(event, place);
    setInterval(() => { if (!document.hidden && sheet.hidden) place(); }, 1500);
  };
  window.PrintBeeBuzz = {open};
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
