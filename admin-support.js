/* Admin support inbox (live data only). Lists tickets, shows the conversation, and lets an admin reply, leave an
 * internal note, change status / priority / assignee, and see the linked order.
 *
 * Every piece of text that came from a customer or the database goes onto the page through textContent / text nodes
 * (see h()). There is no innerHTML with ticket text in this file.
 */
const API = '/api/admin/support';
const STATUS = {
  open: ['Open', 'is-open'], in_progress: ['In progress', 'is-progress'], pending: ['Waiting for customer', 'is-pending'],
  resolved: ['Resolved', 'is-resolved'], closed: ['Closed', 'is-closed'],
};
const PRIORITY = {low: ['Low', 'p-low'], normal: ['Normal', 'p-normal'], high: ['High', 'p-high'], urgent: ['Urgent', 'p-urgent']};
const OTP = {not_issued: ['Not issued yet', 'is-closed'], active: ['Active', 'is-resolved'], expired: ['Expired', 'is-pending'], locked: ['Locked after 3 wrong tries', 'is-urgent']};
const SORTS = [['updated', 'Latest activity'], ['newest', 'Newest first'], ['oldest', 'Oldest first'], ['priority', 'Highest priority']];
const humanise = key => String(key || '').replace(/[_.]/g, ' ').replace(/^./, c => c.toUpperCase());
const orderLabel = key => (window.PrintBeeStatus?.model ? PrintBeeStatus.label(key) : humanise(key));
const money = new Intl.NumberFormat('en-IN', {style: 'currency', currency: 'INR'});
const PAGE = 25;

// the list filters are kept while you open a ticket and come back
const filters = {status: 'active', priority: '', category: '', assignee: '', q: '', sort: 'updated', offset: 0};
let meta = null;                                  // {me, agents, categories}

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
function icon(path, size = 18) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false'})) svg.setAttribute(k, v);
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter(kid => kid != null && kid !== false));
const when = seconds => seconds ? new Date(seconds * 1000).toLocaleString('en-IN', {day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'}) : '';
const fileSize = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replaceAll('-', '').padEnd(20, '0');
const statusChip = status => h('span', {class: 'sp-chip ' + (STATUS[status]?.[1] || ''), text: STATUS[status]?.[0] || humanise(status)});
const priorityChip = priority => h('span', {class: 'sp-chip ' + (PRIORITY[priority]?.[1] || ''), text: PRIORITY[priority]?.[0] || humanise(priority)});
const sourceBadge = source => source === 'buzz' ? h('span', {class: 'sp-source is-buzz', title: 'Created by Buzz, the AI assistant'}, icon('M12 3v3M5 8h14v10H5zM9 13h.01M15 13h.01M9 21h6', 14), 'Buzz AI')
  : source === 'admin' ? h('span', {class: 'sp-source', title: 'Opened by the team for a customer'}, 'Team') : null;

async function request(path, {method = 'GET', body, key} = {}) {
  let response;
  try {
    response = await fetch(path, {method, cache: 'no-store', credentials: 'same-origin',
      headers: {...(body !== undefined ? {'Content-Type': 'application/json'} : {}), ...(key ? {'Idempotency-Key': key} : {})},
      body: body !== undefined ? JSON.stringify(body) : undefined});
  } catch { throw new Error('No connection. Check your network and try again.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}

/** The red number on the sidebar link: tickets that are open and nobody has picked up yet. */
export async function supportBadge() {
  const badge = document.getElementById('support-badge');
  if (!badge) return;
  try {
    const {new: count} = await request(`${API}/tickets?limit=1`);
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.hidden = !count;
    badge.setAttribute('aria-label', count + ' new support ' + (count === 1 ? 'ticket' : 'tickets'));
    badge.title = count + ' new support ' + (count === 1 ? 'ticket' : 'tickets') + ' waiting for someone to pick them up';
  } catch { /* leave the last number */ }
}

export function mountSupport(host, sub = '') {
  let timer = null, alive = true;
  const stop = () => { alive = false; clearInterval(timer); };
  const guard = fn => async (...args) => { try { return await fn(...args); } catch (error) { if (alive) showError(error); } };
  const showError = error => fill(host, h('div', {class: 'sp-error', role: 'alert'}, h('strong', {text: 'Could not load support'}), h('p', {text: error.message}),
    h('a', {class: 'sp-btn', href: '#support', text: 'Back to the inbox'})));
  (async () => {
    try {
      meta ||= await request(`${API}/agents`);
      if (!alive) return;
      /^\d+$/.test(sub) ? detail(Number(sub)) : list();
    } catch (error) { if (alive) showError(error); }
  })();

  // ---------------------------------------------------------------- list
  function list() {
    const statsBox = h('div', {class: 'sp-stats', role: 'group', 'aria-label': 'Tickets by status'});
    const bar = h('div', {class: 'sp-toolbar'});
    const rows = h('div', {class: 'sp-list', 'aria-live': 'polite'});
    const pager = h('div', {class: 'sp-pager'});
    fill(host, statsBox, bar, rows, pager);

    const search = h('input', {type: 'search', class: 'sp-input sp-search', placeholder: 'Search number, subject, customer or order', 'aria-label': 'Search tickets', value: filters.q});
    let debounce;
    search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => { filters.q = search.value.trim(); filters.offset = 0; load(); }, 300); });
    const select = (label, key, options) => h('label', {class: 'sp-select'}, h('span', {text: label}),
      h('select', {class: 'sp-input', onchange: event => { filters[key] = event.target.value; filters.offset = 0; load(); }},
        options.map(([value, text]) => h('option', {value, text, selected: filters[key] === value}))));
    fill(bar, search,
      select('Status', 'status', [['', 'All'], ['active', 'Active'], ...Object.entries(STATUS).map(([k, [text]]) => [k, text])]),
      select('Priority', 'priority', [['', 'Any'], ...Object.entries(PRIORITY).map(([k, [text]]) => [k, text])]),
      select('Category', 'category', [['', 'Any'], ...meta.categories.map(c => [c.key, c.label])]),
      select('Assigned to', 'assignee', [['', 'Anyone'], ['unassigned', 'Unassigned'], ...meta.agents.map(a => [a, a === meta.me ? 'Me (' + a + ')' : a])]),
      select('Sort', 'sort', SORTS));

    const load = guard(async () => {
      const query = new URLSearchParams({limit: PAGE, offset: filters.offset, sort: filters.sort});
      for (const key of ['status', 'priority', 'category', 'assignee', 'q']) if (filters[key]) query.set(key, filters[key]);
      const data = await request(`${API}/tickets?${query}`);
      if (!alive) return;
      if (data.total && filters.offset >= data.total) { filters.offset = Math.max(0, (Math.ceil(data.total / PAGE) - 1) * PAGE); return load(); }
      drawStats(data);
      drawRows(data);
      supportBadge();
    });
    const stat = (label, count, status, note) => h('button', {type: 'button', class: 'sp-stat' + (filters.status === status && !note ? ' is-on' : ''), 'aria-pressed': String(filters.status === status),
      onclick: () => { filters.status = status; filters.assignee = note === 'new' ? 'unassigned' : ''; filters.offset = 0; if (note === 'new') filters.status = 'open'; list(); }},
      h('strong', {text: String(count)}), h('span', {text: label}));
    function drawStats(data) {
      const c = data.counts;
      fill(statsBox, stat('New', data.new, 'open', 'new'), stat('Open', c.open, 'open'), stat('In progress', c.in_progress, 'in_progress'),
        stat('Waiting for customer', c.pending, 'pending'), stat('Resolved', c.resolved, 'resolved'), stat('Closed', c.closed, 'closed'));
      statsBox.firstChild.classList.add('is-new');
    }
    function drawRows(data) {
      if (!data.tickets.length) {
        fill(rows, h('div', {class: 'sp-empty'}, icon('M4 5h16v11H9l-5 4zM8 9.5h8M8 12.5h5', 28),
          h('strong', {text: Object.values(filters).some((v, i) => i < 5 && v && v !== 'active') || filters.q ? 'No tickets match these filters' : 'No tickets here yet'}),
          h('p', {text: 'New customer tickets will show up here as they arrive.'})));
        fill(pager);
        return;
      }
      fill(rows, data.tickets.map(t => h('a', {class: 'sp-row' + (t.status === 'open' && !t.assignee ? ' is-new' : ''), href: '#support/' + t.id},
        h('span', {class: 'sp-row-main'},
          h('span', {class: 'sp-row-title'}, h('strong', {text: t.subject}), sourceBadge(t.source)),
          h('small', {class: 'sp-row-meta', text: [t.number, t.customer, t.categoryLabel, t.orderNumber].filter(Boolean).join(' · ')}),
          t.preview ? h('small', {class: 'sp-row-preview', text: t.preview}) : null),
        h('span', {class: 'sp-row-side'}, h('span', {class: 'sp-chips'}, statusChip(t.status), priorityChip(t.priority)),
          h('small', {text: t.assignee ? 'Assigned: ' + t.assignee : 'Unassigned'}), h('small', {text: when(t.updated)})))));
      const from = data.offset + 1, to = data.offset + data.tickets.length;
      fill(pager, h('span', {class: 'sp-count', text: `${from}–${to} of ${data.total}`}),
        h('div', {class: 'sp-pager-buttons'},
          h('button', {type: 'button', class: 'sp-btn', disabled: data.offset <= 0, onclick: () => { filters.offset = Math.max(0, filters.offset - PAGE); load(); }, text: 'Previous'}),
          h('button', {type: 'button', class: 'sp-btn', disabled: to >= data.total, onclick: () => { filters.offset += PAGE; load(); }, text: 'Next'})));
    }
    load();
    timer = setInterval(() => { if (!document.hidden && document.activeElement !== search) load(); }, 30000);
  }

  // ---------------------------------------------------------------- one ticket
  function detail(id) {
    const head = h('header', {class: 'sp-card sp-head'});
    const thread = h('div', {class: 'sp-thread', role: 'log', 'aria-label': 'Conversation'});
    const composer = h('div');
    const side = h('aside', {class: 'sp-side'});
    fill(host, h('a', {class: 'sp-back', href: '#support'}, icon('m15 6-6 6 6 6', 18), 'All tickets'),
      h('div', {class: 'sp-detail'}, h('div', {class: 'sp-main'}, head, thread, composer), side));
    let ticket, key = newKey(), shown = '';
    const status = h('p', {class: 'sp-flash', role: 'status'});

    const act = guard(async (path, body, message) => {
      const result = await request(`${API}/tickets/${id}/${path}`, {method: 'POST', body, key: path === 'reply' || path === 'note' ? key : undefined});
      if (path === 'reply' || path === 'note') key = newKey();
      const wasClosed = ticket.status === 'closed';
      ticket = result.ticket;
      draw(path === 'reply' || path === 'note' || wasClosed !== (ticket.status === 'closed'));   // keep a half-written reply when only a menu changed
      flash(message);
      supportBadge();
    });
    function flash(message) { status.textContent = message || ''; if (message) setTimeout(() => { if (status.textContent === message) status.textContent = ''; }, 4000); }
    const field = (label, control) => h('label', {class: 'sp-field'}, h('span', {text: label}), control);

    function drawHead() {
      const statusSelect = h('select', {class: 'sp-input', onchange: event => act('status', {status: event.target.value}, 'Status updated.')},
        h('option', {value: ticket.status, text: STATUS[ticket.status][0]}), ticket.nextStatuses.map(s => h('option', {value: s, text: '→ ' + STATUS[s][0]})));
      const prioritySelect = h('select', {class: 'sp-input', onchange: event => act('priority', {priority: event.target.value}, 'Priority updated.')},
        Object.entries(PRIORITY).map(([k, [text]]) => h('option', {value: k, text, selected: ticket.priority === k})));
      const assignee = h('select', {class: 'sp-input', onchange: event => act('assign', {assignee: event.target.value || null}, event.target.value ? 'Assigned.' : 'Unassigned.')},
        h('option', {value: '', text: 'Unassigned'}), meta.agents.map(a => h('option', {value: a, text: a === meta.me ? 'Me (' + a + ')' : a, selected: ticket.assignee === a})));
      fill(head,
        h('div', {class: 'sp-title'}, h('h2', {text: ticket.subject}), statusChip(ticket.status), priorityChip(ticket.priority), sourceBadge(ticket.source)),
        h('p', {class: 'sp-meta', text: [ticket.number, ticket.categoryLabel, 'Opened ' + when(ticket.created)].join(' · ')}),
        h('p', {class: 'sp-meta'}, 'Customer: ', h('strong', {text: ticket.customer})),
        h('div', {class: 'sp-controls'}, field('Status', statusSelect), field('Priority', prioritySelect), field('Assigned to', assignee),
          ticket.assignee === meta.me ? null : h('button', {type: 'button', class: 'sp-btn sp-take', text: 'Assign to me', onclick: () => act('assign', {assignee: meta.me}, 'Assigned to you.')})),
        status);
    }
    const attachment = a => h('a', {class: 'sp-file', href: `${API}/attachments/${a.id}`, download: a.name, rel: 'noopener'}, icon('M6 3h8l4 4v14H6zM14 3v5h4', 16), h('span', {text: a.name}), h('small', {text: fileSize(a.size)}));
    function drawThread() {
      const signature = ticket.messages.length + ':' + ticket.status;
      if (signature === shown) return;
      shown = signature;
      fill(thread, ticket.aiSummary ? h('section', {class: 'sp-ai'}, h('strong', {}, icon('M12 3v3M5 8h14v10H5zM9 13h.01M15 13h.01', 16), ' Buzz summary'), h('p', {text: ticket.aiSummary})) : null,
        ticket.messages.map(m => {
          if (m.kind === 'event') return h('p', {class: 'sp-event'}, h('span', {text: `${m.body} · ${m.author === 'customer' ? 'customer' : m.author} · ${when(m.created)}`}));
          const note = m.kind === 'internal', agent = m.kind === 'agent';
          return h('article', {class: 'sp-msg ' + (note ? 'is-note' : agent ? 'is-agent' : 'is-customer')},
            h('header', {}, note ? icon('M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z', 15) : null,
              h('strong', {text: note ? 'Internal note' : agent ? 'Reply to customer' : 'Customer'}), h('small', {text: `${m.author} · ${when(m.created)}`})),
            note ? h('p', {class: 'sp-note-hint', text: 'Only your team can see this. The customer never does.'}) : null,
            h('p', {class: 'sp-text', text: m.body}),
            m.attachments?.length ? h('div', {class: 'sp-files'}, m.attachments.map(attachment)) : null);
        }));
    }
    let mode = 'reply';
    function drawComposer() {
      if (ticket.status === 'closed') return fill(composer, h('p', {class: 'sp-closed', text: 'This ticket is closed. Reopen it with the status menu to reply, or leave an internal note below.'}), compose(true));
      fill(composer, compose(false));
    }
    function compose(noteOnly) {
      if (noteOnly) mode = 'note';
      const box = h('textarea', {class: 'sp-input', rows: '4', maxlength: '4000', 'aria-label': 'Message'});
      const send = h('button', {type: 'submit', class: 'sp-btn sp-primary'});
      const tabs = h('div', {class: 'sp-tabs', role: 'group', 'aria-label': 'Message type'});
      const paint = () => {
        const note = mode === 'note';
        form.classList.toggle('is-note', note);
        box.placeholder = note ? 'Write a private note for your team…' : 'Write a reply the customer will see…';
        send.textContent = note ? 'Save internal note' : 'Send reply';
        fill(tabs, noteOnly ? null : h('button', {type: 'button', class: 'sp-tab', 'aria-pressed': String(!note), onclick: () => { mode = 'reply'; paint(); }, text: 'Reply to customer'}),
          h('button', {type: 'button', class: 'sp-tab', 'aria-pressed': String(note), onclick: () => { mode = 'note'; paint(); }, text: 'Internal note'}));
        hint.textContent = note ? 'Visible to admins and warehouse staff only.' : 'The customer gets an email that there is a reply.';
      };
      const hint = h('small', {class: 'sp-hint'});
      const form = h('form', {class: 'sp-card sp-compose'}, tabs, box, h('div', {class: 'sp-compose-row'}, hint, send));
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!box.value.trim()) return flash('Write a message first.');
        send.disabled = true;
        await act(mode, {message: box.value}, mode === 'note' ? 'Note saved.' : 'Reply sent.');
        send.disabled = false;
      });
      paint();
      return form;
    }
    function drawSide() {
      const o = ticket.order, d = o?.delivery;
      const row = (label, value) => value == null || value === '' ? null : h('div', {class: 'sp-kv'}, h('dt', {text: label}), h('dd', {}, value));
      fill(side,
        h('section', {class: 'sp-card sp-order'}, h('h3', {text: 'Order'}),
          !o ? h('p', {class: 'sp-muted', text: 'This ticket is not linked to an order.'}) : h('dl', {},
            row('Order', o.number),
            row('Status', h('span', {class: 'sp-chip', text: orderLabel(o.status)})),
            row('Paid', when(o.paidAt)),
            row('Total', Number.isFinite(o.total) ? money.format(o.total / 100) : null),
            row('Files', String(o.files)),
            row('Customer', o.customerName), row('Address', o.address),
            row('Bee Runner', d ? d.beeRunner : 'Not assigned yet'),
            d ? row('Delivery code', h('span', {}, h('span', {class: 'sp-chip ' + (OTP[d.otpState]?.[1] || ''), text: OTP[d.otpState]?.[0] || d.otpState}),
              h('small', {class: 'sp-muted', text: ' The code itself is never shown here.'}))) : null,
            row('Last location', d?.lastLocationAt ? when(d.lastLocationAt) : null)),
          o ? h('a', {class: 'sp-btn sp-invoice', href: o.invoice.url, download: o.invoice.number + '.pdf', rel: 'noopener'}, icon('M12 4v10M8 10l4 4 4-4M5 19h14', 16), 'Invoice ' + o.invoice.number) : null),
        o?.events?.length ? h('section', {class: 'sp-card'}, h('h3', {text: 'Order history'}),
          h('ol', {class: 'sp-events'}, o.events.map(e => h('li', {}, h('span', {text: orderLabel(e.to || e.event)}), h('small', {text: when(e.created)}))))) : null);
    }
    function draw(full) { drawHead(); drawThread(); if (full) drawComposer(); drawSide(); }

    (async () => {
      try { ticket = (await request(`${API}/tickets/${id}`)).ticket; } catch (error) { if (alive) showError(error); return; }
      if (!alive) return;
      draw(true);
      timer = setInterval(async () => {
        // New messages appear on their own; what you are typing is left alone.
        if (document.hidden) return;
        try {
          const fresh = (await request(`${API}/tickets/${id}`)).ticket;
          const changed = fresh.messages.length !== ticket.messages.length || fresh.status !== ticket.status || fresh.assignee !== ticket.assignee || fresh.priority !== ticket.priority;
          const closedChanged = (fresh.status === 'closed') !== (ticket.status === 'closed');
          ticket = fresh;
          if (changed && !host.contains(document.activeElement.closest?.('select'))) draw(closedChanged);
        } catch { /* try again next time */ }
      }, 20000);
    })();
  }

  return stop;
}
