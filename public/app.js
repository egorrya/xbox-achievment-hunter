const $ = s => document.querySelector(s);
let games = [], selected, achievements = [], entries = [], job = { status: 'idle' };
let gamesLoading = null, historyLoading = false, actionLoading = false, polling = false, gameRequest = 0;
const totals = new Map(), totalsPending = new Set(), totalsQueue = [], achievementRequests = new Map();
let totalsActive = 0, gameObserver, titleBased = null;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const attr = esc;
const field = (obj, ...names) => names.map(n => obj?.[n]).find(v => v !== undefined && v !== null);
const error = e => { $('#alert').hidden = false; $('#alert').textContent = e.message || String(e); };
async function api(path, options = {}) { try { const r = await fetch(path, { ...options, signal: options.signal || AbortSignal.timeout(25000) }); const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Request failed'); return data; } catch(e) { if (e.name === 'TimeoutError') throw new Error('The request timed out. Please try again.'); throw e; } }
const post = path => api(path, {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
function page(name) { for (const el of document.querySelectorAll('.page')) el.hidden = el.id !== name; document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.page === name || (name === 'game' && b.dataset.page === 'games'))); $('#alert').hidden = true; window.scrollTo(0,0); }
function navigate(path) { if (location.pathname !== path) history.pushState(null, '', path); showRoute(); }
let routeRequest = 0, actionVersion = 0, uncertainShown = null;
async function showRoute() {
  const request = ++routeRequest;
  const match = location.pathname.match(/^\/games(?:\/(\d+))?\/?$/);
  if (!match) { ++gameRequest; page('profile'); return; }
  if (!match[1]) { ++gameRequest; page('games'); await loadGames(); return; }
  if (!games.length) { page('games'); await loadGames(); }
  if (request !== routeRequest) return;
  let game = games.find(g => String(field(g,'TitleId','titleId')) === match[1]);
  if (!game) {
    page('games'); $('#gameCount').textContent='Looking up Title ID…';
    try {
      const result=await api('/api/game?title='+encodeURIComponent(match[1]));
      if(request!==routeRequest)return;
      const titles=field(result,'Titles','titles');
      game=Array.isArray(titles) ? titles.find(g=>String(field(g,'TitleId','titleId'))===match[1]) : null;
      if (!game) throw new Error('XAU could not find a game with this Title ID.');
    } catch(e) { if(request===routeRequest){renderGames();error(e)} return; }
    renderGames();
  }
  openGame(game);
}
window.addEventListener('popstate', showRoute);
document.querySelectorAll('nav button').forEach(b => b.onclick = () => navigate(b.dataset.page === 'games' ? '/games' : '/'));
$('#goGames').onclick = () => navigate('/games'); $('#back').onclick = () => navigate('/games');
$('#titleForm').onsubmit = event => { event.preventDefault(); const title=$('#titleInput').value.trim(); if(!/^\d+$/.test(title)){error(new Error('Enter a numeric Title ID.'));return;} navigate('/games/'+title); };
async function profile() { try {const data = await api('/api/profile'); const p = field(data,'People','people')?.[0] || data; const name = field(p,'UniqueModernGamertag','Gamertag','gamertag','DisplayName') || 'Player'; const image = field(p,'DisplayPicRaw','displayPicRaw'); $('#profileCard').innerHTML = `<div class="profile-card">${image ? `<img class="avatar" src="${attr(image)}" alt="">` : '<div class="avatar"></div>'}<div><div class="eyebrow">XBOX ACCOUNT</div><h2>${esc(name)}</h2><div class="muted">${esc(field(p,'GamerScore','gamerScore') || '0')} gamerscore &nbsp; · &nbsp; XUID ${esc(field(p,'Xuid','xuid') || '—')}</div></div></div>`; $('#connection').textContent='● XAU connected';} catch(e) {$('#profileCard').textContent='Could not load the profile.'; $('#connection').textContent='● XAU unavailable'; error(e);} }
async function loadGames() {if(gamesLoading)return gamesLoading;$('#gameCount').textContent='Loading…';gamesLoading=(async()=>{try {const data=await api('/api/games'); games=field(data,'Titles','titles') || []; renderGames();}catch(e){$('#gameCount').textContent='Loading failed';error(e)}finally{gamesLoading=null;}})();return gamesLoading;}
function gameTotal(game) {
  const a=field(game,'Achievement','achievement')||{};
  const current=Number(field(a,'CurrentAchievements','currentAchievements')||0);
  const supplied=Number(field(a,'TotalAchievements','totalAchievements'));
  const cached=totals.get(String(field(game,'TitleId','titleId')));
  if(cached !== undefined) return cached;
  return Number.isFinite(supplied) && supplied > 0 && supplied >= current ? supplied : null;
}
function updateTotal(title, total) {
  totals.set(title,total);
  document.querySelectorAll('.game-card').forEach(card=>{
    if(card.dataset.title===title) {const totalNode=card.querySelector('.total-count');totalNode.textContent=total===null?'':` / ${total}`;}
  });
}
function queueTotal(title) {
  if(!/^\d+$/.test(title)||totals.has(title)||totalsPending.has(title)) return;
  totalsPending.add(title);totalsQueue.push(title);loadTotals();
}
function fetchAchievements(title) {
  title=String(title);
  if(!achievementRequests.has(title)) {
    const request=api('/api/achievements?title='+encodeURIComponent(title)).finally(()=>achievementRequests.delete(title));
    achievementRequests.set(title,request);
  }
  return achievementRequests.get(title);
}
function loadTotals() {
  while(totalsActive<2 && totalsQueue.length){
    const title=totalsQueue.shift();if(totals.has(title)){totalsPending.delete(title);continue;}totalsActive++;
    fetchAchievements(title).then(data=>{
      const list=field(data,'achievements','Achievements');
      if(!Array.isArray(list)) throw new Error('Invalid achievement list');
      updateTotal(title,list.length);
    }).catch(()=>updateTotal(title,null)).finally(()=>{totalsActive--;totalsPending.delete(title);loadTotals()});
  }
}
function renderGames(){
  const term=$('#search').value.toLowerCase();const list=games.filter(g=>String(field(g,'Name','name')).toLowerCase().includes(term));
  $('#gameCount').textContent=`${list.length} games`;
  $('#gameList').innerHTML=list.map((g,i)=>{
    const a=field(g,'Achievement','achievement')||{};const img=field(g,'DisplayImage','displayImage');
    const title=String(field(g,'TitleId','titleId')||'');const total=gameTotal(g);
    return `<button class="game-card" data-i="${i}" data-title="${attr(title)}">${img?`<img class="cover" src="${attr(img)}" alt="">`:'<div class="cover"></div>'}<div class="game-content"><h3>${esc(field(g,'Name','name'))}</h3><div class="game-progress"><span class="muted">${esc(field(a,'CurrentAchievements','currentAchievements')||0)}<span class="total-count">${total===null?'':` / ${total}`}</span> achievements</span><span class="game-arrow" aria-hidden="true">→</span></div></div></button>`;
  }).join('') || '<p class="muted">No games found.</p>';
  gameObserver?.disconnect();
  if('IntersectionObserver' in window) gameObserver=new IntersectionObserver(items=>items.forEach(item=>{if(item.isIntersecting){queueTotal(item.target.dataset.title);gameObserver.unobserve(item.target)}}),{rootMargin:'300px'});
  $('#gameList').querySelectorAll('button').forEach(b=>{
    const game=list[Number(b.dataset.i)];b.onclick=()=>navigate('/games/'+encodeURIComponent(String(field(game,'TitleId','titleId'))));
    if(gameTotal(game)===null&&!totals.has(b.dataset.title)){if(gameObserver)gameObserver.observe(b);else queueTotal(b.dataset.title)}
  });
}
$('#search').oninput=renderGames;
async function openGame(game){const request=++gameRequest;selected=game;titleBased=null;achievements=[];entries=[];historyMessage('');$('#titleBasedStatus').textContent='Checking title-based support…';$('#selectionControls').hidden=true;$('#historyInfo').textContent='';$('#historyList').innerHTML='';$('#tag').value='';$('#start').disabled=true;const name=field(game,'Name','name'), title=field(game,'TitleId','titleId');page('game');$('#gameHead').innerHTML=`<div class="eyebrow">GAME / ${esc(title)}</div><h1>${esc(name)}<span>.</span></h1>`;$('#taLink').href='https://www.trueachievements.com/searchresults.aspx?search='+encodeURIComponent(name);$('#achievementList').innerHTML='<p class="muted">Loading…</p>';checkTitleBased(title,request);try{const data=await fetchAchievements(title);if(request!==gameRequest)return;achievements=field(data,'achievements','Achievements')||[];if(Array.isArray(achievements))updateTotal(String(title),achievements.length);$('#achievementCount').textContent=achievements.length+' total';$('#achievementList').innerHTML=achievements.map(a=>{const image=a.mediaAssets?.[0]?.url;const unlocked=isUnlocked(a);return `<div class="achievement ${unlocked?'is-unlocked':'is-locked'}">${image?`<img src="${attr(image)}" alt="">`:'<div class="avatar" style="width:55px;height:55px;border-radius:8px;flex:none"></div>'}<div><strong>${esc(a.name)}</strong><span class="muted">${esc(a.description||a.lockedDescription||'')}</span></div><span class="achievement-status" aria-label="${unlocked?'Unlocked':'Locked'}" title="${unlocked?'Unlocked':'Locked'}"><span aria-hidden="true">${unlocked?'✓':'○'}</span><span>${unlocked?'Unlocked':'Locked'}</span></span></div>`}).join('')||'<p class="muted">No achievements found.</p>';}catch(e){if(request===gameRequest){$('#achievementList').innerHTML='<p class="muted">Could not load achievements.</p>';error(e)}}}
async function checkTitleBased(title,request){
  try {const result=await api('/api/title-based?title='+encodeURIComponent(title));if(request!==gameRequest)return;titleBased=result.titleBased;$('#titleBasedStatus').textContent=titleBased===true?'Title Based: yes':titleBased===false?'Title Based: no — copying unavailable':'Title Based: unknown — copying unavailable';}
  catch(e){if(request!==gameRequest)return;titleBased=null;$('#titleBasedStatus').textContent='Could not check title-based support — copying unavailable';error(e)}
  if(entries.length)renderHistory();
}
function historyMessage(message, isError=false){const el=$('#historyMessage');el.textContent=message;el.hidden=!message;el.classList.toggle('is-error',isError);}
function clearHistory(){historyMessage('');entries=[];$('#historyInfo').textContent='';$('#historyList').innerHTML='';$('#selectionControls').hidden=true;$('#start').disabled=true;}
function isUnlocked(a){return String(a.progressState||'').toLowerCase()==='achieved'||(!a.progressState&&Boolean(a.timeUnlocked)&&Date.parse(a.timeUnlocked)>0);}
function selectionKey(){return 'xau-selection:'+String(field(selected,'TitleId','titleId'));}
function savedSelection(){try{return JSON.parse(localStorage.getItem(selectionKey())||'{}')}catch{return {}}}
function saveSelection(){try{const choices=savedSelection();for(const entry of entries)choices[entry.id]=entry.selected;localStorage.setItem(selectionKey(),JSON.stringify(choices))}catch{}}
function prepare(rows){clearHistory();const index=new Map();for(const a of achievements){const n=String(a.name||'').trim().toLocaleLowerCase();if(index.has(n)) index.set(n,null);else index.set(n,a);}let problems=[];entries=rows.map(row=>{const a=row.id != null ? achievements.find(item=>String(item.id)===String(row.id)) : index.get(row.name.trim().toLocaleLowerCase());if(!a){problems.push(row.name);return null;}if(!Number.isFinite(Date.parse(row.time))){problems.push(row.name+' (invalid timestamp)');return null;}return {id:String(a.id),name:a.name,time:new Date(row.time).toISOString(),alreadyUnlocked:isUnlocked(a)};}).filter(Boolean).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));if(problems.length){entries=[];throw new Error('Could not match or read the timestamp for: '+problems.slice(0,8).join(', '));}if(!entries.length)throw new Error('The history is empty.');if(new Set(entries.map(x=>x.id)).size!==entries.length){entries=[];throw new Error('The history contains duplicate achievements.');}const saved=savedSelection();entries=entries.map(x=>({...x,selected:typeof saved[x.id]==='boolean'?saved[x.id]:!x.alreadyUnlocked}));$('#selectionControls').hidden=false;renderHistory();}
function renderHistory(){const count=entries.filter(x=>x.selected).length;$('#historyInfo').textContent=`Selected ${count} of ${entries.length}. The first is sent immediately; intervals between selected achievements are preserved.`;$('#historyList').innerHTML=entries.map((x,i)=>`<label class="history-item"><input type="checkbox" data-i="${i}" ${x.selected?'checked':''}><span>${esc(x.name)} <span class="muted">· ${esc(new Date(x.time).toLocaleString())}${x.alreadyUnlocked?' · already unlocked':''}</span></span></label>`).join('');$('#historyList').querySelectorAll('input').forEach(box=>box.onchange=()=>{entries[Number(box.dataset.i)].selected=box.checked;saveSelection();renderHistory()});$('#start').disabled=!count||actionLoading||titleBased!==true;}
$('#tag').addEventListener('input',()=>{if(entries.length)clearHistory()});
$('#selectAll').onclick=()=>{entries.forEach(x=>x.selected=true);saveSelection();renderHistory()};
$('#selectNone').onclick=()=>{entries.forEach(x=>x.selected=false);saveSelection();renderHistory()};
$('#importHistory').onclick=()=>{if(historyLoading)return;try{prepare($('#manual').value.split(/\r?\n/).filter(x=>x.trim()).map(line=>{const [name,time]=line.split('\t');return{name:name||'',time:time||''}}));}catch(e){$('#start').disabled=true;historyMessage(e.message||String(e),true)}};
$('#loadHistory').onclick=async()=>{
  if(historyLoading)return;
  historyLoading=true;const request=gameRequest;clearHistory();
  try{
    if(!achievements.length)throw new Error('Wait for the game’s achievements to load.');
    const tag=$('#tag').value.trim();if(!tag)throw new Error('Enter the player’s gamertag.');
    $('#loadHistory').disabled=true;$('#loadHistory').textContent='Loading…';historyMessage('Loading the player’s Xbox history…');
    const title=String(field(selected,'TitleId','titleId'));
    const result=await api('/api/history?'+new URLSearchParams({title,tag}),{signal:AbortSignal.timeout(120000)});
    if(request===gameRequest)prepare(result.entries);
  }catch(e){if(request===gameRequest){$('#start').disabled=true;historyMessage(e.message||'Loading failed',true)}}
  finally{historyLoading=false;$('#loadHistory').disabled=false;$('#loadHistory').textContent='Load history'}
};
$('#start').onclick=async()=>{if(actionLoading||titleBased!==true)return;const chosen=entries.filter(x=>x.selected);if(!chosen.length)return;actionLoading=true;actionVersion++;$('#start').disabled=true;try{job=await api('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({titleId:String(field(selected,'TitleId','titleId')),game:field(selected,'Name','name'),tag:$('#tag').value,entries:chosen}),signal:AbortSignal.timeout(50000)});renderStatus();}catch(e){historyMessage(e.message||String(e),true)}finally{actionLoading=false;renderHistory()}};
for(const action of ['pause','resume','reset'])$('#'+action).onclick=async()=>{if(actionLoading)return;actionLoading=true;actionVersion++;$('#'+action).disabled=true;try{if(action==='resume'&&job.uncertainId){const result=await api('/api/uncertain',{signal:AbortSignal.timeout(45000)});uncertainShown=result.id;$('#uncertainStatus').textContent=`XAU status: ${result.progress==='achieved'?'unlocked':'not yet unlocked'}. Choose how to continue.`;$('#uncertain').hidden=false;}else{job=await post('/api/'+action);uncertainShown=null;renderStatus()}}catch(e){$('#status').textContent=e.message||String(e)}finally{actionLoading=false;$('#'+action).disabled=false}};
for(const [button,choice] of [['skipUncertain','skip'],['retryUncertain','retry']])$('#'+button).onclick=async()=>{if(actionLoading||!uncertainShown)return;actionLoading=true;actionVersion++;$('#skipUncertain').disabled=$('#retryUncertain').disabled=true;try{job=await api('/api/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({choice,id:uncertainShown}),signal:AbortSignal.timeout(45000)});uncertainShown=null;renderStatus()}catch(e){$('#uncertainStatus').textContent=e.message||String(e)}finally{actionLoading=false;$('#skipUncertain').disabled=$('#retryUncertain').disabled=false}};

function duration(ms){let n=Math.ceil(Math.max(0,ms)/1000),d=Math.floor(n/86400);n%=86400;return `${d?d+'d ':''}${String(Math.floor(n/3600)).padStart(2,'0')}:${String(Math.floor(n%3600/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;}
function renderStatus(){
  const labels={idle:'No active queue',running:'Copying in progress',paused:'Paused',completed:'Copying complete'};
  let text=labels[job.status]||job.status;
  if(job.entries){
    text+=`<p>${esc(job.game)} · ${esc(job.tag)}<br>Processed: ${job.index} of ${job.entries.length}</p>`;
    if(job.status==='running'||job.status==='paused'){
      const remaining=job.status==='paused'?job.remaining:job.dueAt-Date.now();
      let estimate=Math.max(0,remaining||0);
      for(let i=job.index+1;i<job.entries.length;i++)estimate+=Math.max(60000,Date.parse(job.entries[i].time)-Date.parse(job.entries[i-1].time));
      text+=`<p>Next: ${esc(job.entries[job.index]?.name||'—')}<br>Time remaining: ${duration(remaining||0)}<br>Estimated time to finish: ${duration(estimate)}${job.status==='running'?` · ${esc(new Date(Date.now()+estimate).toLocaleString())}`:''}</p>`;
    }
    text+='<p>Unlock requests are at least 60 seconds apart. Shorter original intervals may take longer.</p>';
  }
  if(job.error)text+=`<p>${esc(job.error)}</p>`;$('#status').innerHTML=text;
  $('#pause').hidden=job.status!=='running';$('#resume').hidden=job.status!=='paused';$('#reset').hidden=job.status==='idle'||job.status==='running';
  if(!job.uncertainId||uncertainShown!==job.uncertainId)$('#uncertain').hidden=true;
  $('#queueDetails').hidden=!job.entries?.length;$('#logDetails').hidden=!job.log?.length;
  $('#queueList').innerHTML=(job.entries||[]).map((item,i)=>{const gap=i?Date.parse(item.time)-Date.parse(job.entries[i-1].time):0;const status=i<job.index?({'sent':'sent','already':'already unlocked','skipped':'skipped'}[job.results?.[item.id]]||'processed'):i===job.index&&job.status!=='completed'?'next':'pending';return `<div class="queue-row"><strong>${i+1}. ${esc(item.name)}</strong><span>${esc(status)} · ${esc(new Date(item.time).toLocaleString())} · interval ${duration(gap)}</span></div>`}).join('');
  $('#queueLog').innerHTML=(job.log||[]).slice().reverse().map(row=>`<div class="queue-row"><span>${esc(new Date(row.time).toLocaleString())} · ${esc(row.message)}</span></div>`).join('');
}
async function poll(){if(polling||actionLoading)return;polling=true;const version=actionVersion;try{const next=await api('/api/state');if(!actionLoading&&version===actionVersion){job=next;renderStatus()}}catch(e){$('#status').textContent='Cannot connect to the app. Queue status is unknown.'}finally{polling=false}}setInterval(poll,1000);showRoute();profile();poll();

// Each tab has its own lease. A short grace period on the server allows reloads.
const clientId = crypto.randomUUID();
function clientHeartbeat(){fetch('/api/client/heartbeat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:clientId}),keepalive:true}).catch(()=>{});}
clientHeartbeat();
setInterval(clientHeartbeat, 20000);
window.addEventListener('pageshow',clientHeartbeat);
window.addEventListener('pagehide',()=>navigator.sendBeacon('/api/client/close',new Blob([JSON.stringify({id:clientId})],{type:'application/json'})));
