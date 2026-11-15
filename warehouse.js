const byId = id => document.getElementById(id);
const preview = new URLSearchParams(location.search).get('preview') === '1';
const board = byId('warehouse-content');
const status = byId('staff-status');
const station = byId('warehouse-detail');
const confirmation = byId('warehouse-confirm');
const viewer = byId('warehouse-preview');
const arrival = byId('warehouse-new');
const mobile = matchMedia('(max-width:1100px)');
const handover=byId('floor-handover');
const shortcutDialog = byId('floor-shortcuts');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const floorStages = [
  ['New','incoming','file'],
  ['Printing','printing','printer'],
  ['Ready','ready','check'],
  ['Handed over','handover','package'],
];
const conveyorStage = order => buckets.includes(stage(order))?stage(order):'Handed over';
const buckets = ['New', 'Printing', 'Ready'];
const sections = [['Home','home'],['Print Queue','printer'],['Printers','monitor'],['History','history'],['Settings','settings']];
const glyphs = {
  home:'<path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 21v-7h6v7"/>',
  printer:'<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6zM6 12h.01"/>',
  monitor:'<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  history:'<path d="M3 12a9 9 0 1 1 2.2 5.9M3 4v8h8m1-4v5l3 2"/>',
  settings:'<path d="M4 6h16M4 12h16M4 18h16M8 4v4m8 2v4m-6 2v4"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  sound:'<path d="M3 9v6h4l5 4V5L7 9zm13 0a4 4 0 0 1 0 6m2-9a8 8 0 0 1 0 12"/>',
  mute:'<path d="M3 9v6h4l5 4V5L7 9zm13 1 5 5m0-5-5 5"/>',
  file:'<path d="M6 3h8l4 4v14H6zm8 0v5h4M9 13h6m-6 4h6"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>',
  moon:'<path d="M20.5 15A9 9 0 0 1 9 3.5 9 9 0 1 0 20.5 15Z"/>',
  package:'<path d="m3 7 9-5 9 5v10l-9 5-9-5V7zm0 0 9 5 9-5m-9 5v10M7.5 4.5l9 5"/>',
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
let staffDock, floorFilter, arrivalTimer, historyPreset='';
let lastStages=new Map(), newlyReady=new Set(), renderedOrderSnapshot;
let polling, liveFeed, busyRefresh = false, refreshVersion = 0, toastTimer, audio;
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
  control.setAttribute('aria-label',control.title);
  control.replaceChildren(icon(preferences.sound?'sound':'mute'));
  const setting=board.querySelector('[data-setting="sound"]');
  if (setting) setting.checked=preferences.sound;
  const display=byId('floor-display-preview');
  if (display) display.textContent=(preferences.large?'Large text':'Standard text')+' · '+(preferences.contrast?'High contrast':'Standard contrast');
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
  const sectionChanged=view!==section;
  view=section;
  floorFilter=null;
  if (!keepSearch) byId('warehouse-search').value='';
  tab=selectedTab || 'New';
  if (['Printers','Settings','Inventory','History'].includes(section)) {
    active=null;
    closeSheet(false);
  }
  render();
  if (sectionChanged) byId('warehouse-columns').scrollTop=0;
  if (!reducedMotion.matches) board.animate([{opacity:.6,transform:'translateY(6px)'},{opacity:1,transform:'translateY(0)'}],
    {duration:210,easing:'ease-out'});
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
function render(refreshStation=true,focusDate=false) {
  renderedOrderSnapshot=JSON.stringify(orders);
  const previous=board.contains(document.activeElement)?document.activeElement.dataset.focus:null;
  const filterOpen=board.querySelector('.wh-filters')?.open;
  board.replaceChildren();
  staffDock?.setActive(view);
  staffDock?.setBadge('Print Queue', newBadges.has('New') ? 1 : 0);
  byId('warehouse-title').textContent=view==='Home'?'Mission control':view;
  for (const control of byId('warehouse-nav').querySelectorAll('button')) {
    if (control.dataset.section===view) control.setAttribute('aria-current','page');
    else control.removeAttribute('aria-current');
  }
  const tools=['Printers','Settings','Inventory'].includes(view);
  const columns=byId('warehouse-columns');
  columns.classList.toggle('wh-context-layout',view==='Printers' || view==='Inventory' || view==='History');
  columns.classList.toggle('wh-settings-layout',view==='Settings');
  if (tools) renderTools();
  else if (view==='History') renderHistory(filterOpen);
  else if (view==='Home') renderHome();
  else renderQueue(filterOpen);
  if (refreshStation) renderStation();
  if (focusDate) board.querySelector('.wh-filters input')?.focus({preventScroll:true});
  else if (previous) [...board.querySelectorAll('[data-focus]')].find(el=>el.dataset.focus===previous)?.focus({preventScroll:true});
}
function heading(title,controls) {
  const bar=node('div',null,'wh-board-head');
  bar.append(node('h2',title));
  if (controls) bar.append(controls);
  return bar;
}
function updateStageCount(control,label) {
  const total=orders.filter(order=>conveyorStage(order)===label).length;
  const count=control.querySelector('strong');
  if (count.textContent===String(total)) return;
  count.textContent=total;
  control.setAttribute('aria-label',label+', '+total+(total===1?' order':' orders'));
}
function renderHome() {
  const metrics=node('div',null,'wh-conveyor');
  metrics.setAttribute('role','group');
  metrics.setAttribute('aria-label','Production stages');
  for (const [label,stageKey,glyph] of floorStages) {
    const stat=button('',()=>{
      floorFilter=floorFilter===label?null:label;
      render();
    },'wh-stat');
    stat.dataset.focus='stat-'+label;
    stat.dataset.stage=stageKey;
    stat.setAttribute('aria-pressed',String(floorFilter===label));
    const symbol=icon(glyph);
    symbol.className='wh-stat-icon';
    stat.append(symbol,node('strong'),node('span',label,'wh-stat-label'));
    updateStageCount(stat,label);
    metrics.append(stat);
  }
  board.append(metrics);
  const late=orders.filter(order=>buckets.includes(stage(order)) && elapsed(order)>=45).length;
  if (late) {
    const alert=chip(late+(late===1?' late order':' late orders'),'wh-attention');
    alert.classList.add('wh-alert');
    board.append(alert);
  }
  const visible=selectedOrders(floorFilter==='Handed over'?['Delivered','Out for delivery']:floorFilter?[floorFilter]:buckets);
  board.append(heading(floorFilter || 'Up next'),list(floorFilter || byId('warehouse-search').value.trim()?visible:visible.slice(0,3)));
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
    el.addEventListener('change',()=>{filters[key]=el.value;if (history) historyPreset='Custom';render();});
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
}
function updateCardAge(meta,order) {
  const label=meta.querySelector('.wh-card-age');
  const text=age(order);
  if (label.textContent!==text) label.textContent=text;
  const ring=meta.querySelector('.wh-ring');
  const minutes=elapsed(order);
  if (!ring || minutes===null) return;
  const title=minutes>=45?'Overdue':45-minutes+' min left';
  if (ring.title===title) return;
  ring.style.setProperty('--remaining',(minutes>=45?100:(45-minutes)/45*100)+'%');
  ring.style.setProperty('--ring',minutes>=45?'var(--danger)':minutes>=30?'var(--warning)':'var(--success)');
  ring.title=title;
  ring.setAttribute('aria-label',title);
}
function list(items) {
  const result=node('div',null,'wh-list');
  if (!items.length) {
    const empty=node('div',null,'clay-card wh-empty');
    const mascot=node('img');mascot.src='/printbee-header-bee.webp';mascot.alt='';mascot.width=80;mascot.height=64;
    const searched=byId('warehouse-search').value.trim() || Object.entries(filters).some(([key,value])=>!['from','to'].includes(key)&&value);
    empty.append(mascot,node('h3',searched?'No matching orders':'All caught up'));
    empty.append(node('p',searched?'Try another search or clear the filters.':'The hive is quiet. New work will appear here.'));
    result.append(empty);
    return result;
  }
  for (const order of items) {
    const card=node('article',null,'wh-order'+(order.fresh?' wh-arrive':''));
    card.dataset.order=order.id;
    card.dataset.selected=String(active===order.id);
    card.dataset.urgent=String(order.priority==='Urgent');
    card.dataset.priority=order.priority || 'Normal';
    const meta=node('div',null,'wh-meta');
    if (order.paidAt) {
      const ring=node('span',null,'wh-ring');
      ring.setAttribute('role','img');
      meta.append(ring);
    }
    meta.append(node('span',null,'wh-muted wh-card-age'));
    updateCardAge(meta,order);
    if (order.priority) meta.append(chip(order.priority,'wh-attention'));
    const specs=node('div',null,'wh-chips');
    const pageCount=order.items.reduce((total,item)=>total+(item.pageRange?.length || item.pages)*item.copies,0);
    const extras=stage(order)==='Ready'?[order.partner || 'Unassigned',order.slot]:[
      order.items.some(item=>colour(item)!=='B&W')?'Colour':'B&W',
      [...new Set(order.items.map(paper))].join('/'),
      [...new Set(order.items.map(binding).filter(Boolean))].join(' · '),
    ];
    [order.items.length+(order.items.length===1?' file':' files'),pageCount+' pages',...extras].filter(Boolean).forEach(text=>{
      const spec=chip(text);
      if (['Colour','B&W'].includes(text)) spec.classList.add('wh-spec-swatch',text==='Colour'?'wh-spec-colour':'wh-spec-mono');
      if (/^A[345]/.test(text)) spec.prepend(icon('file'));
      specs.append(spec);
    });
    const action={New:'Print',Printing:'View print',Ready:'Hand over'}[stage(order)] || 'View order';
    const open=button(action,()=>openOrder(order.id,true),'clay-button wh-open'+(['New','Ready'].includes(stage(order))?' wh-primary':''));
    open.dataset.focus='order-'+order.id;
    open.setAttribute('aria-label',action+' '+labelOrder(order));
    card.append(node('h3',labelOrder(order)),meta,specs,open);
    result.append(card);
  }
  return result;
}
function renderHistory(filterOpen) {
  const visible=selectedOrders(['Delivered','Out for delivery']);
  board.append(heading('Order history',button('Export CSV',()=>exportHistory(visible),'clay-button wh-primary')));
  const dates=node('div',null,'wh-tool-actions wh-date-presets');
  for (const label of ['All dates','Today','7 days','Custom']) {
    const control=button(label,()=>{
      historyPreset=label;
      if (label==='Custom') {render(true,true);return;}
      const now=new Date();
      const start=new Date(now);
      if (label==='7 days') start.setDate(start.getDate()-6);
      const dateString=date=>[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
      filters.from=label==='All dates'?'':dateString(start);
      filters.to=label==='All dates'?'':dateString(now);
      render();
    });
    control.dataset.focus='history-'+label;
    control.setAttribute('aria-pressed',String((historyPreset || 'All dates')===label));
    dates.append(control);
  }
  const range=queueFilters(filterOpen || historyPreset==='Custom',true);
  board.append(dates,range);
  const delivered=visible.filter(order=>order.status==='delivered').length;
  const files=visible.reduce((total,order)=>total+order.items.length,0);
  board.append(node('p',delivered+' delivered · '+files+' total files','wh-history-summary'));
  if (!visible.length) {
    const mascot=node('img');mascot.src='/printbee-header-bee.webp';mascot.alt='';mascot.width=80;mascot.height=64;
    const empty=node('div',null,'clay-card wh-empty wh-alert');
    empty.append(mascot,node('h3','No matching orders'),node('p','Try a different date range or search.'));
    board.append(empty);
    return;
  }
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
    const open=button(labelOrder(order),()=>openOrder(order.id,true),'wh-order-link');
    open.dataset.focus='order-'+order.id;
    const copy=button('',async()=>{await navigator.clipboard.writeText(labelOrder(order));announce('Order number copied.');},'wh-icon-button wh-order-copy');
    copy.setAttribute('aria-label','Copy '+labelOrder(order));
    copy.append(icon('copy'));
    const orderCell=node('div',null,'wh-history-order');
    orderCell.append(open,copy);
    row.insertCell().append(orderCell);
    row.insertCell().textContent=order.paidAt?new Date(order.paidAt*1000).toLocaleDateString():'—';
    row.insertCell().textContent=order.customer;
    row.insertCell().append(chip(stage(order),statusStyle(stage(order))));
    row.insertCell().textContent=order.items.length;
  }
  wrapper.append(table);
  board.append(wrapper);
}
function printerIllustration() {
  const drawing=node('div',null,'wh-device');
  drawing.setAttribute('aria-hidden','true');
  drawing.append(node('span',null,'wh-device-paper'),node('span',null,'wh-device-case'),node('span',null,'wh-device-output'));
  return drawing;
}
function settingRow(key,label,description) {
  const row=node('label',null,'wh-setting'), input=node('input');
  input.type='checkbox';
  input.role='switch';
  input.checked=preferences[key];
  input.dataset.setting=key;
  const detail=node('small',description,'wh-muted');
  detail.id='floor-setting-'+key;
  input.setAttribute('aria-describedby',detail.id);
  input.addEventListener('change',()=>setSetting(key,input.checked));
  const copy=node('span');
  copy.append(node('strong',label),detail);
  row.append(copy,input);
  return row;
}
function renderTools() {
  const panel=node('section',null,'clay-card wh-tool');
  if (view==='Printers') {
    const header=node('div',null,'wh-meta');
    const state=!connected || !online?'Offline':paused?'Paused':'Online';
    header.append(node('h2',preview?'Mock printer':'Warehouse print agent'),
      chip(state,'wh-agent '+(state==='Online'?'wh-good':state==='Paused'?'wh-attention':'wh-bad')));
    panel.append(printerIllustration(),header);
    if (preview) {
      const controls=node('div',null,'wh-tool-actions');
      controls.append(button('Test print',()=>announce(paused?'Resume the mock queue before testing.':'Mock print passed. No paper used.'),'clay-button wh-primary'),
        button(paused?'Resume':'Pause',()=>{paused=!paused;updateTop();render();}));
      const capabilities=node('div',null,'wh-chips');
      ['Colour / B&W','A4 / A3','Duplex'].forEach(value=>capabilities.append(chip(value)));
      panel.append(capabilities,controls);
    } else {
      panel.append(node('p','Run test prints and pause the printer at the warehouse workstation.','wh-muted'));
    }
    board.append(panel);
  } else if (view==='Inventory') {
    panel.append(node('h2','Inventory'),node('p',preview?'A4 · 490 sheets     A3 · 38 sheets     Spiral coils · 12 remaining':'Stock counts are managed at the print room.'));
    board.append(panel);
  } else {
    const groups=node('div',null,'wh-setting-groups');
    const alerts=node('section',null,'clay-card wh-tool');
    alerts.append(node('h2','Alerts'),
      settingRow('sound','New order chime','Play a sound when a paid order arrives or finishes printing.'),
      settingRow('takeover','Full-screen alert for new orders','Show incoming paid orders over the work area.'));
    const printing=node('section',null,'clay-card wh-tool');
    printing.append(node('h2','Printing'),settingRow('skipConfirm','Skip print confirmation','Send files to the printer in one press.'));
    const display=node('section',null,'clay-card wh-tool');
    const example=node('div',null,'wh-station-contact wh-display-preview');
    const displayStatus=node('span');
    displayStatus.id='floor-display-preview';
    displayStatus.setAttribute('role','status');
    example.append(node('strong','Display preview'),displayStatus);
    display.append(node('h2','Display'),settingRow('large','Large text','Increase type size across the Print Floor.'),
      settingRow('contrast','High contrast','Use stronger colours for labels, controls and focus.'),example);
    const integration=node('section',null,'clay-card wh-tool');
    integration.append(node('h2','Integrations'));
    if ('Notification' in window) integration.append(button('Enable browser notifications',async()=>{
      announce((await Notification.requestPermission())==='granted'?'Notifications enabled.':'Notifications are off. Check browser permissions.');
    }));
    integration.append(button('View inventory',()=>go('Inventory')));
    groups.append(alerts,printing,display,integration);
    board.append(groups);
    syncPreferences();
  }
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
  station.classList.toggle('wh-context-station',['Printers','History','Inventory'].includes(view) && !active);
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
  station.hidden=view==='Settings';
  if (station.hidden) return;
  station.classList.toggle('wh-context-station',['Printers','History','Inventory'].includes(view) && !order);
  byId('floor-detail-context').textContent='Order station';
  byId('detail-title').textContent=order?labelOrder(order):'Next up';
  if (!order) {
    renderStationContext(body,dock);
    return;
  }
  const bucket=stage(order), summary=node('div',null,'wh-meta');
  summary.append(chip(bucket,statusStyle(bucket)),window.PrintBeeStatus?.model && order.status?PrintBeeStatus.badge(order.status):chip('Paid','wh-good'));
  const minutes=elapsed(order);
  if (minutes!==null && buckets.includes(bucket)) summary.append(chip(minutes>=45?'SLA overdue':45-minutes+' min left','wh-sla '+(minutes>=45?'wh-bad':minutes>=30?'wh-attention':'')));
  body.append(summary,orderTracker(bucket));
  if (bucket==='Ready') body.append(node('span','READY','wh-ready-stamp'+(newlyReady.has(order.id)?' wh-arrive':'')));
  const contact=node('div',null,'wh-station-contact');
  contact.append(node('strong',order.customer || 'Customer unavailable'),
    node('span',order.partner?'Partner: '+order.partner:'Unassigned'),node('span',order.slot || 'No delivery slot set'));
  body.append(contact);
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
function orderTracker(bucket) {
  const tracker=node('ol',null,'wh-tracker');
  tracker.setAttribute('aria-label','Order progress');
  const step={New:0,Printing:1,Ready:2}[bucket] ?? 3;
  ['Received','Printing','Ready','Handed over'].forEach((label,index)=>{
    const item=node('li',label);
    if (index<=step) item.classList.add('wh-step-reached');
    if (index===step) item.setAttribute('aria-current','step');
    tracker.append(item);
  });
  return tracker;
}
function renderStationContext(body,dock) {
  const title=byId('detail-title');
  if (view==='Printers') {
    title.textContent='Pair a printer';
    const steps=node('ol',null,'wh-pair-steps');
    ['Connect the printer and print a test page from the workstation.','Start the PrintBee agent with the printer name and its print-agent key.','Return here and wait for the agent to show Online.'].forEach(text=>steps.append(node('li',text)));
    body.append(steps);
    return;
  }
  if (view==='Inventory') {title.textContent='Stock overview';body.append(node('p','Check stock before starting a print run.','wh-muted'));return;}
  if (view==='History') {
    title.textContent='Recent handovers';
    const rows=selectedOrders(['Delivered','Out for delivery']);
    body.append(node('p',rows.length+' orders in this date range.','wh-muted'));
    if (rows.length) {
      const recent=rows.slice().sort((first,second)=>(second.paidAt||0)-(first.paidAt||0))[0];
      body.append(button(labelOrder(recent),()=>openOrder(recent.id,true)));
    }
    return;
  }
  const candidates=selectedOrders(buckets);
  const next=candidates.find(order=>stage(order)==='New') || candidates[0];
  if (next) {
    body.append(node('h3',labelOrder(next)),chip(stage(next),statusStyle(stage(next))));
    const files=node('ul',null,'wh-next-files');
    next.items.slice(0,3).forEach(item=>{
      const row=node('li');
      row.append(icon('file'),node('span',item.name),node('small',item.pages+' pages'));
      files.append(row);
    });
    body.append(files);
    dock.hidden=false;
    if (stage(next)==='New') renderPrintAction(next,dock,true);
    else dock.append(mainAction(stage(next)==='Ready'?'Hand over':'View print',()=>openOrder(next.id,true),'open'));
  } else {
    body.append(node('p','All caught up. New orders will appear here.','wh-muted'));
  }
  body.append(button('Keyboard shortcuts',()=>shortcutDialog.showModal(),'wh-order-link'));
}
function fileRow(order,item,index) {
  const row=node('article',null,'wh-file');
  const thumb=icon('file');thumb.className='wh-file-icon';
  const info=node('div');
  const state=jobState(order,index);
  const title=node('h3',item.name);
  thumb.append(node('small',item.pages+' p'));
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
    const print=button(state==='failed'?'Retry file':'Print file',()=>confirmPrint(order,index));
    print.disabled=!connected || !online || paused;
    menu.append(print);
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
function renderPrintAction(order,dock,selectFirst=false) {
  dock.hidden=false;
  const labels=order.items.map((_,index)=>jobState(order,index));
  const printing=labels.some(state=>state==='queued'||state==='printing');
  const failures=labels.filter(state=>state==='failed').length;
  if (printing) {
    const progress=node('div',null,'wh-progress');
    const caption=node('div',null,'wh-meta');
    const done=labels.filter(state=>state==='done').length;
    const sentSheets=order.items.reduce((sum,item,index)=>sum+(labels[index]==='done'?sheets(item):0),0);
    const totalSheets=order.items.reduce((sum,item)=>sum+sheets(item),0);
    caption.append(node('strong',done+' of '+labels.length+' files printed'));
    const bar=node('progress');bar.max=Math.max(1,totalSheets);bar.value=sentSheets;
    bar.setAttribute('aria-label','Sheets in completed files');
    const device=printerIllustration();
    device.classList.add('wh-device-printing');
    progress.append(device,caption,bar,node('small',sentSheets+' / '+totalSheets+' sheets in completed files','wh-muted'));
    dock.append(progress);
    return;
  }
  const control=mainAction(failures?'Retry print':order.items.length===1?'Print':'Print all',()=>{
    if (selectFirst) openOrder(order.id);
    return confirmPrint(order,'all');
  },'print');
  control.prepend(icon('printer'));
  control.disabled=printPending || !order.items.length || !online || !connected || paused;
  dock.append(control);
  if (!online || !connected || paused) dock.append(node('small','Print is available when the printer is online.','wh-muted'));
}
function renderHandover(order,body,dock) {
  const details=node('section',null,'wh-notes wh-pickup');
  details.append(node('h3','Pickup'),
    node('p',order.partner?'Assigned to '+order.partner:'Unassigned'),
    node('p',order.slot || 'No delivery slot set'));
  body.append(details);
  dock.hidden=false;
  dock.append(mainAction('Hand over',()=>showHandover(order),'handover'));
}
function showHandover(order) {
  const path='/api/staff/orders/'+order.id+'/label';
  const title=labelOrder(order)+' packing label';
  const label=node('div',null,'wh-pickup-label');
  label.append(icon('file'),node('strong',labelOrder(order)),node('span','Packing label'));
  const body=byId('floor-handover-body');
  body.replaceChildren(label,node('p','Partner: '+(order.partner || 'Unassigned')),
    node('p',order.slot || 'No delivery slot set'));
  if (!preview) body.append(node('p','The delivery partner confirms pickup in their portal.','wh-muted'));
  const actions=byId('floor-handover-actions');
  actions.querySelectorAll('[data-handover-action]').forEach(action=>action.remove());
  const packing=button('Preview packing label',()=>showAsset(title,path,order),preview?'clay-button':'clay-button wh-primary');
  packing.dataset.handoverAction='';
  actions.append(packing);
  if (preview) {
    const confirm=mainAction('Confirm sample handover',async()=>{
      if (order.status!=='packed') return;
      order.status='out_for_delivery';
      addEvent(order,'delivery_picked_up');
      handover.close();
      await refreshAfterAction('Sample handover confirmed.');
    },'confirm-handover');
    confirm.dataset.handoverAction='';
    actions.append(confirm);
  }
  handover.showModal();
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
  if (!connected || !online || paused) throw new Error('Print is available when the printer is online.');
  printAction=()=>sendPrint(current,index,selected);
  if (preferences.skipConfirm) return runPrint();
  const total=selected.reduce((sum,i)=>sum+sheets(current.items[i]),0);
  const modes=[...new Set(selected.map(i=>colour(current.items[i])))].join(' / ');
  byId('confirm-body').replaceChildren(
    node('h3',labelOrder(current)),
    node('p',preview?'Printer: Mock printer':'Printer: Warehouse workstation'),
    node('p',selected.length+(selected.length===1?' file':' files')+' · '+total+(total===1?' sheet':' sheets')+' · '+modes)
  );
  confirmation.returnValue='cancel';
  confirmation.showModal();
  byId('floor-print-slide').focus();
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
  badge.classList.toggle('wh-attention',connected && paused);
  badge.classList.toggle('wh-bad',!connected || (!online && !paused));
  const paidToday=orders.filter(order=>today(order.paidAt));
  const todayBadge=byId('today-count');
  const handedOver=paidToday.filter(order=>conveyorStage(order)==='Handed over').length;
  const ring=node('span',null,'wh-today-ring');
  ring.style.setProperty('--today-progress',(paidToday.length?handedOver/paidToday.length:0)*100+'%');
  ring.setAttribute('aria-hidden','true');
  todayBadge.replaceChildren(ring,node('span',paidToday.length+' today'));
  todayBadge.title=handedOver+' handed over today';
  const banner=byId('floor-connection');
  banner.hidden=connected && online && !paused;
  byId('floor-connection-copy').textContent=!connected?'Connection lost. The queue reconnects automatically.':
    paused?'Printer paused. Resume it in Printers.':'Printer offline. Check the warehouse workstation before printing.';
  byId('floor-retry').hidden=connected;
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
  if (preferences.takeover && !confirmation.open && !viewer.open && !arrival.open && !handover.open && !shortcutDialog.open && !printPending && !station.contains(document.activeElement)) {
    arrivalOrder=latest.id;
    byId('arrival-number').textContent=message;
    arrival.returnValue='dismiss';
    arrival.showModal();
    const deadline=Date.now()+15000;
    const tick=()=>{
      const remaining=Math.max(0,Math.ceil((deadline-Date.now())/1000));
      byId('floor-arrival-timer').textContent='Closes in '+remaining+' s';
      if (!remaining) arrival.close('dismiss');
    };
    tick();
    arrivalTimer=setInterval(tick,250);
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
  playChime(660,880);
}
function playChime(first,second) {
  if (preferences.sound && audio?.state==='running') {
    const tone=audio.createOscillator(), gain=audio.createGain(), now=audio.currentTime;
    tone.frequency.setValueAtTime(first,now);
    tone.frequency.setValueAtTime(second,now+.09);
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
  const previous=JSON.stringify(findOrder());
  newlyReady=new Set(current.orders.filter(order=>order.status==='packed' && lastStages.get(order.id)==='printing').map(order=>order.id));
  lastStages=new Map(current.orders.map(order=>[order.id,order.status]));
  const wasAvailable=connected && online && !paused;
  orders=current.orders;
  online=current.agentOnline;
  connected=true;
  updateTop();
  const fresh=known?orders.filter(order=>order.status==='paid' && !known.has(order.id)):[];
  known=new Set(orders.map(order=>order.id));
  notifyNew(fresh);
  if (newlyReady.size) playChime(523,784);
  const ordersChanged=renderedOrderSnapshot!==JSON.stringify(orders);
  for (const control of board.querySelectorAll('.wh-tab')) {
    const label=control.dataset.focus.slice(4);
    const count=control.querySelector('.wh-count');
    const total=String(orders.filter(order=>stage(order)===label).length);
    if (count.textContent!==total) count.textContent=total;
  }
  const safeToRender=!board.contains(document.activeElement) && !board.querySelector('details[open]') && view!=='Settings';
  if (force || fresh.length || (ordersChanged && safeToRender)) {
    render(false);
    if (fresh.length) {
      setTimeout(()=>fresh.forEach(order=>delete order.fresh),240);
      setTimeout(()=>newBadges.delete('New'),240);
    }
  } else {
    if (ordersChanged) {
      for (const control of board.querySelectorAll('.wh-stat')) {
        updateStageCount(control,control.querySelector('.wh-stat-label').textContent);
      }
    }
    for (const card of board.querySelectorAll('.wh-order[data-order]')) {
      const order=findOrder(card.dataset.order);
      if (order) updateCardAge(card,order);
    }
  }
  const selected=findOrder();
  if (!selected && active) {active=null;closeSheet();}
  if (force || previous!==JSON.stringify(selected) || wasAvailable!==(connected && online && !paused) ||
      (ordersChanged && safeToRender && !station.contains(document.activeElement) && !selected)) renderStation();
  else if (selected) {
    const timer=station.querySelector('.wh-sla');
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
    if (connected) {
      announce('Connection lost. Retrying automatically…');
      connected=false;
      updateTop();
      renderStation();
    }
  } finally {busyRefresh=false;}
}
function initFloorControls() {
  const root=document.documentElement;
  const theme=byId('theme');
  const syncTheme=()=>{
    const dark=root.dataset.theme==='dark';
    const symbol=icon(dark?'sun':'moon').firstElementChild;
    symbol.setAttribute('aria-hidden','true');
    theme.replaceChildren(symbol);
    theme.setAttribute('aria-pressed',String(dark));
    theme.title=dark?'Switch to Sun Hive':'Switch to Moon Hive';
    theme.setAttribute('aria-label',theme.title);
  };
  syncTheme();
  new MutationObserver(syncTheme).observe(root,{attributeFilter:['data-theme']});
  theme.addEventListener('click',()=>{
    root.dataset.theme=root.dataset.theme==='dark'?'light':'dark';
    try {localStorage.setItem('printbee-admin-theme',root.dataset.theme);} catch {}
  });
  const collapse=byId('floor-collapse');
  collapse.addEventListener('click',()=>{
    const narrow=byId('warehouse-app').classList.toggle('wh-collapsed');
    collapse.setAttribute('aria-expanded',String(!narrow));
    collapse.setAttribute('aria-label',narrow?'Expand sidebar':'Collapse sidebar');
    collapse.textContent=narrow?'›':'‹';
  });
  byId('floor-retry').addEventListener('click',()=>refresh(true).catch(()=>announce('Still offline. Try again in a moment.')));
  const phoneLayout=matchMedia('(max-width:700px), (max-width:850px) and (orientation:portrait)');
  const account=document.querySelector('.wh-account');
  const accountParent=account.parentElement;
  const placeAccount=()=>{
    const target=phoneLayout.matches?document.querySelector('.wh-indicators'):accountParent;
    if (account.parentElement!==target) target.append(account);
  };
  phoneLayout.addEventListener('change',placeAccount);
  placeAccount();
  const slide=byId('floor-print-slide');
  let start, travel;
  slide.addEventListener('pointerdown',event=>{
    if (!event.isPrimary || event.button!==0) return;
    start=event.clientX;
    travel=Math.max(1,slide.clientWidth-slide.firstElementChild.offsetWidth-16);
    slide.setPointerCapture(event.pointerId);
  });
  slide.addEventListener('pointermove',event=>{
    if (start===undefined) return;
    const distance=Math.max(0,Math.min(travel,event.clientX-start));
    slide.style.setProperty('--slide-offset',distance+'px');
  });
  const clear=()=>{start=undefined;slide.style.removeProperty('--slide-offset');};
  slide.addEventListener('pointercancel',clear);
  slide.addEventListener('pointerup',event=>{
    const complete=start!==undefined && event.clientX-start>=travel*.78;
    clear();
    if (complete && confirmation.open) slide.form.requestSubmit(slide);
  });
  slide.addEventListener('click',event=>{if (event.detail>0) event.preventDefault();});
}
function handleKeys(event) {
  if (event.defaultPrevented || confirmation.open || viewer.open || arrival.open || handover.open || shortcutDialog.open) return;
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
  if (event.key==='?') {event.preventDefault();shortcutDialog.showModal();return;}
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
  if (preview) byId('floor-shift').textContent='Sample shift';
  byId('search-icon').append(icon('search'));
  byId('station-close').append(icon('close'));
  byId('station-close').addEventListener('click',()=>closeSheet());
  byId('sound-toggle').addEventListener('click',()=>setSetting('sound',!preferences.sound));
  initFloorControls();
  const search=byId('warehouse-search');
  search.addEventListener('input',()=>{
    if (search.value.trim() && ['Printers','Settings','Inventory'].includes(view)) go('Print Queue','New',true);
    else render();
  });
  for (const [title,glyph] of sections) {
    const control=button('',()=>go(title),'wh-nav-button');
    control.dataset.section=title;
    const label=title==='Home'?'Mission control':title;
    control.title=label;
    control.setAttribute('aria-label',label);
    control.append(icon(glyph),node('span',label,'wh-nav-label'));
    byId('warehouse-nav').append(control);
  }
  const nav=byId('warehouse-staff-dock');
  const open=section=>()=>{go(section);scrollTo(0,0);};
  staffDock=window.createStaffDock(nav,[
    {id:'Home',label:'Home',icon:'home',select:open('Home')},
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
arrival.addEventListener('close',()=>{
  clearInterval(arrivalTimer);
  if (arrival.returnValue==='open' && arrivalOrder) openArrival(arrivalOrder);
});
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
    // Orders arrive over the live feed (instant); this slow poll is only a safety net.
    polling=setInterval(refreshLive,30000);
    liveFeed=PrintBeeLive.start({as:'warehouse',onSync:refreshLive});
  },()=>{clearInterval(polling);liveFeed?.stop();});
}
