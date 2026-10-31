import test from 'node:test';
import assert from 'node:assert/strict';
import {createStatsService,parseStats} from '../stats.js';
import {ensureXboxPc} from '../windows-auth.js';
const scid='12345678-1234-1234-1234-123456789abc';
const fixture={groups:[{statlistscollection:[{scid,stats:[{name:'Kills',value:'7',type:'Integer',groupproperties:{DisplayName:'Enemy kills'}}]}]}]};
const xau=async path=>path==='/api/profile/me'?{People:[{Xuid:'42'}]}:path==='/api/xauth?format=json'?{token:'private-token'}:{titles:[{titleId:'123',detail:{scid}}]};
test('parse stats preserves metadata and never makes missing scids writable',()=>{const [stat]=parseStats(fixture);assert.deepEqual(stat,{name:'Kills',displayName:'Enemy kills',value:'7',type:'Integer',scid,writable:true});assert.equal(parseStats({statListsCollection:[{stats:[{name:'A',value:0}]}]})[0].writable,false);});
test('writes use the current Xbox revision and verify the result',async()=>{
  const calls=[];let value='7';const fetcher=async(url,options)=>{calls.push({url,options});if(options.method==='PATCH'){value='9';return new Response(null,{status:204});}if(url.includes('/batch'))return Response.json({statListsCollection:[]});return Response.json({stats:[{name:'Kills',value,type:'Integer',revision:2000000000}]});};
  const service=createStatsService({xau,statMode:async()=> 'title',fetcher,sleep:async()=>{}});assert.equal((await service.read('123'))[0].value,'7');assert.deepEqual(await service.write({title:'123',name:'Kills',scid,value:'9'}),{confirmed:true});const write=calls.find(c=>c.options.method==='PATCH'),body=JSON.parse(write.options.body);assert.equal(body.stats.title.Kills.value,'9');assert.equal(body.previousRevision,2000000000);assert.equal(body.revision,2000000001);
  await assert.rejects(()=>service.write({title:'123',name:'unknown',scid,value:'9'}),/not available/);await assert.rejects(()=>service.write({title:'123',name:'Kills',scid,value:'1.5'}),/valid Integer/);assert.equal(calls.filter(c=>c.options.method==='PATCH').length,1);
});
test('unconfirmed or rejected writes are not reported as confirmed',async()=>{let mode='unconfirmed';const fetcher=async(url,options)=>{if(url.includes('/batch'))return Response.json(fixture);if(options.method==='PATCH')return mode==='reject'?new Response('sensitive response',{status:403}):new Response(null,{status:204});return Response.json({stats:[{name:'Kills',value:'7'}]});};const service=createStatsService({xau,statMode:async()=> 'title',fetcher,sleep:async()=>{}});assert.deepEqual(await service.write({title:'123',name:'Kills',scid,value:'9'}),{confirmed:false});mode='reject';await assert.rejects(()=>service.write({title:'123',name:'Kills',scid,value:'9'}),e=>e.message.includes('403')&&!e.message.includes('sensitive'));});
test('Xbox is launched only when its process is absent',async()=>{
  let calls=0,launches=0,args;
  const run=async(...input)=>{calls++;args=input;return {stdout:'running\r\n'};};
  assert.deepEqual(await ensureXboxPc({platform:'win32',run,launch:async()=>{launches++;}}),{launched:false});
  assert.equal(launches,0);assert.equal(args[0],'powershell.exe');assert.match(args[1].at(-1),/XboxPcApp/);
  assert.deepEqual(await ensureXboxPc({platform:'win32',run:async()=>({stdout:'stopped'}),launch:async()=>{launches++;}}),{launched:true});assert.equal(launches,1);
  await assert.rejects(()=>ensureXboxPc({platform:'win32',run:async()=>{throw Error('private');}}),e=>!e.message.includes('private'));
  await assert.rejects(()=>ensureXboxPc({platform:'win32',run:async()=>({stdout:'unexpected'}),launch:async()=>{launches++;}}),/check/);assert.equal(launches,1);
});

test('reads grouped playtime and SCID batch responses',()=>{
  assert.equal(parseStats({groups:[{statListsCollection:[{stats:[{statname:'MinutesPlayed',value:135}]}]}]})[0].value,'135');
  assert.equal(parseStats({users:[{scids:[{scid,stats:[{statname:'Kills',value:7}]}]}]})[0].scid,scid);
});
test('loads SCID stats when the Hero response is empty',async()=>{
  const calls=[];
  const service=createStatsService({xau,statMode:async()=> 'title',fetcher:async(url,options)=>{calls.push({url,options});return Response.json(url.includes('/batch')?{groups:[]}:{stats:[{name:'Kills',type:'Integer',value:7}]});}});
  assert.equal((await service.read('123'))[0].value,'7');
  assert.ok(calls.some(call=>call.url.includes('/scids/'+scid+'/stats')));
});
test('resolves missing SCID from achievement metadata',async()=>{
  const service=createStatsService({xau:async path=>path==='/api/games/me'?{titles:[{titleId:'123'}]}:path==='/api/achievements/123'?{achievements:[{serviceConfigId:scid}]}:xau(path),fetcher:async(url)=>Response.json(url.includes('/batch')?{}:{stats:[{name:'Kills',value:'5'}]})});
  assert.equal((await service.read('123'))[0].scid,scid);
});
test('does not write if reading the revision fails',async()=>{
  let writes=0;const service=createStatsService({xau,statMode:async()=> 'title',fetcher:async(url,options)=>{if(options.method==='PATCH'){writes++;return new Response(null,{status:204});}if(url.includes('/batch'))return Response.json({});if(url.includes('?include='))return new Response(null,{status:403});return Response.json({stats:[{name:'Kills',type:'Integer',value:'1'}]});}});
  await assert.rejects(()=>service.write({title:'123',name:'Kills',scid,value:'2'}),/403/);assert.equal(writes,0);
});

test('event-based or unknown titles cannot be written as title stats',async()=>{
  let writes=0;for(const mode of ['event','unknown','unavailable']){
    const service=createStatsService({xau,statMode:async()=>mode,fetcher:async(url,options)=>{if(options.method==='PATCH')writes++;return Response.json(url.includes('/batch')?{}:{stats:[{name:'Kills',type:'Integer',value:'1'}]});}});
    const stats=await service.read('123');assert.equal(stats[0].writable,false);assert.ok(stats[0].readOnlyReason);
    await assert.rejects(()=>service.write({title:'123',name:'Kills',scid,value:'2'}),/not available/);
  }assert.equal(writes,0);
});

test('shows TitleHub-only stats as read-only',async()=>{
  const service=createStatsService({xau:async path=>path.includes('/games/search/titleid/')?{Titles:[{TitleId:'123',stats:{items:[{statName:'Distance',displayValue:'12 km'}]}}]}:xau(path),statMode:async()=> 'title',fetcher:async()=>Response.json({})});
  const stats=await service.read('123');assert.equal(stats[0].name,'Distance');assert.equal(stats[0].value,'12 km');assert.equal(stats[0].writable,false);
});
