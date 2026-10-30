import { planSelected, MIN_INTERVAL_MS } from './timing.js';
const $ = s => document.querySelector(s);
let games = [], selected, achievements = [], entries = [], job = { status: 'idle' };
let gamesLoading = null, historyLoading = false, actionLoading = false, polling = false, gameRequest = 0, referenceSession = 0;
const totals = new Map(), totalsPending = new Set(), totalsQueue = [], achievementRequests = new Map();
let totalsActive = 0, totalsLastRequest = 0, gameObserver, titleBased = null, titleCatalog = null;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const attr = esc;
const field = (obj, ...names) => names.map(n => obj?.[n]).find(v => v !== undefined && v !== null);
const error = e => { $('#alert').hidden = false; $('#alert').textContent = e.message || String(e); };
async function api(path, options = {}) { try { const r = await fetch(path, { ...options, signal: options.signal || AbortSignal.timeout(25000) }); const data = await r.json(); if (!r.ok) {const failure=new Error(data.error || 'Request failed');failure.status=r.status;failure.retryAfter=data.retryAfter;throw failure;} return data; } catch(e) { if (e.name === 'TimeoutError') throw new Error('The request timed out. Please try again.'); throw e; } }
const post = path => api(path, {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
function page(name) { for (const el of document.querySelectorAll('.page')) el.hidden = el.id !== name; document.querySelectorAll('.main-nav a').forEach(link => { const active=link.dataset.page === name || (name === 'game' && link.dataset.page === 'games'); link.classList.toggle('active',active); if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current'); }); $('#alert').hidden = true; window.scrollTo(0,0); }
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
document.querySelectorAll('.main-nav a, .brand').forEach(link => link.addEventListener('click', event => { if(event.button!==0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(link.getAttribute('href')); }));
$('#goGames').onclick = () => navigate('/games'); $('#back').onclick = () => navigate('/games');
$('#titleForm').onsubmit = event => { event.preventDefault(); const title=$('#titleInput').value.trim(); if(!/^\d+$/.test(title)){error(new Error('Enter a numeric Title ID.'));return;} navigate('/games/'+title); };
let authPoll, lastAuthStatus, tokenPending = false;
async function refreshLogin(){
  try {
    const result=await api('/api/auth/status');
    const signedIn=result.status==='signed_in'||result.status==='external';
    $('#loginPanel').hidden=signedIn;
    $('#profileCard').hidden=!signedIn;$('#goGames').hidden=!signedIn;$('#signOut').hidden=result.status!=='signed_in';
    $('#tokenButton').disabled=tokenPending||result.status==='restoring';
    if(!tokenPending&&result.status!==lastAuthStatus) $('#loginMessage').textContent=result.status==='restoring'?'Restoring saved token…':result.error||'';
    if((result.status==='signed_in'||result.status==='external')&&lastAuthStatus!==result.status){$('#alert').hidden=true;profile();if(!$('#games').hidden)loadGames();}
    if(result.status==='signed_out'||result.status==='error'){$('#profileCard').textContent='Sign in to load your profile.';}
    lastAuthStatus=result.status;
  } catch(e) {$('#loginMessage').textContent=e.message||'Sign-in unavailable';}
}
async function initLogin(){await refreshLogin();authPoll=setInterval(refreshLogin,3000);}
$('#tokenForm').onsubmit=async event=>{
  event.preventDefault();const input=$('#xauthToken'),button=$('#tokenButton');
  const value=input.value.trim();input.value='';if(!value)return;
  tokenPending=true;button.disabled=true;$('#loginMessage').textContent='Checking token…';
  try{await api('/api/auth/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:value}),signal:AbortSignal.timeout(50000)});await refreshLogin()}
  catch(e){$('#loginMessage').textContent=e.message||'Token sign-in failed'}finally{tokenPending=false;button.disabled=false}
};
$('#signOut').onclick=async()=>{const button=$('#signOut');button.disabled=true;try{await post('/api/auth/logout');profileAccount=null;completedTitles.clear();games=[];totals.clear();totalsQueue.length=0;totalsPending.clear();gameObserver?.disconnect();await refreshLogin();navigate('/')}catch(e){error(e)}finally{button.disabled=false}};
let profileAccount = null, profileUpdating = false, completedTitles = new Set();
const profileKey = account => 'xau-profile-stats:' + account;
function readProfileSnapshot(account) {
  try { const snapshot=JSON.parse(localStorage.getItem(profileKey(account))); return snapshot && Number.isFinite(snapshot.unlocked) && Number.isFinite(snapshot.completed) && Number.isFinite(snapshot.total) ? snapshot : null; } catch { return null; }
}
function drawProfileStats(snapshot) {
  const node=$('#profileStats');if(!node)return;
  const number = value => Number(value).toLocaleString();
  node.innerHTML = `<div class="profile-stat"><span>GAMERSCORE</span><strong>${snapshot ? esc(number(snapshot.score)) : '—'}</strong></div><div class="profile-stat"><span>COMPLETED GAMES</span><strong>${snapshot ? esc(number(snapshot.completed)) : '—'}</strong></div><div class="profile-stat profile-stat-progress"><span>COMPLETION</span><strong>${snapshot ? esc(snapshot.total ? (snapshot.unlocked / snapshot.total * 100).toFixed(1) : '0.0') + '%' : '—'}</strong></div>`;
  $('#profileRefreshHint').textContent=snapshot?.updatedAt ? 'Updated ' + new Date(snapshot.updatedAt).toLocaleString() : 'Update to load your achievement stats';
}
async function profile() {
  try {
    const data=await api('/api/profile');const p=field(data,'People','people')?.[0] || data;
    const account=String(field(p,'Xuid','xuid')||'');if(!/^\d+$/.test(account))throw new Error('Could not identify the Xbox account.');
    profileAccount=account;
    const name=field(p,'UniqueModernGamertag','Gamertag','gamertag','DisplayName')||'Player';const image=field(p,'DisplayPicRaw','displayPicRaw');
    $('#profileCard').innerHTML=`<div class="profile-card"><div class="profile-identity">${image ? `<img class="avatar" src="${attr(image)}" alt="">` : '<div class="avatar"></div>'}<div class="profile-name"><h2>${esc(name)}</h2><div class="profile-refresh"><button id="refreshProfile" type="button" aria-label="Refresh profile stats" aria-describedby="profileRefreshHint"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-2.1 5"/></svg></button><span id="profileRefreshHint" class="profile-refresh-hint" role="tooltip"></span></div></div></div><div id="profileStats" class="profile-stats" aria-live="polite"></div><div id="profileUpdated" class="profile-update-status" role="status" hidden></div></div>`;
    const snapshot=readProfileSnapshot(account);completedTitles=new Set(Array.isArray(snapshot?.completedTitles) ? snapshot.completedTitles.map(String).filter(title=>/^\d+$/.test(title)) : []);
    drawProfileStats(snapshot);if(games.length)renderGames();$('#refreshProfile').onclick=refreshProfileStats;
  } catch(e) {$('#profileCard').textContent='Could not load the profile.';error(e);}
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
    try{savedTotals=JSON.parse(localStorage.getItem(totalsKey))||{};}catch{}
    const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    async function getCount(title){
      const saved=savedTotals[title];if(saved && Number.isInteger(saved.count) && saved.count>=0 && Date.now()-saved.time<7*86400000)return saved.count;
      for(let attempt=0;attempt<4;attempt++){
        await delay(Math.max(0,1000-(Date.now()-previousRequest)));previousRequest=Date.now();
        if(profileAccount!==account)throw new Error('The account changed.');
        try{
          const data=await api('/api/achievements?title='+encodeURIComponent(title));const achievements=field(data,'achievements','Achievements');
          if(!Array.isArray(achievements))throw new Error('Xbox did not return the achievement list.');
          savedTotals[title]={count:achievements.length,time:Date.now()};try{localStorage.setItem(totalsKey,JSON.stringify(savedTotals));}catch{}
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
    try{localStorage.setItem(profileKey(account),JSON.stringify(snapshot));}catch{}
    completedTitles=completedIds;drawProfileStats(snapshot);if(games.length)renderGames();
  } catch(e) {if(profileAccount===account){drawProfileStats(readProfileSnapshot(account));error(e);}}
  finally {profileUpdating=false;if($('#refreshProfile')===button){button.disabled=false;button.classList.remove('is-updating');$('#profileUpdated').hidden=true;}}
}
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
    const request=api('/api/achievements?title='+encodeURIComponent(title)).finally(()=>achievementRequests.delete(title));
    achievementRequests.set(title,request);
  }
  return achievementRequests.get(title);
}
function loadTotals() {
  while(totalsActive<1 && totalsQueue.length){
    const title=totalsQueue.shift();if(totals.has(title)){totalsPending.delete(title);continue;}totalsActive++;
    new Promise(resolve=>setTimeout(resolve,Math.max(0,1000-(Date.now()-totalsLastRequest)))).then(()=>{totalsLastRequest=Date.now();return fetchAchievements(title)}).then(data=>{
      const list=field(data,'achievements','Achievements');
      if(!Array.isArray(list)) throw new Error('Invalid achievement list');
      updateTotal(title,list.length);
    }).catch(()=>updateTotal(title,null)).finally(()=>{totalsActive--;totalsPending.delete(title);loadTotals()});
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
    return `<button class="game-card ${complete?'is-complete':''}" data-i="${i}" data-title="${attr(title)}" data-current="${current}">${img?`<img class="cover-back" src="${attr(img)}" alt="" aria-hidden="true"><img class="cover" src="${attr(img)}" alt="">`:'<div class="cover"></div>'}<div class="game-content"><h3>${esc(field(g,'Name','name'))}</h3><div class="game-progress"><span class="muted">${esc(field(a,'CurrentAchievements','currentAchievements')||0)}<span class="total-count">${total===null?'':` / ${total}`}</span> achievements</span><span class="game-arrow" aria-hidden="true">→</span></div></div></button>`;
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
function saveGameFilters(){try{localStorage.setItem(filtersKey,JSON.stringify({titleBased:$('#titleFilter').checked,hideEmpty:$('#hideEmpty').checked,hideCompleted:$('#hideCompleted').checked}));}catch{}}
async function restoreGameFilters(){
  let saved;try{saved=JSON.parse(localStorage.getItem(filtersKey)||'{}')}catch{return;}
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
    checkbox.disabled=true;$('#gameCount').textContent='Loading filter…';
    try{const result=await api('/api/title-based/catalog');titleCatalog=new Set(result.titles);}
    catch(e){checkbox.checked=false;error(e)}finally{checkbox.disabled=false}
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
  card.innerHTML=`<div class="game-progress-top"><span class="game-progress-percent">${percent===null?'—':percent+'%'}</span></div><div class="game-progress-bar" role="progressbar" aria-label="Achievement progress" ${percent===null?'':`aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"`}><span style="width:${percent??0}%"></span></div><div class="game-progress-stats"><div><span>ACHIEVEMENTS</span><strong>${unlocked===null?'—':`${unlocked} <small>/ ${total}</small>`}</strong></div><div><span>GAMERSCORE</span><strong>${score}</strong></div></div>`;
}
async function openGame(game){const request=++gameRequest;selected=game;titleBased=null;achievements=[];clearHistory();$('#selectionControls').hidden=true;$('#historyInfo').textContent='';$('#historyList').innerHTML='';$('#tag').value='';$('#start').disabled=true;const name=field(game,'Name','name'), title=field(game,'TitleId','titleId');page('game');renderSpoof();$('#gameHead').innerHTML=`<div class="game-heading"><div class="game-heading-title"><div class="game-meta"><span class="eyebrow">GAME / ${esc(title)}</span><span id="titleBasedStatus" class="game-type" role="status">Checking title-based support…</span></div><h1>${esc(name)}<span>.</span></h1></div><aside id="gameProgress" class="game-progress-card" aria-label="Game progress" aria-live="polite"></aside></div>`;renderGameProgress(game,null);$('#taLink').href='https://www.trueachievements.com/searchresults.aspx?search='+encodeURIComponent(name);$('#achievementList').innerHTML='<p class="muted">Loading…</p>';checkTitleBased(title,request);try{const data=await fetchAchievements(title);if(request!==gameRequest)return;achievements=field(data,'achievements','Achievements')||[];if(Array.isArray(achievements))updateTotal(String(title),achievements.length);renderGameProgress(game,achievements);$('#achievementCount').textContent=achievements.length+' total';$('#achievementList').innerHTML=achievements.map(a=>{const image=a.mediaAssets?.[0]?.url;const unlocked=isUnlocked(a);return `<div class="achievement ${unlocked?'is-unlocked':'is-locked'}">${image?`<img src="${attr(image)}" alt="">`:'<div class="avatar" style="width:55px;height:55px;border-radius:8px;flex:none"></div>'}<div><strong>${esc(a.name)}</strong><span class="muted">${esc(a.description||a.lockedDescription||'')}</span></div><span class="achievement-status" aria-label="${unlocked?'Unlocked':'Locked'}" title="${unlocked?'Unlocked':'Locked'}"><span aria-hidden="true">${unlocked?'✓':'○'}</span><span>${unlocked?'Unlocked':'Locked'}</span></span></div>`}).join('')||'<p class="muted">No achievements found.</p>';}catch(e){if(request===gameRequest){$('#achievementList').innerHTML='<p class="muted">Could not load achievements.</p>';error(e)}}}
async function checkTitleBased(title,request){
  try {const result=await api('/api/title-based?title='+encodeURIComponent(title));if(request!==gameRequest)return;titleBased=result.titleBased;$('#titleBasedStatus').textContent=titleBased===true?'Title Based':titleBased===false?'Title Based: no — copying unavailable':'Title Based: unknown — copying unavailable';}
  catch(e){if(request!==gameRequest)return;titleBased=null;$('#titleBasedStatus').textContent='Could not check title-based support — copying unavailable';error(e)}
  if(entries.length)renderHistory();
}
function historyMessage(message, isError=false){const el=$('#historyMessage');el.textContent=message;el.hidden=!message;el.classList.toggle('is-error',isError);}
function clearHistory(){if(!$('#referenceDialog').hidden)$('#referenceNext').disabled=true;historyMessage('');$('#timingOptions').hidden=true;$('#totalHours').value='';entries=[];$('#historyInfo').textContent='';$('#historyList').innerHTML='';$('#selectionControls').hidden=true;$('#start').disabled=true;}
function isUnlocked(a){return String(a.progressState||'').toLowerCase()==='achieved'||(!a.progressState&&Boolean(a.timeUnlocked)&&Date.parse(a.timeUnlocked)>0);}
function selectionKey(){return 'xau-selection:'+String(field(selected,'TitleId','titleId'));}
function savedSelection(){try{return JSON.parse(localStorage.getItem(selectionKey())||'{}')}catch{return {}}}
function saveSelection(){try{const choices=savedSelection();for(const entry of entries)choices[entry.id]=entry.selected;localStorage.setItem(selectionKey(),JSON.stringify(choices))}catch{}}
function prepare(rows){clearHistory();const index=new Map();for(const a of achievements){const n=String(a.name||'').trim().toLocaleLowerCase();if(index.has(n)) index.set(n,null);else index.set(n,a);}let problems=[];entries=rows.map(row=>{const a=row.id != null ? achievements.find(item=>String(item.id)===String(row.id)) : index.get(row.name.trim().toLocaleLowerCase());if(!a){problems.push(row.name);return null;}if(!Number.isFinite(Date.parse(row.time))){problems.push(row.name+' (invalid timestamp)');return null;}return {id:String(a.id),name:a.name,time:new Date(row.time).toISOString(),alreadyUnlocked:isUnlocked(a)};}).filter(Boolean).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));if(problems.length){entries=[];throw new Error('Could not match or read the timestamp for: '+problems.slice(0,8).join(', '));}if(!entries.length)throw new Error('The history is empty.');if(new Set(entries.map(x=>x.id)).size!==entries.length){entries=[];throw new Error('The history contains duplicate achievements.');}const saved=savedSelection();entries=entries.map(x=>({...x,selected:typeof saved[x.id]==='boolean'?saved[x.id]:!x.alreadyUnlocked}));$('#selectionControls').hidden=false;$('#timingOptions').hidden=false;renderHistory();if(!$('#referenceDialog').hidden)$('#referenceNext').disabled=false;}
function renderHistory(){
  const count=entries.filter(x=>x.selected).length;
  let plan, info;
  try {
    if(!count) throw new Error('Select at least one achievement.');
    plan=planSelected(entries,$('#totalHours').value);
    info=`Selected ${count} of ${entries.length}. Estimated queue time: ${duration(plan.reduce((sum,item)=>sum+item.delayMs,0))}.`;
  } catch(e) {info=e.message;}
  $('#historyInfo').textContent=info;
  $('#historyList').innerHTML=entries.map((x,i)=>`<label class="history-item"><input type="checkbox" data-i="${i}" ${x.selected?'checked':''}><span>${esc(x.name)} <span class="muted">· ${esc(new Date(x.time).toLocaleString())}${x.alreadyUnlocked?' · already unlocked':''}</span></span></label>`).join('');
  $('#historyList').querySelectorAll('input').forEach(box=>box.onchange=()=>{entries[Number(box.dataset.i)].selected=box.checked;saveSelection();renderHistory()});
  $('#start').disabled=!plan?.length||actionLoading||titleBased!==true||job.status==='running'||job.status==='paused';
  const canUpdate=job.status==='paused'&&!job.uncertainId&&String(field(selected,'TitleId','titleId'))===String(job.titleId);
  $('#applySchedule').hidden=!canUpdate;$('#applySchedule').disabled=!plan?.length||actionLoading||titleBased!==true;
}
$('#totalHours').oninput=()=>{if(entries.length)renderHistory()};
$('#tag').addEventListener('input',()=>{if(entries.length)clearHistory()});
$('#selectAll').onclick=()=>{entries.forEach(x=>x.selected=true);saveSelection();renderHistory()};
$('#selectNone').onclick=()=>{entries.forEach(x=>x.selected=false);saveSelection();renderHistory()};
$('#importHistory').onclick=()=>{if(historyLoading)return;try{prepare($('#manual').value.split(/\r?\n/).filter(x=>x.trim()).map(line=>{const [name,time]=line.split('\t');return{name:name||'',time:time||''}}));}catch(e){$('#start').disabled=true;historyMessage(e.message||String(e),true)}};
$('#loadHistory').onclick=async()=>{
  if(historyLoading)return;
  historyLoading=true;const request=gameRequest, session=referenceSession;clearHistory();
  try{
    if(!achievements.length)throw new Error('Wait for the game’s achievements to load.');
    const tag=$('#tag').value.trim();if(!tag)throw new Error('Enter the player’s gamertag.');
    $('#loadHistory').disabled=true;$('#loadHistory').textContent='Loading…';historyMessage('Loading the player’s Xbox history…');
    const title=String(field(selected,'TitleId','titleId'));
    const result=await api('/api/history?'+new URLSearchParams({title,tag}),{signal:AbortSignal.timeout(120000)});
    if(request===gameRequest&&session===referenceSession){prepare(result.entries);if(Number.isFinite(result.minutesPlayed)&&result.minutesPlayed>0){$('#totalHours').value=String(Math.round(result.minutesPlayed/60*100)/100);renderHistory();}}
  }catch(e){if(request===gameRequest&&session===referenceSession){$('#start').disabled=true;historyMessage(e.message||'Loading failed',true)}}
  finally{historyLoading=false;$('#loadHistory').disabled=false;$('#loadHistory').textContent='Load history'}
};
$('#start').onclick=async()=>{if(actionLoading||titleBased!==true)return;let chosen;try{chosen=planSelected(entries,$('#totalHours').value)}catch(e){historyMessage(e.message,true);return;}if(!chosen.length)return;actionLoading=true;actionVersion++;$('#start').disabled=true;try{job=await api('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({titleId:String(field(selected,'TitleId','titleId')),game:field(selected,'Name','name'),tag:$('#tag').value,entries:chosen}),signal:AbortSignal.timeout(50000)});renderStatus();}catch(e){historyMessage(e.message||String(e),true)}finally{actionLoading=false;renderHistory()}};
$('#applySchedule').onclick=async()=>{
  if(actionLoading)return;let chosen;try{chosen=planSelected(entries,$('#totalHours').value)}catch(e){historyMessage(e.message,true);return;}
  actionLoading=true;actionVersion++;$('#applySchedule').disabled=true;
  try{job=await api('/api/reschedule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({titleId:String(field(selected,'TitleId','titleId')),tag:$('#tag').value,entries:chosen})});historyMessage('Paused queue updated. Review it before resuming.');if(!$('#referenceDialog').hidden)closeReferenceEditor();renderStatus()}
  catch(e){if(!referenceDialog.hidden){$('#referenceDialogHint').textContent=e.message||String(e);$('#referenceDialogHint').hidden=false}else historyMessage(e.message||String(e),true)}finally{actionLoading=false;renderHistory()}
};
for(const action of ['pause','resume','reset'])$('#'+action).onclick=async()=>{if(actionLoading)return;actionLoading=true;actionVersion++;$('#'+action).disabled=true;try{if(action==='resume'&&job.uncertainId){const result=await api('/api/uncertain',{signal:AbortSignal.timeout(45000)});uncertainShown=result.id;$('#uncertainStatus').textContent=`XAU status: ${result.progress==='achieved'?'unlocked':'not yet unlocked'}. Choose how to continue.`;$('#uncertain').hidden=false;}else{job=await post('/api/'+action);uncertainShown=null;renderStatus()}}catch(e){$('#status').textContent=e.message||String(e)}finally{actionLoading=false;$('#'+action).disabled=false}};
for(const [button,choice] of [['skipUncertain','skip'],['retryUncertain','retry']])$('#'+button).onclick=async()=>{if(actionLoading||!uncertainShown)return;actionLoading=true;actionVersion++;$('#skipUncertain').disabled=$('#retryUncertain').disabled=true;try{job=await api('/api/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({choice,id:uncertainShown}),signal:AbortSignal.timeout(45000)});uncertainShown=null;renderStatus()}catch(e){$('#uncertainStatus').textContent=e.message||String(e)}finally{actionLoading=false;$('#skipUncertain').disabled=$('#retryUncertain').disabled=false}};

function duration(ms){let n=Math.ceil(Math.max(0,ms)/1000),d=Math.floor(n/86400);n%=86400;return `${d?d+'d ':''}${String(Math.floor(n/3600)).padStart(2,'0')}:${String(Math.floor(n%3600/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;}
let queueHasSchedule = false;
function setQueueExpanded(expanded){$('#queueBody').hidden=!expanded;$('#queueSummary').hidden=expanded;$('#toggleQueuePanel').setAttribute('aria-expanded',String(expanded));$('#toggleQueuePanel').innerHTML=expanded?'Collapse <span aria-hidden="true">↑</span>':'Expand <span aria-hidden="true">↓</span>'; }
$('#toggleQueuePanel').onclick=()=>setQueueExpanded($('#queueBody').hidden);
const referenceDialog=$('#referenceDialog'),queueSetup=$('#queueSetup'),setupHome=queueSetup.parentElement;
function referenceStep(step){
  const review=step===2;$('#referenceStep').hidden=review;$('#reviewStep').hidden=!review;
  $('#referenceBack').hidden=!review;$('#referenceNext').hidden=review;
  $('#referenceNext').disabled=!entries.length;$('#referenceDialogHint').textContent='Only paused queues can be updated.';$('#referenceDialogHint').hidden=!review||job.status==='paused';
}
$('#toggleQueueSetup').onclick=()=>{
  if(!referenceDialog.hidden)return;
  clearHistory();$('#tag').value='';$('#manual').value='';$('#referenceDialogContent').append(queueSetup);queueSetup.hidden=false;
  referenceStep(1);$('.queue-workspace').hidden=true;$('.queue-details').hidden=true;referenceDialog.hidden=false;$('#toggleQueueSetup').setAttribute('aria-expanded','true');
};
$('#referenceClose').onclick=()=>closeReferenceEditor();
$('#referenceNext').onclick=()=>{if(entries.length){referenceStep(2);renderHistory()}};
$('#referenceBack').onclick=()=>referenceStep(1);
function closeReferenceEditor(){if(referenceDialog.hidden)return;referenceSession++;referenceDialog.hidden=true;setupHome.prepend(queueSetup);queueSetup.hidden=true;$('.queue-workspace').hidden=false;$('.queue-details').hidden=false;$('#referenceStep').hidden=false;$('#reviewStep').hidden=false;$('#toggleQueueSetup').setAttribute('aria-expanded','false');$('#toggleQueueSetup').focus()}
function renderStatus(){
  const labels={idle:'Idle',running:'Running',paused:'Paused',completed:'Completed'};
  const active=job.status==='running'||job.status==='paused';
  const hasSchedule=Boolean(job.entries?.length);
  if(!hasSchedule&&!referenceDialog.hidden)closeReferenceEditor();
  if(hasSchedule!==queueHasSchedule){$('#queueSetup').hidden=hasSchedule;setQueueExpanded(!hasSchedule);queueHasSchedule=hasSchedule;}
  $('#toggleQueuePanel').hidden=!hasSchedule;
  if(hasSchedule){const total=job.entries.length, done=job.index||0, current=job.entries[done];const remaining=job.status==='paused'?job.remaining:job.dueAt-Date.now();$('#queueSummary').innerHTML=`<div class="queue-summary-context"><strong>${esc(job.game)}</strong>${job.tag?` <span>· ${esc(job.tag)}</span>`:''}</div><div class="queue-summary-metrics"><span><strong>${done} / ${total}</strong> completed</span>${active?`<span>Next: <strong>${esc(current?.name||'—')}</strong></span><span>In <strong class="queue-clock">${duration(remaining||0)}</strong></span>`:''}</div>${job.error?'<div class="queue-summary-error">Queue paused with an error. Expand for details.</div>':''}`;}
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
    text+=`<div class="queue-metrics"><div class="queue-metric"><span>Progress</span><strong>${done}<small> / ${total}</small></strong></div><div class="queue-metric queue-next"><span>Next achievement</span><strong>${esc(active?current?.name||'—':'—')}</strong></div><div class="queue-metric"><span>Next in</span><strong class="queue-clock">${active?duration(remaining||0):'—'}</strong></div><div class="queue-metric"><span>Estimated remaining</span><strong>${active?duration(estimate):'—'}</strong></div></div>`;
    text+=`<div class="queue-progress" role="progressbar" aria-label="Queue progress" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><span style="width:${total?Math.min(100,Math.max(0,done/total*100)):0}%"></span></div>`;
  }else text='<p class="queue-empty">Load a player’s history below to prepare your queue.</p>';
  if(job.error)text+=`<div class="queue-error"><strong>Queue paused</strong><span>${esc(job.error)}</span></div>`;
  $('#status').innerHTML=text;
  $('#pause').hidden=job.status!=='running';$('#resume').hidden=job.status!=='paused';$('#reset').hidden=job.status==='idle'||job.status==='running';
  if(!job.uncertainId||uncertainShown!==job.uncertainId)$('#uncertain').hidden=true;
  if(entries.length) {const canUpdate=job.status==='paused'&&!job.uncertainId&&String(field(selected,'TitleId','titleId'))===String(job.titleId);$('#applySchedule').hidden=!canUpdate;}
  $('#queueDetails').hidden=!job.entries?.length;$('#logDetails').hidden=!job.log?.length;
  $('#queueList').innerHTML=(job.entries||[]).map((item,i)=>{const gap=Number.isSafeInteger(item.delayMs)?item.delayMs:(i?Date.parse(item.time)-Date.parse(job.entries[i-1].time):0);const status=i<job.index?({'sent':'sent','already':'already unlocked','skipped':'skipped'}[job.results?.[item.id]]||'processed'):i===job.index&&job.status!=='completed'?'next':'pending';return `<div class="queue-row"><strong>${i+1}. ${esc(item.name)}</strong><span>${esc(status)} · ${esc(new Date(item.time).toLocaleString())} · planned interval ${duration(gap)}</span></div>`}).join('');
  $('#queueLog').innerHTML=(job.log||[]).slice().reverse().map(row=>`<div class="queue-row"><span>${esc(new Date(row.time).toLocaleString())} · ${esc(row.message)}</span></div>`).join('');
}
let spoofState={status:'idle'}, spoofBusy=false, spoofVersion=0;
function renderSpoof(){
  const active=spoofState.status==='running', title=String(field(selected,'TitleId','titleId')||'');
  $('#spoofButton').textContent=active?'Stop spoof':'Start spoof';
  $('#spoofButton').disabled=spoofBusy||!title;
  $('#spoofStatus').textContent=active ? `Spoofing ${spoofState.titleId===title?'this game':'Title ID '+spoofState.titleId} · ${duration(Date.now()-spoofState.startedAt)}` : spoofState.error ? `Spoof stopped: ${spoofState.error}` : spoofState.notice || 'Spoof off';
}
$('#spoofButton').onclick=async()=>{
  if(spoofBusy||!selected)return;
  spoofBusy=true;spoofVersion++;renderSpoof();
  try {
    const active=spoofState.status==='running';
    spoofState=await api('/api/spoofer/'+(active?'stop':'start'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(active?{}:{titleId:String(field(selected,'TitleId','titleId'))}),signal:AbortSignal.timeout(50000)});
  } catch(e){error(e)} finally{spoofBusy=false;renderSpoof()}
};
async function pollSpoof(){
  if(spoofBusy)return;const version=spoofVersion;
  try{const next=await api('/api/spoofer');if(!spoofBusy&&version===spoofVersion){spoofState=next;renderSpoof()}}catch{}
}
setInterval(pollSpoof,1000);pollSpoof();
async function poll(){if(polling||actionLoading)return;polling=true;const version=actionVersion;try{const next=await api('/api/state');if(!actionLoading&&version===actionVersion){job=next;renderStatus()}}catch(e){$('#status').textContent='Cannot connect to the app. Queue status is unknown.'}finally{polling=false}}setInterval(poll,1000);restoreGameFilters().finally(()=>{showRoute();initLogin();poll()});

// Each tab has its own lease. A short grace period on the server allows reloads.
const clientId = crypto.randomUUID();
function clientHeartbeat(){fetch('/api/client/heartbeat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:clientId}),keepalive:true}).catch(()=>{});}
clientHeartbeat();
setInterval(clientHeartbeat, 20000);
window.addEventListener('pageshow',clientHeartbeat);
window.addEventListener('pagehide',()=>navigator.sendBeacon('/api/client/close',new Blob([JSON.stringify({id:clientId})],{type:'application/json'})));
