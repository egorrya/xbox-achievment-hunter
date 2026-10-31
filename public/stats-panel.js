import { showNotification, dismissNotification } from './notification.js';

export function initStatsPanel(getTitle, getPlaytime) {
  const $ = selector => document.querySelector(selector);
  const tabs = [$('#achievementsTab'), $('#statsTab')];
  let generation = 0, loadedTitle = null, loadingTitle = null, stats = [], editing = false;

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, signal:AbortSignal.timeout(120000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  function activate(index, focus = false) {
    tabs.forEach((tab, i) => { tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1; });
    $('#achievementsPanel').hidden = index !== 0; $('#statsPanel').hidden = index !== 1; $('#achievementCount').hidden = index !== 0;
    if (focus) tabs[index].focus();
    if (index === 1 && loadedTitle !== getTitle()) void load();
  }
  tabs.forEach((tab, i) => {
    tab.onclick = () => activate(i);
    tab.onkeydown = event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); activate(1 - i, true); } };
  });
  function render() {
    const editButton = $('#statsEdit');
    editButton.disabled = !stats.some(stat => stat.writable) || Boolean(loadingTitle);
    editButton.textContent = editing ? 'Done' : 'Edit stats';
    editButton.setAttribute('aria-pressed', String(editing));
    const list = $('#statsList'); list.replaceChildren();
    for (const stat of stats) {
      const row = document.createElement('div'); row.className = 'stat-row';
      const label = document.createElement('div'); label.className = 'stat-name';
      const name = document.createElement('strong'); name.textContent = stat.displayName || stat.name; label.append(name);
      if (stat.displayName && stat.displayName !== stat.name) { const meta = document.createElement('small'); meta.textContent = stat.name; label.append(meta); }
      row.append(label);
      if (editing && stat.writable) {
        const input = document.createElement('input'); input.value = stat.value; input.setAttribute('aria-label', 'Value for ' + (stat.displayName || stat.name));
        const button = document.createElement('button'); button.className = 'secondary'; button.textContent = 'Save';
        const feedback = document.createElement('div'); feedback.className = 'stat-feedback'; feedback.setAttribute('role', 'status');
        const title = loadedTitle;
        button.onclick = async () => {
          const value = input.value.trim();
          if (!value || value.length > 100) { feedback.classList.add('inline-error'); showNotification(feedback, 'Enter a value up to 100 characters.'); return; }
          button.disabled = true; dismissNotification(feedback); feedback.hidden = false; feedback.classList.remove('inline-error'); feedback.textContent = 'Saving…';
          try {
            const result = await api('/api/stats', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({title, name:stat.name, scid:stat.scid, value})});
            if (result.confirmed) stat.value = value;
            feedback.textContent = result.confirmed ? 'Saved and confirmed.' : 'Sent to Xbox; the updated value is not confirmed yet.';
          } catch (error) { feedback.classList.add('inline-error'); showNotification(feedback, error.message || 'Could not save.'); }
          finally { button.disabled = false; }
        };
        row.append(input, button, feedback);
      } else {
        const value = document.createElement('strong'); value.className = 'stat-value'; value.textContent = stat.value || '—'; row.append(value);
        if (editing && !stat.writable && stat.readOnlyReason) { const note = document.createElement('div'); note.className = 'stat-feedback'; note.textContent = stat.readOnlyReason; row.append(note); }
      }
      list.append(row);
    }
  }
  async function load() {
    const title = getTitle(); if (!title || loadingTitle === title) return;
    loadingTitle = title; const current = ++generation; editing = false; stats = [];
    $('#statsRefresh').disabled = true; dismissNotification($('#statsMessage')); $('#statsMessage').hidden = false; $('#statsMessage').classList.remove('inline-error'); $('#statsMessage').textContent = 'Loading stats…'; render();
    let problem, loadedStats = [];
    try {
      const result = await api('/api/stats?title=' + encodeURIComponent(title));
      if (!Array.isArray(result.stats)) throw new Error('Xbox returned an invalid stats list.');
      loadedStats = result.stats;
    } catch (error) { problem = error; }
    if (current !== generation || title !== getTitle()) return;
    if (!loadedStats.length) {
      try {
        const data = await getPlaytime(title);
        if (current !== generation || title !== getTitle()) return;
        if (typeof data.minutesPlayed === 'number' && Number.isFinite(data.minutesPlayed) && data.minutesPlayed >= 0) {
          const minutes = Math.floor(data.minutesPlayed);
          loadedStats = [{name:'Time in game', displayName:'Time in game', value:`${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2,'0')}m`, writable:false}];
        }
      } catch { /* Xbox may not expose play time for this game. */ }
    }
    if (current !== generation || title !== getTitle()) return;
    stats = loadedStats; loadedTitle = title; loadingTitle = null; $('#statsRefresh').disabled = false; render();
    if (problem) { $('#statsMessage').classList.add('inline-error'); showNotification($('#statsMessage'),problem.message || 'Could not load stats.'); }
    else $('#statsMessage').textContent = stats.length ? '' : 'Xbox did not provide stats or game time for this game.';
  }
  $('#statsRefresh').onclick = load;
  $('#statsEdit').onclick = () => { if (!stats.some(stat => stat.writable)) return; editing = !editing; render(); };
  return () => {
    generation++; loadedTitle = null; loadingTitle = null; stats = []; editing = false;
    $('#statsRefresh').disabled = false; $('#statsList').replaceChildren();
    dismissNotification($('#statsMessage')); $('#statsMessage').hidden = false; $('#statsMessage').classList.remove('inline-error'); $('#statsMessage').textContent = '';
    render(); activate(0);
  };
}
