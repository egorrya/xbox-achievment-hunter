import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
const isolatedAuthDir=mkdtempSync(join(tmpdir(),'xau-auth-isolated-'));
process.env.AUTH_FILE=join(isolatedAuthDir,'session.json');
process.on('exit',()=>rmSync(isolatedAuthDir,{recursive:true,force:true}));
const { createXboxApi, useXauth, loginStatus, signOut, attachXboxPc }=await import('../xbox-client.js');
const { readXboxPcCandidates }=await import('../windows-auth.js');

test('Xbox adapter sends individual unlock and heartbeat requests', async () => {
  const calls=[]; const scid='12345678-1234-1234-1234-123456789abc';
  const xbox=createXboxApi({getToken:async()=>({userXUID:'1234',userHash:'hash',XSTSToken:'secret'}),fetcher:async(url,options)=>{
    calls.push({url,options});
    if(url.includes('/achievements?'))return new Response(JSON.stringify({achievements:[{id:'7',serviceConfigId:scid}]}),{status:200});
    return new Response('',{status:200});
  }});
  const spoof=await xbox('/api/spoof/55');assert.equal(spoof.titleId,'55');assert.equal(calls[0].url,'https://presence-heartbeat.xboxlive.com/users/xuid(1234)/devices/current/');assert.equal(calls[0].options.headers['x-xbl-contract-version'],'3');assert.deepEqual(JSON.parse(calls[0].options.body),{titles:[{expiration:600,id:'55',state:'active',sandbox:'RETAIL'}]});
  await xbox('/api/spoof-stop');assert.equal(calls[1].url,calls[0].url);assert.equal(calls[1].options.method,'DELETE');
  const result=await xbox('/api/achievements/unlock',{body:JSON.stringify({titleId:'55',achievementId:'7'})});assert.equal(result.achievementId,'7');
  const update=calls.find(c=>c.url.includes('/update'));const body=JSON.parse(update.options.body);
  assert.deepEqual(body.achievements,[{id:'7',percentComplete:'100'}]);assert.equal(body.serviceConfigId,scid);
  assert.equal(update.options.headers.Authorization,'XBL3.0 x=hash;secret');assert.equal(update.options.headers['x-xbl-contract-version'],'2');assert.equal(update.options.headers['User-Agent'],'XboxServicesAPI/2021.10.20211005.0 c');
  assert.equal(calls.filter(c=>c.url.includes('/update')).length,1);
});

test('Xbox adapter reports heartbeat and unlock HTTP errors', async () => {
  const xbox=createXboxApi({getToken:async()=>({userXUID:'1234',userHash:'hash',XSTSToken:'secret'}),fetcher:async()=>new Response('',{status:403})});
  await assert.rejects(()=>xbox('/api/spoof/55'),/HTTP 403.*Xbox rejected the presence request/);
});

test('Xbox errors identify the failing operation without exposing response secrets', async () => {
  const xbox=createXboxApi({getToken:async()=>({userXUID:'1234',userHash:'hash',XSTSToken:'secret'}),fetcher:async()=>new Response(JSON.stringify({errorCode:'InvalidParameter',message:'secret'}),{status:400})});
  await assert.rejects(()=>xbox('/api/games/me'),e=>/games list.*HTTP 400.*InvalidParameter/.test(e.message)&&!e.message.includes('secret'));
  await assert.rejects(()=>xbox('/api/profile/me'),/profile lookup.*HTTP 400/);
});


test('manual XAuth sign-in resolves XUID independently from user hash', async () => {
  const calls=[];
  const fetcher=async(url,options)=>{calls.push({url,options});if(url.includes('profile.xboxlive.com'))return new Response(JSON.stringify({profileUsers:[{id:'1234'}]}));return new Response(JSON.stringify({People:[{Xuid:'1234'}]}));};
  await assert.rejects(()=>useXauth('not a token',{fetcher}),/Invalid XAuth/);
  await useXauth('XBL3.0 x=987654;fake-token-12345678901234567890',{fetcher});
  assert.equal(loginStatus().status,'signed_in');assert.ok(calls[1].url.includes('xuids(1234)'));assert.ok(!calls[1].url.includes('xuids(987654)'));
  assert.equal(calls[0].options.headers.Authorization,'XBL3.0 x=987654;fake-token-12345678901234567890');
  const saved=JSON.parse(await readFile(process.env.AUTH_FILE,'utf8'));assert.equal(saved.token,'XBL3.0 x=987654;fake-token-12345678901234567890');
  if(process.platform!=='win32')assert.equal((await stat(process.env.AUTH_FILE)).mode & 0o777,0o600);
  const script="import {restoreXauth,loginStatus} from './xbox-client.js'; const fetcher=async url=>new Response(JSON.stringify(url.includes('profile.xboxlive.com')?{profileUsers:[{id:'1234'}]}:{People:[{Xuid:'1234'}]})); await restoreXauth({fetcher}); if(loginStatus().status!=='signed_in')process.exit(1);";
  await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),env:process.env});
  await signOut();assert.equal(loginStatus().status,'signed_out');await assert.rejects(()=>readFile(process.env.AUTH_FILE),{code:'ENOENT'});
});

test('Xbox PC sign-in checks candidates and preserves account on mismatch', async () => {
  const first='XBL3.0 x=wrong;fake-token-12345678901234567890', second='XBL3.0 x=correct;fake-token-12345678901234567890';
  const fetcher=async(url,options)=>new Response(JSON.stringify(url.includes('profile.xboxlive.com')?{profileUsers:[{id:'1234'}]}:{People:[{Xuid:options.headers.Authorization.includes('wrong')?'9999':'1234'}]}));
  await attachXboxPc({expectedXuid:'1234',readCandidates:async()=>[first,second],fetcher});
  assert.equal(loginStatus().source,'xbox-pc');
  await assert.rejects(()=>attachXboxPc({expectedXuid:'1234',readCandidates:async()=>[first],fetcher}),/No usable Xbox PC authorization/);
  assert.equal(loginStatus().status,'signed_in');assert.equal(loginStatus().source,'xbox-pc');
  await signOut();
});

test('Xbox PC credential scanner validates output without exposing credentials', async () => {
  await assert.rejects(()=>readXboxPcCandidates({platform:'darwin'}),/only on Windows/);
  const values=await readXboxPcCandidates({platform:'win32',run:async()=>({stdout:JSON.stringify(['test-token'])})});
  assert.deepEqual(values,['test-token']);
  await assert.rejects(()=>readXboxPcCandidates({platform:'win32',run:async()=>{throw Error('private-token')}}),e=>!e.message.includes('private-token'));
});

test('profile, game lookup, achievements, and gamertag use XAU Xbox routes', async () => {
  const calls=[];
  const xbox=createXboxApi({getToken:async()=>({userXUID:'1234',userHash:'hash',XSTSToken:'secret'}),fetcher:async(url,options)=>{
    calls.push({url,options});
    if(url.includes('profile.xboxlive.com'))return new Response(JSON.stringify({profileUsers:[{id:'5678'}]}));
    if(url.includes('/achievements?'))return new Response(JSON.stringify({achievements:[{id:'1'}]}));
    return new Response('{}');
  }});
  await xbox('/api/profile/me');await xbox('/api/games/me');await xbox('/api/games/search/titleid/55');await xbox('/api/achievements/55');
  const profile=await xbox('/api/profile/gt/Player%2333');assert.equal(profile.People[0].Xuid,'5678');
  assert.equal(calls[0].url,'https://peoplehub.xboxlive.com/users/me/people/xuids(1234)/decoration/detail,preferredColor,presenceDetail,multiplayerSummary');assert.equal(calls[0].options.headers['x-xbl-contract-version'],'5');
  assert.match(calls[1].url,/titleHistory\/decoration\/Achievement,detail,scid\?maxItems=10000$/);assert.equal(calls[1].options.headers['x-xbl-contract-version'],'2');
  assert.match(calls[2].url,/titles\/batch\/decoration\/GamePass,Achievement,Stats$/);assert.deepEqual(JSON.parse(calls[2].options.body),{Pfns:null,TitleIds:['55']});
  assert.equal(calls[3].url,'https://achievements.xboxlive.com/users/xuid(1234)/achievements?titleId=55&maxItems=1000');assert.equal(calls[3].options.headers['x-xbl-contract-version'],'4');
  assert.match(calls[4].url,/users\/gt\(Player%2333\)\/profile\/settings\?settings=GameDisplayPicRaw,Gamerscore,Gamertag$/);
});

test('empty modern achievements fall back to the Xbox 360 endpoint', async () => {
  const calls=[];
  const xbox=createXboxApi({getToken:async()=>({userXUID:'1234',userHash:'hash',XSTSToken:'secret'}),fetcher:async(url,options)=>{
    calls.push({url,options});return new Response(JSON.stringify({achievements:url.includes('/titleachievements?')?[{id:42}]:[]}));
  }});
  const data=await xbox('/api/achievements/55');assert.equal(data.achievements[0].id,42);assert.equal(calls.length,2);
  assert.equal(calls[1].url,'https://achievements.xboxlive.com/users/xuid(1234)/titleachievements?titleId=55&maxItems=1000');assert.equal(calls[1].options.headers['x-xbl-contract-version'],'3');
});




test('Xbox rate limits preserve retry timing without exposing the response body', async () => {
  const xbox=createXboxApi({getToken:async()=>({userXUID:'1234',userHash:'hash',XSTSToken:'secret'}),fetcher:async()=>new Response('private',{status:429,headers:{'Retry-After':'45'}})});
  await assert.rejects(()=>xbox('/api/achievements/55'),e=>e.status===429 && e.retryAfter===45 && !e.message.includes('private'));
});
