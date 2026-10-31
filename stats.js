// Xbox stat read/write workflow based on the public Achievement Labs implementation:
// https://github.com/Achievement-Labs/achievement-labs/blob/de5fa46b6b775c12fab1d2814621651962250f65/src/AchievementLabs.Core/Networking/XboxApiClient.cs
const guid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const validScid=value=>guid.test(value)&&!/^[0-]+$/.test(value);
const prop=(object,...keys)=>{if(!object||typeof object!=='object')return undefined;const key=Object.keys(object).find(k=>keys.some(name=>name.toLowerCase()===k.toLowerCase()));return key===undefined?undefined:object[key];};
const stringValue=value=>typeof value==='string'||typeof value==='number'||typeof value==='boolean'?String(value):'';
export function parseStats(data,fallbackScid=''){
  const collections=[];const add=value=>{if(Array.isArray(value))collections.push(...value);};
  for(const group of prop(data,'groups')||[]){add(prop(group,'statlistscollection','statlistcollection'));if(Array.isArray(prop(group,'stats','statlist')))collections.push(group);}
  add(prop(data,'statlistscollection','statlistcollection'));
  for(const user of prop(data,'users')||[])add(prop(user,'scids'));
  if(Array.isArray(prop(data,'stats','statlist')))collections.push(data);
  const result=[],seen=new Set();
  for(const collection of collections){const scid=stringValue(prop(collection,'scid','serviceconfigid'))||fallbackScid;const stats=prop(collection,'stats','statlist');if(!Array.isArray(stats))continue;for(const item of stats){const name=stringValue(prop(item,'name','statname','statisticname'));if(!name||name.length>200)continue;const itemScid=stringValue(prop(item,'scid','serviceconfigid'))||scid;const key=name.toLowerCase()+'\0'+itemScid.toLowerCase();if(seen.has(key))continue;seen.add(key);const display=stringValue(prop(prop(item,'groupproperties'),'displayname'))||stringValue(prop(item,'displayname'))||name;const value=prop(item,'value')??prop(prop(item,'properties'),'value');result.push({name,displayName:display,value:stringValue(value),type:stringValue(prop(item,'type','valuetype'))||'Unknown',scid:itemScid,writable:validScid(itemScid)});}}
  return result;
}
function titleHubStats(data,title,scid){
  const titles=prop(data,'titles');if(!Array.isArray(titles))return [];
  const result=[];
  function visit(value){
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){for(const item of value)visit(item);return;}
    const name=stringValue(prop(value,'statname','statisticname','id','name'));
    const raw=prop(value,'value','displayvalue','currentvalue','numbervalue','stringvalue');
    if(name && raw!==undefined && (typeof raw==='string'||typeof raw==='number'||typeof raw==='boolean'))result.push({name,displayName:stringValue(prop(value,'displayname'))||name,value:stringValue(raw),type:stringValue(prop(value,'type','valuetype','statistictype','displayformat'))||'Unknown',scid:stringValue(prop(value,'scid','serviceconfigid'))||scid,writable:false});
    for(const child of Object.values(value))if(child && typeof child==='object')visit(child);
  }
  for(const item of titles)if(String(prop(item,'titleid','moderntitleid'))===title)visit(prop(item,'stats'));
  return result;
}
function validateValue(value,stat){
  const hint=(stat.type==='Unknown'?(/^(true|false)$/i.test(stat.value)?'boolean':/^-?\d+$/.test(stat.value)?'integer':Number.isFinite(Number(stat.value))&&stat.value.trim()?'double':'string'):stat.type).toLowerCase();
  if(hint.includes('string'))return value;
  if(hint.includes('bool') && /^(true|false)$/i.test(value))return value.toLowerCase();
  if(/int|long/.test(hint) && /^-?\d+$/.test(value)){try{const n=BigInt(value);if(n>=-(2n**63n)&&n<2n**63n)return value;}catch{}}
  if(/double|float|single|decimal|number/.test(hint) && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value)))return value;
  throw new Error(`Enter a valid ${stat.type === 'Unknown' ? hint : stat.type} value.`);
}
function revisionFrom(data){
  const objects=[];const visit=value=>{if(!value||typeof value!=='object')return;if(Array.isArray(value)){for(const item of value)visit(item);return;}objects.push(value);for(const item of Object.values(value))visit(item);};visit(data);
  for(const key of ['previousRevision','revision'])for(const object of objects){const value=prop(object,key);if((typeof value==='number'||typeof value==='string') && /^\d+$/.test(String(value))){const n=Number(value);if(Number.isSafeInteger(n)&&n>=0)return n;}}
  return 0;
}
export function createStatsService({xau,statMode=async()=> 'unknown',fetcher=fetch,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  async function request(url,token,contract,{method='GET',body,allow404=false}={}){
    const response=await fetcher(url,{method,headers:{Authorization:token,'x-xbl-contract-version':String(contract),Accept:'application/json','Accept-Language':'en-US',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000),redirect:'error'});
    if(allow404 && response.status===404)return {};
    if(!response.ok){const e=new Error(`Xbox stats request failed (HTTP ${response.status})`);e.status=response.status;throw e;}const text=await response.text();if(!text)return {};try{return JSON.parse(text);}catch{throw new Error('Xbox returned an invalid stats response');}
  }
  async function identity(){const profile=await xau('/api/profile/me');const xuid=String(prop((prop(profile,'people')||[])[0],'xuid')||'');if(!/^\d+$/.test(xuid))throw new Error('Could not identify the Xbox account');const token=prop(await xau('/api/xauth?format=json'),'token');if(typeof token!=='string'||!token.trim())throw new Error('Xbox authorization is unavailable');return{xuid,token};}
  async function read(title,{xuid,token}){
    const [library,achievement,modeResult,titleHub]=await Promise.allSettled([xau('/api/games/me'),xau('/api/achievements/'+title),statMode(title),xau('/api/games/search/titleid/'+title)]);
    const mode=modeResult.status==='fulfilled'?modeResult.value:'unavailable';
    const game=(prop(library.status==='fulfilled'?library.value:null,'titles')||[]).find(item=>String(prop(item,'titleid'))===title);
    let scid=stringValue(prop(game,'serviceconfigid','scid')||prop(prop(game,'detail'),'scid','serviceconfigid'));
    if(!validScid(scid)){const items=prop(achievement.status==='fulfilled'?achievement.value:null,'achievements')||[];scid=items.map(item=>stringValue(prop(item,'serviceconfigid','scid'))).find(validScid)||'';}
    const hero={arrangebyfield:'xuid',xuids:[xuid],groups:[{name:'Hero',titleId:title}]};
    const calls=[request('https://userstats.xboxlive.com/batch',token,2,{method:'POST',body:hero})];
    if(validScid(scid))calls.unshift(request(`https://userstats.xboxlive.com/users/xuid(${xuid})/scids/${scid}/stats`,token,2));
    const responses=await Promise.allSettled(calls),merged=[],seen=new Set();
    for(const response of responses)if(response.status==='fulfilled')for(const stat of parseStats(response.value,scid)){const key=stat.name.toLowerCase()+'\0'+stat.scid.toLowerCase();if(!seen.has(key)){seen.add(key);stat.writable=stat.writable && mode==='title';if(!stat.writable)stat.readOnlyReason=mode==='event'?'This game uses event-based stats; event editing is not available.':mode==='unavailable'?'Could not load the stat compatibility catalog.':mode!=='title'?'This game is not listed as supporting title-based stat editing.':'This stat has no valid service configuration.';merged.push(stat);}}
    for(const stat of titleHubStats(titleHub.status==='fulfilled'?titleHub.value:null,title,scid)){if(!merged.some(item=>item.name.toLowerCase()===stat.name.toLowerCase())){stat.readOnlyReason='This value is shown by Xbox; a writable stat was not found.';merged.push(stat);}}
    if(!merged.length && responses.every(r=>r.status==='rejected'))throw responses[0].reason;
    return merged;
  }
  return {
    async read(title){const auth=await identity();return read(title,auth);},
    async write({title,name,scid,value}){
      if(!/^\d+$/.test(title)||typeof name!=='string'||!name||name.length>200||!validScid(scid)||typeof value!=='string'||!value.trim()||value.length>100)throw new Error('Invalid stat value');
      const auth=await identity(),list=await read(title,auth);const stat=list.find(item=>item.name===name&&item.scid.toLowerCase()===scid.toLowerCase()&&item.writable);if(!stat)throw new Error('This stat is not available for the selected game. Reload stats.');
      const safeValue=validateValue(value.trim(),stat);
      const again=await identity();if(auth.xuid!==again.xuid)throw new Error('The Xbox account changed. Reload stats.');
      const statUrl=`https://userstats.xboxlive.com/users/xuid(${auth.xuid})/scids/${scid}/stats/${encodeURIComponent(name)}?include=value,metadata`;
      const revision=revisionFrom(await request(statUrl,again.token,2,{allow404:true}));
      const now=new Date(),body={$schema:'http://stats.xboxlive.com/2017-1/schema#',previousRevision:revision,revision:Math.max(Math.floor(now.getTime()/1000),revision+1),timestamp:now.toISOString(),stats:{title:{[name]:{value:safeValue}}}};
      await request(`https://statswrite.xboxlive.com/stats/users/${auth.xuid}/scids/${scid}`,again.token,4,{method:'PATCH',body});
      await sleep(2000);let confirmed=false;try{const data=await request(statUrl,again.token,2);const items=parseStats(data,scid);confirmed=items.some(item=>item.name===name&&item.value.trim()===safeValue);}catch{}
      return {confirmed};
    }
  };
}
