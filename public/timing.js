export const MIN_INTERVAL_MS = 2000;

// Source timestamps alone do not include the player's active play time.
export function planIntervals(entries, { mode, hours, firstDelayMs = 0, gapWeights } = {}) {
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
  if (!Number.isSafeInteger(firstDelayMs) || firstDelayMs < 0 || firstDelayMs > 315360000000) throw new Error('Invalid first interval.');
  const totalTarget = Math.round(limit);
  if (totalTarget < firstDelayMs) throw new Error(`Total time is too short for the first interval. Enter at least ${Math.ceil(firstDelayMs / 3600000 * 100) / 100} hours.`);
  if (!gaps.length) return [firstDelayMs];
  const target = totalTarget - firstDelayMs;
  const pacing = gaps.map((_, i) => Number.isFinite(gapWeights?.[i]) && gapWeights[i] >= 0.8 && gapWeights[i] <= 1.2 ? gapWeights[i] : 1);
  const floors = gaps.map(gap => Math.max(MIN_INTERVAL_MS, Math.min(gap, 3600000)));
  const required = floors.reduce((sum, value) => sum + value, 0);
  if (target < required) {
    const minimumHours = Math.ceil((required + firstDelayMs) / 3600000 * 100) / 100;
    throw new Error(`Total time is too short to preserve the reference intervals. Enter at least ${minimumHours} hours.`);
  }
  const original = gaps.map((gap, i) => Math.max(floors[i], gap));
  const originalTotal = original.reduce((sum, gap) => sum + gap, 0);
  if (originalTotal > target) {
    // Shorten the longest breaks first; a common cap preserves every shorter gap.
    let low = MIN_INTERVAL_MS, high = Math.ceil(target / Math.min(...pacing));
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2);
      const sum = original.reduce((total, gap, i) => Math.min(target + 1, total + Math.max(floors[i], Math.min(gap, Math.floor(middle * pacing[i])))), 0);
      if (sum <= target) low = middle; else high = middle - 1;
    }
    const intervals = original.map((gap, i) => Math.max(floors[i], Math.min(gap, Math.floor(low * pacing[i]))));
    let remainder = target - intervals.reduce((sum, gap) => sum + gap, 0);
    for (let i = 0; remainder > 0; i = (i + 1) % intervals.length) {
      if (intervals[i] < original[i]) { intervals[i]++; remainder--; }
    }
    return [firstDelayMs, ...intervals];
  }
  const remaining = target - originalTotal;
  // Extra time belongs to longer breaks, not to achievements earned together.
  const baseWeights = gaps.map((gap, i) => gap >= 3600000 ? gap * pacing[i] : 0);
  const weightTotal = baseWeights.reduce((sum, weight) => sum + weight, 0);
  if (!weightTotal) return [firstDelayMs, ...original];
  const weights = baseWeights.map(weight => weight / weightTotal);
  const extras = weights.map(weight => Math.floor(weight * remaining));
  let remainder = remaining - extras.reduce((sum, value) => sum + value, 0);
  for (let i = 0; remainder > 0; i = (i + 1) % extras.length) { if (baseWeights[i] > 0) { extras[i]++; remainder--; } }
  return [firstDelayMs, ...extras.map((value, i) => value + original[i])];
}

export function planSelected(entries, hours, {firstDelayMs = 0} = {}) {
  const selected = entries.filter(item => item.selected);
  const intervals = planIntervals(selected, { mode: 'total', hours, firstDelayMs, gapWeights:selected.slice(1).map(item => item.pacingWeight) });
  return selected.map((item, i) => ({...item, delayMs:intervals[i]}));
}

// Always label each unit: the queue stores all delays in milliseconds.
export function formatDuration(ms) {
  let seconds = Math.ceil(Math.max(0, ms) / 1000);
  const days = Math.floor(seconds / 86400); seconds %= 86400;
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60); seconds %= 60;
  return `${days ? days + 'd ' : ''}${String(hours).padStart(2,'0')}h ${String(minutes).padStart(2,'0')}m ${String(seconds).padStart(2,'0')}s`;
}
