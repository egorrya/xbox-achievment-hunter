import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { steamProfileUrl, linkedSteamProfile, parseSteamProfile, parseSteamAchievements, matchSteamAchievements, matchingSteamGame } from '../public/steam.js';

test('Steam profile URLs allow only canonical community profiles',()=>{
  assert.equal(steamProfileUrl('https://steamcommunity.com/id/Example/'),'https://steamcommunity.com/id/Example/');
  assert.equal(steamProfileUrl('https://steamcommunity.com/profiles/76561197968575517'),'https://steamcommunity.com/profiles/76561197968575517/');
  for(const input of ['http://steamcommunity.com/id/test','https://steamcommunity.com.evil.test/id/name','https://steamcommunity.com/id/name/stats/42','https://steamcommunity.com/profiles/123','https://steamcommunity.com/id/name/?foo=1'])assert.throws(()=>steamProfileUrl(input));
});

test('Xbox linked Steam accounts require an actual profile URL or Steam ID',()=>{
  assert.deepEqual(linkedSteamProfile({linkedAccounts:[{networkName:'Steam',displayName:'Same Name',deeplink:'https://steamcommunity.com/id/player/'}]}),{status:'linked',url:'https://steamcommunity.com/id/player/'});
  assert.deepEqual(linkedSteamProfile({LinkedAccounts:[{NetworkName:'Steam',SteamId:'76561197968575517'}]}),{status:'linked',url:'https://steamcommunity.com/profiles/76561197968575517/'});
  assert.deepEqual(linkedSteamProfile({linkedAccounts:[{networkName:'Steam',displayName:'player',deeplink:null}]}),{status:'unavailable'});
  assert.deepEqual(linkedSteamProfile({linkedAccounts:[{networkName:'Steam',deeplink:'https://evil.test/id/player'}]}),{status:'unavailable'});
  assert.deepEqual(linkedSteamProfile({linkedAccounts:[]}),{status:'unlinked'});
  assert.deepEqual(linkedSteamProfile({linkedAccounts:[{networkName:'Steam',deeplink:'https://steamcommunity.com/id/first/'},{networkName:'Steam',deeplink:'https://steamcommunity.com/id/second/'}]}),{status:'unavailable'});
});

test('only public Steam profiles with valid IDs are accepted',()=>{
  const doc=(privacy,id='76561197968575517')=>({documentElement:{tagName:'profile'},querySelector:s=>({'privacyState':{textContent:privacy},'steamID64':{textContent:id},'steamID':{textContent:'Alice'}}[s]||null)});
  assert.deepEqual(parseSteamProfile('',()=>doc('public')),{steamId:'76561197968575517',name:'Alice'});
  assert.throws(()=>parseSteamProfile('',()=>doc('private')));assert.throws(()=>parseSteamProfile('',()=>doc('public','123')));
});

test('new Steam achievement pages join profile unlock times with the game schema',()=>{
  const steamId='76561197968575517', queries=[{state:{data:{appid:620,steamid:steamId,achievements:{'30':{unlocked:true,unlock_time:1657768377},'31':{unlocked:true,unlock_time:0},'32':{unlocked:false}}}}},{state:{data:{appid:620,groups:[{achievements:[{internal_key:30,name:'High Five'},{internal_key:31,name:'No Time'},{internal_key:32,name:'Locked'}]}]}}}];
  const raw=JSON.stringify({renderContext:{queryData:JSON.stringify({queries})}});const parser=()=>({querySelector:()=>({textContent:raw})});
  const result=parseSteamAchievements('<html></html>',steamId,'620',parser);assert.deepEqual(result,{entries:[{name:'High Five',time:new Date(1657768377*1000).toISOString()}],invalid:1});
  assert.throws(()=>parseSteamAchievements('<html></html>','76561197968575518','620',parser),/unavailable/);
});

test('Steam matching ignores ambiguous, missing, and duplicate names',()=>{
  const rows=['High Five','Duplicate','Only Steam','Repeated','Repeated'].map(name=>({name,time:'2025-01-01T00:00:00Z'}));
  const result=matchSteamAchievements(rows,[{id:'1',name:'high   five'},{id:'2',name:'Duplicate'},{id:'3',name:'Duplicate'},{id:'4',name:'Repeated'}]);
  assert.deepEqual(result.matches.map(x=>x.id),['1']);assert.deepEqual(result.unmatched,['Duplicate','Only Steam','Repeated','Repeated']);
});

test('automatic Steam game selection requires one exact match',()=>{
  const games=[{id:'620',name:'Portal 2'},{id:'123',name:'Portal 2: Other Edition'}];
  assert.equal(matchingSteamGame(games,'  PORTAL   2 ')?.id,'620');
  assert.equal(matchingSteamGame(games,'Portal'),null);
  assert.equal(matchingSteamGame([...games,{id:'999',name:'Portal 2'}],'Portal 2'),null);
  assert.equal(matchingSteamGame([{id:'bad',name:'Portal 2'}],'Portal 2'),null);
});

test('legacy XML includes only achievements with real timestamps',()=>{
  const doc={documentElement:{tagName:'playerstats'},querySelector:()=>null,querySelectorAll:()=>[{querySelector:s=>({textContent:s==='name'?'First':'1657768377'})},{querySelector:s=>({textContent:s==='name'?'No time':'0'})}]};
  const result=parseSteamAchievements('<playerstats></playerstats>','76561197968575517','620',()=>doc);assert.equal(result.entries.length,1);assert.equal(result.entries[0].name,'First');assert.equal(result.invalid,1);
});
