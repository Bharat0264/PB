const byId = id => document.getElementById(id);
const preview = new URLSearchParams(location.search).get('preview') === '1';
const board = byId('warehouse-content');
const status = byId('staff-status');
const drawer = byId('warehouse-detail');
const confirmation = byId('warehouse-confirm');
const filters = byId('warehouse-filters');
const lanes = ['New', 'Printing', 'Printed', 'Packed', 'Ready for pickup'];
const sections = ['Dashboard', 'Orders', 'Print Queue', 'Packing', 'Ready for Pickup', 'History', 'Printers', 'Inventory', 'Settings'];
const money = new Intl.NumberFormat('en-IN', {style:'currency', currency:'INR'}).format;
const demoOrders = preview ? makeSamples() : [];
let orders = [];
let online = preview;
let view = 'Dashboard';
let table = false;
let seen;
let timer;
let refreshing = false;
let sound = false;
let skipConfirm = false;
let paused = false;
let printAction;
let active;
let url;

function node(tag, text, cls) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}
function button(text, fn, cls = 'clay-button') {
  const el = node('button', text, cls);
  el.type = 'button';
  el.onclick = async () => {
    el.disabled = true;
    try { await fn(); }
    catch (error) { (drawer.open ? byId('detail-status') : status).textContent = error.message; }
    finally { el.disabled = false; }
  };
  return el;
}
function makeSamples() {
  const date = new Date().toISOString().slice(2, 10).replaceAll('-', '');
  return ['paid','paid','printing','printing','packed','packed','delivered'].map((state, index) => ({
    id:'demo-' + index, number:'PB-' + date + '-' + (4100 + index), status:state,
    partner:index === 5 ? 'Demo delivery partner' : null,
    paidAt:Math.floor(Date.now()/1000) - (index + 1)*435,
    customer:['Maya Rao','Arjun Dev','Sana Thomas'][index%3], phone:'0000000000',
    address:'SRM campus, Demo block ' + (index+1), slot:'Today, 4–6 PM',
    notes:index === 0 ? 'Please keep the two copies separate.' : '', priority:index === 0 ? 'Urgent' : index === 1 ? 'Express' : '',
    bill:{total:16000+index*750}, items:[
      {name:'Campus notes.pdf',size:182300,pages:12+index,copies:2,duplex:true,colour:index%2===0,paper:'A4',orientation:'Portrait',binding:'spiral'},
      {name:'Reference sheet.pdf',size:68410,pages:3,copies:1,colour:false,paper:index===1?'A3':'A4',orientation:'Landscape',binding:'none'},
    ],
    jobs:state==='paid'?[]:[0,1].map(position=>({position,state:index===2?'printing':'done'})),
    timeline:[{action:'paid',created:Math.floor(Date.now()/1000)-(index+1)*435},
      ...(state==='delivered'?[{action:'delivery_completed',created:Math.floor(Date.now()/1000)-60}]:[])],
  }));
}
function orderLabel(order) {
  return order.number || 'PB-' + order.id.slice(0,8).toUpperCase();
}
function stage(order) {
  if (order.status === 'paid') return 'New';
  if (order.status === 'printing') return order.items.length && order.items.every((_,i)=>jobState(order,i)==='done') ? 'Printed' : 'Printing';
  if (order.status === 'packed') return order.partner ? 'Ready for pickup' : 'Packed';
  return order.status === 'delivered' ? 'Delivered' : 'Out for delivery';
}
function jobState(order, index) { return order.jobs.find(job => job.position === index)?.state; }
function sheets(item) {return Math.ceil(item.pages / (item.duplex ? 2 : 1)) * item.copies;}
function elapsed(order) { return order.paidAt ? Math.max(0,Math.floor((Date.now()/1000-order.paidAt)/60)) : null; }
function today(epoch) { return epoch && new Date(epoch*1000).toDateString() === new Date().toDateString(); }
function spec(item) {
  return [item.colourPages?.length ? 'Mixed colour' : item.colour?'Colour':'Black & white',item.duplex?'Double-sided':'Single-sided',
    item.paper || 'A4',item.orientation,item.copies+' copies',item.pageRange?.length?'Pages '+item.pageRange.join(', '):item.pages+' pages',
    item.binding && item.binding!=='none'?item.binding+' binding':'No binding',sheets(item)+' sheets'].filter(Boolean).join(' · ');
}
async function request(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error || 'Warehouse connection unavailable.');
  }
  return response;
}
function notifyNew(fresh) {
  if (!fresh.length) return;
  status.textContent = fresh.length + ' new paid order' + (fresh.length === 1 ? '' : 's');
  if (document.hidden) {
    document.title = '(' + fresh.length + ') PrintBee warehouse';
    if ('Notification' in window && Notification.permission==='granted') new Notification('PrintBee warehouse', {body:status.textContent,tag:'printbee-warehouse'});
  }
  if (sound && window.AudioContext) {
    try {
      const audio = new AudioContext();
      const tone = audio.createOscillator(), gain = audio.createGain();
      gain.gain.value = .08;
      tone.frequency.value = 650;
      tone.connect(gain).connect(audio.destination);
      tone.onended = () => audio.close();
      tone.start();
      tone.stop(audio.currentTime + .15);
    } catch {}
  }
}
async function refresh() {
  if (preview) orders = demoOrders;
  else {
    const data = await (await request('/api/staff/orders')).json();
    orders = data.orders;
    online = data.agentOnline;
  }
  const fresh = seen ? orders.filter(o => o.status === 'paid' && !seen.has(o.id)) : [];
  for (const order of fresh) order.fresh = true;
  seen = new Set(orders.map(o => o.id));
  byId('agent-status').textContent = (preview ? 'Mock printer ' : 'Print agent ') + (online ? 'online' : 'offline');
  byId('agent-status').classList.toggle('warehouse-bad', !online);
  if (!preview) status.textContent = 'Today: ' + orders.filter(o=>today(o.paidAt)).length + ' paid orders';
  notifyNew(fresh);
  if (!board.contains(document.activeElement) || fresh.length) render();
}
function activeOrders() {
  const search = byId('warehouse-search').value.trim().toLowerCase();
  const state = byId('warehouse-state').value;
  const colour = byId('warehouse-colour').value, paper = byId('warehouse-paper').value;
  const date = byId('warehouse-date').value, priority = byId('warehouse-priority').value, partner = byId('warehouse-partner').value;
  const viewLanes = {'Print Queue':['New','Printing'],'Packing':['Printed','Packed'],'Ready for Pickup':['Packed','Ready for pickup'],'History':['Delivered','Out for delivery']};
  const allowed = viewLanes[view] || lanes;
  return orders.filter(o => allowed.includes(stage(o)) && (!state || stage(o)===state)
    && (!search || [orderLabel(o),o.customer,o.phone].join(' ').toLowerCase().includes(search))
    && (!colour || o.items.some(item=>colour === 'colour' ? item.colour || item.colourPages?.length : !item.colour))
    && (!paper || o.items.some(item=>(item.paper||'A4')===paper))
    && (!date || today(o.paidAt)) && (!priority || priority===o.priority)
    && (!partner || Boolean(o.partner)===(partner==='assigned')))
    .sort((a,b)=>Number(Boolean(b.priority))-Number(Boolean(a.priority)) || (b.paidAt||0)-(a.paidAt||0));
}
function dashboardStats() {
  const metrics = node('div',null,'warehouse-kpis');
  const times = orders.flatMap(o => {
    const start=o.timeline?.find(e=>e.action==='print_queued')?.created;
    const finish=o.timeline?.filter(e=>e.action==='print_done').at(-1)?.created;
    return start && finish ? [(finish-start)/60] : [];
  });
  const pairs = [
    ['New orders',orders.filter(o=>stage(o)==='New').length], ['Printing now',orders.filter(o=>stage(o)==='Printing').length],
    ['To pack',orders.filter(o=>stage(o)==='Printed').length], ['Ready for pickup',orders.filter(o=>o.status==='packed').length],
    ['Delivered today',orders.filter(o=>o.status==='delivered' && o.timeline?.some(e=>e.action==='delivery_completed' && today(e.created))).length],
    ['Avg. print time',times.length?Math.round(times.reduce((a,b)=>a+b,0)/times.length)+' min':'—'],
    ['Late orders',orders.filter(o=>lanes.includes(stage(o)) && elapsed(o)>=45).length],
  ];
  for (const [name,value] of pairs) {
    const card = node('div',null,'clay-card');
    card.append(node('strong',value),node('span',name));
    metrics.append(card);
  }
  return metrics;
}
function render() {
  board.replaceChildren();
  byId('warehouse-title').textContent = view==='Dashboard'?'Warehouse':view;
  for (const btn of byId('warehouse-nav').children) btn.toggleAttribute('aria-current',btn.textContent===view);
  const routine = !['Printers','Inventory','Settings'].includes(view);
  filters.hidden = !routine;
  if (!routine) { renderTools(); return; }
  const visible = activeOrders();
  if (view==='Dashboard') board.append(dashboardStats());
  if (view==='History') board.append(button('Export CSV', () => exportHistory(visible)));
  if (!visible.length) {
    board.append(node('p','No orders match this view.','clay-card'));
    return;
  }
  if (table || view==='History') {
    const wrapper = node('div',null,'clay-card warehouse-table');
    wrapper.tabIndex=0;
    wrapper.setAttribute('aria-label','Order table');
    const chart=node('table',null,'clay-table');
    const head=node('thead'), row=node('tr');
    for (const title of ['Order','Customer','Status','Files','Sheets','Action']) { const cell=node('th',title); cell.scope='col'; row.append(cell); }
    head.append(row); chart.append(head);
    const body=node('tbody');
    for (const order of visible) {
      const line=node('tr');
      for (const value of [orderLabel(order),order.customer,stage(order),order.items.length,order.items.reduce((sum,item)=>sum+sheets(item),0)]) line.append(node('td',value));
      const action=node('td');
      action.append(button('View '+orderLabel(order),()=>openOrder(order.id)));
      line.append(action); body.append(line);
    }
    chart.append(body); wrapper.append(chart); board.append(wrapper);
    return;
  }
  const grid=node('div',null,'warehouse-board');
  grid.tabIndex=0;
  grid.setAttribute('aria-label','Order board');
  for (const lane of lanes) {
    const column=node('section',null,'warehouse-lane');
    const items=visible.filter(o=>stage(o)===lane);
    column.append(node('h2',lane+' ('+items.length+')'));
    for (const order of items) {
      const card=node('article',null,'clay-card warehouse-order'+(order.priority?' warehouse-priority':'')+(order.fresh?' warehouse-arrive':''));
      const minutes=elapsed(order);
      card.append(node('h3',orderLabel(order)),node('p',order.customer));
      if (order.priority) card.append(node('span',order.priority,'clay-badge warehouse-warn'));
      if (minutes!=null) card.append(node('p',minutes+' min since payment'),node('span',minutes>=45?'SLA overdue':(45-minutes)+' min left','clay-badge '+(minutes>=45?'warehouse-bad':minutes>=30?'warehouse-warn':'')));
      const pages=order.items.reduce((sum,item)=>sum+item.pages*item.copies,0);
      card.append(node('p',order.items.length+' files · '+pages+' pages'),
        node('p',(order.items.some(i=>i.colour||i.colourPages?.length)?'Colour':'Black & white')+(order.items.some(i=>i.binding&&i.binding!=='none')?' · Binding':'') ),
        button('Open '+orderLabel(order),()=>openOrder(order.id)));
      column.append(card);
    }
    grid.append(column);
  }
  board.append(grid);
}
function renderTools() {
  const card=node('section',null,'clay-card');
  card.append(node('h2',view));
  if (view==='Printers') {
    card.append(node('p',preview?'Mock printer · A4/A3 · Colour · Duplex · Online':online?'Print agent online. Printer selection is configured on its workstation.':'Print agent offline.'));
    if (preview) card.append(button(paused?'Resume mock queue':'Pause mock queue',()=>{paused=!paused;render();}),button('Test print',()=>{status.textContent='Mock printer test passed. No paper used.';}));
  }
  if (view==='Inventory') {
    card.append(node('p',preview?'Sample stock':'Stock counts are managed at the print room.'));
    if (preview) {
      const list=node('ul');
      for (const item of ['A4 paper · 490 sheets','A3 paper · 38 sheets','Spiral coils · 12 remaining · Low stock','Colour toner · 62%']) list.append(node('li',item));
      card.append(list);
    }
  }
  if (view==='Settings') {
    card.append(button(sound?'Turn chime off':'Turn chime on',()=>{sound=!sound;render();}),
      button(skipConfirm?'Require print confirmation':'Skip print confirmation',()=>{skipConfirm=!skipConfirm;render();}));
    if ('Notification' in window) card.append(button('Enable browser notifications',async()=>{
      status.textContent=(await Notification.requestPermission())==='granted'?'Notifications enabled.':'Notifications were not enabled.';
    }));
  }
  board.append(card);
}
function exportHistory(rows) {
  const cell = value => {
    const s=String(value??'');
    return '"'+(/^[=+\-@\t\r\n]/.test(s)?"'":'')+s.replaceAll('"','""')+'"';
  };
  const lines=[['Order','Customer','Status','Files','Sheets'],...rows.map(o=>[orderLabel(o),o.customer,stage(o),o.items.length,o.items.reduce((n,i)=>n+sheets(i),0)])];
  const csv=URL.createObjectURL(new Blob([lines.map(line=>line.map(cell).join(',')).join('\r\n')],{type:'text/csv'}));
  download(csv,'printbee-warehouse.csv');
  setTimeout(()=>URL.revokeObjectURL(csv),1000);
}
function download(link, filename) {
  const a=node('a'); a.href=link; a.download=filename; a.click();
}
async function file(order,index,show,host) {
  if (preview) {
    if (show) host.append(node('p','This sample order has no customer document.'));
    return;
  }
  const response=await request('/api/staff/files/'+order.id+'/'+index);
  const data=await response.blob();
  if (show && !drawer.open) return;
  const asset=URL.createObjectURL(show ? data.slice(0,data.size,'application/pdf') : data);
  if (!show) {
    download(asset,order.items[index].name);
    setTimeout(()=>URL.revokeObjectURL(asset),1000);
    return;
  }
  if (url) {
    URL.revokeObjectURL(url);
    drawer.querySelector('iframe')?.remove();
  }
  url=asset;
  const viewer=node('iframe');
  viewer.title='Preview '+order.items[index].name;
  viewer.src=url;
  host.append(viewer);
}
function openOrder(id, reset = true) {
  active=id;
  const order=orders.find(o=>o.id===id);
  if (!order) return;
  if (reset) byId('detail-status').textContent='';
  byId('detail-title').textContent=orderLabel(order)+' · '+stage(order);
  const body=byId('detail-body');
  if (url) {URL.revokeObjectURL(url);url=null;}
  body.replaceChildren();
  const phone=node('a',order.phone);
  phone.href='tel:'+String(order.phone||'').replace(/[^+0-9]/g,'');
  body.append(node('p','Payment confirmed'+(Number.isInteger(order.bill?.total)?' · '+money(order.bill.total/100):'')+(order.coupon?' · '+order.coupon:'')),
    node('p',order.paidAt?'Paid '+new Date(order.paidAt*1000).toLocaleString():'Payment time unavailable.'),
    node('h3',order.customer),phone,node('p',order.address),node('p',order.slot),
    node('p',order.partner?'Partner: '+order.partner:'Awaiting partner assignment'));
  if (order.notes) body.append(node('p',order.notes,'warehouse-notes'));
  body.append(node('p',order.items.reduce((sum,item)=>sum+sheets(item),0)+' sheets required'));
  const printable = ['New','Printing'].includes(stage(order));
  order.items.forEach((item,index)=>{
    const card=node('section',null,'warehouse-file');
    const job=order.jobs.find(entry=>entry.position===index);
    card.append(node('h3',item.name),node('p',Math.ceil((item.size||0)/1024)+' KB · '+spec(item)),
      node('p',job?(job.state==='done'?'Done':job.state)+(job.error?' · '+job.error:''):'Not queued'));
    if (['paid','printing','packed'].includes(order.status)) {
      if (/\.pdf$/i.test(item.name)) card.append(button('Preview PDF',()=>file(order,index,true,card)));
      if (!preview) card.append(button('Download file',()=>file(order,index,false,card)));
    }
    if (printable && (!job || job.state==='failed')) card.append(button(job?'Retry print':'Print file',()=>confirmPrint(order,index)));
    if (!preview && printable && (!job || job.state==='failed')) card.append(button('Confirm manually printed',async()=>{
      if (!window.confirm('Confirm this file has already been printed?')) return;
      await request('/api/staff/orders/'+order.id+'/printed/'+index,{method:'POST'});
      await refresh();
      openOrder(order.id);
    }));
    body.append(card);
  });
  if (printable) body.append(button('Print all',()=>confirmPrint(order,'all')));
  if (stage(order)==='Printed') {
    const list=node('fieldset');
    list.append(node('legend','Packing checklist'));
    for (const label of ['All files printed','Binding / finishing checked','Print quality checked','Copies counted']) {
      const row=node('label'); const input=node('input'); input.type='checkbox';
      row.append(input,document.createTextNode(' '+label+' ')); list.append(row);
    }
    const pack=button('Mark packed',async()=>{
      if (list.querySelector('input:not(:checked)')) throw new Error('Complete the packing checklist.');
      if (preview) {order.status='packed'; addEvent(order,'packed');}
      else await request('/api/staff/orders/'+order.id+'/advance',{method:'POST',headers:{'X-Order-Status':'printing'}});
      await refresh(); openOrder(order.id);
    });
    list.append(pack);body.append(list);
  }
  if (order.status==='packed') {
    if (preview) body.append(button('Simulate partner handover',async()=>{order.status='out_for_delivery';addEvent(order,'delivery_picked_up');await refresh();openOrder(order.id);}));
    else body.append(button('Download packing label',async()=>{
      const response=await request('/api/staff/orders/'+order.id+'/label');
      const label=URL.createObjectURL(await response.blob());
      download(label,orderLabel(order)+'-packing.pdf');setTimeout(()=>URL.revokeObjectURL(label),1000);
    }));
  }
  if (order.timeline?.length) {
    const timeline=node('ol');
    for (const entry of order.timeline) timeline.append(node('li',entry.action.replaceAll('_',' ')+' · '+new Date(entry.created*1000).toLocaleString()));
    body.append(node('h3','Order timeline'),timeline);
  }
  if (!drawer.open) drawer.showModal();
}
function addEvent(order, action) { order.timeline.push({action,created:Math.floor(Date.now()/1000)}); }
function confirmPrint(order,index) {
  const selection=index==='all' ? order.items.map((_,i)=>i).filter(i=>!jobState(order,i)||jobState(order,i)==='failed') : [index];
  if (!selection.length) throw new Error('Every file is already queued or printed.');
  if (preview && paused) throw new Error('Resume the mock queue from Printers first.');
  const run=()=>sendPrint(order,index,selection);
  if (skipConfirm) return run();
  byId('confirm-body').replaceChildren(node('p',preview?'Print to Mock Printer':'Print to the warehouse workstation'), ...selection.map(i=>node('p',order.items[i].name+' · '+spec(order.items[i]))));
  printAction=run;
  confirmation.returnValue='cancel';
  confirmation.showModal();
}
async function sendPrint(order,index,selection) {
  if (preview) {
    order.status='printing';
    addEvent(order,'print_queued');
    for (const position of selection) {
      order.jobs=order.jobs.filter(job=>job.position!==position);
      order.jobs.push({position,state:'queued'});
    }
    setTimeout(()=>updateMockJobs(order,selection,'printing'),350);
    setTimeout(()=>updateMockJobs(order,selection,'done'),1350);
  } else {
    const result=await (await request('/api/staff/orders/'+order.id+'/print/'+index,{method:'POST'})).json();
    if (!result.queued) throw new Error('No new files were queued. Refresh and check the order.');
  }
  await refresh();
  openOrder(order.id);
}
async function updateMockJobs(order,selection,state) {
  order.jobs.filter(job=>selection.includes(job.position)).forEach(job=>{job.state=state;});
  if (state==='done') addEvent(order,'print_done');
  await refresh();
  if (drawer.open && active===order.id) openOrder(order.id,false);
}
confirmation.addEventListener('close',()=>{
  const run=printAction;
  printAction=null;
  if (confirmation.returnValue==='print' && run) run().catch(error=>{byId('detail-status').textContent=error.message;});
});
drawer.addEventListener('close',()=>{
  active=null;
  if (url) {URL.revokeObjectURL(url);url=null;}
  render();
});
filters.addEventListener('input',render);
byId('warehouse-view').onclick=event=>{
  table=!table;event.currentTarget.textContent=table?'Board view':'Table view';render();
};
document.addEventListener('keydown',event=>{
  if (event.ctrlKey||event.metaKey||event.altKey||event.defaultPrevented||event.target.closest('input,select,textarea,[contenteditable]')) return;
  if (event.key==='/' && !drawer.open && !filters.hidden) {event.preventDefault();byId('warehouse-search').focus();}
  const key=event.key.toLowerCase();
  if (!confirmation.open && drawer.open && ['p','k'].includes(key)) {
    const name=key==='p'?'Print all':'Mark packed';
    [...byId('detail-body').querySelectorAll('button')].find(el=>el.textContent===name)?.click();
  }
  if (!drawer.open && ['ArrowRight','ArrowLeft'].includes(event.key) && board.contains(document.activeElement)) {
    const buttons=[...board.querySelectorAll('.warehouse-order button')];
    const current=buttons.indexOf(document.activeElement);
    const next=buttons[current+(event.key==='ArrowRight'?1:-1)];
    if (next) {event.preventDefault();next.focus();}
  }
});
document.addEventListener('visibilitychange',()=>{
  if (!document.hidden) document.title='PrintBee warehouse';
});
async function start() {
  byId('warehouse-app').hidden=false;
  byId('warehouse-nav').hidden=false;
  byId('agent-status').hidden=false;
  for (const label of sections) byId('warehouse-nav').append(button(label,()=>{
    view=label;byId('warehouse-state').value='';render();
  },'warehouse-nav-button'));
  for (const label of [...lanes,'Out for delivery','Delivered']) byId('warehouse-state').append(new Option(label));
  await refresh();
}
async function refreshLive() {
  if (refreshing) return;
  refreshing = true;
  try {
    const previous=active && orders.find(o=>o.id===active);
    await refresh();
    const current=active && orders.find(o=>o.id===active);
    if (drawer.open && !confirmation.open && current && previous && JSON.stringify(current.jobs)!==JSON.stringify(previous.jobs)) {
      // Replace the drawer only if focus is outside its controls.
      if (!byId('detail-body').contains(document.activeElement)) openOrder(active,false);
      else byId('detail-status').textContent='Print status changed. Reopen the order to refresh its details.';
    }
  } catch {
    status.textContent='Connection lost. Retrying automatically…';
    byId('agent-status').textContent='Connection unavailable';
  } finally {
    refreshing = false;
  }
}
if (preview) {
  byId('portal-login').hidden=true;
  byId('warehouse-mode-link').href='/warehouse';
  byId('warehouse-mode-link').textContent='Live warehouse sign-in';
  status.textContent='Sample dashboard · Mock printer · No live orders';
  start().catch(error=>{status.textContent=error.message;});
} else {
  connectPortal('warehouse',status,async()=>{
    try {await start();} finally {timer=setInterval(refreshLive,5000);}
  },()=>clearInterval(timer));
}
