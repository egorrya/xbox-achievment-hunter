export const MIN_INTERVAL_MS = 2000;

// Source timestamps alone do not include the player's active play time.
export function planIntervals(entries, { mode, hours } = {}) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('Choose at least one achievement.');
  const gaps = entries.slice(1).map((item, i) => {
    const gap = Date.parse(item.time) - Date.parse(entries[i].time);
    if (!Number.isFinite(gap) || gap < 0) throw new Error('Invalid achievement timeline.');
    return gap;
  });
  if (mode === 'original') return [0, ...gaps.map(gap => Math.max(MIN_INTERVAL_MS, gap))];
  const limit = Number(hours) * 3600000;
  if (!Number.isFinite(limit) || limit <= 0 || limit > 315360000000) throw new Error('Enter a valid number of hours.');
  if (mode === 'cap') {
    if (limit < MIN_INTERVAL_MS) throw new Error('The maximum interval must be at least 2 seconds.');
    return [0, ...gaps.map(gap => Math.max(MIN_INTERVAL_MS, Math.min(gap, limit)))];
  }
  if (mode !== 'total') throw new Error('Select how to schedule the achievements.');
  if (!gaps.length) return [0];
  const target = Math.round(limit);
  if (target < gaps.length * MIN_INTERVAL_MS) throw new Error('Total time is too short for the 2-second minimum interval.');
  const baseline = gaps.length * MIN_INTERVAL_MS;
  const remaining = target - baseline;
  const totalGap = gaps.reduce((sum, gap) => sum + gap, 0);
  const weights = totalGap ? gaps.map(gap => gap / totalGap) : gaps.map(() => 1 / gaps.length);
  const extras = weights.map(weight => Math.floor(weight * remaining));
  let remainder = remaining - extras.reduce((sum, value) => sum + value, 0);
  for (let i = 0; remainder > 0; i = (i + 1) % extras.length, remainder--) extras[i]++;
  return [0, ...extras.map(value => value + MIN_INTERVAL_MS)];
}

export function planSelected(entries, hours) {
  const all = planIntervals(entries, { mode: 'total', hours });
  return entries.map((item, i) => ({...item, delayMs:all[i]})).filter(item => item.selected);
}
