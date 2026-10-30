import http from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 3000);
const XAU = (process.env.XAU_URL || 'http://localhost:1337').replace(/\/$/, '');
const CATALOG_URL = process.env.TITLE_CATALOG_URL || 'https://raw.githubusercontent.com/Fumo-Unlockers/XboxGames/main/xbox_games.json';
const MIN_UNLOCK_INTERVAL = 60000;
const STATE_FILE = process.env.STATE_FILE || join(process.cwd(), 'state.json');
let state = { status: 'idle' }, busy = false, mutating = false;
try { state = JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (state.inFlight) { state.uncertainId = state.inFlight; state.status = 'paused'; state.remaining = Math.max(0, (state.dueAt || Date.now()) - Date.now()); state.error = 'Результат предыдущего запроса неизвестен. Проверьте достижение перед продолжением.'; state.log = [...(state.log || []), {time: new Date().toISOString(), message: 'Очередь остановлена: ' + state.error}].slice(-200); delete state.inFlight; }
async function save() { const tmp = STATE_FILE + '.tmp'; await writeFile(tmp, JSON.stringify(state, null, 2)); await rename(tmp, STATE_FILE); }
await save();
function log(message) {
  state.log = [...(state.log || []), { time: new Date().toISOString(), message }].slice(-200);
}
function advance(item, outcome) {
  const now = Date.now(); state.results ||= {}; state.results[item.id] = outcome;
  state.index++;
  if (state.index >= state.entries.length) { state.status = 'completed'; delete state.dueAt; log('Очередь завершена'); }
  else {
    const gap = Math.max(0, Date.parse(state.entries[state.index].time) - Date.parse(item.time));
    state.dueAt = Math.max(now + gap, (state.lastUnlockAt || 0) + MIN_UNLOCK_INTERVAL);
  }
}
async function achievementStatus(achievementId) {
  await requireAccount();
  const current = await xau('/api/achievements/' + id(state.titleId));
  if (!Array.isArray(current?.achievements)) throw new Error('XAU не вернул список достижений для проверки');
  const matching = current.achievements.filter(a => String(a.id) === achievementId);
  if (matching.length !== 1 || typeof matching[0].progressState !== 'string') throw new Error('Не удалось проверить статус достижения в XAU');
  const progress = matching[0].progressState.toLowerCase();
  if (!['achieved', 'notstarted', 'inprogress'].includes(progress)) throw new Error('Неизвестный статус достижения в XAU');
  return progress;
}
async function get(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000), redirect: 'error' });
  const raw = await response.text(); let data; try { data = JSON.parse(raw); } catch { data = raw; }
  if (!response.ok || (data && typeof data === 'object' && data.error)) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}
const xau = (path, options) => get(XAU + path, options);
const id = value => { if (!/^\d+$/.test(String(value))) throw new Error('Некорректный ID'); return String(value); };
let catalogPromise, catalogExpires = 0;
async function titleBased(title) {
  if (!catalogPromise || Date.now() >= catalogExpires) {
    catalogExpires = Date.now() + 86400000;
    catalogPromise = get(CATALOG_URL).then(data => {
      if (!Array.isArray(data)) throw new Error('Каталог типов игр недоступен');
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
  return (await catalogPromise).get(id(title)) ?? null;
}
async function requireTitleBased(title) {
  const result = await titleBased(title);
  if (result !== true) throw new Error(result === false ? 'Игра не является Title Based' : 'Не удалось подтвердить, что игра Title Based');
}
async function currentXuid() {
  const profile = await xau('/api/profile/me');
  const people = profile?.People ?? profile?.people;
  const xuid = people?.[0]?.Xuid ?? people?.[0]?.xuid;
  if (typeof xuid !== 'string' || !/^\d+$/.test(xuid)) throw new Error('XAU не вернул XUID текущего аккаунта');
  return xuid;
}
async function requireAccount() {
  if (!state.accountXuid) throw new Error('Очередь не привязана к аккаунту; сбросьте её и создайте заново');
  if (await currentXuid() !== state.accountXuid) throw new Error('Аккаунт XAU изменился; верните исходный аккаунт');
}
async function referenceHistory(tag, title) {
  if (!tag || tag.length > 100) throw new Error('Укажите Gamertag игрока');
  const profile = await xau('/api/profile/gt/' + encodeURIComponent(tag));
  const people = profile?.People ?? profile?.people;
  const xuid = people?.[0]?.Xuid ?? people?.[0]?.xuid;
  if (!xuid) throw new Error('Не удалось определить XUID игрока');
  const token = (await xau('/api/xauth?format=json'))?.token;
  if (typeof token !== 'string' || !token.trim()) throw new Error('XAU не вернул авторизацию Xbox');
  const result = []; const seenTokens = new Set(); let continuation;
  do {
    const url = new URL(`/users/xuid(${id(xuid)})/achievements`, process.env.XBOX_ACHIEVEMENTS_ORIGIN || 'https://achievements.xboxlive.com');
    url.searchParams.set('titleId', id(title)); url.searchParams.set('maxItems', '1000');
    if (continuation) url.searchParams.set('continuationToken', continuation);
    const page = await get(url, { headers: { Authorization: token, 'x-xbl-contract-version': '4', Accept: 'application/json' } });
    if (!Array.isArray(page?.achievements)) throw new Error('Xbox не вернул список достижений игрока');
    result.push(...page.achievements);
    continuation = page.pagingInfo?.continuationToken;
    if (continuation && (seenTokens.has(continuation) || seenTokens.size >= 100)) throw new Error('Не удалось полностью загрузить историю Xbox');
    if (continuation) seenTokens.add(continuation);
  } while (continuation);
  const entries = [];
  for (const achievement of result) {
    if (String(achievement.progressState || '').toLowerCase() !== 'achieved') continue;
    const time = achievement.progression?.timeUnlocked;
    if (!time || !Number.isFinite(Date.parse(time)) || Date.parse(time) < Date.UTC(2005, 0, 1)) throw new Error('У полученного достижения отсутствует корректная дата: ' + (achievement.name || achievement.id));
    entries.push({ id: id(achievement.id), name: String(achievement.name || achievement.id), time: new Date(time).toISOString() });
  }
  if (!entries.length) throw new Error('У игрока нет доступных полученных достижений в этой игре');
  if (new Set(entries.map(a => a.id)).size !== entries.length) throw new Error('Xbox вернул повторяющиеся достижения');
  entries.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  return { entries };
}
async function tick() {
  if (busy || mutating || state.status !== 'running') return;
  busy = true;
  try {
    await requireTitleBased(state.titleId);
    const now = Date.now();
    if (!state.nextSpoof || now >= state.nextSpoof) {
      await requireAccount();
      const result = await xau('/api/spoof/' + id(state.titleId));
      if (!result || typeof result !== 'object' || result.message !== 'Spoofing started successfully.' || String(result.titleId) !== state.titleId) throw new Error('XAU вернул некорректный ответ на запрос спуфа');
      state.nextSpoof = Date.now() + 290000; log('Спуф запущен'); await save();
    }
    if (state.status !== 'running' || Date.now() < state.dueAt) return;
    const item = state.entries[state.index];
    if (!item) { state.status = 'completed'; await save(); return; }
    const progress = await achievementStatus(item.id);
    if (progress !== 'achieved') {
      const availableAt = (state.lastUnlockAt || 0) + MIN_UNLOCK_INTERVAL;
      if (Date.now() < availableAt) { state.dueAt = availableAt; await save(); return; }
      state.inFlight = item.id; state.lastUnlockAt = Date.now(); log(`Запрос: ${item.name}`); await save();
      const result = await xau('/api/achievements/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ titleId: state.titleId, achievementId: item.id }) });
      if (!result || typeof result !== 'object' || result.message !== 'Achievement unlocked successfully' || String(result.titleId) !== state.titleId || String(result.achievementId) !== item.id) throw new Error('XAU вернул некорректный ответ на запрос разблокировки');
      delete state.inFlight; log(`Отправлено: ${item.name}`); advance(item, 'sent');
    } else { log(`Уже получено, пропущено: ${item.name}`); advance(item, 'already'); }
    await save();
  } catch (e) {
    state.status = 'paused'; state.remaining = Math.max(0, (state.dueAt || Date.now()) - Date.now());
    const reason = e.name === 'TimeoutError' ? 'Превышено время ожидания ответа XAU.' : e.message;
    state.error = (state.inFlight ? 'Результат разблокировки может быть неизвестен. Проверьте достижение перед продолжением. ' : 'Ошибка проверки игры, достижений, спуфа или сохранения состояния. ') + reason;
    if (state.inFlight) state.uncertainId = state.inFlight;
    delete state.inFlight; log('Очередь остановлена: ' + state.error); await save();
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
  shuttingDown = true; clearInterval(tickTimer); clearInterval(clientTimer);
  console.log('Все страницы закрыты; сервер останавливается.');
  server.close();
}, 1000);
const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
async function body(req) { let s = ''; for await (const chunk of req) { s += chunk; if (s.length > 2_000_000) throw new Error('Слишком большой запрос'); } return JSON.parse(s || '{}'); }
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'Недопустимый источник запроса' });
    if (req.method === 'POST' && ['/api/client/heartbeat', '/api/client/close'].includes(url.pathname)) {
      const b = await body(req);
      if (typeof b.id !== 'string' || !/^[a-zA-Z0-9-]{10,100}$/.test(b.id)) throw new Error('Некорректный идентификатор страницы');
      if (url.pathname.endsWith('/heartbeat')) { hadClient = true; clients.set(b.id, Date.now()); closeDeadline = null; }
      else if (clients.delete(b.id) && !clients.size) closeDeadline = Date.now() + CLOSE_GRACE_MS;
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state);
    if (req.method === 'GET' && url.pathname === '/api/profile') return json(res, 200, await xau('/api/profile/me'));
    if (req.method === 'GET' && url.pathname === '/api/game') return json(res, 200, await xau('/api/games/search/titleid/' + id(url.searchParams.get('title'))));
    if (req.method === 'GET' && url.pathname === '/api/games') return json(res, 200, await xau('/api/games/me'));
    if (req.method === 'GET' && url.pathname === '/api/achievements') return json(res, 200, await xau('/api/achievements/' + id(url.searchParams.get('title'))));
    if (req.method === 'GET' && url.pathname === '/api/title-based') return json(res, 200, { titleBased: await titleBased(id(url.searchParams.get('title'))) });
    if (req.method === 'GET' && url.pathname === '/api/uncertain') { if (state.status !== 'paused' || !state.uncertainId) throw new Error('Нет неопределённого результата'); return json(res, 200, { id: state.uncertainId, progress: await achievementStatus(state.uncertainId) }); }
    if (req.method === 'GET' && url.pathname === '/api/history') return json(res, 200, await referenceHistory((url.searchParams.get('tag') || '').trim(), id(url.searchParams.get('title'))));
    if (req.method === 'POST' && ['/api/start', '/api/pause', '/api/resume', '/api/reset', '/api/resolve'].includes(url.pathname)) {
      if (busy || mutating) throw new Error('Дождитесь завершения текущего запроса и попробуйте снова');
      mutating = true;
      try {
    if (req.method === 'POST' && url.pathname === '/api/start') {
      if (busy || state.status === 'running' || state.status === 'paused') throw new Error('Сначала завершите или сбросьте текущую очередь');
      const b = await body(req); const titleId = id(b.titleId);
      await requireTitleBased(titleId);
      if (!Array.isArray(b.entries) || !b.entries.length || b.entries.length > 10000) throw new Error('Список достижений пуст или слишком велик');
      const entries = b.entries.map(a => ({ id: id(a.id), name: String(a.name || a.id), time: a.time }));
      if (new Set(entries.map(a => a.id)).size !== entries.length) throw new Error('В очереди есть повторяющиеся достижения');
      if (entries.some(a => !Number.isFinite(Date.parse(a.time))) || entries.some((a,i) => i && Date.parse(a.time) < Date.parse(entries[i-1].time))) throw new Error('Некорректная последовательность');
      const accountXuid = await currentXuid();
      state = { status: 'running', lastUnlockAt: state.lastUnlockAt || 0, accountXuid, titleId, game: String(b.game || ''), tag: String(b.tag || ''), entries, index: 0, dueAt: Date.now(), nextSpoof: 0, log: [], results: {} }; log('Очередь запущена'); await save(); return json(res, 200, state);
    }
    if (req.method === 'POST' && url.pathname === '/api/pause') { if (state.status !== 'running') throw new Error('Копирование не запущено'); state.status = 'paused'; state.remaining = Math.max(0, state.dueAt - Date.now()); log('Очередь приостановлена'); await save(); return json(res, 200, state); }
    if (req.method === 'POST' && url.pathname === '/api/resume') { if (state.status !== 'paused' || busy) throw new Error('Невозможно продолжить сейчас'); if (state.uncertainId) throw new Error('Сначала выберите действие для неподтверждённого достижения'); state.status = 'running'; state.dueAt = Date.now() + (state.remaining || 0); state.nextSpoof = 0; delete state.error; log('Очередь продолжена'); await save(); return json(res, 200, state); }
    if (req.method === 'POST' && url.pathname === '/api/resolve') {
      if (state.status !== 'paused' || !state.uncertainId) throw new Error('Нет неопределённого результата');
      const b = await body(req); if (!['skip', 'retry'].includes(b.choice)) throw new Error('Выберите действие');
      const item = state.entries[state.index];
      if (!item || item.id !== state.uncertainId || b.id !== item.id) throw new Error('Состояние очереди изменилось');
      const progress = await achievementStatus(item.id);
      delete state.uncertainId; delete state.error;
      if (b.choice === 'skip' || progress === 'achieved') {
        log(`${progress === 'achieved' ? 'Подтверждено' : 'Пропущено пользователем'}: ${item.name}`);
        advance(item, progress === 'achieved' ? 'already' : 'skipped');
      } else { log(`Повтор разрешён пользователем: ${item.name}`); state.dueAt = Math.max(Date.now() + (state.remaining || 0), (state.lastUnlockAt || 0) + MIN_UNLOCK_INTERVAL); }
      if (state.status !== 'completed') { state.status = 'running'; state.nextSpoof = 0; }
      await save(); return json(res, 200, state);
    }
    if (req.method === 'POST' && url.pathname === '/api/reset') { if (busy || state.status === 'running') throw new Error('Сначала остановите копирование и дождитесь завершения запроса'); state = { status: 'idle', lastUnlockAt: state.lastUnlockAt || 0 }; await save(); return json(res, 200, state); }
      } finally { mutating = false; }
    }
    const files = { '/': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'], '/style.css': ['style.css','text/css'] }; const file = files[url.pathname] || (/^\/games(?:\/\d+)?\/?$/.test(url.pathname) ? ['index.html','text/html'] : undefined);
    if (req.method === 'GET' && file) { res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8' }); return res.end(await readFile(join('public', file[0]))); }
    json(res, 404, { error: 'Не найдено' });
  } catch (e) { json(res, 400, { error: e.message || 'Ошибка запроса' }); }
});
server.requestTimeout = 25000;
server.headersTimeout = 26000;
server.listen(PORT, '127.0.0.1', () => console.log(`XAU Companion: http://127.0.0.1:${PORT} (XAU: ${XAU})`));
