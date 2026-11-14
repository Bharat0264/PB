const $ = id => document.getElementById(id);
const demo = new URLSearchParams(location.search).get('preview') === '1';
const content = $('rider-content');
const status = $('ops-status');
const money = n => new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format((n || 0)/100);
const seed = () => ({
  available:false, earnings:{lifetime:3700,outstanding:3700}, step:0, failures:0, unlock:0,
  orders:[
    {id:'sample-1',order_number:'PB-DEMO-4101',status:'packed',payout:4200,summary:'0.6 km to pickup · 1.4 km to drop · 11 min · 2 packets',urgent:true,address:'North Hostel reception, SRM campus',customer:'Sample customer',notes:'Meet at reception.'},
    {id:'sample-2',order_number:'PB-DEMO-4102',status:'packed',payout:3800,summary:'0.9 km to pickup · 1.1 km to drop · 12 min · 1 packet',address:'Engineering block, SRM campus',customer:'Sample customer'},
    {id:'sample-3',order_number:'PB-DEMO-4100',status:'delivered',partner:'sample',payout:3700},
  ],
});
function saved(key) {try {return localStorage.getItem(key);} catch {return null;}}
function save(key,value) {try {localStorage.setItem(key,value);} catch {}}
let state = {available:false,orders:[],earnings:{}};
if (demo) {
  state = seed();
  try { state = JSON.parse(saved('printbee-partner-demo')) || state; } catch {}
}
let tab='Cockpit', completed, busy=false, reading, interval, localStep=0;
let watch, lastSent=0, point, sending=false, wakeLock, offerIds;
let period='Today', shiftSince=demo ? state.shiftSince : null, lastTab;
let notices=[];
const skipped=new Set();
let profile={name:'Aarav Kumar',vehicle:'TN 19 · Electric scooter',payout:'aarav@upi',language:'English',alerts:true};
if (demo) {
  try { profile={...profile,...JSON.parse(saved('printbee-rider-profile'))}; } catch {}
}
const symbols={
  Cockpit:'M3 4h18v16H3z M3 10h18 M9 10v10',
  Earnings:'M3 18h18 M6 15v-4 M12 15V7 M18 15V4',
  Profile:'M20 21a8 8 0 0 0-16 0 M16 7a4 4 0 1 1-8 0 4 4 0 1 1 8 0',
  search:'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  bell:'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  moon:'M20 15a8 8 0 0 1-11-11 8 8 0 1 0 11 11',
};
function symbol(name) {
  const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');
  icon.setAttribute('viewBox','0 0 24 24');
  icon.setAttribute('aria-hidden','true');
  icon.innerHTML='<path d="'+symbols[name]+'" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>';
  return icon;
}
function notify(message) {
  status.textContent=message;
  notices=[message,...notices.filter(item=>item!==message)].slice(0,8);
}
function node(tag,text,cls) {
  const el=document.createElement(tag);
  if(text!=null) el.textContent=text;
  if(cls) el.className=cls;
  return el;
}
function card(title) {
  const section=node('section',null,'clay-card');
  if(title) section.append(node('h2',title));
  return section;
}
function link(text,url,external=false) {
  const el=node('a',text,'rider-contact');el.href=url;
  if(external) {el.target='_blank';el.rel='noopener noreferrer';}
  return el;
}
async function run(action, control) {
  if (busy) return;
  busy=true;
  if(control) control.disabled=true;
  status.textContent='';
  try {await action();}
  catch(error) {status.textContent=error.message;}
  finally {busy=false;if(control) control.disabled=false;}
}
function button(text,action,type='clay-button') {
  const control=node('button',text,type);control.type='button';
  control.onclick=()=>run(action,control);
  return control;
}
function orderNo(order) {return order.order_number || 'PB-'+order.id.slice(0,8).toUpperCase();}
function active() {return state.orders.find(o=>o.partner && ['packed','out_for_delivery'].includes(o.status));}
function offers() {return state.orders.filter(o=>!o.partner && o.status==='packed');}
function persist() {if(demo) save('printbee-partner-demo',JSON.stringify(state));}
function changed() {persist();render();}
async function request(path,data) {
  const response=await fetch(path,{method:data===undefined?'GET':'POST',cache:'no-store',
    headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
  const body=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(body.error || 'Delivery service unavailable.');
  return body;
}
function orderAction(order,action,data={}) {return request('/api/partner/orders/'+order.id+'/'+action,data);}
async function refresh() {
  if (reading) {
    await reading.catch(() => {});
    if (!busy) return;
  }
  const snapshot = request('/api/partner/orders');
  reading = snapshot;
  try {
    const data = await snapshot;
    const old=active()?.id;
    const nextOffers=data.orders.filter(o=>!o.partner && o.status==='packed').map(o=>o.id);
    if(offerIds && data.available && nextOffers.some(id=>!offerIds.includes(id))) {
      notify('New delivery available.');
      navigator.vibrate?.(70);
    }
    offerIds=nextOffers;
    const updated=JSON.stringify(state)!==JSON.stringify(data);
    if (!state.available && data.available) shiftSince=Date.now();
    if (!data.available) shiftSince=null;
    state=data;
    if(old && old!==active()?.id) {
      localStep=0;
      stopLocation();
      if(!completed) status.textContent='This delivery is no longer assigned to you. Contact PrintBee.';
    }
    if(state.available && active()?.status==='out_for_delivery') startLocation();
    else stopLocation();
    $('network').hidden=true;
    if(updated || !content.querySelector('.rider-layout')) render();
  } catch(error) {
    $('network').hidden=false;
    if(!content.querySelector('.rider-layout')) {
      const message=card('Deliveries could not load');
      message.append(button('Retry',refresh,'rider-secondary'));
      content.replaceChildren(message);
    }
    throw error;
  } finally {if (reading === snapshot) reading = null;}
}
function stopLocation() {
  if(watch!==undefined) navigator.geolocation.clearWatch(watch);
  watch=undefined;point=null;lastSent=0;
  if(wakeLock && !wakeLock.released) wakeLock.release().catch(()=>{});
  wakeLock=null;
}
async function keepAwake() {
  if(!demo && state.available && active()?.status==='out_for_delivery' && navigator.wakeLock && !document.hidden && (!wakeLock || wakeLock.released)) {
    try {wakeLock=await navigator.wakeLock.request('screen');} catch {}
  }
}
async function sendLocation() {
  const order=active(), latest=point;
  if(!latest || !navigator.onLine || !state.available || order?.status!=='out_for_delivery' || sending || Date.now()-lastSent<5000) return;
  lastSent=Date.now();sending=true;
  try {await orderAction(order,'location',latest);if(point===latest) point=null;}
  catch {if(state.available && order.id===active()?.id) status.textContent='Location update paused. Retrying when connected.';}
  finally {sending=false;}
}
function startLocation() {
  if(demo || watch!==undefined || !navigator.geolocation) return;
  watch=navigator.geolocation.watchPosition(({coords})=>{
    if(coords.accuracy>100) return;
    point={lat:coords.latitude,lng:coords.longitude};sendLocation();
  },()=>{status.textContent='Allow location access to share your progress.';},{enableHighAccuracy:true,maximumAge:5000,timeout:15000});
  keepAwake();
}
async function toggleOnline() {
  const next=!state.available;
  if(demo) {state.available=next;shiftSince=next?Date.now():null;state.shiftSince=shiftSince;changed();return;}
  if(next) {
    if(!navigator.geolocation) throw new Error('Location is unavailable on this device.');
    await new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,
      ()=>reject(new Error('Allow location access before going online.')),{maximumAge:15000,timeout:12000}));
  }
  await request('/api/partner/availability',{available:next});
  await refresh();
}
function stats() {
  const grid=node('div',null,'rider-metrics');
  const delivered=state.orders.filter(o=>o.status==='delivered');
  const entries=[
    [demo?'Earned today':'Lifetime earned',money(state.earnings.lifetime),'Earnings',demo?'+12% vs yesterday':'Across all deliveries'],
    ['Awaiting settlement',money(state.earnings.outstanding),'Earnings',demo?'+8% vs yesterday':'Recorded payout balance'],
    ['Completed',delivered.length,'Cockpit',demo?'+1 vs yesterday':'Recent deliveries'],
    ['Rating',demo?'4.9 / 5':'—','Profile',demo?'Steady vs yesterday':'Rating unavailable'],
  ];
  entries.forEach(([name,value,icon,context],index)=>{
    const tile=card(); tile.classList.add('rider-stat');
    const mark=node('span',null,'rider-metric-icon'); mark.append(symbol(icon));
    const metric=node('strong',value);
    tile.append(mark,node('span',name,'rider-muted'),metric,node('small',context));
    if(demo) tile.insertAdjacentHTML('beforeend','<svg class="rider-spark" viewBox="0 0 100 20" aria-hidden="true" preserveAspectRatio="none"><polyline points="0,18 16,14 33,'+(index+10)+' 50,15 67,7 83,10 100,3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>');
    grid.append(tile);
  });
  return grid;
}
function routePanel(order) {
  const section=card(demo?'Route preview':'Directions');
  section.classList.add('rider-map');
  if(demo) {
    const drawing=node('div');
    drawing.innerHTML='<svg viewBox="0 0 440 290" role="img" aria-label="Illustrated campus delivery route"><rect width="440" height="290" fill="#ede4cc"/><path d="M0 175 146 160 272 220 440 180M0 81 155 60 278 100 440 57M95 0l31 290M350 0l-29 290M0 249l440 7" stroke="#fffaf0" stroke-width="18" fill="none"/><path d="M90 215 142 200 187 167 240 151 305 100 360 79" fill="none" stroke="#9f710d" stroke-width="8" stroke-linecap="round"/><circle cx="90" cy="215" r="9" fill="#865b12"/><circle cx="360" cy="79" r="11" fill="#ffc83d" stroke="#865b12" stroke-width="3"/><circle class="route-dot" cx="162" cy="185" r="9" fill="#ffc83d" stroke="#513408" stroke-width="3"/></svg>';
    drawing.className='rider-map-art';
    drawing.append(node('span',order?'11 min · sample pickup':'SRM campus','clay-badge rider-eta'));
    section.append(drawing,node('p','Illustrative route','rider-muted'));
  } else if(order) {
    const destination=order.status==='packed'?'SRM Institute of Science and Technology, Kattankulathur':
      order.address?.match(/Delivery pin: (-?[\d.]+,\s*-?[\d.]+)/i)?.[1] || order.address;
    if(destination) section.append(node('p',order.status==='packed'?'SRM campus print room':order.address),
      link('Open in Google Maps','https://www.google.com/maps/dir/?'+new URLSearchParams({api:1,destination,travelmode:'driving'}),true));
  } else section.append(node('p','Directions appear after you accept a delivery.','rider-muted'));
  return section;
}
function availableOrders() {
  const section=card('Available deliveries');
  const list=node('div',null,'rider-offers');section.append(list);
  if(state.available) for(const order of offers().filter(item=>!skipped.has(item.id))) {
    const tile=node('article',null,'rider-order');
    tile.append(node('h3',orderNo(order)),node('strong',money(order.payout)+' payout'),node('p',order.summary,'rider-muted'));
    if(order.urgent) tile.append(node('span','Urgent','clay-badge'));
    tile.append(button('Accept delivery',async()=>{
      if(active()) throw new Error('Finish your current delivery first.');
      if(demo) {order.partner='sample';state.step=0;state.failures=0;state.unlock=0;changed();}
      else {await orderAction(order,'accept');await refresh();}
      notify('Delivery accepted.');
    }));
    if(demo) tile.append(button('Skip',()=>{skipped.add(order.id);render();notify('Sample offer skipped.');},'rider-secondary'));
    list.append(tile);
  }
  if(!list.children.length) list.append(node('p',state.available?'No orders right now.':'Go online to see delivery offers.','rider-muted'));
  return section;
}
function mainAction(text,fn) {return button(text,fn,'clay-button rider-main-action');}
function activeDelivery(order) {
  const step=order.status==='packed'?( (demo?state.step:localStep)===1 ? 1 : 0):( (demo?state.step:localStep)===3 ? 3 : 2);
  const section=card();
  const progress=node('ol',null,'rider-progress');progress.setAttribute('aria-label','Delivery progress');
  ['Warehouse','Pickup','Customer','Verify'].forEach((text,i)=>{
    const li=node('li',(i+1)+' '+text);if(i===step) li.setAttribute('aria-current','step');progress.append(li);
  });
  section.append(progress,node('h2',['Go to the warehouse','Confirm pickup','Navigate to customer','Verify delivery code'][step]),node('p',orderNo(order),'rider-muted'));
  function advance(next) {if(demo) state.step=next;else localStep=next;changed();}
  if(step===0) section.append(node('p','SRM campus print room'),mainAction('I’ve arrived',()=>advance(1)));
  if(step===1) {
    const checks=node('fieldset',null,'rider-checks');checks.append(node('legend','Before you leave'));
    for(const text of ['Packet count matches','Labels match this order']) {
      const label=node('label'), input=node('input');input.type='checkbox';label.append(input,text);checks.append(label);
    }
    section.append(checks,mainAction('Confirm pickup',async()=>{
      if(checks.querySelector('input:not(:checked)')) throw new Error('Check the packets and labels first.');
      if(demo) {order.status='out_for_delivery';advance(2);}
      else {await orderAction(order,'pickup');localStep=2;await refresh();}
      notify('Pickup confirmed.');
    }));
  }
  if(step===2) {
    section.append(node('p',order.customer),node('p',order.address),node('p',order.notes,'rider-muted'));
    if(!demo && order.phone) section.append(link('Call customer','tel:'+order.phone.replace(/[^+0-9]/g,'')));
    section.append(mainAction('I’m with the customer',()=>advance(3)));
  }
  if(step===3) section.append(codeForm(order));
  return section;
}
function codeForm(order) {
  const form=node('form',null,'rider-code');
  const field=node('label','Customer’s four-digit code');
  const input=node('input',null,'clay-input');
  input.type='text';input.inputMode='numeric';input.autocomplete='one-time-code';input.maxLength=4;input.required=true;input.pattern='[0-9]{4}';
  field.append(input);
  const digits=node('div',null,'rider-digits');digits.setAttribute('aria-hidden','true');
  for(let i=0;i<4;i++) digits.append(node('span','·'));
  const submit=node('button','Verify and deliver','clay-button');submit.type='submit';
  const cooldown=node('p',null,'rider-muted');
  if(demo) form.append(node('p','Demo code: 4816','rider-muted'));
  function tick() {
    const seconds=demo?Math.max(0,Math.ceil((state.unlock-Date.now())/1000)):0;
    cooldown.textContent=seconds?'Try again in '+seconds+' seconds.':'';
    input.disabled=submit.disabled=Boolean(seconds);
    if(seconds) setTimeout(()=>{if(form.isConnected) tick();},1000);
  }
  form.append(field,digits,cooldown,submit);tick();
  input.oninput=()=>{
    input.value=input.value.replace(/\D/g,'').slice(0,4);
    [...digits.children].forEach((el,i)=>{el.textContent=input.value[i]||'·';});
    if(input.value.length===4) form.requestSubmit();
  };
  form.onsubmit=event=>{
    event.preventDefault();
    run(async()=>{
      if(demo) {
        if(Date.now()<state.unlock) throw new Error('Wait before trying again.');
        if(input.value!=='4816') {
          state.failures++;
          if(state.failures>=3) {state.failures=0;state.unlock=Date.now()+60000;}
          changed();navigator.vibrate?.(100);
          throw new Error(state.unlock>Date.now()?'Too many attempts. Try again in 60 seconds.':'Wrong code. '+(3-state.failures)+' tries left.');
        }
        order.status='delivered';order.completedAt=Date.now();state.earnings.lifetime+=order.payout;state.earnings.outstanding+=order.payout;
        persist();
        completed=order;
      } else {
        try {await orderAction(order,'deliver',{code:input.value});}
        catch(error) {input.select();throw error;}
        completed=order;stopLocation();
        state.orders=state.orders.map(item=>item.id===order.id?{...item,status:'delivered'}:item);
        await refresh().catch(()=>{});
      }
      render();
    },submit);
  };
  return form;
}
function success() {
  const section=card();section.classList.add('rider-success');
  const bee=node('img');bee.src='/printbee-header-bee.webp';bee.alt='';
  section.append(bee,node('span','Verified','clay-badge'),node('h2','Delivery complete'),
    node('p',orderNo(completed)),node('p',money(completed.payout)+' earned'),
    mainAction('Next order',()=>{completed=null;render();}));
  return section;
}
function showDialog(title,populate) {
  const dialog=$('rider-dialog');
  $('rider-dialog-title').textContent=title;
  const body=$('rider-dialog-body');
  body.replaceChildren();
  $('portal-logout').classList.toggle('rider-menu-logout',title==='Partner account');
  populate(body);
  if(!dialog.open) dialog.showModal();
}

function selectTab(next) {
  tab=next;
  if($('rider-dialog').open) $('rider-dialog').close();
  render();
  window.scrollTo(0,0);
  content.focus({preventScroll:true});
}

function openSearch() {
  showDialog('Search portal',body=>{
    const field=node('input',null,'clay-input');
    field.type='search';
    field.placeholder='Search pages or orders';
    field.setAttribute('aria-label','Search pages or orders');
    const results=node('div',null,'rider-search-results');
    const list=[['Cockpit','Cockpit'],['Earnings','Earnings'],['Profile','Profile'],
      ...state.orders.filter(order=>order.partner).map(order=>[orderNo(order),order.status==='delivered'?'Earnings':'Cockpit'])];
    const matches=()=>{
      const query=field.value.trim().toLowerCase();
      results.replaceChildren(...list.filter(([name])=>name.toLowerCase().includes(query)).map(([name,destination])=>button(name,()=>selectTab(destination),'rider-secondary')));
      if(!results.children.length) results.append(node('p','No results.','rider-muted'));
    };
    field.oninput=matches;
    body.append(field,results);
    matches();
  });
  $('rider-dialog-body').querySelector('input').focus();
}
function openNotifications() {
  showDialog('Notifications',body=>{
    for(const message of notices) body.append(node('p',message));
    if(!notices.length) body.append(node('p','You’re all caught up.','rider-muted'));
  });
}
function shift() {
  const section=card(state.available?'You’re online':'You’re offline');
  section.classList.add('rider-shift');
  section.toggleAttribute('data-online',state.available);
  const time=node('span',null,'rider-muted');
  time.dataset.shiftTime='';
  const toggle=button(state.available?'Go offline':'Go online',toggleOnline,state.available?'rider-secondary':'clay-button');
  section.append(time,toggle);
  return section;
}
function updateClock() {
  const chip=$('sidebar-shift');
  chip.textContent=state.available?'Shift online':'Shift offline';
  const timer=content.querySelector('[data-shift-time]');
  if(!timer) return;
  const minutes=shiftSince?Math.floor((Date.now()-shiftSince)/60000):0;
  timer.textContent=state.available && shiftSince?Math.floor(minutes/60)+'h '+minutes%60+'m on shift':state.available?'Ready to receive offers':'Go online to receive offers';
}
function deliveriesForPeriod() {
  const range={Today:1,Week:7,Month:30}[period];
  return state.orders.filter(order=>order.status==='delivered' && (!demo || (order.completedAt ? Date.now()-order.completedAt<range*86400000 : true)));
}
function exportDeliveries() {
  const csv=value=>'"'+String(value).replace(/^[=+@\-]/,"'$&").replaceAll('"','""')+'"';
  const rows=[['Order ID','Route','Amount INR','Status'],...deliveriesForPeriod().map(order=>[orderNo(order),demo?'SRM campus':'',(order.payout||0)/100,'Delivered'])];
  const url=URL.createObjectURL(new Blob([rows.map(row=>row.map(csv).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
  const a=link('Download',url);a.download='printbee-deliveries.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function deliveriesTable() {
  const section=card('Recent deliveries');
  const rows=deliveriesForPeriod();
  if(!rows.length) {section.append(node('p','No completed deliveries yet.','rider-content-empty'));return section;}
  const wrapper=node('div',null,'rider-table-wrap');
  wrapper.tabIndex=0;wrapper.setAttribute('role','region');wrapper.setAttribute('aria-label','Recent deliveries table');
  const table=node('table',null,'rider-table');
  const head=node('thead'), header=node('tr');
  for(const title of ['Order ID','Route','Time','Amount','Status']) {
    const cell=node('th',title,title==='Amount'?'numeric':null);cell.scope='col';header.append(cell);
  }
  head.append(header);table.append(head);
  const body=node('tbody');
  for(const order of rows) {
    const row=node('tr');
    [orderNo(order),demo?'SRM campus':'—',order.completedAt?new Date(order.completedAt).toLocaleTimeString('en-IN',{hour:'numeric',minute:'2-digit'}):demo?'10:20 am':'—',money(order.payout)].forEach((value,index)=>row.append(node('td',value,index===3?'numeric':null)));
    const cell=node('td');cell.append(node('span',demo?'Awaiting':'Delivered','clay-badge'));row.append(cell);body.append(row);
  }
  table.append(body);wrapper.append(table);section.append(wrapper);return section;
}
function earningsChart() {
  const section=card(demo?'Earnings trend · sample':'Earnings overview');
  if(!demo) {section.append(node('p',money(state.earnings.lifetime)+' lifetime earnings','rider-content-empty'));return section;}
  const values={Today:[0,24,37,52,50,74,99],Week:[80,96,84,128,151,171,201],Month:[90,170,220,200,340,385,453]}[period];
  const chart=node('div',null,'rider-chart');
  const axes=values.map((value,index)=>[10+index*80,117-value/Math.max(...values)*105]);
  const points=axes.map(pair=>pair.join(',')).join(' ');
  chart.innerHTML='<svg viewBox="0 0 500 124" role="group" aria-label="Sample earnings plot"><path d="M10 32H490M10 72H490M10 117H490" stroke="var(--rider-border)" stroke-dasharray="4 5"/><polygon points="10,117 '+points+' 490,117" fill="currentColor" opacity=".13"/><polyline points="'+points+'" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const svg=chart.querySelector('svg');
  const tip=node('p','Explore the chart points for amounts.');
  axes.forEach(([x,y],index)=>{
    const dot=document.createElementNS(svg.namespaceURI,'circle');
    for(const [name,value] of Object.entries({cx:x,cy:y,r:5,fill:'currentColor',tabindex:'0','aria-label':'Point '+(index+1)+': '+money(values[index]*100)})) dot.setAttribute(name,value);
    const update=()=>{tip.textContent=dot.getAttribute('aria-label');};
    dot.onfocus=dot.onpointerenter=update;
    svg.append(dot);
  });
  chart.append(tip);section.append(chart);return section;
}
function renderEarnings(main,side,heading) {
  const controls=node('div',null,'rider-actions');
  if(demo) {
    const segment=node('div',null,'rider-period');segment.setAttribute('role','group');segment.setAttribute('aria-label','Earnings period');
    for(const name of ['Today','Week','Month']) {
      const control=button(name,()=>{period=name;render();content.querySelector('[aria-pressed=true]')?.focus();},'rider-secondary');
      control.setAttribute('aria-pressed',String(name===period));segment.append(control);
    }
    controls.append(segment);
  }
  controls.append(button('Export CSV',exportDeliveries,'rider-secondary'));heading.append(controls);
  main.append(earningsChart(),deliveriesTable());
  const settlement=card('Settlement');
  settlement.append(node('strong',money(state.earnings.outstanding)),node('p','Awaiting settlement','rider-muted'));
  if(demo) {
    const bar=node('progress');bar.value=state.earnings.outstanding/100;bar.max=Math.max(100,bar.value);bar.setAttribute('aria-label','Sample balance toward ₹100 payout');
    settlement.append(bar,node('p','Sample payout schedule · Friday'),button('Request payout',()=>notify('Sample payout request recorded for this session.'),'rider-secondary'));
    const incentive=card('Delivery streak');
    const progress=node('progress');progress.value=Math.min(5,state.orders.filter(o=>o.status==='delivered').length);progress.max=5;progress.setAttribute('aria-label','Sample deliveries toward a five-delivery goal');
    incentive.append(progress,node('p',progress.value+' of 5 deliveries toward the sample bonus.','rider-muted'));
    side.append(settlement,incentive);
  } else side.append(settlement);
}
function renderProfile(main,side) {
  const identity=card(demo?profile.name:'Partner account');
  identity.classList.add('rider-identity');
  const image=node('img');image.src='/printbee-header-bee.webp';image.alt='';image.width=64;image.height=51;
  identity.prepend(image);
  identity.append(node('p',demo?'Partner PB-R104 · 4.9 rating':'Delivery partner'));
  if(demo) identity.append(node('span','Sample identity verified','clay-badge'),node('p',profile.vehicle));
  identity.append(node('p'),link(demo?'Live partner sign-in':'Email PrintBee support',demo?'/partner':'mailto:printbee.co.in@gmail.com'));
  side.append(identity);
  const info=card('Account settings');
  if(demo) {
    const form=node('form',null,'rider-profile-form');
    for(const [key,title] of [['name','Display name'],['vehicle','Vehicle'],['payout','Payout account'],['language','Language']]) {
      const label=node('label',title),input=node('input',null,'clay-input');
      input.name=key;input.value=profile[key];input.required=true;input.maxLength=80;label.append(input);form.append(label);
    }
    const label=node('label','Delivery notifications');
    const checkbox=node('input');checkbox.type='checkbox';checkbox.name='alerts';checkbox.checked=profile.alerts;label.append(checkbox);form.append(label);
    const saveButton=node('button','Save sample profile','clay-button');saveButton.hidden=true;
    const payload=()=>Object.fromEntries([...new FormData(form)].filter(([key])=>key!=='alerts'));
    form.oninput=()=>{saveButton.hidden=JSON.stringify({...payload(),alerts:checkbox.checked})===JSON.stringify(profile);};
    form.onsubmit=event=>{
      event.preventDefault();
      const updated=payload();
      for(const key of Object.keys(updated)) updated[key]=updated[key].trim();
      if(Object.values(updated).some(value=>!value)) {status.textContent='Complete each field before saving.';return;}
      profile={...updated,alerts:checkbox.checked};save('printbee-rider-profile',JSON.stringify(profile));render();notify('Sample profile saved.');
    };
    form.append(saveButton);info.append(form);
    const docs=card('Vehicle documents');docs.append(node('p','Sample driving licence and vehicle record · Verified'),button('Reset sample deliveries',()=>{state=seed();shiftSince=null;skipped.clear();completed=null;tab='Cockpit';changed();},'rider-secondary'));
    main.append(info,docs);
  } else {
    info.append(node('p','Manage account and payout details through PrintBee support.','rider-muted'));
    if(active()) info.append(button(state.available?'Go offline':'Go online',toggleOnline,'rider-secondary'));
    main.append(info,stats());
  }
}
function render() {
  for(const control of $('rider-nav').children) {
    if(control.dataset.section===tab) control.setAttribute('aria-current','page');
    else control.removeAttribute('aria-current');
  }
  $('rider-current').textContent=tab;
  const order=active(), head=node('div',null,'rider-card-head rider-page-head');
  const title=node('div');
  title.append(node('h1',tab==='Cockpit'?'Delivery cockpit':tab));
  if(tab==='Cockpit') title.append(node('p',demo?'Welcome, '+profile.name.split(' ')[0]+'.':'Manage deliveries for your shift.'));
  head.append(title);
  const layout=node('div',null,'rider-layout'), stack=node('div',null,'rider-stack'), side=node('div',null,'rider-stack rider-aside');
  if(tab!==lastTab) layout.classList.add('rider-enter');
  lastTab=tab;
  if(tab==='Cockpit') {
    layout.classList.add('rider-cockpit');
    stack.append(shift(),stats());
    if(completed) stack.append(success());
    else if(order) stack.append(activeDelivery(order));
    else stack.append(availableOrders());
    layout.append(stack,routePanel(order));
  } else if(tab==='Earnings') {
    renderEarnings(stack,side,head);layout.append(stack,side);
  } else {
    renderProfile(stack,side);layout.append(side,stack);
  }
  content.replaceChildren(head,layout);updateClock();
}
function night(enabled) {
  document.body.classList.toggle('rider-night',enabled);
  $('night-mode').setAttribute('aria-pressed',String(enabled));
}
night(saved('printbee-rider-night')==='1');
$('night-mode').replaceChildren(symbol('moon'));
const collapse=$('rider-collapse');
function sidebar(compact) {
  document.querySelector('.rider-frame').classList.toggle('rider-compact',compact);
  collapse.setAttribute('aria-expanded',String(!compact));
  collapse.setAttribute('aria-label',compact?'Expand sidebar':'Collapse sidebar');
  collapse.textContent=compact?'›':'‹';
}
sidebar(saved('printbee-rider-rail')==='1');
collapse.onclick=()=>{
  const compact=collapse.getAttribute('aria-expanded')==='true';
  sidebar(compact);save('printbee-rider-rail',compact?'1':'0');
};
$('night-mode').onclick=()=>{
  const enabled=$('night-mode').getAttribute('aria-pressed')!=='true';
  night(enabled);save('printbee-rider-night',enabled?'1':'0');
};
async function init() {
  $('rider-app').hidden=false;
  content.tabIndex=-1;
  for(const name of ['Cockpit','Earnings','Profile']) {
    const control=button('',()=>selectTab(name),'rider-secondary rider-tab');
    control.dataset.section=name;control.setAttribute('aria-label',name);
    control.append(symbol(name),node('span',name));$('rider-nav').append(control);
  }
  for(const id of ['rider-nav','sidebar-shift','rider-search','rider-notifications','rider-avatar']) $(id).hidden=false;
  $('rider-search').replaceChildren(symbol('search'));
  $('rider-notifications').replaceChildren(symbol('bell'));
  $('rider-search').onclick=openSearch;
  $('rider-notifications').onclick=openNotifications;
  $('rider-avatar').onclick=()=>showDialog('Partner account',body=>body.append(button('Open profile',()=>selectTab('Profile'),'rider-secondary')));
  document.addEventListener('keydown',event=>{
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k') {event.preventDefault();openSearch();}
  });
  setInterval(updateClock,30000);
  if(demo) {render();return;}
  function poll() {
    if(!busy) refresh().catch(()=>{});
    sendLocation();
  }
  window.addEventListener('online',poll);
  window.addEventListener('offline',()=>{$('network').hidden=false;});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){poll();keepAwake();}});
  try {await refresh();} finally {interval=setInterval(poll,5000);}
}
if(demo) {
  $('portal-login').hidden=true;
  $('preview-chip').hidden=false;
  init();
  if('serviceWorker' in navigator) navigator.serviceWorker.register('/partner-sw.js').catch(()=>{});
} else {
  connectPortal('partner',status,init,()=>{clearInterval(interval);stopLocation();});
  $('phone-login').onsubmit=event=>{
    event.preventDefault();
    const form=event.currentTarget, control=form.querySelector('button');
    run(async()=>{
      const code=$('login-code'), phone=form.elements.phone.value.trim();
      if(code.hidden) {
        await request('/api/partner/auth/send',{phone});
        code.hidden=false;form.elements.code.required=true;
        form.elements.phone.readOnly=true;
        control.textContent='Verify code';form.elements.code.focus();
      } else {
        await request('/api/partner/auth/check',{phone,code:form.elements.code.value.trim()});
        location.reload();
      }
    },control);
  };
}
