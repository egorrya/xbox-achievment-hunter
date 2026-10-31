import test from 'node:test';
import assert from 'node:assert/strict';
import { initSpoofPanel } from '../public/spoof-panel.js';

test('spoof status polling does not overlap and clocks do not issue requests', async () => {
  const original={document:globalThis.document,fetch:globalThis.fetch,setInterval:globalThis.setInterval};
  const elements=new Map(),timers=[],calls=[];let finishPoll;
  const element=id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,textContent:'',classList:{add(){},remove(){}}});return elements.get(id);};
  globalThis.document={hidden:false,querySelector:element,addEventListener(){}};
  globalThis.setInterval=(fn,ms)=>{timers.push({fn,ms});return timers.length;};
  globalThis.fetch=async url=>{calls.push(url);if(url==='/api/spoofer')return await new Promise(resolve=>{finishPoll=()=>resolve({ok:true,json:async()=>({status:'idle'})});});return {ok:true,json:async()=>({minutesPlayed:30,updatedAt:Date.now()})};};
  try {
    const open=initSpoofPanel(()=> '123');open();
    assert.deepEqual(timers.map(timer=>timer.ms),[1000,5000]);
    timers[0].fn();timers[1].fn();timers[1].fn();
    assert.equal(calls.filter(url=>url==='/api/spoofer').length,1);
    assert.equal(calls.filter(url=>url.startsWith('/api/playtime')).length,1);
    const time=await open.getPlaytime('123');assert.equal(time.minutesPlayed,30);assert.equal(calls.filter(url=>url.startsWith('/api/playtime')).length,1);
    finishPoll();await new Promise(resolve=>setImmediate(resolve));
    timers[1].fn();assert.equal(calls.filter(url=>url==='/api/spoofer').length,2);finishPoll();
  } finally {Object.assign(globalThis,original);}
});

test('spoof status is shared outside the game page without polling after it stops', async () => {
  const original={document:globalThis.document,fetch:globalThis.fetch,setInterval:globalThis.setInterval};
  const elements=new Map(),timers=[],states=[];let calls=0;
  globalThis.document={hidden:false,querySelector:id=>{if(!elements.has(id))elements.set(id,{hidden:id==='#game',disabled:false,textContent:'',classList:{add(){},remove(){}}});return elements.get(id);},addEventListener(){}};
  globalThis.setInterval=(fn,ms)=>{timers.push({fn,ms});return timers.length;};
  globalThis.fetch=async()=>({ok:true,json:async()=>++calls===1?{status:'running',titleId:'123',startedAt:1}:{status:'idle'}});
  try {
    initSpoofPanel(()=>undefined,state=>states.push(state.status));await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls,1);assert.deepEqual(states,['running']);
    timers.find(t=>t.ms===5000).fn();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);assert.deepEqual(states,['running','idle']);
    timers.find(t=>t.ms===5000).fn();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);
  } finally {Object.assign(globalThis,original);}
});

test('account reset discards a spoof action that finishes later', async () => {
  const original={document:globalThis.document,fetch:globalThis.fetch,setInterval:globalThis.setInterval};
  const elements=new Map(),states=[];let finishAction;
  globalThis.document={hidden:false,querySelector:id=>{if(!elements.has(id))elements.set(id,{hidden:false,disabled:false,textContent:'',classList:{add(){},remove(){}}});return elements.get(id);},addEventListener(){}};
  globalThis.setInterval=()=>1;
  globalThis.fetch=async url=>{
    if(url==='/api/spoofer/start')return await new Promise(resolve=>{finishAction=()=>resolve({ok:true,json:async()=>({status:'running',titleId:'123'})});});
    return {ok:true,json:async()=>({status:'idle'})};
  };
  try {
    const open=initSpoofPanel(()=> '123',state=>states.push(state.status));
    await new Promise(resolve=>setImmediate(resolve));
    const pending=open.action('start');await new Promise(resolve=>setImmediate(resolve));
    open.reset();finishAction();await pending;
    assert.equal(states.at(-1),'idle');assert.ok(!states.includes('running'));
  } finally {Object.assign(globalThis,original);}
});

test('sign-in refreshes spoof status even if an earlier poll is still pending', async () => {
  const original={document:globalThis.document,fetch:globalThis.fetch,setInterval:globalThis.setInterval};
  const elements=new Map(),states=[];let finishFirst,calls=0;
  globalThis.document={hidden:false,querySelector:id=>{if(!elements.has(id))elements.set(id,{hidden:id==='#game',disabled:false,textContent:'',classList:{add(){},remove(){}}});return elements.get(id);},addEventListener(){}};
  globalThis.setInterval=()=>1;
  globalThis.fetch=async()=>{calls++;if(calls===1)return await new Promise(resolve=>{finishFirst=()=>resolve({ok:true,json:async()=>({status:'idle'})});});return {ok:true,json:async()=>({status:'idle',titleId:'123'})};};
  try {
    const open=initSpoofPanel(()=>undefined,state=>states.push(state));
    open.reset();open.refreshStatus();finishFirst();
    await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls,2);assert.equal(states.at(-1).titleId,'123');
  } finally {Object.assign(globalThis,original);}
});
