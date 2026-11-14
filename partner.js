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
      status.textContent='New delivery available.';
      navigator.vibrate?.(70);
    }
    offerIds=nextOffers;
    const updated=JSON.stringify(state)!==JSON.stringify(data);
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
  if(demo) {state.available=next;changed();return;}
  if(next) {
    if(!navigator.geolocation) throw new Error('Location is unavailable on this device.');
    await new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,
      ()=>reject(new Error('Allow location access before going online.')),{maximumAge:15000,timeout:12000}));
  }
  await request('/api/partner/availability',{available:next});
  await refresh();
}
function stats() {
  const section=card(demo?'Today · sample':'Earnings');
  const grid=node('div',null,'rider-metrics');
  for(const [label,value] of [[demo?'Earned today':'Lifetime earned',money(state.earnings.lifetime)],['Awaiting settlement',money(state.earnings.outstanding)],['Completed deliveries',state.orders.filter(o=>o.status==='delivered').length],...(demo?[['Rating','4.9 / 5']]:[])]) {
    const cell=node('div');cell.append(node('strong',value),node('span',label,'rider-muted'));grid.append(cell);
  }
  section.append(grid);return section;
}
function routePanel(order) {
  const section=card(demo?'Route preview':'Directions');
  section.classList.add('rider-map');
  if(demo) {
    const drawing=node('div');
    drawing.innerHTML='<svg viewBox="0 0 440 290" role="img" aria-label="Illustrated campus delivery route"><rect width="440" height="290" fill="#ede4cc"/><path d="M0 175 146 160 272 220 440 180M0 81 155 60 278 100 440 57M95 0l31 290M350 0l-29 290M0 249l440 7" stroke="#fffaf0" stroke-width="18" fill="none"/><path d="M90 215 142 200 187 167 240 151 305 100 360 79" fill="none" stroke="#9f710d" stroke-width="8" stroke-linecap="round"/><circle cx="90" cy="215" r="9" fill="#865b12"/><circle cx="360" cy="79" r="11" fill="#ffc83d" stroke="#865b12" stroke-width="3"/><circle class="route-dot" cx="162" cy="185" r="9" fill="#ffc83d" stroke="#513408" stroke-width="3"/></svg>';
    section.append(drawing,node('p','SRM campus · Illustrative route','rider-muted'));
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
  if(state.available) for(const order of offers()) {
    const tile=node('article',null,'rider-order');
    tile.append(node('h3',orderNo(order)),node('strong',money(order.payout)+' payout'),node('p',order.summary,'rider-muted'));
    if(order.urgent) tile.append(node('span','Urgent','clay-badge'));
    tile.append(button('Accept delivery',async()=>{
      if(active()) throw new Error('Finish your current delivery first.');
      if(demo) {order.partner='sample';state.step=0;state.failures=0;state.unlock=0;changed();}
      else {await orderAction(order,'accept');await refresh();}
      status.textContent='Delivery accepted.';
    }));
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
      status.textContent='Pickup confirmed.';
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
        order.status='delivered';state.earnings.lifetime+=order.payout;state.earnings.outstanding+=order.payout;
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
function render() {
  for(const control of $('rider-nav').children) {
    if(control.textContent===tab) control.setAttribute('aria-current','page');
    else control.removeAttribute('aria-current');
  }
  const order=active();
  const layout=node('div',null,'rider-layout'), stack=node('div',null,'rider-stack');
  const title=node('h1',tab==='Cockpit'?'Delivery cockpit':tab);
  if(tab==='Cockpit') {
    if(completed) stack.append(success());
    else if(order) stack.append(activeDelivery(order));
    else {
      const online=card(state.available?'You’re online':'You’re offline');
      online.append(mainAction(state.available?'Go offline':'Go online',toggleOnline));
      stack.append(online,stats(),availableOrders());
    }
    layout.append(stack,routePanel(order));
  } else if(tab==='Earnings') {
    const history=card('Recent deliveries');
    for(const order of state.orders.filter(o=>o.status==='delivered')) history.append(node('p',orderNo(order)+' · '+money(order.payout)));
    if(history.children.length===1) history.append(node('p','No completed deliveries yet.','rider-muted'));
    stack.append(stats(),history);layout.append(stack);
  } else {
    const profile=card(demo?'Sample rider':'Partner account');
    profile.append(node('p',demo?'Approved · Demo workspace':'Support','rider-muted'),
      link(demo?'Live partner sign-in':'Email PrintBee support',demo?'/partner':'mailto:printbee.co.in@gmail.com'));
    if(demo) profile.append(mainAction('Reset sample deliveries',()=>{state=seed();completed=null;tab='Cockpit';changed();}));
    else if(order) profile.append(mainAction(state.available?'Go offline':'Go online',toggleOnline));
    stack.append(profile);layout.append(stack);
  }
  content.replaceChildren(title,layout);
}
function night(enabled) {
  document.body.classList.toggle('rider-night',enabled);
  $('night-mode').setAttribute('aria-pressed',String(enabled));
}
night(saved('printbee-rider-night')==='1');
$('night-mode').onclick=()=>{
  const enabled=$('night-mode').getAttribute('aria-pressed')!=='true';
  night(enabled);save('printbee-rider-night',enabled?'1':'0');
};
async function init() {
  $('rider-app').hidden=false;
  content.tabIndex=-1;
  for(const name of ['Cockpit','Earnings','Profile']) $('rider-nav').append(button(name,()=>{
    tab=name;render();content.focus({preventScroll:true});
  },'rider-secondary'));
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
