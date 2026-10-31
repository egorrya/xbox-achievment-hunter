import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planIntervals, planSelected, formatDuration } from '../public/timing.js';
const rows = [{time:'2023-01-01T00:00:00Z'},{time:'2023-01-01T01:00:00Z'},{time:'2026-01-01T00:00:00Z'}];
test('caps breaks while retaining shorter intervals and minimum rate', () => {
  assert.deepEqual(planIntervals(rows,{mode:'cap',hours:5}),[0,3600000,18000000]);
});
test('spreads the chosen total over the timeline and honours the minimum', () => {
  const result=planIntervals(rows,{mode:'total',hours:100});
  assert.equal(result[0],0);assert.equal(result.reduce((a,b)=>a+b),360000000);assert.ok(result.slice(1).every(gap=>gap>=2000));
  assert.throws(()=>planIntervals(rows,{mode:'total',hours:0.0001}),/too short/);
});
test('equal timestamps stay close when there are no long breaks', () => {
  const same=rows.map(()=>({time:rows[0].time}));
  assert.deepEqual(planIntervals(same,{mode:'total',hours:1}),[0,2000,2000]);
});


test('plans selected achievements using their actual timestamps', () => {
  const items=rows.map((row,i)=>({...row,id:String(i),selected:i!==1}));
  const selected=planSelected(items,100);
  assert.deepEqual(selected.map(item=>item.id),['0','2']);
  assert.equal(selected[0].delayMs,0);assert.equal(selected[1].delayMs,360000000);
});

test('planned and displayed seconds, minutes and hours use the correct units',()=>{
  const entries=[{time:'2025-01-01T00:00:00Z',selected:true},{time:'2025-01-01T01:00:00Z',selected:true}];
  const hour=planSelected(entries,1);assert.equal(hour[1].delayMs,3600000);assert.equal(formatDuration(hour[1].delayMs),'01h 00m 00s');
  const minute=planSelected([{time:'2025-01-01T00:00:00Z',selected:true},{time:'2025-01-01T00:01:00Z',selected:true}],1/60);assert.equal(minute[1].delayMs,60000);assert.equal(formatDuration(minute[1].delayMs),'00h 01m 00s');
  assert.equal(formatDuration(1000),'00h 00m 01s');assert.equal(formatDuration(90061000),'1d 01h 01m 01s');
});

test('shortens long breaks before a one-hour interval',()=>{
  const items=[{time:'2024-01-01T00:00:00Z'},{time:'2024-01-01T01:00:00Z'},{time:'2024-12-31T01:00:00Z'}];
  const plan=planIntervals(items,{mode:'total',hours:10});
  assert.deepEqual(plan,[0,3600000,32400000]);
  assert.equal(plan.reduce((sum,value)=>sum+value,0),36000000);
});
test('rejects a budget that would shrink hourly intervals into minutes',()=>{
  const items=[{time:'2024-01-01T00:00:00Z'},{time:'2024-01-01T01:00:00Z'},{time:'2024-01-10T01:00:00Z'}];
  assert.throws(()=>planIntervals(items,{mode:'total',hours:1}),/at least 2 hours/);
  assert.deepEqual(planIntervals(items,{mode:'total',hours:2}),[0,3600000,3600000]);
});

test('skipping a reference achievement does not discard the intervening hour',()=>{
  const entries=[{id:'a',time:'2025-01-01T00:00:00Z',selected:true},{id:'b',time:'2025-01-01T01:00:00Z',selected:false},{id:'c',time:'2025-01-01T01:01:00Z',selected:true}];
  const plan=planSelected(entries,2);
  assert.equal(plan.length,2);assert.equal(plan[1].delayMs,7200000);assert.ok(plan[1].delayMs>=3600000);
});
test('mixed short and long gaps keep hourly minimum while fitting the budget',()=>{
  const entries=[{time:'2025-01-01T00:00:00Z'},{time:'2025-01-01T00:05:00Z'},{time:'2025-01-01T01:05:00Z'},{time:'2025-05-01T01:05:00Z'}];
  const plan=planIntervals(entries,{mode:'total',hours:3});
  assert.deepEqual(plan,[0,300000,3600000,6900000]);
  assert.equal(plan.reduce((sum,value)=>sum+value,0),10800000);
});

test('the first achievement waits the chosen interval and the rest still fit the total',()=>{
  const entries=[{id:'a',time:'2025-01-01T00:00:00Z',selected:true},{id:'b',time:'2025-01-01T01:00:00Z',selected:true},{id:'c',time:'2025-02-01T01:00:00Z',selected:true}];
  const firstDelayMs=55*60000,plan=planSelected(entries,10,{firstDelayMs});
  assert.equal(plan[0].delayMs,firstDelayMs);assert.equal(plan[1].delayMs,3600000);
  assert.equal(plan.reduce((sum,item)=>sum+item.delayMs,0),36000000);
  assert.throws(()=>planSelected(entries,2,{firstDelayMs}),/at least 2.92 hours/);
  assert.equal(planSelected([entries[0]],3,{firstDelayMs})[0].delayMs,firstDelayMs);
});

test('stable pacing varies long gaps without shrinking hourly intervals or changing the total',()=>{
  const entries=[{time:'2025-01-01T00:00:00Z'},{time:'2025-01-05T00:00:00Z'},{time:'2025-01-12T00:00:00Z'}];
  const options={mode:'total',hours:8,firstDelayMs:3600000,gapWeights:[0.8,1.2]};
  const first=planIntervals(entries,options),second=planIntervals(entries,options);
  assert.deepEqual(first,second);assert.equal(first[0],3600000);assert.ok(first[1]>=3600000&&first[2]>=3600000);assert.ok(first[2]>first[1]);
  assert.equal(first.reduce((sum,value)=>sum+value,0),28800000);
});

test('shortening one long interval with a low pacing weight still fits the budget',()=>{
  const entries=[{time:'2025-01-01T00:00:00Z'},{time:'2025-01-01T02:00:00Z'}];
  assert.deepEqual(planIntervals(entries,{mode:'total',hours:1,gapWeights:[0.8]}),[0,3600000]);
});

test('varied histories preserve the budget and hourly floors',()=>{
  let seed=4242;const next=()=>{seed=(seed*48271)%2147483647;return seed/2147483647;};
  for(let sample=0;sample<100;sample++){
    const entries=[{time:'2025-01-01T00:00:00Z'}],gaps=[];let timestamp=Date.parse(entries[0].time);
    for(let i=0;i<8;i++){const gap=Math.floor(next()*7200)*1000;gaps.push(gap);timestamp+=gap;entries.push({time:new Date(timestamp).toISOString()});}
    const firstDelayMs=3600000,required=firstDelayMs+gaps.reduce((sum,gap)=>sum+Math.max(2000,Math.min(gap,3600000)),0);
    const target=required+Math.floor(next()*14400000),weights=gaps.map(()=>0.8+next()*0.4);
    const plan=planIntervals(entries,{mode:'total',hours:target/3600000,firstDelayMs,gapWeights:weights});
    const sum=plan.reduce((value,item)=>value+item,0);
    assert.ok(sum<=target);if(gaps.some(gap=>gap>=3600000))assert.equal(sum,target);assert.equal(plan[0],firstDelayMs);
    gaps.forEach((gap,i)=>assert.ok(plan[i+1]>=Math.max(2000,Math.min(gap,3600000))));
  }
});


test('only timestamps that are close together produce a close interval',()=>{
  const items=[{time:'2025-01-01T00:00:00Z'},{time:'2025-01-01T00:00:05Z'},{time:'2025-01-01T00:10:05Z'},{time:'2025-01-01T02:10:05Z'}];
  const plan=planIntervals(items,{mode:'total',hours:3});
  assert.equal(plan[1],5000);assert.equal(plan[2],600000);assert.ok(plan[3]>=3600000);
  assert.throws(()=>planIntervals(items,{mode:'total',hours:1}),/too short/);
});
