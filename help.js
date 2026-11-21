/* PrintBee Help: home, new ticket, my tickets and the conversation.
 *
 * Everything that comes from a person or the server (subjects, messages, file names, order numbers) is put on the page
 * with textContent / text nodes through h(). There is no innerHTML with ticket text anywhere in this file.
 */
(() => {
  'use strict';
  const app = document.getElementById('help-app');
  const STATUS = {
    open: ['Open', 'is-open'], in_progress: ['In progress', 'is-progress'], pending: ['Waiting for you', 'is-pending'],
    resolved: ['Resolved', 'is-resolved'], closed: ['Closed', 'is-closed'],
  };
  const ORDER_STATUS = {paid: 'Paid', printing: 'Printing', packed: 'Ready', out_for_delivery: 'On the way', delivered: 'Delivered', cancelled: 'Cancelled'};
  const TOPICS = [
    ['delivery', 'Delivery issue', 'Bee Runner late, wrong address, missing order', 'M3 17h13V6H3zM16 10h3l2 3v4h-5M7.5 19.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM17.5 19.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z'],
    ['print_quality', 'Print quality', 'Faded, smudged or wrong pages', 'M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z'],
    ['order', 'Order or payment', 'Charges, refunds, changes', 'M4 7h16v12H4zM4 11h16M8 15h3'],
    ['account', 'Account', 'Sign-in and profile', 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 21v-1a6 6 0 0 1 6-6h3a6 6 0 0 1 6 6v1'],
  ];
  const ACCEPT = ['application/pdf', 'image/jpeg', 'image/png'];
  const MAX_FILES = 5, MAX_BYTES = 10 * 1024 * 1024;
  let categories = null, orders = null, poll = null;

  // ---- tiny DOM helpers (text only) ---------------------------------------------------------------
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }
  function icon(path, size = 22) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    for (const [k, v] of Object.entries({viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false'})) svg.setAttribute(k, v);
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', path);
    svg.append(p);
    return svg;
  }
  const bee = () => h('img', {src: '/printbee-header-bee.webp', alt: '', width: 28, height: 25, class: 'help-bee'});
  const when = seconds => new Date(seconds * 1000).toLocaleString(undefined, {day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'});
  const size = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
  const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replaceAll('-', '').padEnd(20, '0');
  const chip = (status) => h('span', {class: 'help-chip ' + (STATUS[status]?.[1] || ''), text: STATUS[status]?.[0] || status});

  async function api(path, options = {}) {
    let response;
    // Every Help call needs a signed-in customer; do not send one (and log a 401) for a signed-out visitor.
    if (!(await (window.PrintBeeWho || Promise.resolve({email: 'unknown'}))).email) throw Object.assign(new Error('Sign in to use Help.'), {signedOut: true});
    try { response = await fetch(path, {credentials: 'same-origin', ...options}); }
    catch { throw new Error('No connection. Check your network and try again.'); }
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) throw Object.assign(new Error('Sign in to use Help.'), {signedOut: true});
    if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }
  const post = (path, body, key) => api(path, {method: 'POST', headers: {'Content-Type': 'application/json', ...(key ? {'Idempotency-Key': key} : {})}, body: JSON.stringify(body || {})});

  // ---- shared pieces ------------------------------------------------------------------------------
  const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter(kid => kid != null && kid !== false));
  function show(...children) {
    clearInterval(poll);
    fill(app, ...children);
    app.focus({preventScroll: true});
  }
  function notice(text, kind = 'info') { return h('p', {class: 'help-notice is-' + kind, role: kind === 'error' ? 'alert' : 'status', text}); }
  function signedOut() {
    show(h('section', {class: 'help-card help-center'}, bee(), h('h1', {text: 'Sign in to get help'}),
      h('p', {class: 'help-muted', text: 'We need to know who you are so we can find your orders and reply to you.'}),
      h('a', {class: 'help-button help-primary', href: '/', text: 'Sign in'})));
  }
  function problem(error) { if (error.signedOut) return signedOut(); show(h('section', {class: 'help-card help-center'}, h('h1', {text: 'We could not load this'}), notice(error.message, 'error'),
    h('a', {class: 'help-button', href: '#/', text: 'Back to Help'}))); }
  const crumb = (label, href) => h('a', {class: 'help-back', href}, icon('m15 6-6 6 6 6', 18), label);
  const orderLabel = o => (o.number || 'Order') + ' · ' + (ORDER_STATUS[o.status] || o.status);

  // ---- files --------------------------------------------------------------------------------------
  function filePicker() {
    const picked = [];
    const list = h('ul', {class: 'help-files', 'aria-label': 'Files to attach'});
    const message = h('p', {class: 'help-hint', role: 'status'});
    const input = h('input', {type: 'file', multiple: true, accept: '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png', class: 'help-sr'});
    const render = () => {
      list.replaceChildren(...picked.map((file, index) => h('li', {}, icon('M6 3h8l4 4v14H6zM14 3v5h4', 18), h('span', {class: 'help-file-name', text: file.name}),
        h('small', {text: size(file.size)}), h('button', {type: 'button', class: 'help-x', 'aria-label': 'Remove ' + file.name, onclick: () => { picked.splice(index, 1); render(); }}, icon('m6 6 12 12M18 6 6 18', 16)))));
    };
    input.addEventListener('change', () => {
      message.textContent = '';
      for (const file of input.files) {
        const okType = ACCEPT.includes(file.type) || /\.(pdf|jpe?g|png)$/i.test(file.name);
        if (!okType) message.textContent = file.name + ' was skipped: only PDF, JPG and PNG files can be attached.';
        else if (file.size > MAX_BYTES) message.textContent = file.name + ' was skipped: files can be up to 10 MB.';
        else if (picked.length >= MAX_FILES) message.textContent = 'You can attach up to ' + MAX_FILES + ' files.';
        else picked.push(file);
      }
      input.value = '';
      render();
    });
    const button = h('label', {class: 'help-attach'}, icon('m21 11-9 9a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8', 18), 'Attach files', input);
    return {picked, node: h('div', {class: 'help-attachments'}, button, h('small', {class: 'help-muted', text: 'PDF, JPG or PNG · up to 5 files · 10 MB each'}), message, list)};
  }
  async function uploadAll(ticketId, messageId, files, onProgress) {
    const failed = [];
    for (const [index, file] of files.entries()) {
      onProgress?.(index + 1, files.length);
      try {
        await api(`/api/support/tickets/${ticketId}/messages/${messageId}/attachments`, {method: 'POST',
          headers: {'X-Filename': encodeURIComponent(file.name), 'Content-Type': file.type || 'application/octet-stream'}, body: file});
      } catch (error) { failed.push(file.name + ': ' + error.message); }
    }
    return failed;
  }

  // ---- home ---------------------------------------------------------------------------------------
  async function home() {
    show(h('p', {class: 'help-loading', text: 'Loading help…'}));
    let tickets;
    try { tickets = (await api('/api/support/tickets')).tickets; } catch (error) { return problem(error); }
    const active = tickets.filter(t => ['open', 'in_progress', 'pending'].includes(t.status));
    show(
      h('section', {class: 'help-hero help-card'}, bee(),
        h('div', {}, h('h1', {text: 'How can we help?'}), h('p', {class: 'help-muted', text: 'Tell us what happened and we will sort it out.'})),
        h('div', {class: 'help-hero-actions'}, h('a', {class: 'help-button help-primary', href: '#/new', text: 'New ticket'}),
          h('a', {class: 'help-button', href: '#/tickets', text: 'My tickets' + (active.length ? ' (' + active.length + ')' : '')}))),
      h('h2', {class: 'help-section', text: 'Choose a topic'}),
      h('div', {class: 'help-topics'}, TOPICS.map(([key, title, hint, path]) => h('a', {class: 'help-topic', href: '#/new?cat=' + key},
        h('span', {class: 'help-topic-icon'}, icon(path)), h('strong', {text: title}), h('small', {text: hint})))),
      h('h2', {class: 'help-section', text: 'Recent tickets'}),
      tickets.length ? h('div', {class: 'help-list'}, tickets.slice(0, 3).map(ticketRow)) : h('p', {class: 'help-card help-empty', text: 'No tickets yet. When you open one, it will show up here.'}),
      tickets.length > 3 ? h('a', {class: 'help-link', href: '#/tickets', text: 'See all tickets'}) : null,
      h('section', {class: 'help-card help-contact'}, h('div', {}, h('strong', {text: 'Need an answer right now?'}), h('p', {class: 'help-muted', text: 'Chat with us on WhatsApp for urgent delivery problems.'})),
        h('a', {class: 'help-button', href: 'https://wa.me/919347541419', target: '_blank', rel: 'noopener noreferrer', text: 'WhatsApp PrintBee'})));
  }
  function ticketRow(ticket) {
    return h('a', {class: 'help-row', href: '#/ticket/' + ticket.id},
      h('span', {class: 'help-row-main'}, h('strong', {text: ticket.subject}),
        h('small', {text: [ticket.number, ticket.categoryLabel, ticket.order?.number].filter(Boolean).join(' · ')})),
      h('span', {class: 'help-row-side'}, chip(ticket.status), h('small', {text: when(ticket.updated)})));
  }

  // ---- my tickets ---------------------------------------------------------------------------------
  async function list() {
    show(h('p', {class: 'help-loading', text: 'Loading your tickets…'}));
    let tickets;
    try { tickets = (await api('/api/support/tickets')).tickets; } catch (error) { return problem(error); }
    const filters = {active: ['Active', t => ['open', 'in_progress', 'pending'].includes(t.status)], done: ['Resolved', t => ['resolved', 'closed'].includes(t.status)], all: ['All', () => true]};
    let current = tickets.some(filters.active[1]) || !tickets.length ? 'active' : 'all';
    const rows = h('div', {class: 'help-list'});
    const tabs = h('div', {class: 'help-tabs', role: 'group', 'aria-label': 'Filter tickets'});
    const draw = () => {
      tabs.replaceChildren(...Object.entries(filters).map(([key, [label]]) => h('button', {type: 'button', class: 'help-tab', 'aria-pressed': String(key === current),
        onclick: () => { current = key; draw(); }, text: label})));
      const shown = tickets.filter(filters[current][1]);
      rows.replaceChildren(...(shown.length ? shown.map(ticketRow) : [h('p', {class: 'help-card help-empty', text: current === 'active' ? 'Nothing open right now.' : 'No tickets here yet.'})]));
    };
    draw();
    show(crumb('Help', '#/'), h('div', {class: 'help-title'}, h('h1', {text: 'My tickets'}), h('a', {class: 'help-button help-primary', href: '#/new', text: 'New ticket'})), tabs, rows);
  }

  // ---- new ticket ---------------------------------------------------------------------------------
  async function create(params) {
    show(h('p', {class: 'help-loading', text: 'Loading…'}));
    try {
      categories ||= (await api('/api/support/categories')).categories;
      orders = (await api('/api/orders')).orders;
    } catch (error) { return problem(error); }
    const wantedOrder = params.get('order') || '';
    let category = categories.some(c => c.key === params.get('cat')) ? params.get('cat') : (wantedOrder ? 'order' : '');
    const key = newKey();
    const picker = filePicker();
    const errorBox = h('p', {class: 'help-notice is-error', role: 'alert', hidden: true});
    const subject = h('input', {class: 'help-input', maxlength: '120', placeholder: 'e.g. My Bee Runner has not arrived', autocomplete: 'off', required: true, id: 'help-subject'});
    const message = h('textarea', {class: 'help-input', maxlength: '4000', rows: '6', placeholder: 'What happened? Include anything that will help us, like page numbers or what you saw.', required: true, id: 'help-message'});
    const count = h('small', {class: 'help-muted help-count', text: '0 / 4000'});
    message.addEventListener('input', () => { count.textContent = message.value.length + ' / 4000'; });
    const orderSelect = h('select', {class: 'help-input', id: 'help-order'}, h('option', {value: '', text: 'Choose an order'}),
      orders.map(o => h('option', {value: o.id, text: orderLabel(o), selected: o.id === wantedOrder})));
    const orderHint = h('small', {class: 'help-muted'});
    const orderField = h('label', {class: 'help-field', for: 'help-order'}, h('span', {text: 'Related order'}), orderSelect, orderHint);
    const cats = h('div', {class: 'help-cats', role: 'radiogroup', 'aria-label': 'Category'});
    const drawCats = () => {
      cats.replaceChildren(...categories.map(c => h('button', {type: 'button', role: 'radio', class: 'help-cat', 'aria-checked': String(c.key === category),
        onclick: () => { category = c.key; drawCats(); }, text: c.label})));
      const needs = categories.find(c => c.key === category)?.needsOrder;
      orderHint.textContent = needs ? 'Required for this topic. We use it to see your order, delivery and invoice.' : 'Optional. Pick one if this is about a specific order.';
      orderSelect.required = Boolean(needs);
    };
    drawCats();
    const submit = h('button', {type: 'submit', class: 'help-button help-primary', text: 'Send ticket'});
    const form = h('form', {class: 'help-card help-form', novalidate: true},
      h('div', {class: 'help-field'}, h('span', {text: 'What is this about?'}), cats),
      orderField,
      h('label', {class: 'help-field', for: 'help-subject'}, h('span', {text: 'Subject'}), subject),
      h('label', {class: 'help-field', for: 'help-message'}, h('span', {text: 'Message'}), message, count),
      h('div', {class: 'help-field'}, h('span', {text: 'Photos or documents (optional)'}), picker.node),
      errorBox, h('div', {class: 'help-actions'}, submit, h('a', {class: 'help-button', href: '#/', text: 'Cancel'})));
    form.addEventListener('submit', async event => {
      event.preventDefault();
      errorBox.hidden = true;
      const fail = text => { errorBox.textContent = text; errorBox.hidden = false; errorBox.scrollIntoView({block: 'nearest'}); };
      const needs = categories.find(c => c.key === category)?.needsOrder;
      if (!category) return fail('Choose what this is about.');
      if (needs && !orderSelect.value) return fail('Choose the order this is about.');
      if (subject.value.trim().length < 3) return fail('Add a short subject.');
      if (message.value.trim().length < 3) return fail('Tell us what happened.');
      submit.disabled = true;                      // no double submits; the Idempotency-Key covers retries too
      submit.textContent = 'Sending…';
      try {
        const {ticket} = await post('/api/support/tickets', {category, subject: subject.value, message: message.value, orderId: orderSelect.value || null}, key);
        if (picker.picked.length) {
          const failed = await uploadAll(ticket.id, ticket.messages[0].id, picker.picked, (n, total) => { submit.textContent = `Uploading ${n} of ${total}…`; });
          if (failed.length) sessionStorage.setItem('help-flash', 'Your ticket was sent, but some files could not be attached: ' + failed.join(' '));
        }
        location.hash = '#/ticket/' + ticket.id;
      } catch (error) {
        if (error.signedOut) return signedOut();
        fail(error.message);
        submit.disabled = false;
        submit.textContent = 'Send ticket';
      }
    });
    show(crumb('Help', '#/'), h('h1', {text: 'New ticket'}), form);
  }

  // ---- conversation -------------------------------------------------------------------------------
  async function conversation(id) {
    show(h('p', {class: 'help-loading', text: 'Loading ticket…'}));
    let ticket;
    try { ticket = (await api('/api/support/tickets/' + id)).ticket; } catch (error) { return problem(error); }
    const flash = sessionStorage.getItem('help-flash');
    sessionStorage.removeItem('help-flash');
    const thread = h('div', {class: 'help-thread', 'aria-label': 'Conversation', role: 'log'});
    const head = h('header', {class: 'help-card help-ticket-head'});
    const compose = h('div');
    let key = newKey(), shownCount = -1, shownStatus = '';
    const attachmentLink = a => h('a', {class: 'help-file-link', href: '/api/support/attachments/' + a.id, download: a.name, rel: 'noopener'}, icon('M6 3h8l4 4v14H6zM14 3v5h4', 16), h('span', {text: a.name}), h('small', {text: size(a.size)}));
    const drawHead = () => {
      const o = ticket.order;
      fill(head,
        h('div', {class: 'help-ticket-top'}, h('h1', {text: ticket.subject}), chip(ticket.status)),
        h('p', {class: 'help-muted help-meta', text: [ticket.number, ticket.categoryLabel, 'Updated ' + when(ticket.updated)].join(' · ')}),
        o ? h('a', {class: 'help-order-link', href: '/orders/' + o.id}, h('span', {text: 'Order ' + o.number}), h('small', {text: ORDER_STATUS[o.status] || o.status})) : null);
    };
    const drawThread = () => {
      if (shownCount === ticket.messages.length && shownStatus === ticket.status) return;
      shownCount = ticket.messages.length; shownStatus = ticket.status;
      thread.replaceChildren(...ticket.messages.map(m => h('article', {class: 'help-bubble ' + (m.from === 'you' ? 'is-you' : 'is-support')},
        h('header', {}, h('strong', {text: m.from === 'you' ? 'You' : 'PrintBee Support'}), h('small', {text: when(m.created)})),
        h('p', {class: 'help-text', text: m.body}),
        m.attachments?.length ? h('div', {class: 'help-bubble-files'}, m.attachments.map(attachmentLink)) : null)));
    };
    const drawCompose = () => {
      if (ticket.status === 'closed') return compose.replaceChildren(notice('This ticket is closed. Open a new ticket if you still need help.'), h('a', {class: 'help-button help-primary', href: '#/new', text: 'New ticket'}));
      const picker = filePicker();
      const box = h('textarea', {class: 'help-input', rows: '4', maxlength: '4000', placeholder: ticket.status === 'resolved' ? 'Still not right? Reply to reopen this ticket.' : 'Write a reply…', 'aria-label': 'Your reply'});
      const err = h('p', {class: 'help-notice is-error', role: 'alert', hidden: true});
      const send = h('button', {type: 'submit', class: 'help-button help-primary', text: 'Send reply'});
      const form = h('form', {class: 'help-card help-reply'}, box, picker.node, err, h('div', {class: 'help-actions'}, send,
        ['resolved', 'closed'].includes(ticket.status) ? null : h('button', {type: 'button', class: 'help-button', text: 'Mark as resolved', onclick: async event => {
          if (!window.confirm('Mark this ticket as resolved? You can reply later to reopen it.')) return;
          event.currentTarget.disabled = true;
          try { ticket = (await post(`/api/support/tickets/${id}/resolve`, {})).ticket; refresh(true); }
          catch (error) { err.textContent = error.message; err.hidden = false; event.currentTarget.disabled = false; }
        }})));
      form.addEventListener('submit', async event => {
        event.preventDefault();
        err.hidden = true;
        if (box.value.trim().length < 1) { err.textContent = 'Write a message first.'; err.hidden = false; return; }
        send.disabled = true; send.textContent = 'Sending…';
        try {
          ticket = (await post(`/api/support/tickets/${id}/reply`, {message: box.value}, key)).ticket;
          key = newKey();
          if (picker.picked.length) {
            const last = [...ticket.messages].reverse().find(m => m.from === 'you');
            const failed = await uploadAll(id, last.id, picker.picked, (n, total) => { send.textContent = `Uploading ${n} of ${total}…`; });
            ticket = (await api('/api/support/tickets/' + id)).ticket;
            if (failed.length) { err.textContent = 'Reply sent, but some files could not be attached: ' + failed.join(' '); err.hidden = false; }
          }
          refresh(true);
        } catch (error) {
          if (error.signedOut) return signedOut();
          err.textContent = error.message; err.hidden = false; send.disabled = false; send.textContent = 'Send reply';
        }
      });
      compose.replaceChildren(form);
    };
    const refresh = (rebuildCompose = false) => { drawHead(); drawThread(); if (rebuildCompose) drawCompose(); };
    drawHead(); drawThread(); drawCompose();
    show(crumb('My tickets', '#/tickets'), flash ? notice(flash, 'error') : null, head, thread, compose);
    // New replies appear on their own. The reply box is left alone so nothing you are typing is lost.
    poll = setInterval(async () => {
      if (document.hidden) return;
      try {
        const fresh = (await api('/api/support/tickets/' + id)).ticket;
        const closedChanged = (ticket.status === 'closed') !== (fresh.status === 'closed');
        ticket = fresh;
        refresh(closedChanged);
      } catch { /* try again next time */ }
    }, 20000);
  }

  // ---- routing ------------------------------------------------------------------------------------
  function route() {
    const hash = location.hash.replace(/^#/, '') || '/';
    const [path, query = ''] = hash.split('?');
    const params = new URLSearchParams(query);
    const ticket = /^\/ticket\/(\d+)$/.exec(path);
    if (ticket) return conversation(Number(ticket[1]));
    if (path === '/new') return create(params);
    if (path === '/tickets') return list();
    return home();
  }
  addEventListener('hashchange', route);
  route();
})();
