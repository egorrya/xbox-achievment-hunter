// Xbox stat request format informed by caiobrasuca/Xbox-Achievement-Unlocker,
// XAU/Services/StatEditor/StatEditorService.cs (GPL-licensed project).
const guid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const prop=(object,...keys)=>{if(!object||typeof object!=='object')return undefined;const key=Object.keys(object).find(k=>keys.some(name=>name.toLowerCase()===k.toLowerCase()));return key===undefined?undefined:object[key];};
const stringValue=value=>typeof value==='string'||typeof value==='number'?String(value):'';
export function parseStats(data,fallbackScid=''){
  const collections=[];const add=value=>{if(Array.isArray(value))collections.push(...value);};
  for(const group of prop(data,'groups')||[])add(prop(group,'statlistscollection','statlistcollection'));
  add(prop(data,'statlistscollection','statlistcollection'));
  for(const user of prop(data,'users')||[])add(prop(user,'scids'));
  const result=[],seen=new Set();
  for(const collection of collections){const scid=stringValue(prop(collection,'scid'))||fallbackScid;const stats=prop(collection,'stats','statlist');if(!Array.isArray(stats))continue;for(const item of stats){const name=stringValue(prop(item,'name','statname'));if(!name||name.length>200)continue;const itemScid=stringValue(prop(item,'scid'))||scid;const key=name+'\0'+itemScid;if(seen.has(key))continue;seen.add(key);const display=stringValue(prop(prop(item,'groupproperties'),'displayname'))||stringValue(prop(item,'displayname'))||name;result.push({name,displayName:display,value:stringValue(prop(item,'value')),type:stringValue(prop(item,'type'))||'Unknown',scid:itemScid,writable:guid.test(itemScid)&&!/^[0-]+$/.test(itemScid)});}}
  return result;
}
export function createStatsService({xau,fetcher=fetch,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  async function request(url,token,contract,{method='GET',body}={}){
    const response=await fetcher(url,{method,headers:{Authorization:token,'x-xbl-contract-version':String(contract),Accept:'application/json','Accept-Language':'en-US',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000),redirect:'error'});
    if(!response.ok){const e=new Error(`Xbox stats request failed (HTTP ${response.status})`);e.status=response.status;throw e;}const text=await response.text();if(!text)return {};try{return JSON.parse(text);}catch{throw new Error('Xbox returned an invalid stats response');}
  }
  async function identity(){const profile=await xau('/api/profile/me');const xuid=String(prop((prop(profile,'people')||[])[0],'xuid')||'');if(!/^\d+$/.test(xuid))throw new Error('Could not identify the Xbox account');const token=prop(await xau('/api/xauth?format=json'),'token');if(typeof token!=='string'||!token.trim())throw new Error('Xbox authorization is unavailable');return{xuid,token};}
  async function read(title,{xuid,token}){
    const games=await xau('/api/games/me');const game=(prop(games,'titles')||[]).find(item=>String(prop(item,'titleid'))===title);const scid=stringValue(prop(prop(game,'detail'),'scid')||prop(game,'serviceconfigid'));
    const hero={arrangebyfield:'xuid',xuids:[xuid],groups:[{name:'Hero',titleId:title}]};let data;
    try{data=await request('https://userstats.xboxlive.com/batch',token,2,{method:'POST',body:hero});}
    catch(e){if(!guid.test(scid)||e.status===401||e.status===403||e.status===429||!e.status)throw e;data=await request('https://userstats.xboxlive.com/batch',token,1,{method:'POST',body:{requestedusers:[xuid],requestedscids:[{scid,requestedstats:[]}]}});}
    return parseStats(data,guid.test(scid)?scid:'');
  }
  return {
    async read(title){const auth=await identity();return read(title,auth);},
    async write({title,name,scid,value}){
      if(!/^\d+$/.test(title)||typeof name!=='string'||!name||name.length>200||!guid.test(scid)||typeof value!=='string'||!value.trim()||value.length>100)throw new Error('Invalid stat value');
      const auth=await identity(),list=await read(title,auth);if(!list.some(item=>item.name===name&&item.scid.toLowerCase()===scid.toLowerCase()&&item.writable))throw new Error('This stat is not available for the selected game. Reload stats.');
      const again=await identity();if(auth.xuid!==again.xuid)throw new Error('The Xbox account changed. Reload stats.');
      const now=new Date(),body={$schema:'http://stats.xboxlive.com/2017-1/schema#',previousRevision:0,revision:Math.floor(now.getTime()/1000),timestamp:now.toISOString(),stats:{title:{[name]:{value:value.trim()}}}};
      await request(`https://statswrite.xboxlive.com/stats/users/${auth.xuid}/scids/${scid}`,again.token,4,{method:'PATCH',body});
      await sleep(2000);let confirmed=false;try{const data=await request(`https://userstats.xboxlive.com/users/xuid(${auth.xuid})/scids/${scid}/stats/${encodeURIComponent(name)}?include=valuemetadata`,again.token,3);const items=prop(data,'stats');confirmed=Array.isArray(items)&&items.some(item=>stringValue(prop(item,'name','statname'))===name&&stringValue(prop(item,'value')).trim()===value.trim());}catch{}
      return {confirmed};
    }
  };
}
