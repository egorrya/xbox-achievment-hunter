import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planIntervals, planSelected } from '../public/timing.js';
const rows = [{time:'2023-01-01T00:00:00Z'},{time:'2023-01-01T01:00:00Z'},{time:'2026-01-01T00:00:00Z'}];
test('caps breaks while retaining shorter intervals and minimum rate', () => {
  assert.deepEqual(planIntervals(rows,{mode:'cap',hours:5}),[0,3600000,18000000]);
});
test('spreads the chosen total over the timeline and honours the minimum', () => {
  const result=planIntervals(rows,{mode:'total',hours:100});
  assert.equal(result[0],0);assert.equal(result.reduce((a,b)=>a+b),360000000);assert.ok(result.slice(1).every(gap=>gap>=2000));
  assert.throws(()=>planIntervals(rows,{mode:'total',hours:0.0001}),/too short/);
});
test('equal timestamps receive an equal share of the chosen duration', () => {
  const same=rows.map(()=>({time:rows[0].time}));
  assert.deepEqual(planIntervals(same,{mode:'total',hours:1}),[0,1800000,1800000]);
});


test('plans the whole history before excluding selected and already unlocked achievements', () => {
  const items=rows.map((row,i)=>({...row,id:String(i),selected:i===2}));
  const all=planIntervals(items,{mode:'total',hours:100});
  const selected=planSelected(items,100);
  assert.equal(selected.length,1);assert.equal(selected[0].id,'2');assert.equal(selected[0].delayMs,all[2]);
  assert.ok(selected[0].delayMs<360000000);
});
