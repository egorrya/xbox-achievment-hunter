import { initSpoofPanel } from './spoof-panel.js';
import { showNotification } from './notification.js';
import { setReferenceStep } from './reference-flow.js';
import { initStatsPanel } from './stats-panel.js';
import { planSelected, MIN_INTERVAL_MS, formatDuration as duration } from './timing.js';
import { linkedSteamProfile, parseSteamProfile, parseSteamAchievements, matchSteamAchievements, matchingSteamGame } from './steam.js';
const $ = s => document.querySelector(s);
let games = [], selected, achievements = [], entries = [], job = { status: 'idle' };
let accountGeneration = 0, activeAccount = null;
let gamesLoading = null, historyLoading = false, actionLoading = false, polling = false, gameRequest = 0, referenceSession = 0;
let firstDelayMs = 0, singleUnlocking = false;
const pendingUnlocks = new Set();
const totals = new Map(), totalsPending = new Set(), totalsQueue = [], achievementRequests = new Map();
let achievementChain = Promise.resolve(), achievementNextAt = 0;
let totalsActive = 0, totalsLastRequest = 0, gameObserver, titleBased = null, titleCatalog = null;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const attr = esc;
const field = (obj, ...names) => names.map(n => obj?.[n]).find(v => v !== undefined && v !== null);
const error = e => showNotification($('#alert'),e.message || String(e));
async function api(path, options = {}) { try { const r = await fetch(path, { ...options, signal: options.signal || AbortSignal.timeout(25000) }); const data = await r.json(); if (!r.ok) {const failure=new Error(data.error || 'Request failed');failure.status=r.status;failure.retryAfter=data.retryAfter;throw failure;} return data; } catch(e) { if (e.name === 'TimeoutError') throw new Error('The request timed out. Please try again.'); throw e; } }
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
function loading(el, active){el.classList.toggle('is-loading',active);if(active)el.setAttribute('aria-busy','true');else el.removeAttribute('aria-busy');}
// The desktop server changes port on each launch, so browser localStorage cannot persist these settings.
let storedSettings = {};
try { storedSettings = await api('/api/settings'); } catch (e) { error(new Error('Could not load saved settings.')); }
try { const result=await api('/api/startup-warnings'); if(result.warnings?.length)showNotification($('#startupWarning'),result.warnings.join(' ')); } catch {}
let settingsQueue = Promise.resolve();
const persistentStorage = {
  getItem(key) { return storedSettings[key] ?? null; },
  setItem(key, value) {
    storedSettings[key] = value;
    settingsQueue = settingsQueue.catch(() => {}).then(() => fetch('/api/settings', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({key,value}), keepalive:true}))
      .then(response => { if (!response.ok) throw new Error('Could not save settings.'); })
      .catch(() => error(new Error('Could not save settings.')));
  },
};
let steamProfile=null, steamSearchRequest=0, steamLinkRequest=0, steamLinkStatus='checking';
function renderSteamProfile(){
  const messages={checking:'Checking linked Steam account…',unlinked:'No Steam account is linked to this Xbox profile.',unavailable:'Xbox did not provide a usable link for the linked Steam account.',private:'The linked Steam profile is private or unavailable.',available:`Linked Steam profile: ${steamProfile?.name||''}`};
  $('#steamReferenceProfile').textContent=messages[steamLinkStatus]||messages.unavailable;
  $('#refreshSteamLink').hidden=steamLinkStatus==='checking'||steamLinkStatus==='available';
  $('#steamOffer').hidden=steamLinkStatus!=='available';
}
async function updateLinkedSteam(person,account){
  const request=++steamLinkRequest,link=linkedSteamProfile(person),previous=steamProfile;
  steamProfile=null;steamLinkStatus=link.status==='linked'?'checking':link.status;renderSteamProfile();
  if(link.status!=='linked'){if(previous&&$('#referenceSource').value==='steam'){referenceSession++;clearHistory();}return;}
  try {
    const response=await api('/api/steam/profile?'+new URLSearchParams({url:link.url}));const verified=parseSteamProfile(response.xml);
    if(request!==steamLinkRequest||profileAccount!==account)return;
    steamProfile={url:link.url,...verified};steamLinkStatus='available';
    const key='steam-profile:'+account,value=JSON.stringify(steamProfile);try{localStorage.setItem(key,value);persistentStorage.setItem(key,value);}catch{}
    if(previous&&(previous.url!==steamProfile.url||previous.steamId!==steamProfile.steamId)&&$('#referenceSource').value==='steam'){referenceSession++;clearHistory();}
  } catch {if(request!==steamLinkRequest||profileAccount!==account)return;steamLinkStatus='private';if(previous&&$('#referenceSource').value==='steam'){referenceSession++;clearHistory();}}
  renderSteamProfile();
}
renderSteamProfile();
$('#refreshSteamLink').onclick=async()=>{const button=$('#refreshSteamLink');if(button.disabled)return;button.disabled=true;loading(button,true);try{await post('/api/cache/refresh');await profile();}catch(e){error(e)}finally{button.disabled=false;loading(button,false);}};
const post = path => api(path, {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
function page(name) { for (const el of document.querySelectorAll('.page')) el.hidden = el.id !== name; document.querySelectorAll('.main-nav a').forEach(link => { const active=link.dataset.page === name || (name === 'game' && link.dataset.page === 'games'); link.classList.toggle('active',active); if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current'); }); $('#alert').hidden = true; window.scrollTo(0,0); }
function navigate(path) { if (location.pathname !== path) history.pushState(null, '', path); return showRoute(); }
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
    page('games'); $('#gameCount').textContent='Looking up Title ID…';loading($('#gameCount'),true);
    try {
      const result=await api('/api/game?title='+encodeURIComponent(match[1]));
      if(request!==routeRequest)return;
      const titles=field(result,'Titles','titles');
      game=Array.isArray(titles) ? titles.find(g=>String(field(g,'TitleId','titleId'))===match[1]) : null;
      if (!game) throw new Error('XAU could not find a game with this Title ID.');
    } catch(e) { if(request===routeRequest){renderGames();error(e)} return; }
    finally {loading($('#gameCount'),false);}
    renderGames();
  }
  openGame(game);
}
window.addEventListener('popstate', showRoute);
document.querySelectorAll('.main-nav a, .brand').forEach(link => link.addEventListener('click', event => { if(event.button!==0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(link.getAttribute('href')); }));
$('#goGames').onclick = () => navigate('/games'); $('#back').onclick = () => navigate('/games');
$('#titleForm').onsubmit = event => { event.preventDefault(); const title=$('#titleInput').value.trim(); if(!/^\d+$/.test(title)){error(new Error('Enter a numeric Title ID.'));return;} navigate('/games/'+title); };
let authPoll, lastAuthStatus, tokenPending = false, loginRequest = null;
async function refreshLogin(){
  if(loginRequest)return loginRequest;
  loginRequest=(async()=>{try {
    const result=await api('/api/auth/status');
    const signedIn=(result.status==='signed_in'||result.status==='external')&&/^\d+$/.test(String(result.xuid||''));
    const account=signedIn?String(result.xuid):null;
    const accountChanged=account!==activeAccount;
    if(accountChanged){resetAccountData();activeAccount=account;if(!account&&!$('#game').hidden)navigate('/');}
    $('#loginPanel').hidden=signedIn;
    $('#profileCard').hidden=!signedIn;$('#goGames').hidden=!signedIn;
    $('#attachXbox').hidden=!result.pcSupported||signedIn;$('#attachXbox').disabled=tokenPending||result.status==='restoring'||result.autoAuth?.status==='connecting';
    if(!tokenPending) $('#loginMessage').textContent=result.autoAuth?.status==='connecting'?'Connecting to Xbox PC…':result.autoAuth?.error||result.error||(!result.pcSupported?'Xbox PC connection is available on Windows.':'');
    if(signedIn&&(accountChanged||lastAuthStatus!==result.status)){$('#alert').hidden=true;profile();if(!$('#games').hidden)loadGames();else if(!$('#game').hidden)showRoute();}
    if(result.status==='signed_out'||result.status==='error'){$('#profileCard').textContent='Sign in to load your profile.';}
    const signedInChanged=signedIn&&(accountChanged||lastAuthStatus!==result.status);
    lastAuthStatus=signedIn?result.status:null;renderHeaderProcesses();
    if(signedInChanged)void openSpoofPanel.refreshStatus();
  } catch(e) {if(activeAccount){resetAccountData();activeAccount=null;if(!$('#game').hidden)navigate('/');}lastAuthStatus=null;renderHeaderProcesses();$('#loginMessage').textContent=e.message||'Sign-in unavailable';}})();
  try{return await loginRequest}finally{loginRequest=null;}
}
async function initLogin(){await refreshLogin();authPoll=setInterval(()=>{if(!document.hidden)refreshLogin()},10000);}
$('#attachXbox').onclick=async()=>{
  if(tokenPending)return;
  const button=$('#attachXbox');tokenPending=true;button.disabled=true;loading(button,true);$('#loginMessage').textContent='Connecting to the Xbox PC app…';
  try{await api('/api/auth/attach',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(180000)});await refreshLogin()}
  catch(e){$('#loginMessage').textContent=e.message||'Could not connect to the Xbox app'}finally{tokenPending=false;button.disabled=false;loading(button,false)}
};
let profileAccount = null, profileUpdating = false, profileRequest = 0, completedTitles = new Set();
const profileKey = account => 'xau-profile-stats:' + account;
function readProfileSnapshot(account) {
  try { const snapshot=JSON.parse(persistentStorage.getItem(profileKey(account))); return snapshot && Number.isFinite(snapshot.unlocked) && Number.isFinite(snapshot.completed) && Number.isFinite(snapshot.total) ? snapshot : null; } catch { return null; }
}
function drawProfileStats(snapshot) {
  const node=$('#profileStats');if(!node)return;
  const number = value => Number(value).toLocaleString();
  node.innerHTML = `<div class="profile-stat"><span>Gamerscore</span><strong>${snapshot ? esc(number(snapshot.score)) : '—'}</strong></div><div class="profile-stat"><span>Completed games</span><strong>${snapshot ? esc(number(snapshot.completed)) : '—'}</strong></div><div class="profile-stat profile-stat-progress"><span>Completion</span><strong>${snapshot ? esc(snapshot.total ? (snapshot.unlocked / snapshot.total * 100).toFixed(1) : '0.0') + '%' : '—'}</strong></div>`;
  $('#profileRefreshHint').textContent=snapshot?.updatedAt ? 'Updated ' + new Date(snapshot.updatedAt).toLocaleString() : 'Update to load your achievement stats';
}
const profilePlaceholder = () => `<div class="profile-card profile-placeholder" aria-hidden="true"><div class="profile-identity"><span class="profile-skeleton profile-skeleton-avatar"></span><span class="profile-skeleton profile-skeleton-name"></span></div><div class="profile-stats">${[1,2,3].map(()=>'<div class="profile-stat"><span class="profile-skeleton profile-skeleton-label"></span><span class="profile-skeleton profile-skeleton-value"></span></div>').join('')}</div></div><span class="sr-only" role="status">Loading profile…</span>`;
async function profile() {
  if(!profileAccount)$('#profileCard').innerHTML=profilePlaceholder();
  const request=++profileRequest;loading($('#profileCard'),true);
  try {
    const data=await api('/api/profile');if(request!==profileRequest)return;const p=field(data,'People','people')?.[0] || data;
    const account=String(field(p,'Xuid','xuid')||'');if(!/^\d+$/.test(account))throw new Error('Could not identify the Xbox account.');
    profileAccount=account;void updateLinkedSteam(p,account);
    const name=field(p,'UniqueModernGamertag','Gamertag','gamertag','DisplayName')||'Player';const image=field(p,'DisplayPicRaw','displayPicRaw');
    $('#profileCard').innerHTML=`<div class="profile-card"><div class="profile-identity">${image ? `<img class="avatar" src="${attr(image)}" alt="">` : '<div class="avatar"></div>'}<div class="profile-name"><h2>${esc(name)}</h2><div class="profile-refresh"><button id="refreshProfile" type="button" aria-label="Refresh profile stats" aria-describedby="profileRefreshHint">${icon("refresh")}</button><span id="profileRefreshHint" class="profile-refresh-hint" role="tooltip"></span></div></div></div><div id="profileStats" class="profile-stats" aria-live="polite"></div><div id="profileUpdated" class="profile-update-status" role="status" hidden></div></div>`;
    const snapshot=readProfileSnapshot(account);completedTitles=new Set(Array.isArray(snapshot?.completedTitles) ? snapshot.completedTitles.map(String).filter(title=>/^\d+$/.test(title)) : []);
    drawProfileStats(snapshot);if(games.length)renderGames();$('#refreshProfile').onclick=refreshProfileStats;
  } catch(e) {if(request===profileRequest){$('#profileCard').textContent='Could not load the profile.';error(e);}}
  finally {if(request===profileRequest)loading($('#profileCard'),false);}
}
async function refreshProfileStats() {
  if(profileUpdating || !profileAccount)return;
  const account=profileAccount, button=$('#refreshProfile');$('#alert').hidden=true;profileUpdating=true;button.disabled=true;button.classList.add('is-updating');$('#profileUpdated').hidden=false;$('#profileUpdated').textContent='Updating achievement stats…';
  try {
    await post('/api/cache/refresh');
    const [profileData,gameData]=await Promise.all([api('/api/profile'),api('/api/games')]);
    const p=field(profileData,'People','people')?.[0] || profileData;
    if(String(field(p,'Xuid','xuid'))!==account)throw new Error('The Xbox account changed. Reload the page and try again.');
    const list=field(gameData,'Titles','titles');if(!Array.isArray(list))throw new Error('Xbox did not return the game library.');
    let next=0, unlocked=0, total=0, completed=0, previousRequest=0;const completedIds=new Set();
    const totalsKey='xau-profile-totals:'+account;let savedTotals={};
    try{savedTotals=JSON.parse(persistentStorage.getItem(totalsKey))||{};}catch{}
    const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    async function getCount(title){
      const saved=savedTotals[title];if(saved && Number.isInteger(saved.count) && saved.count>=0 && Date.now()-saved.time<7*86400000)return saved.count;
      for(let attempt=0;attempt<4;attempt++){
        await delay(Math.max(0,1000-(Date.now()-previousRequest)));previousRequest=Date.now();
        if(profileAccount!==account)throw new Error('The account changed.');
        try{
          const data=await fetchAchievements(title);if(profileAccount!==account)throw new Error('The account changed.');const achievements=field(data,'achievements','Achievements');
          if(!Array.isArray(achievements))throw new Error('Xbox did not return the achievement list.');
          savedTotals[title]={count:achievements.length,time:Date.now()};try{persistentStorage.setItem(totalsKey,JSON.stringify(savedTotals));}catch{}
          return achievements.length;
        }catch(e){
          if(e.status!==429)throw e;
          const wait=Math.max(1,Number(e.retryAfter)||30,30*2**attempt);
          if(attempt===3||wait>120)throw new Error(`Xbox is limiting requests. Try updating again in ${Math.ceil(wait/60)} min. Your progress has been saved.`);
          if($('#profileUpdated'))$('#profileUpdated').textContent=`Xbox rate limit reached. Waiting ${wait} seconds…`;
          await delay(wait*1000);
        }
      }
    }
    async function worker(){while(next<list.length){
      if(profileAccount!==account)return;
      if($('#profileUpdated'))$('#profileUpdated').textContent=`Checking games: ${next} / ${list.length}…`;
      const game=list[next++], a=field(game,'Achievement','achievement')||{};
      const title=String(field(game,'TitleId','titleId')||'');if(!/^\d+$/.test(title))throw new Error('A game is missing its Title ID.');
      const current=Number(field(a,'CurrentAchievements','currentAchievements')||0);
      let count=Number(field(a,'TotalAchievements','totalAchievements'));
      if(!Number.isFinite(count)||count<=0||count<current){
        count=await getCount(title);
        if(count<current){delete savedTotals[title];count=await getCount(title);}
      }
      if(!Number.isFinite(current)||current<0||count<current)throw new Error('Xbox returned incomplete achievement data.');
      unlocked+=current;total+=count;if(count>0&&current===count){completed++;completedIds.add(title);}
    }}
    await worker();
    if(profileAccount!==account)return;
    const snapshot={score:Number(field(p,'GamerScore','gamerScore')||0),unlocked,total,completed,completedTitles:[...completedIds],updatedAt:Date.now()};
    try{persistentStorage.setItem(profileKey(account),JSON.stringify(snapshot));}catch{}
    completedTitles=completedIds;drawProfileStats(snapshot);if(games.length)renderGames();
  } catch(e) {if(profileAccount===account){drawProfileStats(readProfileSnapshot(account));error(e);}}
  finally {profileUpdating=false;if($('#refreshProfile')===button){button.disabled=false;button.classList.remove('is-updating');$('#profileUpdated').hidden=true;}}
}
async function loadGames() {if(gamesLoading)return gamesLoading;const generation=accountGeneration;$('#gameCount').textContent='Loading…';loading($('#gameCount'),true);gamesLoading=(async()=>{try {const data=await api('/api/games');if(generation!==accountGeneration)return;games=field(data,'Titles','titles') || [];renderGames();}catch(e){if(generation===accountGeneration){$('#gameCount').textContent='Loading failed';error(e)}}finally{if(generation===accountGeneration){gamesLoading=null;loading($('#gameCount'),false);}}})();return gamesLoading;}
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
  if($('#hideCompleted').checked && Number.isFinite(total) && total>0 && games.some(g=>String(field(g,'TitleId','titleId'))===title && Number(field(field(g,'Achievement','achievement')||{},'CurrentAchievements','currentAchievements'))===total)){renderGames();return;}
  document.querySelectorAll('.game-card').forEach(card=>{
    if(card.dataset.title===title) {const totalNode=card.querySelector('.total-count');totalNode.textContent=total===null?'':` / ${total}`;const current=Number(card.dataset.current);card.classList.toggle('is-complete',completedTitles.has(title)||(Number.isFinite(total)&&total>0&&current===total));}
  });
}
function queueTotal(title) {
  if(!/^\d+$/.test(title)||totals.has(title)||totalsPending.has(title)) return;
  totalsPending.add(title);totalsQueue.push(title);loadTotals();
}
function fetchAchievements(title) {
  title=String(title);
  if(!achievementRequests.has(title)) {
    const generation=accountGeneration;
    const request=achievementChain.then(async()=>{
      await new Promise(resolve=>setTimeout(resolve,Math.max(0,achievementNextAt-Date.now())));
      achievementNextAt=Date.now()+1000;
      try { const data=await api('/api/achievements?title='+encodeURIComponent(title));if(generation!==accountGeneration)throw new Error('Account changed');return data; }
      catch(e) { if(e.status===429)achievementNextAt=Math.max(achievementNextAt,Date.now()+Math.max(1,Number(e.retryAfter)||30)*1000); throw e; }
    }).finally(()=>{if(achievementRequests.get(title)===request)achievementRequests.delete(title)});
    achievementChain=request.catch(()=>{});achievementRequests.set(title,request);
  }
  return achievementRequests.get(title);
}
function loadTotals() {
  while(totalsActive<1 && totalsQueue.length){
    const title=totalsQueue.shift(), generation=accountGeneration;if(totals.has(title)){totalsPending.delete(title);continue;}totalsActive++;
    new Promise(resolve=>setTimeout(resolve,Math.max(0,1000-(Date.now()-totalsLastRequest)))).then(()=>{totalsLastRequest=Date.now();return fetchAchievements(title)}).then(data=>{
      const list=field(data,'achievements','Achievements');
      if(!Array.isArray(list)) throw new Error('Invalid achievement list');
      if(generation===accountGeneration)updateTotal(title,list.length);
    }).catch(()=>{if(generation===accountGeneration)updateTotal(title,null)}).finally(()=>{totalsActive--;if(generation===accountGeneration)totalsPending.delete(title);loadTotals()});
  }
}
function renderGames(){
  const term=$('#search').value.toLowerCase();const filtered=$('#titleFilter').checked,hideEmpty=$('#hideEmpty').checked,hideCompleted=$('#hideCompleted').checked;
  const filterCount=Number(filtered)+Number(hideEmpty)+Number(hideCompleted);$('#filterCount').textContent=filterCount;$('#filterCount').hidden=!filterCount;
  const list=games.filter(g=>{
    const title=String(field(g,'TitleId','titleId')||''),a=field(g,'Achievement','achievement')||{};
    const raw=field(a,'CurrentAchievements','currentAchievements'),current=raw===undefined?null:Number(raw),total=gameTotal(g);
    const complete=completedTitles.has(title)||(current!==null&&Number.isFinite(current)&&Number.isFinite(total)&&total>0&&current===total);
    return String(field(g,'Name','name')).toLowerCase().includes(term)&&(!filtered||titleCatalog?.has(title))&&(!hideEmpty||current!==0)&&(!hideCompleted||!complete);
  });
  $('#gameCount').textContent=`${list.length} games`;
  $('#gameList').innerHTML=list.map((g,i)=>{
    const a=field(g,'Achievement','achievement')||{};const img=field(g,'DisplayImage','displayImage');
    const title=String(field(g,'TitleId','titleId')||'');const total=gameTotal(g);const current=Number(field(a,'CurrentAchievements','currentAchievements')||0);const complete=completedTitles.has(title)||(Number.isFinite(total)&&total>0&&current===total);
    return `<button class="game-card ${complete?'is-complete':''}" data-i="${i}" data-title="${attr(title)}" data-current="${current}">${img?`<img class="cover" src="${attr(img)}" alt="">`:'<div class="cover"></div>'}<div class="game-content"><h3>${esc(field(g,'Name','name'))}</h3><div class="game-progress"><span class="muted">${esc(field(a,'CurrentAchievements','currentAchievements')||0)}<span class="total-count">${total===null?'':` / ${total}`}</span> achievements</span>${icon("arrow-right")}</div></div></button>`;
  }).join('') || '<p class="muted">No games found.</p>';
  gameObserver?.disconnect();
  if('IntersectionObserver' in window) gameObserver=new IntersectionObserver(items=>items.forEach(item=>{if(item.isIntersecting){queueTotal(item.target.dataset.title);gameObserver.unobserve(item.target)}}),{rootMargin:'300px'});
  $('#gameList').querySelectorAll('button').forEach(b=>{
    const game=list[Number(b.dataset.i)];b.onclick=()=>navigate('/games/'+encodeURIComponent(String(field(game,'TitleId','titleId'))));
    if(gameTotal(game)===null&&!totals.has(b.dataset.title)){if(gameObserver)gameObserver.observe(b);else queueTotal(b.dataset.title)}
  });
}
$('#search').oninput=renderGames;
const filtersKey='xau-game-filters';
function saveGameFilters(){try{persistentStorage.setItem(filtersKey,JSON.stringify({titleBased:$('#titleFilter').checked,hideEmpty:$('#hideEmpty').checked,hideCompleted:$('#hideCompleted').checked}));}catch{}}
async function restoreGameFilters(){
  let saved;try{saved=JSON.parse(persistentStorage.getItem(filtersKey)||'{}')}catch{return;}
  $('#hideEmpty').checked=saved?.hideEmpty===true;$('#hideCompleted').checked=saved?.hideCompleted===true;
  if(saved?.titleBased===true){
    $('#titleFilter').checked=true;$('#titleFilter').disabled=true;
    try{const result=await api('/api/title-based/catalog');titleCatalog=new Set(result.titles)}
    catch(e){$('#titleFilter').checked=false;error(e)}finally{$('#titleFilter').disabled=false}
  }
}
$('#hideEmpty').onchange=$('#hideCompleted').onchange=()=>{saveGameFilters();renderGames()};
document.addEventListener('click',event=>{const filters=$('.game-filters');if(!filters.contains(event.target))filters.open=false});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&$('.game-filters').open){$('.game-filters').open=false;$('.game-filters summary').focus()}});
$('#titleFilter').onchange=async event=>{
  const checkbox=event.currentTarget;
  if(checkbox.checked&&!titleCatalog){
    checkbox.disabled=true;$('#gameCount').textContent='Loading filter…';loading($('#gameCount'),true);
    try{const result=await api('/api/title-based/catalog');titleCatalog=new Set(result.titles);}
    catch(e){checkbox.checked=false;error(e)}finally{checkbox.disabled=false;loading($('#gameCount'),false)}
  }
  saveGameFilters();renderGames();
};
function renderGameProgress(game, list) {
  const card=$('#gameProgress');if(!card)return;
  const valid=Array.isArray(list), total=valid?list.length:null;
  const unlocked=valid?list.filter(isUnlocked).length:null;
  const percent=total ? Math.round(unlocked/total*100) : total===0 ? 0 : null;
  const summary=field(game,'Achievement','achievement')||{};
  const scoreValue=(...names)=>{const value=field(summary,...names);if(value===undefined||value===null||value==='')return null;const n=Number(value);return Number.isFinite(n)&&n>=0?n:null;};
  let earned=scoreValue('CurrentGamerscore','currentGamerscore','CurrentGamerScore','currentGamerScore');
  let possible=scoreValue('TotalGamerscore','totalGamerscore','TotalGamerScore','totalGamerScore');
  if((earned===null||possible===null)&&valid&&list.length){
    let sum=0, current=0, known=true;
    for(const achievement of list){
      const rewards=field(achievement,'rewards','Rewards');if(!Array.isArray(rewards)){known=false;break;}
      const reward=rewards.find(item=>String(field(item,'type','Type')||'').toLowerCase()==='gamerscore');
      if(!reward){known=false;break;}const value=Number(field(reward,'value','Value'));if(!Number.isFinite(value)||value<0){known=false;break;}
      sum+=value;if(isUnlocked(achievement))current+=value;
    }
    if(known){earned=current;possible=sum;}
  }
  const score=earned!==null&&possible!==null?`${earned.toLocaleString()} <small>/ ${possible.toLocaleString()}</small>`:'—';
  card.innerHTML=`<div class="game-progress-top"><span class="game-progress-percent">${percent===null?'—':percent+'%'}</span></div><div class="game-progress-bar" role="progressbar" aria-label="Achievement progress" ${percent===null?'':`aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"`}><span style="width:${percent??0}%"></span></div><div class="game-progress-stats"><div><span>Achievements</span><strong>${unlocked===null?'—':`${unlocked} <small>/ ${total}</small>`}</strong></div><div><span>Gamerscore</span><strong>${score}</strong></div></div>`;
}
async function openGame(game){const request=++gameRequest;selected=game;titleBased=null;achievements=[];clearHistory();referenceStep(1);$('#selectionControls').hidden=true;$('#historyInfo').textContent='';$('#historyList').innerHTML='';$('#tag').value='';$('#start').disabled=true;const name=field(game,'Name','name'), title=field(game,'TitleId','titleId');$('#steamGameSearch').value=name||'';$('#steamGame').innerHTML='<option value="">Search for a game first</option>';steamSearchRequest++;page('game');openSpoofPanel();resetStatsPanel();renderStatus();$('#gameHead').innerHTML=`<div class="game-heading"><div class="game-heading-title"><div class="game-meta"><span class="eyebrow">Game / ${esc(title)}</span><span id="titleBasedStatus" class="game-type" role="status">Checking title-based support…</span></div><h1>${esc(name)}<span>.</span></h1></div><aside id="gameProgress" class="game-progress-card" aria-label="Game progress" aria-live="polite"></aside></div>`;renderGameProgress(game,null);$('#taLink').href='https://www.trueachievements.com/searchresults.aspx?search='+encodeURIComponent(name);$('#achievementList').innerHTML='<p class="muted loading-indicator" role="status">Loading achievements…</p>';checkTitleBased(title,request);try{const data=await fetchAchievements(title);if(request!==gameRequest)return;achievements=field(data,'achievements','Achievements')||[];if(Array.isArray(achievements)){if(!singleUnlocking)for(const item of achievements)pendingUnlocks.delete(String(title)+':'+String(item.id));updateTotal(String(title),achievements.length);}renderGameProgress(game,achievements);$('#achievementCount').textContent=achievements.length+' total';renderAchievements();}catch(e){if(request===gameRequest){$('#achievementList').innerHTML='<p class="muted">Could not load achievements.</p>';error(e)}}}
function renderAchievements(){
  const title=String(field(selected,'TitleId','titleId'));
  $('#achievementList').innerHTML=achievements.map(item=>{
    const image=item.mediaAssets?.[0]?.url, unlocked=isUnlocked(item), id=String(item.id), pending=pendingUnlocks.has(title+':'+id);
    return `<div class="achievement ${unlocked?'is-unlocked':'is-locked'}">${image?`<img src="${attr(image)}" alt="">`:'<div class="avatar" style="width:55px;height:55px;border-radius:8px;flex:none"></div>'}<div class="achievement-copy"><strong>${esc(item.name)}</strong><span class="muted">${esc(item.description||item.lockedDescription||'')}</span></div>${unlocked?'<span class="achievement-status" aria-label="Unlocked"><svg class="icon" aria-hidden="true"><use href="#icon-check"></use></svg><span>Unlocked</span></span>':`<button type="button" class="secondary achievement-unlock" data-achievement-id="${attr(id)}" ${pending?'data-pending="true" disabled':''} aria-label="Unlock ${attr(item.name)}">${pending?'Pending':'Unlock'}</button>`}</div>`;
  }).join('')||'<p class="muted">No achievements found.</p>';
  updateAchievementButtons();
}
function updateAchievementButtons(){
  const blocked=singleUnlocking||titleBased!==true||job.status==='running'||job.status==='paused';
  $('#achievementList').querySelectorAll('.achievement-unlock').forEach(button=>{
    button.disabled=blocked||button.dataset.pending==='true';
    button.title=button.dataset.pending==='true'?'Reload the game to check the result':job.status==='running'||job.status==='paused'?'Finish or reset the copy queue first':titleBased!==true?'Available for confirmed title-based games':'';
  });
}
$('#achievementList').addEventListener('click',async event=>{
  const button=event.target.closest('.achievement-unlock');
  if(!button||button.disabled||singleUnlocking)return;
  const title=String(field(selected,'TitleId','titleId')),achievementId=button.dataset.achievementId,current=gameRequest,key=title+':'+achievementId;
  singleUnlocking=true;updateAchievementButtons();loading(button,true);
  try {
    const result=await api('/api/achievement/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({titleId:title,achievementId}),signal:AbortSignal.timeout(120000)});
    if(result.status==='sent')pendingUnlocks.add(key);
    else if(result.status!=='confirmed'&&result.status!=='already')throw new Error('The unlock result is unknown. Reload the game to check before trying again.');
    if(current!==gameRequest)return;
    if(result.status==='sent') {error(new Error('Request sent. Reload the game later to verify the achievement.'));return;}
    const item=achievements.find(value=>String(value.id)===achievementId);if(item)item.progressState='Achieved';
    entries=entries.map(entry=>entry.id===achievementId?{...entry,alreadyUnlocked:true,selected:false}:entry);
    if(entries.length)renderHistory();renderGameProgress(selected,achievements);
  } catch(e) {
    if(!e.status||/result is unknown/i.test(e.message||''))pendingUnlocks.add(key);
    if(current===gameRequest)error(e);
  } finally {
    singleUnlocking=false;if(current===gameRequest)renderAchievements();else updateAchievementButtons();
  }
});
async function checkTitleBased(title,request){
  try {const result=await api('/api/title-based?title='+encodeURIComponent(title));if(request!==gameRequest)return;titleBased=result.titleBased;$('#titleBasedStatus').textContent=titleBased===true?'Title Based':titleBased===false?'Title Based: no — copying unavailable':'Title Based: unknown — copying unavailable';}
  catch(e){if(request!==gameRequest)return;titleBased=null;$('#titleBasedStatus').textContent='Could not check title-based support — copying unavailable';error(e)}
  if(entries.length)renderHistory();
  updateAchievementButtons();
}
function historyMessage(message, isError=false){if(isError && $('#referenceStep').hidden){error(new Error(message));return;}const el=$('#historyMessage');el.classList.toggle('is-error',isError);showNotification(el,message,{dismissible:isError});}
function clearHistory(){$('#steamMatchNotice').hidden=true;$('#steamMatchNotice').textContent='';if(!$('#referenceDialog').hidden)$('#referenceNext').disabled=true;$('#inlineReferenceNext').hidden=true;historyMessage('');$('#timingOptions').hidden=true;$('#totalHours').value='';entries=[];$('#historyInfo').textContent='';$('#historyList').innerHTML='';$('#selectionControls').hidden=true;$('#start').disabled=true;}
function isUnlocked(a){return String(a.progressState||'').toLowerCase()==='achieved'||(!a.progressState&&Boolean(a.timeUnlocked)&&Date.parse(a.timeUnlocked)>0);}
function selectionKey(){return 'xau-selection:'+String(activeAccount||'')+':'+String(field(selected,'TitleId','titleId'));}
function savedSelection(){try{return JSON.parse(persistentStorage.getItem(selectionKey())||'{}')}catch{return {}}}
function saveSelection(){try{const choices=savedSelection();for(const entry of entries)choices[entry.id]=entry.selected;persistentStorage.setItem(selectionKey(),JSON.stringify(choices))}catch{}}
function prepare(rows){clearHistory();firstDelayMs=(45+Math.floor(Math.random()*31))*60000;const index=new Map();for(const a of achievements){const n=String(a.name||'').trim().toLocaleLowerCase();if(index.has(n)) index.set(n,null);else index.set(n,a);}let problems=[];entries=rows.map(row=>{const a=row.id != null ? achievements.find(item=>String(item.id)===String(row.id)) : index.get(row.name.trim().toLocaleLowerCase());if(!a){problems.push(row.name);return null;}if(!Number.isFinite(Date.parse(row.time))){problems.push(row.name+' (invalid timestamp)');return null;}return {id:String(a.id),name:a.name,time:new Date(row.time).toISOString(),alreadyUnlocked:isUnlocked(a),pacingWeight:0.8+Math.random()*0.4};}).filter(Boolean).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));if(problems.length){entries=[];throw new Error('Could not match or read the timestamp for: '+problems.slice(0,8).join(', '));}if(!entries.length)throw new Error('The history is empty.');if(new Set(entries.map(x=>x.id)).size!==entries.length){entries=[];throw new Error('The history contains duplicate achievements.');}const saved=savedSelection();entries=entries.map(x=>({...x,selected:typeof saved[x.id]==='boolean'?saved[x.id]:!x.alreadyUnlocked}));$('#selectionControls').hidden=false;$('#timingOptions').hidden=false;renderHistory();if(!$('#referenceDialog').hidden)$('#referenceNext').disabled=false;}
function renderHistory(){
  const count=entries.filter(x=>x.selected).length;
  let plan, info;
  try {
    if(!count) throw new Error('Select at least one achievement.');
    plan=planSelected(entries,$('#totalHours').value,{firstDelayMs});
    info=`Selected ${count} of ${entries.length}. Estimated queue time: ${duration(plan.reduce((sum,item)=>sum+item.delayMs,0))}.`;
  } catch(e) {info=e.message;}
  $('#historyInfo').textContent=info;
  const intervals=new Map((plan||[]).map(item=>[item.id,item.delayMs]));
  $('#historyList').innerHTML=entries.map((x,i)=>`<label class="history-item"><input type="checkbox" data-i="${i}" ${x.selected?'checked':''}><span>${esc(x.name)} <span class="muted">· ${esc(new Date(x.time).toLocaleString())}${x.alreadyUnlocked?' · already unlocked':''}${intervals.has(x.id)?' · interval '+duration(intervals.get(x.id)):''}</span></span></label>`).join('');
  $('#historyList').querySelectorAll('input').forEach(box=>box.onchange=()=>{entries[Number(box.dataset.i)].selected=box.checked;saveSelection();renderHistory()});
  $('#start').disabled=!plan?.length||actionLoading||titleBased!==true||job.status==='running'||job.status==='paused';
  const canUpdate=job.status==='paused'&&!job.uncertainId&&String(field(selected,'TitleId','titleId'))===String(job.titleId);
  $('#applySchedule').hidden=!canUpdate;$('#applySchedule').disabled=!plan?.length||actionLoading||titleBased!==true;
}
$('#totalHours').oninput=()=>{if(entries.length)renderHistory()};
$('#tag').addEventListener('input',()=>{if(entries.length)clearHistory()});
function referenceLabel(){return $('#referenceSource').value==='steam'?`Steam: ${steamProfile?.name||'player'}`:$('#tag').value;}
$('#referenceSource').onchange=()=>{referenceSession++;clearHistory();const steam=$('#referenceSource').value==='steam';$('#xboxReference').hidden=steam;$('#steamReference').hidden=!steam;renderSteamProfile();};
$('#steamGame').onchange=()=>{referenceSession++;if(entries.length)clearHistory();};
$('#steamGameSearch').oninput=()=>{steamSearchRequest++;$('#steamGame').innerHTML='<option value="">Search for a game first</option>';referenceSession++;if(entries.length)clearHistory();};
async function searchSteamGames(){
  const button=$('#findSteamGames');if(button.disabled)return;const request=++steamSearchRequest,game=gameRequest,query=$('#steamGameSearch').value.trim();
  if(!query){historyMessage('Enter a game name to search Steam.',true);return;}
  button.disabled=true;loading(button,true);historyMessage('Searching Steam games…');
  try{const result=await api('/api/steam/search?'+new URLSearchParams({q:query}));if(request!==steamSearchRequest||game!==gameRequest)return;const list=Array.isArray(result.items)?result.items:[];$('#steamGame').innerHTML='<option value="">Select a Steam game</option>'+list.map(item=>`<option value="${attr(item.id)}">${esc(item.name)} (${esc(item.id)})</option>`).join('');historyMessage(list.length?'Choose the matching Steam game.':'No Steam games found.');return list;}
  catch(e){if(request===steamSearchRequest&&game===gameRequest)historyMessage(e.message||'Steam search failed.',true);}
  finally{button.disabled=false;loading(button,false);}
}
$('#findSteamGames').onclick=searchSteamGames;
$('#useSteamOffer').onclick=async()=>{
  if(!steamProfile||historyLoading)return;const button=$('#useSteamOffer'),game=gameRequest,profile=steamProfile.steamId;
  button.disabled=true;loading(button,true);
  try{
    $('#referenceSource').value='steam';$('#referenceSource').onchange();
    const session=referenceSession,gameName=field(selected,'Name','name');$('#steamGameSearch').value=gameName||'';
    const list=await searchSteamGames();if(game!==gameRequest||session!==referenceSession||profile!==steamProfile?.steamId||$('#referenceSource').value!=='steam'||!list)return;
    const exact=matchingSteamGame(list,gameName);
    if(exact){$('#steamGame').value=String(exact.id);$('#loadHistory').click();}
    else historyMessage('Choose the matching Steam game, then load its history.');
  }finally{button.disabled=false;loading(button,false);}
};
$('#selectAll').onclick=()=>{entries.forEach(x=>x.selected=true);saveSelection();renderHistory()};
$('#selectNone').onclick=()=>{entries.forEach(x=>x.selected=false);saveSelection();renderHistory()};
$('#importHistory').onclick=()=>{if(historyLoading)return;try{prepare($('#manual').value.split(/\r?\n/).filter(x=>x.trim()).map(line=>{const [name,time]=line.split('\t');return{name:name||'',time:time||''}}));showReferenceReview();}catch(e){$('#start').disabled=true;historyMessage(e.message||String(e),true)}};
$('#loadHistory').onclick=async()=>{
  if(historyLoading)return;
  historyLoading=true;const request=gameRequest, session=referenceSession;clearHistory();
  try{
    if(!achievements.length)throw new Error('Wait for the game’s achievements to load.');
    const steam=$('#referenceSource').value==='steam',tag=$('#tag').value.trim();if(!steam&&!tag)throw new Error('Enter the player’s gamertag.');
    if(steam&&!steamProfile)throw new Error('Link a Steam account to your Xbox profile and make the Steam profile public.');
    const appId=$('#steamGame').value;if(steam&&!appId)throw new Error('Search for and select the matching Steam game.');
    $('#loadHistory').disabled=true;loading($('#loadHistory'),true);historyMessage(steam?'Loading Steam achievement history…':'Loading the player’s Xbox history…');
    const title=String(field(selected,'TitleId','titleId'));
    const profile=steamProfile;
    const result=steam?await api('/api/steam/history?'+new URLSearchParams({steamId:profile.steamId,appId}),{signal:AbortSignal.timeout(120000)}):await api('/api/history?'+new URLSearchParams({title,tag}),{signal:AbortSignal.timeout(120000)});
    if(request===gameRequest&&session===referenceSession){
      if(steam){const parsed=parseSteamAchievements(result.content,profile.steamId,appId),matched=matchSteamAchievements(parsed.entries,achievements);if(!matched.matches.length)throw new Error('No Steam achievements with matching Xbox names and valid unlock times were found.');prepare(matched.matches);const missing=matched.unmatched.length+parsed.invalid;if(missing){$('#steamMatchNotice').textContent=`${missing} Steam achievement(s) were skipped because the name could not be matched uniquely or the unlock time was unavailable.`+(matched.unmatched.length?' Unmatched: '+matched.unmatched.slice(0,8).join(', ')+(matched.unmatched.length>8?'…':''):'');$('#steamMatchNotice').hidden=false;}}
      else{prepare(result.entries);if(Number.isFinite(result.minutesPlayed)&&result.minutesPlayed>0){$('#totalHours').value=String(Math.round(result.minutesPlayed/60*100)/100);renderHistory();}}
      showReferenceReview();
    }
  }catch(e){if(request===gameRequest&&session===referenceSession){$('#start').disabled=true;historyMessage(e.message||'Loading failed',true)}}
  finally{historyLoading=false;loading($('#loadHistory'),false);$('#loadHistory').disabled=false;$('#loadHistory').textContent='Load history'}
};
$('#start').onclick=async()=>{if(actionLoading||titleBased!==true)return;let chosen;try{chosen=planSelected(entries,$('#totalHours').value,{firstDelayMs})}catch(e){historyMessage(e.message,true);return;}if(!chosen.length)return;actionLoading=true;actionVersion++;$('#start').disabled=true;loading($('#start'),true);try{job=await api('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({titleId:String(field(selected,'TitleId','titleId')),game:field(selected,'Name','name'),tag:referenceLabel(),entries:chosen}),signal:AbortSignal.timeout(50000)});renderStatus();}catch(e){historyMessage(e.message||String(e),true)}finally{actionLoading=false;loading($('#start'),false);renderHistory()}};
$('#applySchedule').onclick=async()=>{
  if(actionLoading)return;let chosen;try{chosen=planSelected(entries,$('#totalHours').value,{firstDelayMs})}catch(e){historyMessage(e.message,true);return;}
  actionLoading=true;actionVersion++;$('#applySchedule').disabled=true;loading($('#applySchedule'),true);
  try{job=await api('/api/reschedule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({titleId:String(field(selected,'TitleId','titleId')),tag:referenceLabel(),entries:chosen})});historyMessage('Paused queue updated. Review it before resuming.');if(!$('#referenceDialog').hidden)closeReferenceEditor();renderStatus()}
  catch(e){if(!referenceDialog.hidden){$('#referenceDialogHint').textContent=e.message||String(e);$('#referenceDialogHint').hidden=false}else historyMessage(e.message||String(e),true)}finally{actionLoading=false;loading($('#applySchedule'),false);renderHistory()}
};
async function queueAction(action, fromHeader = false){
  if(actionLoading)return;
  if(action==='resume' && job.uncertainId && fromHeader){
    await openProcess(job.titleId,'#statusPanel');
    if($('#game').hidden || String(field(selected,'TitleId','titleId'))!==String(job.titleId))return;
  }
  actionLoading=true;actionVersion++;const generation=accountGeneration;$('#'+action).disabled=true;loading($('#'+action),true);renderHeaderProcesses();
  try{
    if(action==='resume'&&job.uncertainId){const result=await api('/api/uncertain',{signal:AbortSignal.timeout(45000)});if(generation!==accountGeneration)return;uncertainShown=result.id;$('#uncertainStatus').textContent=`XAU status: ${result.progress==='achieved'?'unlocked':'not yet unlocked'}. Choose how to continue.`;$('#uncertain').hidden=false;}
    else{const next=await post('/api/'+action);if(generation!==accountGeneration)return;job=next;uncertainShown=null;renderStatus()}
  }catch(e){if(generation===accountGeneration){if(fromHeader)error(e);else $('#status').textContent=e.message||String(e)}}
  finally{actionLoading=false;$('#'+action).disabled=false;loading($('#'+action),false);renderHeaderProcesses()}
}
for(const action of ['pause','resume','reset'])$('#'+action).onclick=()=>queueAction(action);

for(const [button,choice] of [['skipUncertain','skip'],['retryUncertain','retry']])$('#'+button).onclick=async()=>{if(actionLoading||!uncertainShown)return;actionLoading=true;actionVersion++;$('#skipUncertain').disabled=$('#retryUncertain').disabled=true;loading($('#'+button),true);try{job=await api('/api/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({choice,id:uncertainShown}),signal:AbortSignal.timeout(45000)});uncertainShown=null;renderStatus()}catch(e){$('#uncertainStatus').textContent=e.message||String(e)}finally{actionLoading=false;$('#skipUncertain').disabled=$('#retryUncertain').disabled=false;loading($('#'+button),false)}};

let queueHasSchedule = false, viewingOtherQueue = false, previousQueueExpanded = true;
function setQueueExpanded(expanded){$('#queueBody').hidden=!expanded;$('#queueSummary').hidden=expanded;$('#toggleQueuePanel').setAttribute('aria-expanded',String(expanded));$('#toggleQueuePanel').innerHTML=expanded?'Collapse '+icon('chevron-up'):'Expand '+icon('chevron-down'); }
$('#toggleQueuePanel').onclick=()=>setQueueExpanded($('#queueBody').hidden);
const referenceDialog=$('#referenceDialog'),queueSetup=$('#queueSetup'),setupHome=queueSetup.parentElement;
function referenceStep(step){
  setReferenceStep({input:$('#referenceStep'),review:$('#reviewStep'),dialogBack:$('#referenceBack'),dialogNext:$('#referenceNext'),inlineBack:$('#inlineReferenceBack'),inlineNext:$('#inlineReferenceNext'),hint:$('#referenceDialogHint')},{review:step===2,dialogOpen:!referenceDialog.hidden,hasEntries:entries.length>0,canUpdate:job.status==='paused'});
}
function showReferenceReview(){referenceStep(2);$('#totalHours').focus();}
$('#toggleQueueSetup').onclick=()=>{
  if(!referenceDialog.hidden)return;
  clearHistory();$('#tag').value='';$('#manual').value='';$('#referenceDialogContent').append(queueSetup);queueSetup.hidden=false;
  referenceDialog.hidden=false;referenceStep(1);$('.queue-workspace').hidden=true;$('.queue-details').hidden=true;$('#toggleQueueSetup').setAttribute('aria-expanded','true');
};
$('#referenceClose').onclick=()=>closeReferenceEditor();
$('#referenceNext').onclick=()=>{if(entries.length){referenceStep(2);renderHistory()}};
$('#referenceBack').onclick=()=>referenceStep(1);
$('#inlineReferenceBack').onclick=()=>referenceStep(1);
$('#inlineReferenceNext').onclick=()=>{if(entries.length)referenceStep(2);};
function closeReferenceEditor(){if(referenceDialog.hidden)return;referenceSession++;referenceDialog.hidden=true;setupHome.prepend(queueSetup);queueSetup.hidden=true;$('.queue-workspace').hidden=false;$('.queue-details').hidden=false;referenceStep(1);$('#toggleQueueSetup').setAttribute('aria-expanded','false');$('#toggleQueueSetup').focus()}
$('#openOtherQueue').onclick=()=>{if(/^\d+$/.test(String(job.titleId)))navigate('/games/'+job.titleId)};
$('#resetOtherQueue').onclick=async()=>{
  if(actionLoading||job.status==='running')return;
  actionLoading=true;actionVersion++;$('#resetOtherQueue').disabled=true;loading($('#resetOtherQueue'),true);
  try{job=await api('/api/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({titleId:job.titleId})});uncertainShown=null;renderStatus();}
  catch(e){error(e)}finally{actionLoading=false;loading($('#resetOtherQueue'),false);renderStatus();}
};
function renderStatus(){
  renderHeaderProcesses();
  updateAchievementButtons();
  const otherGame=Boolean(selected && job.entries?.length && String(job.titleId)!==String(field(selected,'TitleId','titleId')));
  $('#otherQueue').hidden=!otherGame;
  if(otherGame){
    if(!viewingOtherQueue){previousQueueExpanded=!$('#queueBody').hidden;viewingOtherQueue=true;if(!referenceDialog.hidden)closeReferenceEditor();}
    $('#queueBody').hidden=true;$('#queueSummary').hidden=true;$('#queueBadge').hidden=true;$('#toggleQueuePanel').hidden=true;
    const label=job.status==='running'?'running':job.status==='paused'?'paused':'completed';
    $('#otherQueueText').textContent=`A ${label} queue belongs to ${job.game||'Title ID '+job.titleId}. ${job.status==='running'?'Pause it before resetting.':'Reset it to create a queue for this game.'}`;
    $('#resetOtherQueue').disabled=job.status==='running'||actionLoading;
    return;
  }
  $('#queueBadge').hidden=false;
  if(viewingOtherQueue){viewingOtherQueue=false;setQueueExpanded(job.entries?.length ? previousQueueExpanded : true);}
  const labels={idle:'Idle',running:'Running',paused:'Paused',completed:'Completed'};
  const active=job.status==='running'||job.status==='paused';
  const hasSchedule=Boolean(job.entries?.length);
  if(!hasSchedule&&!referenceDialog.hidden)closeReferenceEditor();
  if(hasSchedule!==queueHasSchedule){$('#queueSetup').hidden=hasSchedule;setQueueExpanded(!hasSchedule);queueHasSchedule=hasSchedule;}
  $('#toggleQueuePanel').hidden=!hasSchedule;
  if(hasSchedule){const total=job.entries.length, done=job.index||0, current=job.entries[done];const remaining=job.status==='paused'?job.remaining:job.dueAt-Date.now();$('#queueSummary').innerHTML=`<div class="queue-summary-context"><strong>${esc(job.game)}</strong>${job.tag?` <span>· ${esc(job.tag)}</span>`:''}</div><div class="queue-summary-metrics"><span><strong>${done} / ${total}</strong> completed</span>${active?`<span>Next: <strong>${esc(current?.name||'—')}</strong></span><span>In <strong class="queue-clock" data-queue-next>${duration(remaining||0)}</strong></span>`:''}</div>${job.error?'<div class="queue-summary-error">Queue paused with an error. Expand for details.</div>':''}`;}
  $('#statusPanel').dataset.hasSchedule=String(hasSchedule);
  $('#queueContext').hidden=!hasSchedule;
  $('#queueContextName').innerHTML=hasSchedule?`${esc(job.game)}${job.tag?` <span>· ${esc(job.tag)}</span>`:''}`:'';
  $('#toggleQueueSetup').hidden=!hasSchedule;
  $('#toggleQueueSetup').setAttribute('aria-expanded',String(!referenceDialog.hidden));
  $('#queueBadge').textContent=labels[job.status]||job.status;
  $('#statusPanel').dataset.status=job.status;
  $('#start').hidden=active;
  let text='';
  if(job.entries){
    const total=job.entries.length, done=job.index||0;
    const current=job.entries[done];
    const remaining=job.status==='paused'?job.remaining:job.dueAt-Date.now();
    let estimate=Math.max(0,remaining||0);
    for(let i=done+1;i<total;i++)estimate+=(Number.isSafeInteger(job.entries[i].delayMs)?job.entries[i].delayMs:Math.max(MIN_INTERVAL_MS,Date.parse(job.entries[i].time)-Date.parse(job.entries[i-1].time)));
    text+=`<div class="queue-metrics"><div class="queue-metric"><span>Progress</span><strong>${done}<small> / ${total}</small></strong></div><div class="queue-metric queue-next"><span>Next achievement</span><strong>${esc(active?current?.name||'—':'—')}</strong></div><div class="queue-metric"><span>Next in</span><strong class="queue-clock" data-queue-next>${active?duration(remaining||0):'—'}</strong></div><div class="queue-metric"><span>Estimated remaining</span><strong data-queue-estimate data-extra="${Math.max(0,estimate-Math.max(0,remaining||0))}">${active?duration(estimate):'—'}</strong></div></div>`;
    text+=`<div class="queue-progress" role="progressbar" aria-label="Queue progress" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><span style="width:${total?Math.min(100,Math.max(0,done/total*100)):0}%"></span></div>`;
  }else text=job.accountMismatch?'<div class="queue-error"><strong>Saved queue belongs to another Xbox account</strong><span>Sign in to that account to finish or reset its queue before starting a new one.</span></div>':'<p class="queue-empty">Load a player’s history below to prepare your queue.</p>';
  if(job.error)text+=`<div class="queue-error"><strong>Queue paused</strong><span>${esc(job.error)}</span></div>`;
  $('#status').innerHTML=text;
  $('#pause').hidden=job.status!=='running';$('#resume').hidden=job.status!=='paused';$('#reset').hidden=job.accountMismatch||job.status==='idle'||job.status==='running';
  if(!job.uncertainId||uncertainShown!==job.uncertainId)$('#uncertain').hidden=true;
  if(entries.length) {const canUpdate=job.status==='paused'&&!job.uncertainId&&String(field(selected,'TitleId','titleId'))===String(job.titleId);$('#applySchedule').hidden=!canUpdate;}
  $('#queueDetails').hidden=!job.entries?.length;$('#logDetails').hidden=!job.log?.length;
  $('#queueList').innerHTML=(job.entries||[]).map((item,i)=>{const gap=Number.isSafeInteger(item.delayMs)?item.delayMs:(i?Date.parse(item.time)-Date.parse(job.entries[i-1].time):0);const status=i<job.index?({'sent':'sent','already':'already unlocked','skipped':'skipped'}[job.results?.[item.id]]||'processed'):i===job.index&&job.status!=='completed'?'next':'pending';return `<div class="queue-row"><strong>${i+1}. ${esc(item.name)}</strong><span>${esc(status)} · ${esc(new Date(item.time).toLocaleString())} · planned interval ${duration(gap)}</span></div>`}).join('');
  $('#queueLog').innerHTML=(job.log||[]).slice().reverse().map(row=>`<div class="queue-row"><span>${esc(new Date(row.time).toLocaleString())} · ${esc(row.message)}</span></div>`).join('');
}
let spoofSnapshot={status:'idle'}, spoofBusy=false;
function resetAccountData(){
  accountGeneration++;profileRequest++;gameRequest++;steamLinkRequest++;referenceSession++;
  profileAccount=null;games=[];gamesLoading=null;selected=null;achievements=[];completedTitles=new Set();
  totals.clear();totalsPending.clear();totalsQueue.length=0;achievementRequests.clear();achievementChain=Promise.resolve();
  pendingUnlocks.clear();steamProfile=null;steamLinkStatus='checking';job={status:'idle'};
  openSpoofPanel.reset();resetStatsPanel();clearHistory();
  $('#gameList').replaceChildren();$('#gameCount').textContent='';$('#gameHead').replaceChildren();$('#achievementList').replaceChildren();$('#achievementCount').textContent='';$('#tag').value='';
  $('#profileCard').innerHTML=profilePlaceholder();renderHeaderProcesses();
}
function headerSpoofTitle(){
  const running=['running','recovering'].includes(spoofSnapshot.status);
  return !running&&job.status==='paused'&&(job.spoofRequiredTitle||job.titleId) ? String(job.spoofRequiredTitle||job.titleId) : spoofSnapshot.titleId;
}
function renderHeaderProcesses(){
  const spoofing=['running','recovering'].includes(spoofSnapshot.status), spoofTitle=headerSpoofTitle(), hasSpoof=Boolean(spoofTitle), copying=job.status==='running'||job.status==='paused';
  const signedIn=lastAuthStatus==='signed_in'||lastAuthStatus==='external';
  $('#headerSpoof').hidden=!signedIn||!hasSpoof;$('#headerQueue').hidden=!signedIn||!copying;
  $('#headerSpoof').disabled=spoofBusy;$('#headerQueue').disabled=actionLoading;
  if(hasSpoof){
    const seconds=Math.max(0,Math.floor(((spoofing?Date.now():Number(spoofSnapshot.endedAt||Date.now()))-Number(spoofSnapshot.startedAt||Date.now()))/1000));
    $('#headerSpoof .header-process-label').textContent=spoofing?'Stop spoof':'Resume spoof';
    $('#headerSpoofTime').textContent=String(spoofSnapshot.titleId||'')===String(spoofTitle)&&spoofSnapshot.startedAt?duration(seconds*1000):'';$('#headerSpoof').dataset.status=spoofing?'running':'paused';
    $('#headerSpoof').title=spoofing?'Stop spoof':'Resume spoof';
  }
  if(copying){$('#headerQueueLabel').textContent=job.status==='paused'?'Resume copying':'Pause copying';$('#headerQueueProgress').textContent=`${job.index||0}/${job.entries?.length||0}`;$('#headerQueue').dataset.status=job.status;$('#headerQueue').title=(job.status==='paused'?'Resume copying':'Pause copying')+(job.game?' · '+job.game:'');}
}

async function openProcess(title,panel){
  if(!/^\d+$/.test(String(title||'')))return;
  if($('#game').hidden||String(field(selected,'TitleId','titleId'))!==String(title))await navigate('/games/'+title);
  if(!$('#game').hidden&&String(field(selected,'TitleId','titleId'))===String(title)){if(panel==='#statusPanel'&&job.entries?.length)setQueueExpanded(true);requestAnimationFrame(()=>document.querySelector(panel)?.scrollIntoView({behavior:'smooth',block:'start'}));}
}
$('#headerSpoof').onclick=async()=>{const failure=await openSpoofPanel.action(['running','recovering'].includes(spoofSnapshot.status)?'stop':'start',headerSpoofTitle());if(failure)error(new Error(failure));};
$('#headerQueue').onclick=()=>queueAction(job.status==='paused'?'resume':'pause',true);
const openSpoofPanel = initSpoofPanel(() => selected && String(field(selected,'TitleId','titleId')),(state,busy)=>{spoofSnapshot=state;spoofBusy=busy;renderHeaderProcesses();});
const resetStatsPanel = initStatsPanel(() => selected && String(field(selected,'TitleId','titleId')), openSpoofPanel.getPlaytime);
function updateQueueClock(){if(job.status!=='running'||$('#game').hidden)return;const remaining=Math.max(0,(job.dueAt||0)-Date.now());document.querySelectorAll('[data-queue-next]').forEach(el=>el.textContent=duration(remaining));document.querySelectorAll('[data-queue-estimate]').forEach(el=>el.textContent=duration(remaining+Number(el.dataset.extra||0)));}
async function poll(){if(polling||actionLoading||document.hidden)return;polling=true;const version=actionVersion,generation=accountGeneration;try{const next=await api('/api/state');if(!actionLoading&&version===actionVersion&&generation===accountGeneration){job=next;renderStatus()}}catch(e){$('#status').textContent='Cannot connect to the app. Queue status is unknown.'}finally{polling=false}}setInterval(poll,5000);setInterval(()=>{if(!document.hidden)updateQueueClock()},1000);document.addEventListener('visibilitychange',()=>{if(!document.hidden){refreshLogin();poll();}});restoreGameFilters().finally(()=>{showRoute();initLogin();poll()});

// Each tab has its own lease. A short grace period on the server allows reloads.
const clientId = crypto.randomUUID();
function clientHeartbeat(){fetch('/api/client/heartbeat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:clientId}),keepalive:true}).catch(()=>{});}
clientHeartbeat();
setInterval(clientHeartbeat, 20000);
window.addEventListener('pageshow',clientHeartbeat);
window.addEventListener('pagehide',()=>navigator.sendBeacon('/api/client/close',new Blob([JSON.stringify({id:clientId})],{type:'application/json'})));
