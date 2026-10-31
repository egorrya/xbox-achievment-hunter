import { showNotification, dismissNotification } from './notification.js';
export function initSpoofPanel(getTitle, onState = () => {}) {
  const $ = selector => document.querySelector(selector);
  let state = { status:'idle' }, busy = false, polling = false, hasPolled = false, repoll = false, version = 0, request = 0, error = '', refreshTitle = null, lastError = '';
  const playtimeCache = new Map();
  const format = ms => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2,'0')}m ${String(seconds % 60).padStart(2,'0')}s`;
  };
  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, signal:options.signal || AbortSignal.timeout(25000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  function getPlaytime(title, {force = false} = {}) {
    const existing = playtimeCache.get(title);
    if (existing && (existing.pending || (!force && existing.expires > Date.now()))) return existing.promise;
    const entry = {pending:true, expires:0};
    entry.promise = api('/api/playtime?title=' + encodeURIComponent(title)).then(data => {
      entry.pending = false; entry.expires = Date.now() + 300000; return data;
    }, error => { if (playtimeCache.get(title) === entry) playtimeCache.delete(title); throw error; });
    playtimeCache.set(title, entry);
    return entry.promise;
  }
  function render() {
    onState(state, busy);
    const running = state.status === 'running', recovering = state.status === 'recovering', title = getTitle(), same = state.titleId === title;
    $('#spoofStart').hidden = running || recovering; $('#spoofStop').hidden = !running && !recovering;
    $('#spoofStart').disabled = busy || !title; $('#spoofStop').disabled = busy;
    $('#spoofStatusBadge').textContent = running ? 'Running' : recovering ? 'Reconnecting' : 'Off';
    $('#spoofElapsed').textContent = same && state.startedAt && (running || state.endedAt) ? format((running ? Date.now() : state.endedAt) - state.startedAt) : '0h 00m 00s';
    if (!busy) {
      const failure = error || (state.error && !recovering ? 'Stopped: ' + state.error : '');
      const message = failure || (recovering ? 'Presence unavailable (HTTP 503). Retrying in 30 seconds.' : running && !same ? 'Running for Title ID ' + state.titleId + '.' : state.notice || '');
      if (failure) {
        if (lastError !== failure) { lastError = failure; $('#spoofMessage').classList.add('inline-error'); showNotification($('#spoofMessage'),failure); }
      } else {
        if (lastError) dismissNotification($('#spoofMessage'));
        lastError = ''; $('#spoofMessage').classList.remove('inline-error');
        $('#spoofMessage').hidden = !message; $('#spoofMessage').textContent = message;
      }
    }
  }
  async function refresh(force = false) {
    const title = getTitle();
    if (!title || refreshTitle === title) return;
    const current = ++request; refreshTitle = title; $('#spoofRefresh').disabled = true;
    $('#spoofPlaytime').textContent = 'Loading…'; $('#spoofPlaytimeNote').textContent = 'Checking Xbox statistics';
    try {
      const data = await getPlaytime(title, {force});
      if (current !== request || title !== getTitle()) return;
      $('#spoofPlaytime').textContent = data.minutesPlayed === null ? 'Unavailable' : `${Math.floor(data.minutesPlayed / 60)}h ${String(Math.floor(data.minutesPlayed % 60)).padStart(2,'0')}m`;
      $('#spoofPlaytimeNote').textContent = data.minutesPlayed === null ? 'Xbox did not provide play time' : 'Updated ' + new Date(data.updatedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    } catch(e) {
      if (current === request && title === getTitle()) { $('#spoofPlaytime').textContent = 'Unavailable'; $('#spoofPlaytimeNote').textContent = e.message || 'Could not update Xbox statistics'; }
    } finally {
      if (current === request) { refreshTitle = null; $('#spoofRefresh').disabled = false; }
    }
  }
  $('#spoofRefresh').onclick = () => refresh(true);
  async function action(action, titleOverride = null) {
    if (busy) return;
    const title = titleOverride || getTitle(); if (action === 'start' && !title) return;
    busy = true; error = ''; lastError = ''; dismissNotification($('#spoofMessage')); $('#spoofMessage').classList.remove('inline-error'); const actionVersion=++version; render();
    $('#spoofMessage').hidden = false; $('#spoofMessage').textContent = action === 'start' ? 'Starting…' : 'Stopping…';
    try {
      const next = await api('/api/spoofer/' + action, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action === 'start' ? {titleId:title} : {}),signal:AbortSignal.timeout(180000)});
      if(actionVersion!==version)return;
      state=next;if (action === 'stop') void refresh(true);
    } catch(e) { if(actionVersion===version){error = e.message || 'Request failed'; return error;} }
    finally { busy = false; render(); }
  }
  $('#spoofStart').onclick = () => action('start'); $('#spoofStop').onclick = () => action('stop');
  async function poll(force = false) {
    if (polling) {if(force)repoll=true;return;}
    if (busy || document.hidden || (!force && $('#game').hidden && !['running','recovering'].includes(state.status) && hasPolled)) return;
    polling = true; const v = version;
    try {
      const next = await api('/api/spoofer');
      if (!busy && v === version) { const old = state.status; state = next; hasPolled=true; render(); if (old === 'running' && state.status !== 'running' && getTitle()) void refresh(true); }
    } catch {} finally { polling = false;if(repoll){repoll=false;void poll(true);} }
  }
  setInterval(() => { if (!document.hidden && (!$('#game').hidden || ['running','recovering'].includes(state.status))) render(); },1000);
  setInterval(() => { void poll(); },5000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void poll();});
  void poll();
  const open = () => { error = ''; render(); void poll(); void refresh(); };
  open.reset = () => { version++;request++;refreshTitle=null;$('#spoofRefresh').disabled=false;state={status:'idle'};error='';lastError='';playtimeCache.clear();hasPolled=false;render();void poll(); };
  open.refreshStatus = () => poll(true);
  open.action = action;
  open.getPlaytime = getPlaytime;
  open.clearPlaytime = () => playtimeCache.clear();
  return open;
}
