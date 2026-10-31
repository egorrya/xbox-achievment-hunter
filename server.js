import http from 'node:http';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MIN_INTERVAL_MS } from './public/timing.js';
import { xboxApi, loginStatus, signOut, attachXboxPc, currentSessionXuid } from './xbox-client.js';
import { ensureXboxPc, waitForXboxPcAuthorization } from './windows-auth.js';
import { createStatsService, parseStats } from './stats.js';
import { steamProfileUrl } from './public/steam.js';
import { connectionView, queueView, spoofView, xboxRecoveryAction } from './auth-state.js';
import { singleFlight } from './connection-flight.js';

const PORT = Number(process.env.PORT || 3000);
const XAU = process.env.XAU_URL?.replace(/\/$/, '');
const CATALOG_URL = process.env.TITLE_CATALOG_URL || 'https://raw.githubusercontent.com/Fumo-Unlockers/XboxGames/main/xbox_games.json';
const MIN_UNLOCK_INTERVAL = MIN_INTERVAL_MS;
const STATE_FILE = process.env.STATE_FILE || join(process.cwd(), 'state.json');
const startupWarnings=[];
async function readSavedObject(file,label,fallback) {
  let content;
  try { content=await readFile(file,'utf8'); } catch(error) { if(error.code==='ENOENT')return fallback; throw error; }
  try {
    const value=JSON.parse(content);
    if (!value || typeof value!=='object' || Array.isArray(value)) throw new SyntaxError('Invalid saved object');
    return value;
  } catch(error) {
    if (!(error instanceof SyntaxError)) throw error;
    const backup=file+'.invalid-'+randomUUID();
    await rename(file,backup);
    startupWarnings.push(`Could not read saved ${label}. The original file was preserved as ${basename(backup)}. ${label==='queue'?'The queue has been stopped.':''}`.trim());
    return fallback;
  }
}
let state = await readSavedObject(STATE_FILE,'queue',{status:'idle'}), busy = false, mutating = false, shuttingDown = false;
let autoResumeQueue = null;
if (state.inFlight) { state.uncertainId = state.inFlight; state.status = 'paused'; state.remaining = Math.max(0, (state.dueAt || Date.now()) - Date.now()); state.error = 'The result of the previous request is unknown. Check the achievement before continuing.'; state.log = [...(state.log || []), {time: new Date().toISOString(), message: 'Queue stopped: ' + state.error}].slice(-200); delete state.inFlight; }
if (process.env.XAU_DESKTOP === '1' && state.status === 'running') { state.status='paused'; state.remaining=Math.max(0, (state.dueAt || Date.now())-Date.now()); state.error='The app closed. Resume the queue when ready.'; }
const SPOOF_FILE = STATE_FILE + '.spoof';
let spoof = await readSavedObject(SPOOF_FILE,'spoof session',{status:'idle'});
const interruptedSpoofTitle = ['running','recovering'].includes(spoof.status) ? spoof.titleId : null;
if (['running','recovering'].includes(spoof.status)) spoof = { ...spoof, status:'idle', endedAt:spoof.lastUpdatedAt || spoof.startedAt, notice:'Previous session was interrupted when the app closed. Start it again.' };
async function saveSpoof() {
  const tmp = SPOOF_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(spoof));
  await rename(tmp, SPOOF_FILE);
}

const SETTINGS_FILE = STATE_FILE + '.settings';
let settings = await readSavedObject(SETTINGS_FILE,'settings',{});
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
await mkdir(dirname(STATE_FILE), {recursive:true});
await save();
function log(message) {
  state.log = [...(state.log || []), { time: new Date().toISOString(), message }].slice(-200);
}
async function pauseForStoppedSpoof(titleId) {
  if (!titleId || !['running','paused'].includes(state.status)) return;
  if (state.status === 'running') {
    state.status='paused'; state.remaining=Math.max(0,(state.dueAt || Date.now())-Date.now());
    state.error='Spoof stopped. Start it again before resuming the queue.';
    log('Queue paused because spoof stopped');
  }
  state.spoofRequiredTitle ||= titleId;
  await save();
}
function requireSpoofForResume() {
  if (state.spoofRequiredTitle && (spoof.status!=='running' || spoof.titleId!==state.spoofRequiredTitle)) throw new Error('Start the stopped spoof again before resuming the queue');
}
if (interruptedSpoofTitle) await pauseForStoppedSpoof(interruptedSpoofTitle);
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
    error.status=response.status;
    if(response.status===429){error.status=429;const value=response.headers.get('retry-after');const seconds=Number(value);const date=Date.parse(value);error.retryAfter=value && Number.isFinite(seconds) ? Math.max(0,seconds) : Number.isFinite(date) ? Math.max(0,Math.ceil((date-Date.now())/1000)) : 30;}
    throw error;
  }
  return data;
}
const xau = (path, options) => XAU ? get(XAU + path, options) : xboxApi(path, options);
async function steamGet(url) {
  const origin=url.origin, signal=AbortSignal.timeout(20000);
  for(let redirects=0;redirects<=3;redirects++){
    const response=await fetch(url,{signal,redirect:'manual',headers:{'Accept-Language':'en-US,en;q=0.9'}});
    if(response.status>=300&&response.status<400){const location=response.headers.get('location');if(!location)throw new Error('Steam returned an invalid redirect.');url=new URL(location,url);if(url.origin!==origin)throw new Error('Steam returned an unexpected redirect.');continue;}
    if(!response.ok)throw new Error(`Steam request failed (HTTP ${response.status}).`);
    if(Number(response.headers.get('content-length'))>5_000_000)throw new Error('Steam response is too large.');
    const data=await response.text();if(data.length>5_000_000)throw new Error('Steam response is too large.');return data;
  }
  throw new Error('Too many Steam redirects.');
}
let statCatalogPromise, statCatalogExpires=0;
async function statMode(title) {
  if (!statCatalogPromise || Date.now() >= statCatalogExpires) {
    const root='https://raw.githubusercontent.com/Achievement-Labs/achievement-labs/de5fa46b6b775c12fab1d2814621651962250f65/src/AchievementLabs.App/StatsCatalog/';
    statCatalogExpires=Date.now()+86400000;
    statCatalogPromise=Promise.all(['TitleBasedStats.txt','EventBasedStats.txt'].map(name=>get(root+name))).then(files=>files.map(file=>new Set(String(file).split(/\r?\n/).map(line=>line.match(/^\s*(\d+)\s*-/)?.[1]).filter(Boolean)))).catch(error=>{statCatalogPromise=undefined;statCatalogExpires=0;throw error;});
  }
  const [titleBased,eventBased]=await statCatalogPromise;
  return eventBased.has(title)?'event':titleBased.has(title)?'title':'unknown';
}
const statsService = createStatsService({ xau: path => path==='/api/games/me' || path.startsWith('/api/achievements/') || path.startsWith('/api/games/search/titleid/') ? cachedXau(path) : xau(path), statMode });
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
    const value=Number(parseStats(stats).find(stat=>stat.name.toLowerCase()==='minutesplayed')?.value);
    if (Number.isFinite(value) && value>0) minutesPlayed=value;
  } catch { /* Some games or profiles do not expose playtime. */ }
  return { entries, minutesPlayed };

}

let autoAuth = { status:'idle' }, autoAuthEnabled = process.platform === 'win32' && process.env.XAU_DESKTOP === '1' && !XAU, nextAutoCheck = 0, authRecoveryRequired=false;
function scheduleXboxRecovery(error) {
  const action=xboxRecoveryAction(error,{external:Boolean(XAU),enabled:autoAuthEnabled,source:loginStatus().source});
  if (action==='reauthorize') {authRecoveryRequired=true;autoAuth={status:'waiting',needsReconnect:true,error:'Xbox authorization expired. Reconnecting to the Xbox PC app.'};nextAutoCheck=0;}
  else if (action==='retry') nextAutoCheck=0;
}
const connectXboxPc = singleFlight(async () => {
  const existing = loginStatus();
  if (shuttingDown || busy || mutating || spoof.status === 'running' || (state.status === 'running' && (existing.status!=='signed_in' || state.dueAt-Date.now()<180000))) throw new Error('Wait for the current operation to finish before connecting Xbox.');
  mutating=true; autoAuth={status:existing.status==='signed_in'&&!authRecoveryRequired?'refreshing':'connecting',...(authRecoveryRequired?{needsReconnect:true}:{})};
  try {
    await ensureXboxPc();
    await waitForXboxPcAuthorization(({signal})=>attachXboxPc({expectedXuid:currentSessionXuid(),signal}));
    clearResponseCache(); authRecoveryRequired=false; autoAuth={status:'connected'}; nextAutoCheck=Date.now()+300000;
    return loginStatus();
  } catch(e) { autoAuth={status:'waiting',...(authRecoveryRequired?{needsReconnect:true}:{}),error:e.message || 'Could not connect to Xbox PC'}; nextAutoCheck=Date.now()+30000; throw e; }
  finally { mutating=false; }
});
async function autoConnect() {
  if (shuttingDown || !autoAuthEnabled || Date.now() < nextAutoCheck || busy || mutating || spoof.status === 'running' || (state.status === 'running' && state.dueAt-Date.now()<180000)) return;
  const existing = loginStatus();
  if (existing.status === 'signed_in' && existing.source !== 'xbox-pc') return;
  try { await connectXboxPc(); } catch { /* Status is exposed to the UI; retry later. */ }
}
const autoAuthTimer=autoAuthEnabled ? setInterval(autoConnect,5000) : null; if(autoAuthEnabled) void autoConnect();
async function tick() {
  if (!XAU && loginStatus().status==='restoring') return;
  if (shuttingDown || busy || mutating) return;
  busy = true;
  try {
    if (spoof.status === 'running' && Date.now() - (spoof.lastUpdatedAt || spoof.startedAt) >= 10000) { spoof.lastUpdatedAt = Date.now(); await saveSpoof(); }
    if (['running','recovering'].includes(spoof.status) && Date.now() >= spoof.nextHeartbeat) {
      try {
        if (!XAU && loginStatus().source==='xbox-pc') { if (autoAuthEnabled) await ensureXboxPc(); await attachXboxPc({expectedXuid:spoof.accountXuid}); }
        if (await currentXuid() !== spoof.accountXuid) throw new Error('The Xbox account changed');
        const now = Date.now();
        const result = await xau('/api/spoof/' + id(spoof.titleId));
        if (result?.message !== 'Spoofing started successfully.' || String(result.titleId) !== spoof.titleId) throw new Error('Invalid spoof response');
        const wasRecovering = spoof.status === 'recovering';
        spoof.status = 'running'; spoof.nextHeartbeat = now + 290000;
        delete spoof.error; delete spoof.endedAt; delete spoof.notice;
        if (wasRecovering && autoResumeQueue === state && state.status === 'paused' && !state.uncertainId && state.spoofRequiredTitle === spoof.titleId && state.accountXuid === spoof.accountXuid) {
          state.status='running'; state.dueAt=Date.now()+(state.remaining || 0);
          delete state.error; delete state.spoofRequiredTitle; log('Queue resumed after spoof reconnected'); await save();
        }
        autoResumeQueue = null;
        if (wasRecovering) await saveSpoof();
      } catch (e) {
        scheduleXboxRecovery(e); const stoppedTitle=spoof.titleId;
        if (e.status === 503) {
          if (spoof.status === 'running') {
            autoResumeQueue = state.status === 'running' && state.accountXuid === spoof.accountXuid ? state : null;
            await pauseForStoppedSpoof(stoppedTitle);
          }
          spoof = { ...spoof, status:'recovering', nextHeartbeat:Date.now()+30000, error:e.message || 'Presence update failed' };
        } else {
          autoResumeQueue = null;
          spoof = { ...spoof, status:'error', endedAt:Date.now(), error:e.message || 'Presence update failed' };
          await pauseForStoppedSpoof(stoppedTitle);
        }
        await saveSpoof();
      }
    }
    if (state.status !== 'running' || Date.now() < state.dueAt) return;
    await requireTitleBased(state.titleId);
    if (shuttingDown || state.status !== 'running' || Date.now() < state.dueAt) return;
    const item = state.entries[state.index];
    if (!item) { state.status = 'completed'; await save(); return; }
    const progress = await achievementStatus(item.id);
    if (shuttingDown) return;
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
let hadClient = false, closeDeadline = null;
const CLOSE_GRACE_MS = 20000, CLIENT_EXPIRY_MS = 600000;
const clientTimer = setInterval(() => {
  const now = Date.now();
  for (const [client, seen] of clients) if (now - seen > CLIENT_EXPIRY_MS) clients.delete(client);
  // Electron owns the backend lifetime; pagehide can also occur while its window remains open.
  if (process.env.XAU_DESKTOP === '1' || !hadClient || clients.size || shuttingDown) return;
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
    if (shuttingDown) return json(res, 503, {error:'Application is closing'});
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'Invalid request origin' });
    if (req.method === 'POST' && ['/api/client/heartbeat', '/api/client/close'].includes(url.pathname)) {
      const b = await body(req);
      if (typeof b.id !== 'string' || !/^[a-zA-Z0-9-]{10,100}$/.test(b.id)) throw new Error('Invalid page identifier');
      if (url.pathname.endsWith('/heartbeat')) { hadClient = true; clients.set(b.id, Date.now()); closeDeadline = null; }
      else if (clients.delete(b.id) && !clients.size) closeDeadline = Date.now() + CLOSE_GRACE_MS;
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/startup-warnings') return json(res,200,{warnings:startupWarnings});
    if (req.method === 'GET' && url.pathname === '/api/settings') return json(res,200,settings);
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const b = await body(req);
      if (typeof b.key !== 'string' || !/^(?:xau-game-filters|xau-(?:profile-stats|profile-totals):\d+|xau-selection:\d+:\d+|steam-profile:\d+)$/.test(b.key) || typeof b.value !== 'string' || b.value.length > 1_000_000) throw new Error('Invalid setting');
      await saveSetting(b.key,b.value); return json(res,200,{ok:true});
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/status') { const auth=XAU ? {status:'external'} : connectionView(loginStatus(),autoAuth); if(auth.status==='signed_in'||auth.status==='external') auth.xuid=XAU ? await currentXuid() : currentSessionXuid(); return json(res,200,auth); }
    if (req.method === 'POST' && url.pathname === '/api/auth/attach') { if (XAU) throw new Error('Xbox PC connection is unavailable with an external XAU server'); autoAuthEnabled=process.platform==='win32' && process.env.XAU_DESKTOP==='1'; return json(res,200,await connectXboxPc()); }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') { if (XAU) throw new Error('Sign out is unavailable with an external XAU server'); if (['running','recovering'].includes(spoof.status) || state.status === 'running' || busy || mutating) throw new Error('Stop spoofing, pause the queue and wait for the current request before signing out'); mutating=true; autoAuthEnabled=false; autoAuth={status:'idle'}; try {await signOut(); clearResponseCache(); return json(res, 200, loginStatus());} finally {mutating=false;} }
    if (req.method === 'POST' && url.pathname === '/api/cache/refresh') { clearResponseCache(); return json(res, 200, { ok: true }); }
    if (req.method === 'GET' && url.pathname === '/api/state') { if(state.status==='idle')return json(res,200,{status:'idle'}); const xuid=XAU ? await currentXuid() : currentSessionXuid();return json(res, 200, queueView(state,{external:Boolean(XAU),status:connectionView(loginStatus(),autoAuth).status,autoStatus:autoAuth.status,xuid})); }
    if (req.method === 'GET' && url.pathname === '/api/spoofer') { if(!spoof.accountXuid)return json(res,200,{status:'idle'});const status=connectionView(loginStatus(),autoAuth).status; const xuid=XAU ? await currentXuid() : currentSessionXuid(); return json(res, 200, spoofView(spoof,{external:Boolean(XAU),status,xuid})); }
    if (req.method === 'POST' && ['/api/spoofer/start','/api/spoofer/stop'].includes(url.pathname)) {
      if (busy || mutating) throw new Error('Wait for the current request to finish and try again');
      mutating = true;
      try {
        if (url.pathname.endsWith('/start')) {
          if (['running','recovering'].includes(spoof.status)) throw new Error('Stop the current spoof first');
          const b=await body(req), titleId=id(b.titleId);
          let accountXuid,result;
          try {
            if (!XAU && loginStatus().source==='xbox-pc') await attachXboxPc({expectedXuid:currentSessionXuid()});
            accountXuid=await currentXuid();
            result=await xau('/api/spoof/'+titleId);
          } catch(e) { scheduleXboxRecovery(e); throw e; }
          if(result?.message !== 'Spoofing started successfully.' || String(result.titleId)!==titleId) throw new Error('Invalid spoof response');
          const startedAt=Date.now();
          spoof={status:'running',titleId,accountXuid,startedAt,lastUpdatedAt:startedAt,nextHeartbeat:startedAt+290000};
          await saveSpoof();
        } else {
          if (spoof.accountXuid && await currentXuid() !== spoof.accountXuid) throw new Error('The spoof session belongs to another Xbox account');
          autoResumeQueue = null;
          if (spoof.status === 'running') await pauseForStoppedSpoof(spoof.titleId);
          if (spoof.status === 'running' && !XAU) {
            if (await currentXuid() !== spoof.accountXuid) throw new Error('The Xbox account changed');
            await xboxApi('/api/spoof-stop');
          }
          spoof={...spoof,status:'idle',endedAt:Date.now(),...(XAU ? {notice:'Presence may remain until it expires.'} : {notice:'Stopped.'})};
          await saveSpoof();
        }
        const {accountXuid, ...view}=spoof; return json(res,200,view);
      } finally { mutating=false; }
    }
    if (req.method === 'POST' && url.pathname === '/api/achievement/unlock') {
      if (busy || mutating || state.status === 'running' || state.status === 'paused') throw new Error('Finish or reset the copy queue before unlocking an achievement individually');
      mutating=true;
      try {
        const b=await body(req), titleId=id(b.titleId), achievementId=id(b.achievementId);
        await requireTitleBased(titleId);
        const accountXuid=await currentXuid();
        const list=await xau('/api/achievements/'+titleId);
        if (!Array.isArray(list?.achievements)) throw new Error('Could not verify the achievement list');
        const matches=list.achievements.filter(item=>String(item.id)===achievementId);
        if(matches.length!==1 || typeof matches[0].progressState!=='string') throw new Error('Could not verify this achievement');
        const progress=matches[0].progressState.toLowerCase();
        if(progress==='achieved') return json(res,200,{status:'already'});
        if(!['notstarted','inprogress'].includes(progress)) throw new Error('Unknown achievement status');
        if(await currentXuid()!==accountXuid) throw new Error('The Xbox account changed. Reload and try again.');
        if(Date.now()<(state.lastUnlockAt||0)+MIN_UNLOCK_INTERVAL) throw new Error('Wait a moment before unlocking another achievement');
        state.lastUnlockAt=Date.now(); await save(); clearResponseCache();
        let result;
        try { result=await xau('/api/achievements/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({titleId,achievementId})}); }
        catch { throw new Error('The unlock result is unknown. Reload the game to check before trying again.'); }
        if(result?.message!=='Achievement unlocked successfully'||String(result.titleId)!==titleId||String(result.achievementId)!==achievementId) throw new Error('The unlock result is unknown. Reload the game to check before trying again.');
        let confirmed=false;
        try {const after=await xau('/api/achievements/'+titleId);confirmed=Array.isArray(after?.achievements)&&after.achievements.some(item=>String(item.id)===achievementId&&String(item.progressState).toLowerCase()==='achieved');} catch {}
        return json(res,200,{status:confirmed?'confirmed':'sent'});
      } finally {mutating=false;}
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
      const playtime = parseStats(stats).find(stat=>stat.name.toLowerCase()==='minutesplayed');
      const value = playtime?.value === '' || playtime?.value == null ? NaN : Number(playtime.value);
      const minutesPlayed = Number.isFinite(value) && value >= 0 ? value : null;
      return json(res,200,{minutesPlayed,updatedAt:Date.now()});
    }
    if (req.method === 'GET' && url.pathname === '/api/profile') { if(!XAU&&connectionView(loginStatus(),autoAuth).status!=='signed_in')throw new Error('Wait for Xbox connection to finish.'); return json(res, 200, await cachedXau('/api/profile/me')); }
    if (req.method === 'GET' && url.pathname === '/api/game') return json(res, 200, await cachedXau('/api/games/search/titleid/' + id(url.searchParams.get('title'))));
    if (req.method === 'GET' && url.pathname === '/api/games') return json(res, 200, await cachedXau('/api/games/me'));
    if (req.method === 'GET' && url.pathname === '/api/achievements') return json(res, 200, await cachedXau('/api/achievements/' + id(url.searchParams.get('title'))));
    if (req.method === 'GET' && url.pathname === '/api/title-based/catalog') return json(res, 200, { titles: [...(await titleCatalog())].filter(([, value]) => value === true).map(([title]) => title) });
    if (req.method === 'GET' && url.pathname === '/api/title-based') return json(res, 200, { titleBased: await titleBased(id(url.searchParams.get('title'))) });
    if (req.method === 'GET' && url.pathname === '/api/uncertain') { if (state.status !== 'paused' || !state.uncertainId) throw new Error('There is no uncertain result'); return json(res, 200, { id: state.uncertainId, progress: await achievementStatus(state.uncertainId) }); }
    if (req.method === 'GET' && url.pathname === '/api/history') return json(res, 200, await referenceHistory((url.searchParams.get('tag') || '').trim(), id(url.searchParams.get('title'))));
    if (req.method === 'GET' && url.pathname === '/api/steam/profile') {
      const profile=steamProfileUrl(url.searchParams.get('url'));
      const steamUrl=new URL(new URL(profile).pathname,process.env.STEAM_COMMUNITY_ORIGIN||'https://steamcommunity.com');steamUrl.searchParams.set('xml','1');
      const xml=await steamGet(steamUrl);
      if(typeof xml!=='string'||xml.length>2_000_000)throw new Error('Steam did not return a valid profile.');
      return json(res,200,{xml});
    }
    if (req.method === 'GET' && url.pathname === '/api/steam/search') {
      const term=(url.searchParams.get('q')||'').trim();if(!term||term.length>150)throw new Error('Enter a game name.');
      const search=new URL('/api/storesearch/',process.env.STEAM_STORE_ORIGIN||'https://store.steampowered.com');search.search=new URLSearchParams({term,l:'english',cc:'us'}).toString();
      const data=await get(search);if(!Array.isArray(data?.items))throw new Error('Steam game search is unavailable.');
      return json(res,200,{items:data.items.filter(item=>item.type==='app'&&/^\d+$/.test(String(item.id))&&typeof item.name==='string').slice(0,20).map(item=>({id:String(item.id),name:item.name}))});
    }
    if (req.method === 'GET' && url.pathname === '/api/steam/history') {
      const steamId=url.searchParams.get('steamId')||'',appId=url.searchParams.get('appId')||'';
      if(!/^\d{17}$/.test(steamId)||!/^\d{1,10}$/.test(appId))throw new Error('Invalid Steam profile or game.');
      const history=new URL(`/profiles/${steamId}/stats/${appId}/achievements/`,process.env.STEAM_COMMUNITY_ORIGIN||'https://steamcommunity.com');history.search=new URLSearchParams({xml:'1',l:'english'}).toString();
      const content=await steamGet(history);if(typeof content!=='string'||content.length>5_000_000)throw new Error('Steam did not return valid achievement data.');
      return json(res,200,{content});
    }
    if (req.method === 'POST' && ['/api/start', '/api/pause', '/api/resume', '/api/reset', '/api/resolve', '/api/reschedule'].includes(url.pathname)) {
      if (busy || mutating) throw new Error('Wait for the current request to finish and try again');
      mutating = true;
      try {
    if (state.accountXuid && state.status!=='idle' && await currentXuid()!==state.accountXuid) throw new Error('The XAU account changed; switch back to the original account.');
    if (req.method === 'POST' && url.pathname === '/api/start') {
      if (busy || state.status === 'running' || state.status === 'paused') throw new Error('Finish or reset the current queue first');
      const b = await body(req); const titleId = id(b.titleId);
      await requireTitleBased(titleId);
      const entries = parseEntries(b.entries);
      const accountXuid = await currentXuid();
      state = { status: 'running', lastUnlockAt: state.lastUnlockAt || 0, accountXuid, titleId, game: String(b.game || ''), tag: String(b.tag || ''), entries, index: 0, dueAt: Date.now() + (entries[0].delayMs || 0), log: [], results: {} }; log('Queue started'); await save(); return json(res, 200, state);
    }
    if (req.method === 'POST' && url.pathname === '/api/pause') { if (state.status !== 'running') throw new Error('Copying is not running'); state.status = 'paused'; state.remaining = Math.max(0, state.dueAt - Date.now()); log('Queue paused'); await save(); return json(res, 200, state); }
    if (req.method === 'POST' && url.pathname === '/api/resume') { if (state.status !== 'paused' || busy) throw new Error('Cannot resume right now'); if (state.uncertainId) throw new Error('Choose an action for the unconfirmed achievement first'); requireSpoofForResume(); await requireAccount(); state.status = 'running'; state.dueAt = Date.now() + (state.remaining || 0); delete state.error; delete state.spoofRequiredTitle; log('Queue resumed'); await save(); return json(res, 200, state); }
    if (req.method === 'POST' && url.pathname === '/api/resolve') {
      if (state.status !== 'paused' || !state.uncertainId) throw new Error('There is no uncertain result');
      requireSpoofForResume();
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
      delete state.spoofRequiredTitle;
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
      autoResumeQueue=null; state.entries=[...processed,...remaining];state.remaining=Math.max(0,remaining[0].delayMs-elapsed);state.tag=String(b.tag||'');
      delete state.error;log('Queue schedule updated');await save();return json(res,200,state);
    }
    if (req.method === 'POST' && url.pathname === '/api/reset') { const b=await body(req); if(b.titleId!==undefined && id(b.titleId)!==state.titleId) throw new Error('The queue has changed; refresh and try again'); if (busy || state.status === 'running') throw new Error('Pause copying and wait for the request to finish first'); state = { status: 'idle', lastUnlockAt: state.lastUnlockAt || 0 }; await save(); return json(res, 200, state); }
      } finally { mutating = false; }
    }
    const files = { '/': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'], '/steam.js': ['steam.js','text/javascript'], '/notification.js': ['notification.js','text/javascript'], '/reference-flow.js': ['reference-flow.js','text/javascript'], '/timing.js': ['timing.js','text/javascript'], '/style.css': ['style.css','text/css'], '/spoof-panel.js': ['spoof-panel.js','text/javascript'], '/stats-panel.js': ['stats-panel.js','text/javascript'] }; const file = files[url.pathname] || (/^\/games(?:\/\d+)?\/?$/.test(url.pathname) ? ['index.html','text/html'] : undefined);
    if (req.method === 'GET' && file) { const content=await readFile(join('public', file[0])); res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8', 'Cache-Control':'no-store' }); return res.end(content); }
    json(res, 404, { error: 'Not found' });
  } catch (e) { json(res, e.status === 429 ? 429 : 400, { error: e.message || 'Request failed', ...(e.status === 429 ? {retryAfter:e.retryAfter} : {}) }); }
});
server.requestTimeout = 25000;
server.headersTimeout = 26000;
server.listen(PORT, '127.0.0.1', () => console.log(`XAU Companion: http://127.0.0.1:${server.address().port} (backend: ${XAU || 'Xbox API'})`));

// Stop the worker both on a normal quit and if the desktop parent disappears.
async function shutdownDesktop() {
  if (shuttingDown) return;
  shuttingDown=true; clearInterval(tickTimer); clearInterval(clientTimer); if(autoAuthTimer) clearInterval(autoAuthTimer);
  const deadline=Date.now()+20000;
  while ((busy || mutating) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,100));
  if (busy || mutating) {
    // Do not leave presence running merely because another request is stuck.
    // Its in-flight journal is recovered on the next launch.
    if (!XAU && ['running','recovering'].includes(spoof.status)) {
      try { await Promise.race([(async()=>{if(await currentXuid()===spoof.accountXuid)await xboxApi('/api/spoof-stop');})(),new Promise(resolve=>setTimeout(resolve,5000))]); } catch {}
    }
    process.exit(0);
  }
  {
    try {
      if (['running','recovering'].includes(spoof.status)) await pauseForStoppedSpoof(spoof.titleId);
      if (state.status==='running') { state.status='paused'; state.remaining=Math.max(0,(state.dueAt||Date.now())-Date.now()); log('Queue paused when the app closed'); await save(); }
      if (['running','recovering'].includes(spoof.status)) {
        let stopped=false;
        if (!XAU) { try { if (await currentXuid()===spoof.accountXuid) { await xboxApi('/api/spoof-stop'); stopped=true; } } catch {} }
        spoof={...spoof,status:'idle',endedAt:Date.now(),notice:stopped?'Stopped.':'Presence may remain until it expires.'}; await saveSpoof();
      }
    } catch { /* Startup recovery handles interrupted state. */ }
  }
  process.exit(0);
}
if (process.env.XAU_DESKTOP === '1' && process.send) {
  process.on('message', message => { if (message==='shutdown') void shutdownDesktop(); });
  process.on('disconnect', () => { void shutdownDesktop(); });
}
