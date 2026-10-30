import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createInterface } from 'node:readline';

test('server reports its assigned port for the desktop window', async () => {
  const dir=await mkdtemp(join(tmpdir(),'xau-desktop-test-'));
  const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'0',AUTH_FILE:join(dir,'auth.json'),STATE_FILE:join(dir,'state.json')},stdio:['ignore','pipe','ignore']});
  try {
    const url=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('server did not start')),5000);
      createInterface({input:child.stdout}).on('line',line=>{const match=line.match(/^XAU Companion: (http:\/\/127\.0\.0\.1:\d+) /);if(match){clearTimeout(timeout);resolve(match[1]);}});
      child.once('exit',()=>{clearTimeout(timeout);reject(new Error('server exited'));});
    });
    assert.notEqual(new URL(url).port,'0');assert.equal((await fetch(url+'/api/state')).status,200);
  } finally {if(child.exitCode===null && child.signalCode===null){child.kill();await new Promise(r=>child.once('exit',r));}await rm(dir,{recursive:true,force:true});}
});

test('queue persists, pauses and resumes without unlockall', async () => {
  const calls=[]; let account='9999';
  const mock=http.createServer(async(req,res)=>{calls.push(req.url);res.setHeader('Content-Type','application/json');if(req.url==='/api/games/search/titleid/123')return res.end(JSON.stringify({Titles:[{TitleId:'123',Name:'Test game'}]}));if(req.url==='/api/profile/me')return res.end(JSON.stringify({People:[{Xuid:account}]}));if(req.url==='/catalog')return res.end(JSON.stringify([{titleId:'123',isTitleBased:true},{titleId:'456',isTitleBased:false}]));if(req.url==='/api/achievements/123')return res.end(JSON.stringify({achievements:[{id:'1',progressState:'NotStarted'},{id:'3',progressState:'NotStarted'}]}));if(req.url==='/api/achievements/429'){res.statusCode=429;res.setHeader('Retry-After','45');return res.end('{}');}if(req.url.startsWith('/api/spoof/')) res.end(JSON.stringify({message:'Spoofing started successfully.',titleId:'123'}));else {let body='';for await (const chunk of req) body+=chunk;const item=JSON.parse(body);res.end(JSON.stringify({message:'Achievement unlocked successfully',titleId:item.titleId,achievementId:item.achievementId}));}});
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const dir=await mkdtemp(join(tmpdir(),'xau-test-')); const stateFile=join(dir,'state.json');
  const probe=http.createServer(); await new Promise(r=>probe.listen(0,'127.0.0.1',r)); const port=probe.address().port; await new Promise(r=>probe.close(r));
  const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port),XAU_URL:`http://127.0.0.1:${mock.address().port}`,TITLE_CATALOG_URL:`http://127.0.0.1:${mock.address().port}/catalog`,AUTH_FILE:join(dir,'auth.json'),STATE_FILE:stateFile},stdio:'ignore'});
  const base=`http://127.0.0.1:${port}`;
  const post=async(path,data={})=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(data)});assert.equal(r.status,200);return r.json()};
  try {
    for(let i=0;i<40;i++){try{await fetch(base+'/api/state');break}catch{await sleep(50)}}
    for (const path of ['/games', '/games/123']) { const response=await fetch(base+path); assert.equal(response.status,200); const html=await response.text();assert.match(html, /Xbox Achievment Hunter/); }
    const game=await (await fetch(base+'/api/game?title=123')).json();assert.equal(game.Titles[0].Name,'Test game');
    await fetch(base+'/api/game?title=123');assert.equal(calls.filter(x=>x==='/api/games/search/titleid/123').length,1);
    await post('/api/cache/refresh');await fetch(base+'/api/game?title=123');assert.equal(calls.filter(x=>x==='/api/games/search/titleid/123').length,2);
    assert.equal((await fetch(base+'/api/game?title=abc')).status,400);
    const limited=await fetch(base+'/api/achievements?title=429');assert.equal(limited.status,429);assert.equal((await limited.json()).retryAfter,45);
    const payload={titleId:'123',game:'Test',entries:[{id:'1',name:'First',time:'2025-01-01T00:00:00Z'},{id:'3',name:'Third',time:'2025-01-01T00:02:00Z'}]};
    for(const titleId of ['456','999']) { const rejected=await fetch(base+'/api/start',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({...payload,titleId})});assert.equal(rejected.status,400); }
    const simultaneous=await Promise.all([1,2].map(()=>fetch(base+'/api/start',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(payload)})));
    assert.deepEqual(simultaneous.map(r=>r.status).sort(),[200,400]);
    for(let i=0;i<40;i++){const state=await (await fetch(base+'/api/state')).json();if(state.index===1)break;await sleep(50)}
    const paused=await post('/api/pause');assert.equal(paused.status,'paused');assert.equal(paused.index,1);assert.ok(paused.remaining>115000);
    const wrongReset=await fetch(base+'/api/reset',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({titleId:'456'})});assert.equal(wrongReset.status,400);assert.equal((await (await fetch(base+'/api/state')).json()).titleId,'123');
    const persisted=JSON.parse(await readFile(stateFile,'utf8'));assert.equal(persisted.index,1);assert.deepEqual(persisted.entries.map(a=>a.id),['1','3']);
    const revised=await post('/api/reschedule',{titleId:'123',tag:'Player',entries:[{id:'1',name:'First',time:'2025-01-01T00:00:00Z',delayMs:0},{id:'3',name:'Third',time:'2025-01-01T00:02:00Z',delayMs:1800000}]});
    assert.equal(revised.index,1);assert.equal(revised.entries[1].delayMs,1800000);assert.ok(revised.remaining>1790000);assert.equal(revised.tag,'Player');
    await sleep(100); account='8888'; const resumed=await fetch(base+'/api/resume',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:'{}'});assert.equal(resumed.status,400);assert.match((await resumed.json()).error,/The XAU account changed/);
    assert.equal(calls.filter(x=>x==='/api/achievements/unlock').length,1);assert.ok(!calls.includes('/api/spoof/123'));assert.ok(!calls.some(x=>x.includes('unlockall')));
  } finally {child.kill();await new Promise(r=>child.once('exit',r));await new Promise(r=>mock.close(r));await rm(dir,{recursive:true,force:true});}
});

test('request errors pause and persist the queue without retrying', async () => {
  let mode = 'unlock-error'; const calls = [];
  const mock = http.createServer(async (req, res) => {
    calls.push(req.url); res.setHeader('Content-Type', 'application/json');
    if(req.url==='/api/profile/me') return res.end(JSON.stringify({People:[{Xuid:'9999'}]}));
    if(req.url==='/catalog') return res.end(JSON.stringify([{titleId:'123',isTitleBased:true}]));
    if(req.url==='/api/achievements/123') return res.end(JSON.stringify({achievements:[{id:'1',progressState:mode==='owned'?'Achieved':'NotStarted'}]}));
    if (req.url.startsWith('/api/spoof/')) {
      if (mode === 'spoof-error') { res.statusCode = 500; return res.end('{"error":"spoof failed"}'); }
      return res.end(JSON.stringify({ message:'Spoofing started successfully.', titleId:'123' }));
    }
    if (mode === 'unlock-error') return res.end('{"error":"unlock failed"}');
    return res.end('{}');
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const dir = await mkdtemp(join(tmpdir(), 'xau-error-test-')); const stateFile = join(dir, 'state.json');
  const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
  const child = spawn(process.execPath, ['server.js'], { env:{ ...process.env, PORT:String(port), XAU_URL:`http://127.0.0.1:${mock.address().port}`, TITLE_CATALOG_URL:`http://127.0.0.1:${mock.address().port}/catalog`, AUTH_FILE:join(dir,'auth.json'),STATE_FILE:stateFile }, stdio:'ignore' });
  const base = `http://127.0.0.1:${port}`;
  async function request(path, data = {}) { const response = await fetch(base + path, { method:'POST', headers:{'Content-Type':'application/json', Origin:base}, body:JSON.stringify(data) }); assert.equal(response.status,200); return response.json(); }
  async function paused() { for (let i=0; i<80; i++) { const state = await (await fetch(base+'/api/state')).json(); if (state.status==='paused') return state; await sleep(50); } throw Error('queue did not pause'); }
  try {
    for (let i=0;i<40;i++) { try { await fetch(base+'/api/state'); break; } catch { await sleep(50); } }
    await request('/api/start', {titleId:'123', entries:[{id:'1',name:'First',time:'2025-01-01T00:00:00Z'}]});
    let state = await paused(); assert.match(state.error,/unlock failed/); assert.equal(state.index,0); assert.equal(calls.filter(x=>x.includes('/unlock')).length,1);
    let saved;for(let i=0;i<40;i++){saved=JSON.parse(await readFile(stateFile,'utf8'));if(saved.status==='paused')break;await sleep(25)}assert.equal(saved.status,'paused');
    const before = calls.length; await sleep(1200); assert.equal(calls.length,before);
    const spoofCount=calls.filter(x=>x.startsWith('/api/spoof/')).length;
    assert.equal(calls.filter(x=>x.startsWith('/api/spoof/')).length,spoofCount);
    const denied=await fetch(base+'/api/resume',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:'{}'});assert.equal(denied.status,400);
    const check=await (await fetch(base+'/api/uncertain')).json();assert.equal(check.progress,'notstarted');
    const skipped=await request('/api/resolve',{id:'1',choice:'skip'});assert.equal(skipped.status,'completed');assert.equal(skipped.results['1'],'skipped');assert.ok(skipped.log.some(x=>x.message.includes('Skipped by user')));
    await request('/api/reset'); mode='owned'; const unlockCount=calls.filter(x=>x==='/api/achievements/unlock').length;
    await request('/api/start', {titleId:'123', entries:[{id:'1',name:'First',time:'2025-01-01T00:00:00Z'}]});
    for(let i=0;i<60;i++){state=await (await fetch(base+'/api/state')).json();if(state.status==='completed')break;await sleep(50)}
    assert.equal(state.status,'completed');assert.equal(calls.filter(x=>x.startsWith('/api/spoof/')).length,spoofCount);assert.equal(calls.filter(x=>x==='/api/achievements/unlock').length,unlockCount);
  } finally { child.kill(); await new Promise(r=>child.once('exit',r)); await new Promise(r=>mock.close(r)); await rm(dir,{recursive:true,force:true}); }
});

test('reference history uses Xbox pages, maps IDs and does not expose the token', async () => {
  const requests=[];
  const mock=http.createServer((req,res)=>{
    requests.push({url:req.url,authorization:req.headers.authorization});res.setHeader('Content-Type','application/json');
    if(req.url==='/api/profile/gt/Player%2333') return res.end(JSON.stringify({People:[{Xuid:'1234567891234567'}]}));
    if(req.url==='/api/xauth?format=json') return res.end(JSON.stringify({token:'test-secret'}));
    if(req.url==='/batch') return res.end(JSON.stringify({statListsCollection:[{stats:[{name:'MinutesPlayed',value:'6000'}]}]}));
    if(req.url.startsWith('/users/xuid(1234567891234567)/achievements?')) {
      const url=new URL(req.url,'http://localhost');assert.equal(req.headers.authorization,'test-secret');assert.equal(url.searchParams.get('titleId'),'123');
      if(!url.searchParams.has('continuationToken')) return res.end(JSON.stringify({achievements:[{id:'2',name:'Second',progressState:'Achieved',progression:{timeUnlocked:'2025-01-01T00:01:00Z'}},{id:'3',name:'Locked',progressState:'NotStarted'}],pagingInfo:{continuationToken:'next'}}));
      return res.end(JSON.stringify({achievements:[{id:'1',name:'First',progressState:'Achieved',progression:{timeUnlocked:'2025-01-01T00:00:00Z'}}]}));
    }
    res.statusCode=404;res.end('{}');
  });
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const dir=await mkdtemp(join(tmpdir(),'xau-history-test-'));const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const mockOrigin=`http://127.0.0.1:${mock.address().port}`;
  const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port),XAU_URL:mockOrigin,XBOX_ACHIEVEMENTS_ORIGIN:mockOrigin,XBOX_USERSTATS_ORIGIN:mockOrigin,AUTH_FILE:join(dir,'auth.json'),STATE_FILE:join(dir,'state.json')},stdio:'ignore'});
  const base=`http://127.0.0.1:${port}`;
  try {
    for(let i=0;i<40;i++){try{await fetch(base+'/api/state');break}catch{await sleep(50)}}
    const response=await fetch(base+'/api/history?'+new URLSearchParams({title:'123',tag:'Player#33'}));assert.equal(response.status,200);const raw=await response.text();assert.ok(!raw.includes('test-secret'));
    assert.deepEqual(JSON.parse(raw).entries.map(x=>x.id),['1','2']);assert.equal(JSON.parse(raw).minutesPlayed,6000);
    assert.equal(requests.filter(x=>x.url.startsWith('/users/')).length,2);
  } finally {child.kill();await new Promise(r=>child.once('exit',r));await new Promise(r=>mock.close(r));await rm(dir,{recursive:true,force:true});}
});

test('restart after an interrupted unlock pauses without a stale remaining delay', async () => {
  const dir=await mkdtemp(join(tmpdir(),'xau-restart-test-'));const file=join(dir,'state.json');
  await writeFile(file,JSON.stringify({status:'running',accountXuid:'9999',titleId:'123',entries:[{id:'1',name:'First',time:'2025-01-01T00:00:00Z'}],index:0,dueAt:Date.now()-5000,remaining:60000,inFlight:'1'}));
  const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port),AUTH_FILE:join(dir,'auth.json'),STATE_FILE:file},stdio:'ignore'});
  try {
    let state;for(let i=0;i<40;i++){try{state=await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();break}catch{await sleep(50)}}
    assert.equal(state.status,'paused');assert.equal(state.index,0);assert.equal(state.remaining,0);assert.equal(state.uncertainId,'1');assert.match(state.error,/unknown/);
    assert.equal(JSON.parse(await readFile(file,'utf8')).status,'paused');
  } finally {child.kill();await new Promise(r=>child.once('exit',r));await rm(dir,{recursive:true,force:true});}
});

test('standalone spoof starts and stops independently of the queue', async () => {
  const calls=[];
  const mock=http.createServer((req,res)=>{
    calls.push(req.url);res.setHeader('Content-Type','application/json');
    if(req.url==='/api/profile/me')return res.end(JSON.stringify({People:[{Xuid:'9999'}]}));
    if(req.url==='/api/spoof/123')return res.end(JSON.stringify({message:'Spoofing started successfully.',titleId:'123'}));
    res.statusCode=404;res.end('{}');
  });
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${mock.address().port}`,dir=await mkdtemp(join(tmpdir(),'xau-spoof-test-'));
  const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port),XAU_URL:origin,STATE_FILE:join(dir,'state.json')},stdio:'ignore'}),base=`http://127.0.0.1:${port}`;
  const send=(path,data={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(data)});
  try {
    for(let i=0;i<40;i++){try{await fetch(base+'/api/state');break}catch{await sleep(50)}}
    const started=await send('/api/spoofer/start',{titleId:'123'});assert.equal(started.status,200);const state=await started.json();
    assert.equal(state.status,'running');assert.equal(state.titleId,'123');assert.equal(state.accountXuid,undefined);assert.ok(state.nextHeartbeat-state.startedAt===290000);
    assert.equal(JSON.parse(await readFile(join(dir,'state.json.spoof'),'utf8')).titleId,'123');
    assert.equal((await (await fetch(base+'/api/state')).json()).status,'idle');
    assert.equal((await send('/api/spoofer/start',{titleId:'123'})).status,400);
    const stopped=await (await send('/api/spoofer/stop')).json();assert.equal(stopped.status,'idle');assert.match(stopped.notice,/expires/);assert.ok(stopped.endedAt);assert.equal(JSON.parse(await readFile(join(dir,'state.json.spoof'),'utf8')).status,'idle');
    await sleep(1200);assert.equal(calls.filter(x=>x==='/api/spoof/123').length,1);
  } finally {child.kill();await new Promise(r=>child.once('exit',r));await new Promise(r=>mock.close(r));await rm(dir,{recursive:true,force:true});}
});

test('unlock requests are spaced and the journal records them', async () => {
  const sent=[];
  const mock=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/catalog')return res.end(JSON.stringify([{titleId:'123',isTitleBased:true}]));
    if(req.url==='/api/profile/me')return res.end(JSON.stringify({People:[{Xuid:'9999'}]}));
    if(req.url==='/api/spoof/123')return res.end(JSON.stringify({message:'Spoofing started successfully.',titleId:'123'}));
    if(req.url==='/api/achievements/123')return res.end(JSON.stringify({achievements:[{id:'1',progressState:'NotStarted'},{id:'2',progressState:'NotStarted'}]}));
    if(req.url==='/api/achievements/unlock'){let raw='';for await(const chunk of req)raw+=chunk;const b=JSON.parse(raw);sent.push(Date.now());return res.end(JSON.stringify({message:'Achievement unlocked successfully',titleId:b.titleId,achievementId:b.achievementId}));}
    res.statusCode=404;res.end('{}');
  });
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${mock.address().port}`;
  const dir=await mkdtemp(join(tmpdir(),'xau-rate-test-'));const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port),AUTH_FILE:join(dir,'auth.json'),STATE_FILE:join(dir,'state.json'),XAU_URL:origin,TITLE_CATALOG_URL:origin+'/catalog'},stdio:'ignore'});const base=`http://127.0.0.1:${port}`;
  try{
    for(let i=0;i<40;i++){try{await fetch(base+'/api/state');break}catch{await sleep(50)}}
    const entries=['1','2'].map(id=>({id,name:id,time:'2025-01-01T00:00:00Z'}));
    const started=await fetch(base+'/api/start',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({titleId:'123',entries})});assert.equal(started.status,200);
    let state;for(let i=0;i<80;i++){state=await (await fetch(base+'/api/state')).json();if(state.index===1)break;await sleep(50)}
    assert.equal(state.index,1);assert.equal(sent.length,1);assert.ok(state.dueAt-sent[0]>=1900);assert.ok(!state.log.some(x=>x.message.includes('presence heartbeat')));assert.equal(state.log.filter(x=>x.message.startsWith('Sent:')).length,1);
    await sleep(1200);assert.equal(sent.length,1);
  }finally{child.kill();await new Promise(r=>child.once('exit',r));await new Promise(r=>mock.close(r));await rm(dir,{recursive:true,force:true});}
});

test('server stops after the last browser tab closes', async () => {
  const dir=await mkdtemp(join(tmpdir(),'xau-close-test-'));const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port),AUTH_FILE:join(dir,'auth.json'),STATE_FILE:join(dir,'state.json')},stdio:'ignore'});
  const base=`http://127.0.0.1:${port}`;let exited=false;child.on('exit',()=>{exited=true});
  const notify=async(path,id)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({id})});assert.equal(r.status,200)};
  try {
    for(let i=0;i<40;i++){try{await fetch(base+'/api/state');break}catch{await sleep(50)}}
    await notify('/api/client/heartbeat','test-client-1111');await notify('/api/client/heartbeat','test-client-2222');
    await notify('/api/client/close','test-client-1111');await sleep(1100);assert.equal(exited,false);
    await notify('/api/client/close','test-client-2222');await sleep(1000);await notify('/api/client/heartbeat','test-client-3333');
    await sleep(1200);assert.equal(exited,false);
    await notify('/api/client/close','test-client-3333');
    for(let i=0;i<250&&!exited;i++)await sleep(100);
    assert.equal(exited,true);
  } finally {if(!exited){child.kill();await new Promise(r=>child.once('exit',r));}await rm(dir,{recursive:true,force:true});}
});

test('game playtime and settings persist independently of the server port', async () => {
  const mock=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/profile/me')return res.end(JSON.stringify({People:[{Xuid:'9999'}]}));
    if(req.url==='/api/xauth?format=json')return res.end(JSON.stringify({token:'private-test-token'}));
    if(req.url==='/batch') {let data='';for await(const chunk of req)data+=chunk;assert.equal(JSON.parse(data).Stats[0].TitleId,'123');return res.end(JSON.stringify({statListsCollection:[{stats:[{name:'MinutesPlayed',value:'135'}]}]}));}
    res.statusCode=404;res.end('{}');
  });
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const mockOrigin=`http://127.0.0.1:${mock.address().port}`,dir=await mkdtemp(join(tmpdir(),'xau-settings-test-'));
  async function launch(){const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'0',XAU_URL:mockOrigin,XBOX_USERSTATS_ORIGIN:mockOrigin,STATE_FILE:join(dir,'state.json')},stdio:['ignore','pipe','ignore']});const base=await new Promise((resolve,reject)=>{createInterface({input:child.stdout}).on('line',line=>{const m=line.match(/^XAU Companion: (http:\/\/127\.0\.0\.1:\d+) /);if(m)resolve(m[1]);});child.once('exit',()=>reject(new Error('server exited')))});return {child,base};}
  let instance;
  try {
    instance=await launch();let {child,base}=instance;
    const play=await (await fetch(base+'/api/playtime?title=123')).json();assert.equal(play.minutesPlayed,135);assert.ok(play.updatedAt);
    assert.equal((await fetch(base+'/spoof-panel.js')).status,200);
    const options={method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({key:'xau-game-filters',value:'{"hideEmpty":true}'})};
    assert.equal((await fetch(base+'/api/settings',options)).status,200);
    assert.equal((await fetch(base+'/api/auth/token',{...options,body:'{}'})).status,404);
    child.kill();await new Promise(r=>child.once('exit',r));instance=null;
    instance=await launch();assert.equal((await (await fetch(instance.base+'/api/settings')).json())['xau-game-filters'],'{"hideEmpty":true}');
  } finally {if(instance){instance.child.kill();await new Promise(r=>instance.child.once('exit',r));}await new Promise(r=>mock.close(r));await rm(dir,{recursive:true,force:true});}
});
