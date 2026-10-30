import http from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { MIN_INTERVAL_MS } from './public/timing.js';
import { xboxApi, loginStatus, signOut, attachXboxPc, currentSessionXuid } from './xbox-client.js';
import { ensureXboxPc } from './windows-auth.js';
import { createStatsService } from './stats.js';

const PORT = Number(process.env.PORT || 3000);
const XAU = process.env.XAU_URL?.replace(/\/$/, '');
const CATALOG_URL = process.env.TITLE_CATALOG_URL || 'https://raw.githubusercontent.com/Fumo-Unlockers/XboxGames/main/xbox_games.json';
const MIN_UNLOCK_INTERVAL = MIN_INTERVAL_MS;
const STATE_FILE = process.env.STATE_FILE || join(process.cwd(), 'state.json');
let state = { status: 'idle' }, busy = false, mutating = false;
try { state = JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (state.inFlight) { state.uncertainId = state.inFlight; state.status = 'paused'; state.remaining = Math.max(0, (state.dueAt || Date.now()) - Date.now()); state.error = 'The result of the previous request is unknown. Check the achievement before continuing.'; state.log = [...(state.log || []), {time: new Date().toISOString(), message: 'Queue stopped: ' + state.error}].slice(-200); delete state.inFlight; }
const SPOOF_FILE = STATE_FILE + '.spoof';
let spoof = { status: 'idle' };
try {
  const saved = JSON.parse(await readFile(SPOOF_FILE, 'utf8'));
  if (saved && typeof saved === 'object') {
    spoof = saved.status === 'running' ? { ...saved, status:'idle', endedAt:saved.lastUpdatedAt || saved.startedAt, notice:'Previous session was interrupted when the app closed. Start it again.' } : saved;
  }
} catch (e) { if (e.code !== 'ENOENT') throw e; }
async function saveSpoof() {
  const { accountXuid, ...safe } = spoof;
  const tmp = SPOOF_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(safe));
  await rename(tmp, SPOOF_FILE);
}

const SETTINGS_FILE = STATE_FILE + '.settings';
let settings = {};
try { const saved = JSON.parse(await readFile(SETTINGS_FILE, 'utf8')); if (saved && typeof saved === 'object' && !Array.isArray(saved)) settings = saved; }
catch (e) { if (e.code !== 'ENOENT') throw e; }
let settingsWrites = Promise.resolve();
async function saveSetting(key, value) {
  const operation = settingsWrites.then(async () => {
    const next = { ...settings, [key]:value }, encoded = JSON.stringify(next);
    if (Buffer.byteLength(encoded) > 4_000_000) throw new Error('Saved settings are too large');
    const tmp = SETTINGS_FILE + '.tmp'; await writeFile(tmp, encoded); await rename(tmp, SETTINGS_FILE); settings = next;
  });
  settingsWrites = operation.catch(() => {});
  return operation;
}
async function save() { const tmp = STATE_FILE + '.tmp'; await writeFile(tmp, JSON.stringify(state, null, 2)); await rename(tmp, STATE_FILE); }
await save();
function log(message) {
  state.log = [...(state.log || []), { time: new Date().toISOString(), message }].slice(-200);
}
function advance(item, outcome) {
  const now = Date.now(); state.results ||= {}; state.results[item.id] = outcome;
  state.index++;
  if (state.index >= state.entries.length) { state.status = 'completed'; delete state.dueAt; log('Queue completed'); }
  else {
    const next = state.entries[state.index];
    const gap = Number.isSafeInteger(next.delayMs) ? next.delayMs : Math.max(0, Date.parse(next.time) - Date.parse(item.time));
    state.dueAt = Math.max(now + gap, (state.lastUnlockAt || 0) + MIN_UNLOCK_INTERVAL);
  }
}
async function achievementStatus(achievementId) {
  await requireAccount();
  const current = await xau('/api/achievements/' + id(state.titleId));
  if (!Array.isArray(current?.achievements)) throw new Error('XAU did not return achievements for verification');
  const matching = current.achievements.filter(a => String(a.id) === achievementId);
  if (matching.length !== 1 || typeof matching[0].progressState !== 'string') throw new Error('Could not check the achievement status in XAU');
  const progress = matching[0].progressState.toLowerCase();
  if (!['achieved', 'notstarted', 'inprogress'].includes(progress)) throw new Error('Unknown achievement status in XAU');
  return progress;
}
async function get(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000), redirect: 'error' });
  const raw = await response.text(); let data; try { data = JSON.parse(raw); } catch { data = raw; }
  if (!response.ok || (data && typeof data === 'object' && data.error)) {
    const error = new Error(data?.error || `HTTP ${response.status}`);
    if(response.status===429){error.status=429;const value=response.headers.get('retry-after');const seconds=Number(value);const date=Date.parse(value);error.retryAfter=value && Number.isFinite(seconds) ? Math.max(0,seconds) : Number.isFinite(date) ? Math.max(0,Math.ceil((date-Date.now())/1000)) : 30;}
    throw error;
  }
  return data;
}
const xau = (path, options) => XAU ? get(XAU + path, options) : xboxApi(path, options);
const statsService = createStatsService({ xau });
const responseCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
function clearResponseCache() { responseCache.clear(); }
async function cachedXau(path) {
  const existing = responseCache.get(path);
  if (existing && existing.expires > Date.now()) return existing.promise;
  const entry = { expires: Date.now() + CACHE_TTL };
  entry.promise = xau(path).catch(error => { if (responseCache.get(path) === entry) responseCache.delete(path); throw error; });
  responseCache.set(path, entry);
  return entry.promise;
}

const id = value => { if (!/^\d+$/.test(String(value))) throw new Error('Invalid ID'); return String(value); };
let catalogPromise, catalogExpires = 0;
async function titleCatalog() {
  if (!catalogPromise || Date.now() >= catalogExpires) {
    catalogExpires = Date.now() + 86400000;
    catalogPromise = get(CATALOG_URL).then(data => {
      if (!Array.isArray(data)) throw new Error('The game type catalog is unavailable');
      const catalog = new Map();
      for (const item of data) {
        const key = String(item.titleId);
        if (!/^\d+$/.test(key) || typeof item.isTitleBased !== 'boolean') continue;
        if (catalog.has(key) && catalog.get(key) !== item.isTitleBased) catalog.set(key, null);
        else if (!catalog.has(key)) catalog.set(key, item.isTitleBased);
      }
      return catalog;
    }).catch(e => { catalogPromise = undefined; catalogExpires = 0; throw e; });
  }
  return await catalogPromise;
}
async function titleBased(title) {
  return (await titleCatalog()).get(id(title)) ?? null;
}
async function requireTitleBased(title) {
  const result = await titleBased(title);
  if (result !== true) throw new Error(result === false ? 'This game is not title based' : 'Could not confirm that this game is title based');
}
async function currentXuid() {
  const profile = await xau('/api/profile/me');
  const people = profile?.People ?? profile?.people;
  const xuid = people?.[0]?.Xuid ?? people?.[0]?.xuid;
  if (typeof xuid !== 'string' || !/^\d+$/.test(xuid)) throw new Error('XAU did not return the current account XUID');
  return xuid;
}
async function requireAccount() {
  if (!state.accountXuid) throw new Error('The queue is not linked to an account; reset it and start again');
  if (await currentXuid() !== state.accountXuid) throw new Error('The XAU account changed; switch back to the original account');
}
function parseEntries(input) {
  if (!Array.isArray(input) || !input.length || input.length > 10000) throw new Error('The achievement list is empty or too large');
  const entries=input.map(a=>({id:id(a.id),name:String(a.name || a.id),time:a.time,...(a.delayMs!==undefined?{delayMs:a.delayMs}:{})}));
  if(entries.some(a=>a.delayMs!==undefined&&(!Number.isSafeInteger(a.delayMs)||a.delayMs<0||a.delayMs>315360000000)))throw new Error('Invalid planned interval');
  if(new Set(entries.map(a=>a.id)).size!==entries.length)throw new Error('The queue contains duplicate achievements');
  if(entries.some(a=>!Number.isFinite(Date.parse(a.time)))||entries.some((a,i)=>i&&Date.parse(a.time)<Date.parse(entries[i-1].time)))throw new Error('Invalid sequence');
  return entries;
}
async function referenceHistory(tag, title) {
  if (!tag || tag.length > 100) throw new Error('Enter the player’s gamertag');
  const profile = await xau('/api/profile/gt/' + encodeURIComponent(tag));
  const people = profile?.People ?? profile?.people;
  const xuid = people?.[0]?.Xuid ?? people?.[0]?.xuid;
  if (!xuid) throw new Error('Could not resolve the player’s XUID');
  const token = (await xau('/api/xauth?format=json'))?.token;
  if (typeof token !== 'string' || !token.trim()) throw new Error('XAU did not return Xbox authorization');
  const result = []; const seenTokens = new Set(); let continuation;
  do {
    const url = new URL(`/users/xuid(${id(xuid)})/achievements`, process.env.XBOX_ACHIEVEMENTS_ORIGIN || 'https://achievements.xboxlive.com');
    url.searchParams.set('titleId', id(title)); url.searchParams.set('maxItems', '1000');
    if (continuation) url.searchParams.set('continuationToken', continuation);
    let page;
    try { page = await get(url, { headers: { Authorization: token, 'x-xbl-contract-version': '4', Accept: 'application/json' } }); }
    catch (error) { throw new Error('Xbox player history request failed: ' + error.message); }
    if (!Array.isArray(page?.achievements)) throw new Error('Xbox did not return the player’s achievements');
    result.push(...page.achievements);
    continuation = page.pagingInfo?.continuationToken;
    if (continuation && (seenTokens.has(continuation) || seenTokens.size >= 100)) throw new Error('Could not load the complete Xbox history');
    if (continuation) seenTokens.add(continuation);
  } while (continuation);
  const entries = [];
  for (const achievement of result) {
    if (String(achievement.progressState || '').toLowerCase() !== 'achieved') continue;
    const time = achievement.progression?.timeUnlocked;
    if (!time || !Number.isFinite(Date.parse(time)) || Date.parse(time) < Date.UTC(2005, 0, 1)) throw new Error('An unlocked achievement has no valid timestamp: ' + (achievement.name || achievement.id));
    entries.push({ id: id(achievement.id), name: String(achievement.name || achievement.id), time: new Date(time).toISOString() });
  }
  if (!entries.length) throw new Error('The player has no accessible unlocked achievements in this game');
  if (new Set(entries.map(a => a.id)).size !== entries.length) throw new Error('Xbox returned duplicate achievements');
  entries.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  let minutesPlayed = null;
  try {
    const stats = await get(new URL('/batch', process.env.XBOX_USERSTATS_ORIGIN || 'https://userstats.xboxlive.com'), {
      method:'POST', headers:{Authorization:token, 'x-xbl-contract-version':'2', Accept:'application/json', 'Content-Type':'application/json'},
      body:JSON.stringify({ArrangeByField:'xuid', Xuids:[id(xuid)], Stats:[{Name:'MinutesPlayed',TitleId:id(title)}]})
    });
    const lists=stats?.statListsCollection ?? stats?.StatListsCollection ?? [];
    for(const list of lists){for(const stat of list.stats ?? list.Stats ?? []){
      const name=stat.name ?? stat.Name;const value=Number(stat.value ?? stat.Value);
      if(typeof name==='string' && name.toLowerCase()==='minutesplayed' && Number.isFinite(value) && value>0) minutesPlayed=value;
    }}
  } catch { /* Some games or profiles do not expose playtime. */ }
  return { entries, minutesPlayed };

}

let autoAuth = { status:'idle' }, autoAuthEnabled = process.platform === 'win32' && process.env.XAU_DESKTOP === '1' && !XAU, nextAutoCheck = 0;
async function autoConnect() {
  if (!autoAuthEnabled || Date.now() < nextAutoCheck || busy || mutating || spoof.status === 'running' || (state.status === 'running' && state.dueAt - Date.now() < 180000)) return;
  const existing = loginStatus();
  if (existing.status === 'signed_in' && existing.source !== 'xbox-pc') return;
  mutating=true; autoAuth={status:'connecting'};
  try {
    await ensureXboxPc();
    if (existing.status !== 'signed_in') await new Promise(resolve=>setTimeout(resolve,5000));
    await attachXboxPc({expectedXuid:currentSessionXuid()});
    clearResponseCache(); autoAuth={status:'connected'}; nextAutoCheck=Date.now()+300000;
  } catch(e) { autoAuth={status:'waiting',error:e.message || 'Could not connect to Xbox PC'}; nextAutoCheck=Date.now()+30000; }
  finally { mutating=false; }
}
const autoAuthTimer=autoAuthEnabled ? setInterval(autoConnect,5000) : null; if(autoAuthEnabled) void autoConnect();
async function tick() {
  if (!XAU && loginStatus().status==='restoring') return;
  if (busy || mutating) return;
  busy = true;
  try {
    if (spoof.status === 'running' && Date.now() - (spoof.lastUpdatedAt || spoof.startedAt) >= 10000) { spoof.lastUpdatedAt = Date.now(); await saveSpoof(); }
    if (spoof.status === 'running' && Date.now() >= spoof.nextHeartbeat) {
      try {
        if (!XAU && loginStatus().source==='xbox-pc') { if (autoAuthEnabled) await ensureXboxPc(); await attachXboxPc({expectedXuid:spoof.accountXuid}); }
        if (await currentXuid() !== spoof.accountXuid) throw new Error('The Xbox account changed');
        const now = Date.now();
        const result = await xau('/api/spoof/' + id(spoof.titleId));
        if (result?.message !== 'Spoofing started successfully.' || String(result.titleId) !== spoof.titleId) throw new Error('Invalid spoof response');
        spoof.nextHeartbeat = now + 290000;
      } catch (e) { spoof = { ...spoof, status:'error', endedAt:Date.now(), error:e.message || 'Presence update failed' }; delete spoof.accountXuid; await saveSpoof(); }
    }
    if (state.status !== 'running') return;
    await requireTitleBased(state.titleId);
    if (state.status !== 'running' || Date.now() < state.dueAt) return;
    const item = state.entries[state.index];
    if (!item) { state.status = 'completed'; await save(); return; }
    const progress = await achievementStatus(item.id);
    if (progress !== 'achieved') {
      const availableAt = (state.lastUnlockAt || 0) + MIN_UNLOCK_INTERVAL;
      if (Date.now() < availableAt) { state.dueAt = availableAt; await save(); return; }
      state.inFlight = item.id; state.lastUnlockAt = Date.now(); log(`Request: ${item.name}`); await save();
      clearResponseCache();
      const result = await xau('/api/achievements/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ titleId: state.titleId, achievementId: item.id }) });
      if (!result || typeof result !== 'object' || result.message !== 'Achievement unlocked successfully' || String(result.titleId) !== state.titleId || String(result.achievementId) !== item.id) throw new Error('XAU returned an invalid response to the unlock request');
      delete state.inFlight; log(`Sent: ${item.name}`); advance(item, 'sent');
    } else { log(`Already unlocked, skipped: ${item.name}`); advance(item, 'already'); }
    await save();
  } catch (e) {
    state.status = 'paused'; state.remaining = Math.max(0, (state.dueAt || Date.now()) - Date.now());
    const reason = e.name === 'TimeoutError' ? 'The XAU request timed out.' : e.message;
    state.error = (state.inFlight ? 'The unlock result may be unknown. Check the achievement before continuing. ' : '') + reason;
    if (state.inFlight) state.uncertainId = state.inFlight;
    delete state.inFlight; log('Queue stopped: ' + state.error); await save();
  } finally { busy = false; }
}
const tickTimer = setInterval(tick, 1000); tick();
const clients = new Map();
let hadClient = false, closeDeadline = null, shuttingDown = false;
const CLOSE_GRACE_MS = 20000, CLIENT_EXPIRY_MS = 600000;
const clientTimer = setInterval(() => {
  const now = Date.now();
  for (const [client, seen] of clients) if (now - seen > CLIENT_EXPIRY_MS) clients.delete(client);
  if (!hadClient || clients.size || shuttingDown) return;
  if (closeDeadline === null) closeDeadline = now + CLOSE_GRACE_MS;
  if (now < closeDeadline || busy || mutating) return;
  shuttingDown = true; clearInterval(tickTimer); clearInterval(clientTimer); if(autoAuthTimer) clearInterval(autoAuthTimer);
  console.log('All pages are closed; stopping the server.');
  server.close();
}, 1000);
const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
async function body(req) { let s = ''; for await (const chunk of req) { s += chunk; if (s.length > 2_000_000) throw new Error('Request is too large'); } return JSON.parse(s || '{}'); }
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'Invalid request origin' });
    if (req.method === 'POST' && ['/api/client/heartbeat', '/api/client/close'].includes(url.pathname)) {
      const b = await body(req);
      if (typeof b.id !== 'string' || !/^[a-zA-Z0-9-]{10,100}$/.test(b.id)) throw new Error('Invalid page identifier');
      if (url.pathname.endsWith('/heartbeat')) { hadClient = true; clients.set(b.id, Date.now()); closeDeadline = null; }
      else if (clients.delete(b.id) && !clients.size) closeDeadline = Date.now() + CLOSE_GRACE_MS;
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/settings') return json(res,200,settings);
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const b = await body(req);
      if (typeof b.key !== 'string' || !/^(?:xau-game-filters|xau-(?:profile-stats|profile-totals|selection):\d+)$/.test(b.key) || typeof b.value !== 'string' || b.value.length > 1_000_000) throw new Error('Invalid setting');
      await saveSetting(b.key,b.value); return json(res,200,{ok:true});
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/status') return json(res, 200, XAU ? {status:'external'} : {...loginStatus(), autoAuth});
    if (req.method === 'POST' && url.pathname === '/api/auth/attach') { if (XAU) throw new Error('Xbox PC connection is unavailable with an external XAU server'); if (spoof.status === 'running' || state.status === 'running' || busy || mutating) throw new Error('Stop spoofing and pause the queue before changing accounts'); mutating=true; autoAuthEnabled=process.platform==='win32' && process.env.XAU_DESKTOP==='1'; autoAuth={status:'connecting'}; try { await attachXboxPc(); autoAuth={status:'connected'}; nextAutoCheck=Date.now()+300000; clearResponseCache(); return json(res,200,loginStatus()); } catch(e) {autoAuth={status:'waiting',error:e.message || 'Could not connect to Xbox PC'}; nextAutoCheck=Date.now()+30000; throw e;} finally {mutating=false;} }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') { if (XAU) throw new Error('Sign out is unavailable with an external XAU server'); if (spoof.status === 'running' || state.status === 'running' || busy || mutating) throw new Error('Stop spoofing, pause the queue and wait for the current request before signing out'); mutating=true; autoAuthEnabled=false; autoAuth={status:'idle'}; try {await signOut(); clearResponseCache(); return json(res, 200, loginStatus());} finally {mutating=false;} }
    if (req.method === 'POST' && url.pathname === '/api/cache/refresh') { clearResponseCache(); return json(res, 200, { ok: true }); }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state);
    if (req.method === 'GET' && url.pathname === '/api/spoofer') { const {accountXuid, ...view} = spoof; return json(res, 200, view); }
    if (req.method === 'POST' && ['/api/spoofer/start','/api/spoofer/stop'].includes(url.pathname)) {
      if (busy || mutating) throw new Error('Wait for the current request to finish and try again');
      mutating = true;
      try {
        if (url.pathname.endsWith('/start')) {
          if (spoof.status === 'running') throw new Error('Stop the current spoof first');
          const b=await body(req), titleId=id(b.titleId);
          if (!XAU && loginStatus().source==='xbox-pc') await attachXboxPc({expectedXuid:currentSessionXuid()});
          const accountXuid=await currentXuid();
          const result=await xau('/api/spoof/'+titleId);
          if(result?.message !== 'Spoofing started successfully.' || String(result.titleId)!==titleId) throw new Error('Invalid spoof response');
          const startedAt=Date.now();
          spoof={status:'running',titleId,accountXuid,startedAt,lastUpdatedAt:startedAt,nextHeartbeat:startedAt+290000};
          await saveSpoof();
        } else {
          if (spoof.status === 'running' && !XAU) {
            if (await currentXuid() !== spoof.accountXuid) throw new Error('The Xbox account changed');
            await xboxApi('/api/spoof-stop');
          }
          spoof={...spoof,status:'idle',endedAt:Date.now(),...(XAU ? {notice:'Presence may remain until it expires.'} : {notice:'Stopped.'})};
          delete spoof.accountXuid; await saveSpoof();
        }
        const {accountXuid, ...view}=spoof; return json(res,200,view);
      } finally { mutating=false; }
    }
    if (req.method === 'GET' && url.pathname === '/api/stats') {
      return json(res,200,{stats:await statsService.read(id(url.searchParams.get('title')))});
    }
    if (req.method === 'POST' && url.pathname === '/api/stats') {
      if (busy || mutating) throw new Error('Wait for the current request to finish and try again');
      mutating=true;
      try {const b=await body(req);return json(res,200,await statsService.write({title:id(b.title),name:b.name,scid:b.scid,value:b.value}));}
      finally {mutating=false;}
    }
    if (req.method === 'GET' && url.pathname === '/api/playtime') {
      const title = id(url.searchParams.get('title')), xuid = await currentXuid();
      const token = (await xau('/api/xauth?format=json'))?.token;
      if (typeof token !== 'string' || !token.trim()) throw new Error('Xbox authorization is unavailable');
      const stats = await get(new URL('/batch', process.env.XBOX_USERSTATS_ORIGIN || 'https://userstats.xboxlive.com'), {
        method:'POST', headers:{Authorization:token, 'x-xbl-contract-version':'2', Accept:'application/json', 'Content-Type':'application/json'},
        body:JSON.stringify({ArrangeByField:'xuid', Xuids:[xuid], Stats:[{Name:'MinutesPlayed',TitleId:title}]})
      });
      let minutesPlayed = null;
      for (const list of stats?.statListsCollection ?? stats?.StatListsCollection ?? []) for (const stat of list.stats ?? list.Stats ?? []) {
        const name=stat.name ?? stat.Name, raw=stat.value ?? stat.Value, value=Number(raw);
        if (typeof name === 'string' && name.toLowerCase() === 'minutesplayed' && raw !== null && raw !== undefined && raw !== '' && Number.isFinite(value) && value >= 0) minutesPlayed=value;
      }
      return json(res,200,{minutesPlayed,updatedAt:Date.now()});
    }
    if (req.method === 'GET' && url.pathname === '/api/profile') return json(res, 200, await cachedXau('/api/profile/me'));
    if (req.method === 'GET' && url.pathname === '/api/game') return json(res, 200, await cachedXau('/api/games/search/titleid/' + id(url.searchParams.get('title'))));
    if (req.method === 'GET' && url.pathname === '/api/games') return json(res, 200, await cachedXau('/api/games/me'));
    if (req.method === 'GET' && url.pathname === '/api/achievements') return json(res, 200, await cachedXau('/api/achievements/' + id(url.searchParams.get('title'))));
    if (req.method === 'GET' && url.pathname === '/api/title-based/catalog') return json(res, 200, { titles: [...(await titleCatalog())].filter(([, value]) => value === true).map(([title]) => title) });
    if (req.method === 'GET' && url.pathname === '/api/title-based') return json(res, 200, { titleBased: await titleBased(id(url.searchParams.get('title'))) });
    if (req.method === 'GET' && url.pathname === '/api/uncertain') { if (state.status !== 'paused' || !state.uncertainId) throw new Error('There is no uncertain result'); return json(res, 200, { id: state.uncertainId, progress: await achievementStatus(state.uncertainId) }); }
    if (req.method === 'GET' && url.pathname === '/api/history') return json(res, 200, await referenceHistory((url.searchParams.get('tag') || '').trim(), id(url.searchParams.get('title'))));
    if (req.method === 'POST' && ['/api/start', '/api/pause', '/api/resume', '/api/reset', '/api/resolve', '/api/reschedule'].includes(url.pathname)) {
      if (busy || mutating) throw new Error('Wait for the current request to finish and try again');
      mutating = true;
      try {
    if (req.method === 'POST' && url.pathname === '/api/start') {
      if (busy || state.status === 'running' || state.status === 'paused') throw new Error('Finish or reset the current queue first');
      const b = await body(req); const titleId = id(b.titleId);
      await requireTitleBased(titleId);
      const entries = parseEntries(b.entries);
      const accountXuid = await currentXuid();
      state = { status: 'running', lastUnlockAt: state.lastUnlockAt || 0, accountXuid, titleId, game: String(b.game || ''), tag: String(b.tag || ''), entries, index: 0, dueAt: Date.now() + (entries[0].delayMs || 0), log: [], results: {} }; log('Queue started'); await save(); return json(res, 200, state);
    }
    if (req.method === 'POST' && url.pathname === '/api/pause') { if (state.status !== 'running') throw new Error('Copying is not running'); state.status = 'paused'; state.remaining = Math.max(0, state.dueAt - Date.now()); log('Queue paused'); await save(); return json(res, 200, state); }
    if (req.method === 'POST' && url.pathname === '/api/resume') { if (state.status !== 'paused' || busy) throw new Error('Cannot resume right now'); if (state.uncertainId) throw new Error('Choose an action for the unconfirmed achievement first'); await requireAccount(); state.status = 'running'; state.dueAt = Date.now() + (state.remaining || 0); delete state.error; log('Queue resumed'); await save(); return json(res, 200, state); }
    if (req.method === 'POST' && url.pathname === '/api/resolve') {
      if (state.status !== 'paused' || !state.uncertainId) throw new Error('There is no uncertain result');
      const b = await body(req); if (!['skip', 'retry'].includes(b.choice)) throw new Error('Choose an action');
      const item = state.entries[state.index];
      if (!item || item.id !== state.uncertainId || b.id !== item.id) throw new Error('The queue state has changed');
      const progress = await achievementStatus(item.id);
      delete state.uncertainId; delete state.error;
      if (b.choice === 'skip' || progress === 'achieved') {
        log(`${progress === 'achieved' ? 'Confirmed' : 'Skipped by user'}: ${item.name}`);
        advance(item, progress === 'achieved' ? 'already' : 'skipped');
      } else { log(`Retry approved by user: ${item.name}`); state.dueAt = Math.max(Date.now() + (state.remaining || 0), (state.lastUnlockAt || 0) + MIN_UNLOCK_INTERVAL); }
      if (state.status !== 'completed') state.status = 'running';
      await save(); return json(res, 200, state);
    }
    if (req.method === 'POST' && url.pathname === '/api/reschedule') {
      if(state.status!=='paused') throw new Error('Pause the queue before updating its schedule');
      if(state.uncertainId) throw new Error('Resolve the uncertain achievement before changing the queue');
      const b=await body(req);if(id(b.titleId)!==state.titleId)throw new Error('The queue belongs to a different game');
      const updated=parseEntries(b.entries);
      if(updated.some(item=>item.delayMs===undefined))throw new Error('Every achievement needs a planned interval');
      const processed=state.entries.slice(0,state.index);const processedIds=new Set(processed.map(item=>item.id));
      const remaining=updated.filter(item=>!processedIds.has(item.id));
      if(!remaining.length)throw new Error('There are no remaining selected achievements');
      const current=state.entries[state.index];
      const oldDelay=Number.isSafeInteger(current?.delayMs)?current.delayMs:state.index>0?Math.max(0,Date.parse(current.time)-Date.parse(state.entries[state.index-1].time)):0;
      const elapsed=current?.id===remaining[0].id?Math.max(0,oldDelay-(state.remaining||0)):0;
      state.entries=[...processed,...remaining];state.remaining=Math.max(0,remaining[0].delayMs-elapsed);state.tag=String(b.tag||'');
      delete state.error;log('Queue schedule updated');await save();return json(res,200,state);
    }
    if (req.method === 'POST' && url.pathname === '/api/reset') { const b=await body(req); if(b.titleId!==undefined && id(b.titleId)!==state.titleId) throw new Error('The queue has changed; refresh and try again'); if (busy || state.status === 'running') throw new Error('Pause copying and wait for the request to finish first'); state = { status: 'idle', lastUnlockAt: state.lastUnlockAt || 0 }; await save(); return json(res, 200, state); }
      } finally { mutating = false; }
    }
    const files = { '/': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'], '/timing.js': ['timing.js','text/javascript'], '/style.css': ['style.css','text/css'], '/spoof-panel.js': ['spoof-panel.js','text/javascript'], '/stats-panel.js': ['stats-panel.js','text/javascript'] }; const file = files[url.pathname] || (/^\/games(?:\/\d+)?\/?$/.test(url.pathname) ? ['index.html','text/html'] : undefined);
    if (req.method === 'GET' && file) { const content=await readFile(join('public', file[0])); res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8', 'Cache-Control':'no-store' }); return res.end(content); }
    json(res, 404, { error: 'Not found' });
  } catch (e) { json(res, e.status === 429 ? 429 : 400, { error: e.message || 'Request failed', ...(e.status === 429 ? {retryAfter:e.retryAfter} : {}) }); }
});
server.requestTimeout = 25000;
server.headersTimeout = 26000;
server.listen(PORT, '127.0.0.1', () => console.log(`XAU Companion: http://127.0.0.1:${server.address().port} (backend: ${XAU || 'Xbox API'})`));
