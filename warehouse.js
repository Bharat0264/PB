const byId = id => document.getElementById(id);
const preview = new URLSearchParams(location.search).get('preview') === '1';
const board = byId('warehouse-content');
const status = byId('staff-status');
const station = byId('warehouse-detail');
const confirmation = byId('warehouse-confirm');
const viewer = byId('warehouse-preview');
const arrival = byId('warehouse-new');
const mobile = matchMedia('(max-width:1050px)');
const buckets = ['New', 'Printing', 'Ready'];
const sections = [['Home','home'],['Print Queue','printer'],['Ready','truck'],['Printers','monitor'],['History','history'],['Settings','settings']];
const glyphs = {
  home:'<path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 21v-7h6v7"/>',
  printer:'<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6zM6 12h.01"/>',
  truck:'<path d="M10 17H5V5h12v12h-3m3-10h3l3 4v6h-2m-4 0h-3"/><circle cx="8" cy="17" r="2"/><circle cx="19" cy="17" r="2"/>',
  monitor:'<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  history:'<path d="M3 12a9 9 0 1 1 2.2 5.9M3 4v8h8m1-4v5l3 2"/>',
  settings:'<path d="M4 6h16M4 12h16M4 18h16M8 4v4m8 2v4m-6 2v4"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  sound:'<path d="M3 9v6h4l5 4V5L7 9zm13 0a4 4 0 0 1 0 6m2-9a8 8 0 0 1 0 12"/>',
  mute:'<path d="M3 9v6h4l5 4V5L7 9zm13 1 5 5m0-5-5 5"/>',
  file:'<path d="M6 3h8l4 4v14H6zm8 0v5h4M9 13h6m-6 4h6"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
};
function icon(name) {
  const span = node('span');
  span.setAttribute('aria-hidden','true');
  span.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'+glyphs[name]+'</svg>';
  return span;
}
const demoOrders = preview ? makeSamples() : [];
const preferences = Object.fromEntries(['sound','skipConfirm','takeover','large','contrast'].map(key => [key,readSetting(key)]));
const money = new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format;
let orders = [], known, newBadges = new Set(), online = preview, connected = true, paused = false;
let view = 'Home', tab = 'New', active, sheet = false, restoreFocus;
let printAction, printPending = false, previewUrl, previewRequest = 0, arrivalOrder;
let staffDock;
let polling, busyRefresh = false, refreshVersion = 0, toastTimer, audio;
const filters = {colour:'', paper:'', date:'', priority:'', partner:'', from:'', to:''};

function readSetting(key) {
  try { return localStorage.getItem('printbee-warehouse-'+key)==='1'; } catch { return false; }
}
function setSetting(key,value) {
  preferences[key] = value;
  try { localStorage.setItem('printbee-warehouse-'+key,value?'1':'0'); } catch {}
  if (key==='sound' && value) prepareSound();
  syncPreferences();
}
function prepareSound() {
  const Audio=window.AudioContext || window.webkitAudioContext;
  if (!preferences.sound || !Audio) return;
  try {
    audio ||= new Audio();
    void audio.resume().catch(()=>{});
  } catch {}
}
function syncPreferences() {
  document.body.classList.toggle('wh-large',preferences.large);
  document.body.classList.toggle('wh-contrast',preferences.contrast);
  const control = byId('sound-toggle');
  control.setAttribute('aria-pressed',String(preferences.sound));
  control.title = preferences.sound?'Mute order chime':'Enable order chime';
  control.replaceChildren(icon(preferences.sound?'sound':'mute'));
  const setting=board.querySelector('[data-setting="sound"]');
  if (setting) setting.checked=preferences.sound;
}
function node(tag,text,cls) {
  const el=document.createElement(tag);
  if (text!=null) el.textContent=text;
  if (cls) el.className=cls;
  return el;
}
function button(text,action,cls='clay-button') {
  const el=node('button',text,cls);
  el.type='button';
  el.addEventListener('click',async()=>{
    el.disabled=true;
    try { await action(); }
    catch (error) { announce(error.message || 'Something went wrong. Try again.',true); }
    finally { el.disabled=false; }
  });
  return el;
}
function announce(message,detail=false) {
  const line=byId(detail?'detail-status':'staff-status');
  window.clearTimeout(toastTimer);
  byId(detail?'staff-status':'detail-status').textContent='';
  line.textContent=message;
  toastTimer=window.setTimeout(()=>{line.textContent='';},8500);
}
function chip(text,style='') { return node('span',text,'wh-chip '+style); }
function labelOrder(order) { return order.number || 'PB-'+order.id.slice(0,8).toUpperCase(); }
function jobState(order,index) { return order.jobs.find(job=>job.position===index)?.state; }
function stage(order) {
  if (order.status==='paid') return 'New';
  if (order.status==='printing') return 'Printing';
  if (order.status==='packed') return 'Ready';
  return order.status==='delivered'?'Delivered':'Out for delivery';
}
function sheets(item) { return Math.ceil((item.pageRange?.length || item.pages)/(item.duplex?2:1))*item.copies; }
function elapsed(order) { return order.paidAt ? Math.max(0,Math.floor((Date.now()/1000-order.paidAt)/60)) : null; }
function age(order) {
  const mins=elapsed(order);
  if (mins===null) return 'Time unavailable';
  if (mins<1) return 'Just now';
  if (mins<60) return mins+' min ago';
  return Math.floor(mins/60)+' hr ago';
}
function today(epoch) { return epoch && new Date(epoch*1000).toDateString()===new Date().toDateString(); }
function paper(item) { return item.paper || 'A4'; }
function colour(item) { return item.colourPages?.length?'Mixed colour':item.colour?'Colour':'B&W'; }
function binding(item) { return item.binding && item.binding!=='none'?item.binding.charAt(0).toUpperCase()+item.binding.slice(1):''; }
function statusStyle(value) { return ['Done','Ready','Delivered','Paid'].includes(value)?'wh-good':value==='Failed'?'wh-bad':value==='New'?'wh-attention':''; }
function jobLabel(state) { return {queued:'Queued',printing:'Printing',done:'Done',failed:'Failed'}[state] || 'Waiting'; }
function findOrder(id=active) { return orders.find(order=>order.id===id); }
async function request(path,options) {
  let response;
  try { response=await fetch(path,options); }
  catch { throw new Error('Connection unavailable. Check your network and try again.'); }
  if (response.ok) return response;
  if ([401,403].includes(response.status)) throw new Error('Your warehouse session may have expired. Sign in again.');
  if (response.status===404) throw new Error('This item is no longer available. Refresh the order and try again.');
  if (response.status===409) throw new Error('The order changed. Refresh and check its current status.');
  throw new Error('That action could not be completed. Check the order and try again.');
}
function makeSamples() {
  const date = new Date().toISOString().slice(2, 10).replaceAll('-', '');
  return ['paid','paid','printing','packed','packed','delivered'].map((state, index) => ({
    id:'demo-' + index, number:'PB-' + date + '-' + (4100 + index), status:state,
    partner:index === 4 ? 'Demo delivery partner' : null,
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

function go(section, selectedTab, keepSearch=false) {
  view=section;
  if (!keepSearch) byId('warehouse-search').value='';
  tab=selectedTab || (section==='Ready'?'Ready':null) || 'New';
  if (['Printers','Settings','Inventory','History'].includes(section)) {
    active=null;
    closeSheet(false);
    renderStation();
  }
  render();
}
function selectedOrders(wanted) {
  const query=byId('warehouse-search').value.trim().toLowerCase();
  return orders.filter(order=>{
    const when=order.paidAt?new Date(order.paidAt*1000):null;
    const from=filters.from && new Date(filters.from+'T00:00:00');
    const to=filters.to && new Date(filters.to+'T23:59:59');
    return wanted.includes(stage(order))
      && (!query || [labelOrder(order),order.customer,order.phone].join(' ').toLowerCase().includes(query))
      && (!filters.colour || order.items.some(item=>filters.colour==='mono'?colour(item)==='B&W':colour(item)!=='B&W'))
      && (!filters.paper || order.items.some(item=>paper(item)===filters.paper))
      && (!filters.date || today(order.paidAt))
      && (!filters.priority || order.priority===filters.priority)
      && (!filters.partner || Boolean(order.partner)===(filters.partner==='assigned'))
      && (view!=='History' || ((!from || when && when>=from) && (!to || when && when<=to)));
  }).sort((a,b)=>Number(b.priority==='Urgent')-Number(a.priority==='Urgent') || ((view==='History' || (view==='Print Queue' && tab==='New'))?(b.paidAt||0)-(a.paidAt||0):(a.paidAt||0)-(b.paidAt||0)));
}
function counts() {
  return Object.fromEntries(buckets.map(label=>[label,orders.filter(order=>stage(order)===label).length]));
}
function render() {
  const previous=board.contains(document.activeElement)?document.activeElement.dataset.focus:null;
  const filterOpen=board.querySelector('.wh-filters')?.open;
  board.replaceChildren();
  staffDock?.setActive(view);
  staffDock?.setBadge('Print Queue', newBadges.has('New') ? 1 : 0);
  byId('warehouse-title').textContent=view==='Home'?'Mission control':view;
  for (const control of byId('warehouse-nav').children) control.toggleAttribute('aria-current',control.dataset.section===view);
  const tools=['Printers','Settings','Inventory'].includes(view);
  byId('warehouse-columns').classList.toggle('wh-single',tools);
  station.hidden=tools;
  if (tools) renderTools();
  else if (view==='History') renderHistory(filterOpen);
  else if (view==='Home') renderHome();
  else renderQueue(filterOpen);
  if (previous) [...board.querySelectorAll('[data-focus]')].find(el=>el.dataset.focus===previous)?.focus({preventScroll:true});
}
function heading(title,controls) {
  const bar=node('div',null,'wh-board-head');
  bar.append(node('h2',title));
  if (controls) bar.append(controls);
  return bar;
}
function renderHome() {
  const metrics=node('div',null,'wh-stats');
  const totals=counts();
  buckets.forEach(label=>{
    const stat=button(label,()=>go('Print Queue',label),'wh-stat');
    stat.dataset.focus='stat-'+label;
    stat.prepend(node('strong',totals[label]));
    metrics.append(stat);
  });
  board.append(metrics);
  const late=orders.filter(order=>buckets.includes(stage(order)) && elapsed(order)>=45).length;
  if (late) {
    const alert=chip(late+(late===1?' late order':' late orders'),'wh-attention');
    alert.classList.add('wh-alert');
    board.append(alert);
  }
  const visible=selectedOrders(buckets);
  board.append(heading('Up next'),list(byId('warehouse-search').value.trim()?visible:visible.slice(0,3)));
}
function queueFilters(open,history=false) {
  const details=node('details',null,'wh-filters');
  details.open=Boolean(open);
  const fields=node('div');
  details.append(node('summary',history?'Date range':'Filters'),fields);
  function makeField(key,name,choices) {
    const label=node('label',name);
    const el=node(choices?'select':'input',null,'clay-input');
    if (choices) choices.forEach(([value,text])=>el.add(new Option(text,value)));
    else el.type='date';
    el.value=filters[key];
    el.dataset.focus='filter-'+key;
    el.addEventListener('change',()=>{filters[key]=el.value;render();});
    label.append(el);
    fields.append(label);
  }
  if (history) {
    makeField('from','From');
    makeField('to','Through');
  } else {
    makeField('colour','Colour',[['','All'],['colour','Colour'],['mono','Black & white']]);
    makeField('paper','Paper',[['','All'],...['A4','A3','A5'].map(size=>[size,size])]);
    makeField('date','Date',[['','Any date'],['today','Today']]);
    makeField('priority','Priority',[['','All'],['Urgent','Urgent'],['Express','Express']]);
    makeField('partner','Partner',[['','Any'],['assigned','Assigned'],['unassigned','Unassigned']]);
  }
  return details;
}
function renderQueue(filterOpen) {
  const lanes=node('div',null,'wh-tabs');
  lanes.setAttribute('role','group');
  lanes.setAttribute('aria-label','Queue stage');
  const totals=counts();
  for (const label of buckets) {
    const control=button(label,()=>{
      tab=label;
      view=label==='Ready'?'Ready':'Print Queue';
      newBadges.delete(label);
      render();
    },'wh-tab');
    control.dataset.focus='tab-'+label;
    control.setAttribute('aria-pressed',String(tab===label));
    control.append(node('span',totals[label],'wh-count'+(newBadges.has(label)?' wh-arrive':'')));
    lanes.append(control);
  }
  board.append(lanes);
  const actions=node('div',null,'wh-tool-actions');
  actions.append(queueFilters(filterOpen));
  board.append(heading(tab,actions),list(selectedOrders([tab])));
  board.append(node('p','↑ / ↓ Move · Enter Open · P Print','wh-hint wh-alert'));
}
function list(items) {
  const result=node('div',null,'wh-list');
  if (!items.length) {
    const empty=node('div',null,'clay-card wh-empty');
    const mascot=node('img');mascot.src='/printbee-header-bee.webp';mascot.alt='';mascot.width=80;mascot.height=64;
    const searched=byId('warehouse-search').value.trim() || Object.entries(filters).some(([key,value])=>!['from','to'].includes(key)&&value);
    empty.append(mascot,node('h3',searched?'No matching orders':'All caught up'));
    if (searched) empty.append(node('p','Try another search or clear the filters.'));
    result.append(empty);
    return result;
  }
  for (const order of items) {
    const card=node('article',null,'wh-order'+(order.fresh?' wh-arrive':''));
    card.dataset.order=order.id;
    card.dataset.selected=String(active===order.id);
    card.dataset.urgent=String(order.priority==='Urgent');
    const meta=node('div',null,'wh-meta');
    const minutes=elapsed(order);
    if (minutes!==null) {
      const ring=node('span',null,'wh-ring');
      ring.style.setProperty('--remaining',(minutes>=45?100:(45-minutes)/45*100)+'%');
      ring.style.setProperty('--ring',minutes>=45?'var(--danger)':minutes>=30?'var(--warning)':'var(--success)');
      ring.title=minutes>=45?'Overdue':45-minutes+' min left';
      ring.setAttribute('role','img');
      ring.setAttribute('aria-label',ring.title);
      meta.append(ring);
    }
    meta.append(node('span',age(order),'wh-muted'));
    if (order.priority) meta.append(chip(order.priority,'wh-attention'));
    const specs=node('div',null,'wh-chips');
    const pageCount=order.items.reduce((total,item)=>total+(item.pageRange?.length || item.pages)*item.copies,0);
    const extras=stage(order)==='Ready'?[order.partner || 'Unassigned',order.slot]:[
      order.items.some(item=>colour(item)!=='B&W')?'Colour':'B&W',
      [...new Set(order.items.map(paper))].join('/'),
      [...new Set(order.items.map(binding).filter(Boolean))].join(' · '),
    ];
    [order.items.length+(order.items.length===1?' file':' files'),pageCount+' pages',...extras].filter(Boolean).forEach(text=>specs.append(chip(text)));
    const action={New:'Print',Printing:'View print',Ready:'Hand over'}[stage(order)];
    const open=button(action,()=>openOrder(order.id,true),'clay-button wh-open');
    open.dataset.focus='order-'+order.id;
    open.setAttribute('aria-label',action+' '+labelOrder(order));
    card.append(node('h3',labelOrder(order)),meta,specs,open);
    result.append(card);
  }
  return result;
}
function renderHistory(filterOpen) {
  const visible=selectedOrders(['Delivered','Out for delivery']);
  board.append(heading('Order history',button('Export CSV',()=>exportHistory(visible),'clay-button wh-primary')),queueFilters(filterOpen,true));
  if (!visible.length) {board.append(node('p','No orders match this date range or search.','clay-card wh-alert'));return;}
  const wrapper=node('div',null,'clay-card wh-table wh-alert');
  wrapper.tabIndex=0;
  wrapper.setAttribute('role','region');
  wrapper.setAttribute('aria-label','Order history table');
  const table=node('table',null,'clay-table');
  const head=table.createTHead().insertRow();
  ['Order','Date','Customer','Status','Files'].forEach(title=>{const cell=node('th',title);cell.scope='col';head.append(cell);});
  const body=table.createTBody();
  for (const order of visible) {
    const row=body.insertRow();
    const open=button(labelOrder(order),()=>openOrder(order.id,true));
    open.dataset.focus='order-'+order.id;
    row.insertCell().append(open);
    [order.paidAt?new Date(order.paidAt*1000).toLocaleDateString():'—',order.customer,stage(order),order.items.length].forEach(value=>row.insertCell().textContent=value);
  }
  wrapper.append(table);
  board.append(wrapper);
}
function renderTools() {
  const panel=node('section',null,'clay-card wh-tool');
  if (view==='Printers') {
    const header=node('div',null,'wh-meta');
    header.append(icon('printer'),node('h2',preview?'Mock printer':'Warehouse print agent'),chip(online && !paused?'Online':paused?'Paused':'Offline',online && !paused?'wh-good':'wh-bad'));
    panel.append(header);
    if (preview) {
      const controls=node('div',null,'wh-tool-actions');
      controls.append(button('Test print',()=>announce(paused?'Resume the mock queue before testing.':'Mock print passed. No paper used.'),'clay-button wh-primary'),button(paused?'Resume':'Pause',()=>{paused=!paused;updateTop();render();}));
      panel.append(node('p','Colour and B&W · A4 / A3 · Duplex'),controls);
    }
    const help=node('details',null,'wh-details');
    const steps=node('ol');
    ['Connect the printer and print a test page from the workstation.','Start the PrintBee agent with the printer name and its print-agent key.','Return here and wait for the agent to show Online.'].forEach(text=>steps.append(node('li',text)));
    help.append(node('summary','Pair a printer'),steps);
    panel.append(help);
  } else if (view==='Inventory') {
    panel.append(node('h2','Inventory'),node('p',preview?'A4 · 490 sheets     A3 · 38 sheets     Spiral coils · 12 remaining':'Stock counts are managed at the print room.'));
  } else {
    panel.append(node('h2','Workspace preferences'));
    for (const [key,label] of [['sound','New order chime'],['skipConfirm','Skip print confirmation'],['takeover','Full-screen alert for new orders'],['large','Large text'],['contrast','High contrast']]) {
      const row=node('label',null,'wh-setting'), input=node('input');
      input.type='checkbox';input.checked=preferences[key];input.dataset.setting=key;
      input.addEventListener('change',()=>setSetting(key,input.checked));
      row.append(input,label);
      panel.append(row);
    }
    if ('Notification' in window) panel.append(button('Enable browser notifications',async()=>{
      announce((await Notification.requestPermission())==='granted'?'Notifications enabled.':'Notifications are off. Check browser permissions.');
    }));
    panel.append(button('View inventory',()=>go('Inventory')));
  }
  board.append(panel);
}
function exportHistory(rows) {
  const cell = value => {
    const s=String(value??'');
    return '"'+(/^[=+\-@\t\r\n]/.test(s)?"'":'')+s.replaceAll('"','""')+'"';
  };
  const lines=[['Order','Customer','Status','Files','Sheets'],...rows.map(o=>[labelOrder(o),o.customer,stage(o),o.items.length,o.items.reduce((n,i)=>n+sheets(i),0)])];
  const csv=URL.createObjectURL(new Blob([lines.map(line=>line.map(cell).join(',')).join('\r\n')],{type:'text/csv'}));
  download(csv,'printbee-warehouse.csv');
  setTimeout(()=>URL.revokeObjectURL(csv),1000);
}
function download(link, filename) {
  const a=node('a'); a.href=link; a.download=filename; a.click();
}

function syncSheet() {
  const open=mobile.matches && sheet;
  station.classList.toggle('wh-sheet',open);
  byId('station-close').hidden=!open;
  document.body.classList.toggle('wh-has-sheet',open);
  for (const target of [station.previousElementSibling,document.querySelector('.wh-rail'),document.querySelector('.wh-top')]) target.inert=open;
  if (open) {
    station.setAttribute('role','dialog');
    station.setAttribute('aria-modal','true');
  } else {
    station.removeAttribute('role');
    station.removeAttribute('aria-modal');
  }
}
function closeSheet(returnFocus=true) {
  sheet=false;
  syncSheet();
  if (returnFocus) {
    const controls=[...board.querySelectorAll('[data-focus]')];
    (controls.find(el=>el.dataset.focus===restoreFocus) || byId('warehouse-search')).focus({preventScroll:true});
  }
}
function openOrder(id,focus=false) {
  const order=findOrder(id);
  if (!order) return announce('That order is no longer in the warehouse queue.');
  active=id;
  if (focus) {
    restoreFocus='order-'+id;
    sheet=true;
    station.querySelector('.wh-station-scroll').scrollTop=0;
    syncSheet();
  }
  for (const card of board.querySelectorAll('[data-order]')) card.dataset.selected=String(card.dataset.order===active);
  renderStation(order);
  if (focus) station.focus({preventScroll:true});
}
function renderStation(order=findOrder()) {
  const body=byId('detail-body'), dock=byId('detail-action');
  const oldFocus=station.contains(document.activeElement)?document.activeElement.dataset.focus:null;
  const scroll=station.querySelector('.wh-station-scroll');
  const top=scroll.scrollTop;
  const detailsOpen=body.querySelector('.wh-details')?.open;
  body.replaceChildren();
  dock.replaceChildren();
  dock.hidden=true;
  byId('detail-title').textContent=order?labelOrder(order):'Select an order';
  if (!order) {
    body.append(node('p','Open an order to see its files and next step.','wh-muted'));
    return;
  }
  const bucket=stage(order), summary=node('div',null,'wh-meta');
  summary.append(chip(bucket,statusStyle(bucket)),chip('Paid','wh-good'));
  const minutes=elapsed(order);
  if (minutes!==null && buckets.includes(bucket)) summary.append(chip(minutes>=45?'SLA overdue':45-minutes+' min left','wh-sla '+(minutes>=45?'wh-bad':minutes>=30?'wh-attention':'')));
  body.append(summary);
  const docs=node('section',null,'wh-files');
  docs.append(node('h3','Files · '+order.items.length));
  order.items.forEach((item,index)=>docs.append(fileRow(order,item,index)));
  body.append(docs);

  if (bucket==='New' || bucket==='Printing') renderPrintAction(order,dock);
  if (bucket==='Ready') renderHandover(order,body,dock);
  body.append(orderDetails(order,detailsOpen));
  scroll.scrollTop=top;
  if (oldFocus) [...station.querySelectorAll('[data-focus]')].find(el=>el.dataset.focus===oldFocus)?.focus({preventScroll:true});
}
function fileRow(order,item,index) {
  const row=node('article',null,'wh-file');
  const thumb=icon('file');thumb.className='wh-file-icon';
  const info=node('div');
  const state=jobState(order,index);
  const title=node('h3',item.name);
  info.append(title,chip(jobLabel(state),statusStyle(jobLabel(state))));
  const specs=node('div',null,'wh-chips');
  [
    colour(item),item.duplex?'Duplex':'Single-sided',paper(item),item.orientation,
    item.copies+(item.copies===1?' copy':' copies'),
    item.pageRange?.length?'Pages '+item.pageRange.join(', '):item.pages+' pages',
    binding(item)?binding(item)+' binding':'',
  ].filter(Boolean).forEach(text=>specs.append(chip(text)));
  row.append(thumb,info,specs);
  if (state==='failed') {
    const hint=item.colourPages?.length?'Mixed-colour files may need manual printing.':'Check the printer and paper, then retry.';
    specs.append(node('p',hint,'wh-muted'));
  }
  if (!['paid','printing','packed'].includes(order.status)) return row;

  const actions=node('div',null,'wh-file-actions');
  if (/\.pdf$/i.test(item.name)) {
    const open=button('Preview',()=>showAsset(item.name,'/api/staff/files/'+order.id+'/'+index));
    open.dataset.focus='preview-'+index;
    open.setAttribute('aria-label','Preview '+item.name);
    actions.append(open);
  }
  const more=node('details'), menu=node('div',null,'wh-file-actions');
  more.append(node('summary','More'),menu);
  if (!preview) menu.append(button('Download',()=>downloadAsset('/api/staff/files/'+order.id+'/'+index,item.name)));
  if (['paid','printing'].includes(order.status) && (!state || state==='failed')) {
    menu.append(button(state==='failed'?'Retry file':'Print file',()=>confirmPrint(order,index)));
    if (!preview) menu.append(button('Confirm manually printed',async()=>{
      if (!window.confirm('Confirm this file has already been printed?')) return;
      await request('/api/staff/orders/'+order.id+'/printed/'+index,{method:'POST'});
      await refreshAfterAction('File marked as printed.');
    }));
  }
  if (menu.childElementCount) actions.append(more);
  if (actions.childElementCount) row.append(actions);
  return row;
}
function mainAction(label,action,kind) {
  const control=button(label,action,'clay-button wh-primary');
  control.dataset.focus='primary-'+kind;
  control.dataset.action=kind;
  return control;
}
function renderPrintAction(order,dock) {
  dock.hidden=false;
  const labels=order.items.map((_,index)=>jobState(order,index));
  const printing=labels.some(state=>state==='queued'||state==='printing');
  const failures=labels.filter(state=>state==='failed').length;
  if (printing) {
    const progress=node('div',null,'wh-progress');
    const caption=node('div',null,'wh-meta');
    const done=labels.filter(state=>state==='done').length;
    caption.append(icon('printer'),node('span',done+' of '+labels.length+' files printed'));
    const bar=node('progress');bar.max=Math.max(1,labels.length);bar.value=done;
    bar.setAttribute('aria-label','Files printed');
    progress.append(caption,bar);
    dock.append(progress);
    return;
  }
  const control=mainAction(failures?'Retry print':order.items.length===1?'Print':'Print all',()=>confirmPrint(order,'all'),'print');
  control.prepend(icon('printer'));
  control.disabled=printPending || !order.items.length;
  dock.append(control);
}
function renderHandover(order,body,dock) {
  const details=node('section',null,'wh-notes');
  const first=node('h3','Pickup');
  details.append(first,node('p',order.partner?'Assigned to '+order.partner:'Waiting for delivery partner'),node('p',order.slot || 'No delivery slot set'));
  body.append(details);
  dock.hidden=false;
  const path='/api/staff/orders/'+order.id+'/label';
  const title=labelOrder(order)+' packing label';
  if (preview) {
    body.append(button('Preview packing label',()=>showAsset(title,path,order)));
    dock.append(mainAction('Confirm sample handover',async()=>{
      order.status='out_for_delivery';addEvent(order,'delivery_picked_up');
      await refreshAfterAction('Sample handover confirmed.');
    },'handover'));
    return;
  }
  details.append(node('p','The delivery partner confirms pickup in their portal. This order then moves to History.','wh-muted'));
  dock.append(mainAction('Preview packing label',()=>showAsset(title,path,order),'label'));
}
function orderDetails(order,opened) {
  const panel=node('details',null,'wh-details');
  panel.open=Boolean(opened);
  const contents=node('div');
  contents.append(node('p','Payment confirmed'+(Number.isInteger(order.bill?.total)?' · '+money(order.bill.total/100):'')+(order.coupon?' · '+order.coupon:'')),
    node('p',order.customer || 'Customer unavailable'));
  const phone=String(order.phone||'').replace(/[^+0-9]/g,'');
  if (phone && !preview) {
    const call=node('a','Call '+order.phone,'wh-text-link');
    call.href='tel:'+phone;
    contents.append(call);
  }
  if (order.address) {
    contents.append(node('p',order.address));
    if (!preview) {
      const map=node('a','Open location in Maps','wh-text-link');
      map.href='https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(order.address);
      map.target='_blank';map.rel='noopener noreferrer';contents.append(map);
    }
  }
  if (order.slot) contents.append(node('p',order.slot));
  if (order.partner) contents.append(node('p','Partner: '+order.partner));
  if (order.notes) contents.append(node('p',order.notes,'wh-notes'));
  if (order.timeline?.length) {
    const timeline=node('ol');
    for (const entry of order.timeline) timeline.append(node('li',entry.action.replaceAll('_',' ')+' · '+new Date(entry.created*1000).toLocaleString()));
    contents.append(node('h3','Timeline'),timeline);
  }
  panel.append(node('summary','Customer and order details'),contents);
  return panel;
}
async function downloadAsset(path,name) {
  const response=await request(path);
  const local=URL.createObjectURL(await response.blob());
  download(local,name);
  setTimeout(()=>URL.revokeObjectURL(local),1000);
}
function showPreview(title,content) {
  byId('preview-title').textContent=title;
  byId('preview-body').replaceChildren(...content);
  if (!viewer.open) viewer.showModal();
}
async function showAsset(title,path,label) {
  const attempt=++previewRequest;
  if (preview) {
    const content=label?[node('h3',labelOrder(label)),node('p',label.customer),node('p',label.address)]:[node('p','This sample order has no customer document.')];
    showPreview(title,content);
    return;
  }
  showPreview(title,[node('p','Loading document…')]);
  try {
    const response=await request(path), data=await response.blob();
    if (!viewer.open || attempt!==previewRequest) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl=URL.createObjectURL(data.slice(0,data.size,'application/pdf'));
    const frame=node('iframe');
    frame.title=title;frame.src=previewUrl;
    const save=node('a','Download PDF','wh-text-link');
    save.href=previewUrl;
    save.download=label?labelOrder(label)+'-packing.pdf':title;
    showPreview(title,[frame,save]);
  } catch (error) {
    if (viewer.open && attempt===previewRequest) showPreview(title,[node('p',error.message)]);
  }
}
viewer.addEventListener('close',()=>{
  previewRequest++;
  byId('preview-body').replaceChildren();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl=null;
});
function confirmPrint(order,index) {
  if (printPending || confirmation.open) return;
  const current=findOrder(order.id);
  if (!current) throw new Error('This order is no longer in the queue.');
  const selected=(index==='all'?current.items.map((_,i)=>i):[index]).filter(i=>[undefined,'failed'].includes(jobState(current,i)));
  if (!selected.length) throw new Error('These files are already queued or printed.');
  if (preview && paused) throw new Error('Resume the mock queue in Printers first.');
  printAction=()=>sendPrint(current,index,selected);
  if (preferences.skipConfirm) return runPrint();
  const total=selected.reduce((sum,i)=>sum+sheets(current.items[i]),0);
  const modes=[...new Set(selected.map(i=>colour(current.items[i])))].join(' / ');
  byId('confirm-body').replaceChildren(
    node('p',preview?'Printer: Mock printer':'Printer: Warehouse workstation'),
    node('p',selected.length+(selected.length===1?' file':' files')+' · '+total+(total===1?' sheet':' sheets')+' · '+modes)
  );
  confirmation.returnValue='cancel';
  confirmation.showModal();
}
async function runPrint() {
  const run=printAction;
  printAction=null;
  if (!run || printPending) return;
  printPending=true;
  try {await run();}
  catch (error) {announce(error.message,true);}
  finally {printPending=false;renderStation();}
}
async function sendPrint(order,index,selected) {
  if (preview) {
    order.status='printing';
    addEvent(order,'print_queued');
    order.jobs=order.jobs.filter(job=>!selected.includes(job.position));
    order.jobs.push(...selected.map(position=>({position,state:'queued'})));
    setTimeout(()=>updateMockJobs(order,selected,'printing'),350);
    setTimeout(()=>updateMockJobs(order,selected,'done'),1350);
  } else {
    const response=await request('/api/staff/orders/'+order.id+'/print/'+index,{method:'POST'});
    if (!(await response.json()).queued) throw new Error('No files were queued. Check for existing jobs, then try again.');
  }
  await refreshAfterAction('Sent to the printer.');
}
function addEvent(order,action) {order.timeline.push({action,created:Math.floor(Date.now()/1000)});}
function updateMockJobs(order,selected,state) {
  order.jobs.filter(job=>selected.includes(job.position)).forEach(job=>{job.state=state;});
  if (state==='done') {
    addEvent(order,'print_done');
    if (order.items.every((_,index)=>jobState(order,index)==='done')) {
      order.status='packed';
      addEvent(order,'packed');
      announce(labelOrder(order)+' is ready for pickup.',true);
    }
  }
  void refresh(true);
}
async function refreshAfterAction(message) {
  announce(message,true);
  try {await refresh(true);}
  catch {announce(message+' The queue will refresh when the connection returns.',true);}
}
function updateTop() {
  const badge=byId('agent-status');
  badge.textContent=!connected?'Connection lost':paused?'Printer paused':online?'Printer online':'Printer offline';
  badge.classList.toggle('wh-good',connected && online && !paused);
  badge.classList.toggle('wh-bad',!connected || !online || paused);
  byId('today-count').textContent=orders.filter(order=>today(order.paidAt)).length+' today';
}
function openArrival(id) {
  go('Print Queue','New');
  openOrder(id,true);
  byId('warehouse-arrival').hidden=true;
}
function notifyNew(fresh) {
  if (!fresh.length) return;
  fresh.forEach(order=>order.fresh=true);
  newBadges.add('New');
  const latest=fresh.reduce((a,b)=>(a.paidAt||0)>=(b.paidAt||0)?a:b);
  const message='New order '+labelOrder(latest)+(fresh.length>1?' +'+(fresh.length-1):'');
  const toast=byId('warehouse-arrival'), live=node('span',message);
  live.setAttribute('role','status');
  toast.replaceChildren(live,button('Open',()=>openArrival(latest.id)));
  toast.hidden=false;
  if (preferences.takeover && !confirmation.open && !viewer.open && !arrival.open && !printPending && !station.contains(document.activeElement)) {
    arrivalOrder=latest.id;
    byId('arrival-number').textContent=message;
    arrival.returnValue='dismiss';
    arrival.showModal();
  }
  if (document.hidden) {
    document.title='('+fresh.length+') PrintBee warehouse';
    if ('Notification' in window && Notification.permission==='granted') {
      try {
        const notice=new Notification('PrintBee warehouse',{body:message,tag:'printbee-warehouse'});
        notice.onclick=()=>{window.focus();openArrival(latest.id);notice.close();};
      } catch {}
    }
  }
  if (preferences.sound && audio?.state==='running') {
    const tone=audio.createOscillator(), gain=audio.createGain(), now=audio.currentTime;
    tone.frequency.setValueAtTime(660,now);
    tone.frequency.setValueAtTime(880,now+.09);
    gain.gain.setValueAtTime(.055,now);
    gain.gain.exponentialRampToValueAtTime(.001,now+.22);
    tone.connect(gain).connect(audio.destination);
    tone.start(now);
    tone.stop(now+.23);
  }
}
async function refresh(force=false) {
  const version=++refreshVersion;
  const current=preview?{orders:demoOrders,agentOnline:true}:await (await request('/api/staff/orders')).json();
  if (version!==refreshVersion) return;
  const previous=findOrder();
  orders=current.orders;
  online=current.agentOnline;
  connected=true;
  updateTop();
  const fresh=known?orders.filter(order=>order.status==='paid' && !known.has(order.id)):[];
  known=new Set(orders.map(order=>order.id));
  notifyNew(fresh);
  for (const control of board.querySelectorAll('.wh-tab')) {
    const label=control.dataset.focus.slice(4);
    control.querySelector('.wh-count').textContent=orders.filter(order=>stage(order)===label).length;
  }
  const safeToRender=!board.contains(document.activeElement) && !board.querySelector('details[open]') && view!=='Settings';
  if (force || fresh.length || safeToRender) {
    render();
    if (fresh.length) {
      setTimeout(()=>fresh.forEach(order=>delete order.fresh),240);
      setTimeout(()=>newBadges.delete('New'),240);
    }
  }
  const selected=findOrder();
  if (force || JSON.stringify(previous)!==JSON.stringify(selected)) {
    renderStation(selected);
    if (!selected && active) {active=null;closeSheet();}
  } else if (selected) {
    const timer=byId('detail-body').querySelector('.wh-sla');
    const minutes=elapsed(selected);
    if (timer && minutes!==null) {
      timer.textContent=minutes>=45?'SLA overdue':45-minutes+' min left';
      timer.className='wh-chip wh-sla '+(minutes>=45?'wh-bad':minutes>=30?'wh-attention':'');
    }
  }
}
async function refreshLive() {
  if (busyRefresh || printPending) return;
  busyRefresh=true;
  try {await refresh();}
  catch {
    if (connected) announce('Connection lost. Retrying automatically…');
    connected=false;
    updateTop();
  } finally {busyRefresh=false;}
}
function handleKeys(event) {
  if (event.defaultPrevented || confirmation.open || viewer.open || arrival.open) return;
  if (event.key==='Escape' && sheet && mobile.matches) {event.preventDefault();closeSheet();return;}
  if (event.key==='Tab' && sheet && mobile.matches) {
    const controls=[...station.querySelectorAll('button:not(:disabled),a[href],summary,input:not(:disabled)')].filter(el=>el.getClientRects().length);
    if (!controls.length) return;
    const current=controls.indexOf(document.activeElement);
    if (event.shiftKey && current<=0) {event.preventDefault();controls.at(-1).focus();}
    else if (!event.shiftKey && current===controls.length-1) {event.preventDefault();controls[0].focus();}
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest?.('input:not([type=checkbox]),select,textarea,[contenteditable]')) return;
  if (event.key==='/' && !(sheet && mobile.matches)) {event.preventDefault();byId('warehouse-search').focus();return;}
  if (['ArrowDown','ArrowUp','ArrowRight','ArrowLeft'].includes(event.key) && board.contains(document.activeElement)) {
    const cards=[...board.querySelectorAll('[data-focus^="order-"]')];
    const index=cards.indexOf(document.activeElement);
    const next=index>=0 && cards[index+(['ArrowDown','ArrowRight'].includes(event.key)?1:-1)];
    if (next) {event.preventDefault();next.focus();}
  }
  if (event.key.toLowerCase()==='p') {
    const control=station.querySelector('[data-action="print"]');
    if (control && control.getClientRects().length && !control.disabled) {event.preventDefault();control.click();}
  }
}
async function start() {
  byId('warehouse-app').hidden=false;
  byId('warehouse-context').textContent=preview?'PrintBee Warehouse · Sample mode':'PrintBee Warehouse';
  byId('search-icon').append(icon('search'));
  byId('station-close').append(icon('close'));
  byId('station-close').addEventListener('click',()=>closeSheet());
  byId('sound-toggle').addEventListener('click',()=>setSetting('sound',!preferences.sound));
  const search=byId('warehouse-search');
  search.addEventListener('input',()=>{
    if (search.value.trim() && ['Printers','Settings','Inventory'].includes(view)) go('Print Queue','New',true);
    else render();
  });
  for (const [title,glyph] of sections) {
    const control=button('',()=>go(title),'wh-nav-button');
    control.dataset.section=title;
    control.setAttribute('aria-label',title);
    control.append(icon(glyph),node('span',title));
    byId('warehouse-nav').append(control);
  }
  const nav=byId('warehouse-staff-dock');
  const open=section=>()=>{go(section);scrollTo(0,0);};
  staffDock=window.createStaffDock(nav,[
    {id:'Home',label:'Home',icon:'home',select:open('Home')},
    {id:'Ready',label:'Ready',icon:'ready',select:open('Ready')},
    {id:'Print Queue',label:'Print',icon:'plus',center:true,select:open('Print Queue')},
    {id:'History',label:'History',icon:'history',select:open('History')},
    {id:'more',label:'More',icon:'more',children:['Printers','Inventory','Settings'].map(id=>({id,label:id,select:open(id)}))},
  ]);
  nav.hidden=false;
  staffDock.setActive(view);
  syncPreferences();
  renderStation();
  try {await refresh(true);}
  catch {
    connected=false;
    updateTop();
    board.replaceChildren(node('p','Orders are unavailable. Check your connection.', 'clay-card'),
      button('Retry',()=>refresh(true),'clay-button wh-primary'));
  }
}
confirmation.addEventListener('close',()=>{
  if (confirmation.returnValue==='print') void runPrint();
  else printAction=null;
});
arrival.addEventListener('close',()=>{if (arrival.returnValue==='open' && arrivalOrder) openArrival(arrivalOrder);});
mobile.addEventListener('change',()=>{
  if (sheet && mobile.matches) sheet=false;
  syncSheet();
});
document.addEventListener('keydown',handleKeys);
document.addEventListener('pointerdown',prepareSound,{once:true});
document.addEventListener('visibilitychange',()=>{if (!document.hidden) document.title='PrintBee warehouse';});
if (preview) {
  byId('portal-login').hidden=true;
  byId('warehouse-mode-link').href='/warehouse';
  byId('warehouse-mode-link').textContent='Live warehouse sign-in';
  void start();
} else {
  connectPortal('warehouse',status,async()=>{
    await start();
    polling=setInterval(refreshLive,5000);
  },()=>clearInterval(polling));
}
