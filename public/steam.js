export function steamProfileUrl(value) {
  let url;
  try { url=new URL(String(value).trim()); } catch { throw new Error('Enter a Steam Community profile link.'); }
  if(url.protocol!=='https:' || url.hostname!=='steamcommunity.com' || url.port || url.username || url.password || url.search || url.hash) throw new Error('Enter a Steam Community profile link.');
  const match=url.pathname.match(/^\/(id|profiles)\/([A-Za-z0-9_-]{2,32})\/?$/);
  if(!match || (match[1]==='profiles' && !/^\d{17}$/.test(match[2]))) throw new Error('Use a Steam profile link, such as https://steamcommunity.com/id/player/.');
  return `https://steamcommunity.com/${match[1]}/${match[2]}/`;
}
export function linkedSteamProfile(person) {
  const accounts=person?.linkedAccounts??person?.LinkedAccounts;
  if(!Array.isArray(accounts))return {status:'unavailable'};
  const steam=accounts.filter(item=>String(item?.networkName??item?.NetworkName??'').toLowerCase()==='steam');
  if(!steam.length)return {status:'unlinked'};
  const urls=new Set();
  for(const item of steam){
    const direct=item.deeplink??item.deepLink??item.DeepLink??item.url??item.Url;
    const steamId=item.steamId??item.SteamId??item.steamID;
    try {if(typeof direct==='string'&&direct)urls.add(steamProfileUrl(direct));else if(typeof steamId==='string'&&/^\d{17}$/.test(steamId))urls.add(steamProfileUrl(`https://steamcommunity.com/profiles/${steamId}/`));} catch {}
  }
  return urls.size===1?{status:'linked',url:[...urls][0]}:{status:'unavailable'};
}
export function parseSteamProfile(xml, parse=(text,type)=>new DOMParser().parseFromString(text,type)) {
  const doc=parse(xml,'application/xml');
  if(doc.querySelector('parsererror') || doc.documentElement?.tagName!=='profile' || doc.querySelector('privacyState')?.textContent.trim().toLowerCase()!=='public') throw new Error('Steam profile is unavailable or private.');
  const steamId=doc.querySelector('steamID64')?.textContent.trim();
  if(!/^\d{17}$/.test(steamId||''))throw new Error('Steam did not return a valid public profile.');
  return {steamId,name:doc.querySelector('steamID')?.textContent.trim()||steamId};
}
export function parseSteamAchievements(text, steamId, appId, parse=(value,type)=>new DOMParser().parseFromString(value,type)) {
  let entries=[];
  if(/^\s*(?:<\?xml|<playerstats\b)/i.test(text)) {
    const doc=parse(text,'application/xml');
    if(doc.querySelector('parsererror') || doc.documentElement?.tagName!=='playerstats' || doc.querySelector('error'))throw new Error('Steam game achievements are unavailable. Check that game details are public.');
    entries=[...doc.querySelectorAll('achievement[closed="1"]')].map(a=>({name:a.querySelector('name')?.textContent.trim(),seconds:Number(a.querySelector('unlockTimestamp')?.textContent)}));
  } else {
    const doc=parse(text,'text/html'), raw=doc.querySelector('#valve-ssr-data')?.textContent;
    let data;try {data=JSON.parse(raw);data=JSON.parse(data.renderContext.queryData);}catch{throw new Error('Steam game achievements are unavailable. Check that game details are public.');}
    const queries=data.queries?.map(q=>q.state?.data).filter(Boolean)||[];
    const progress=queries.find(x=>String(x.appid)===String(appId)&&String(x.steamid)===String(steamId)&&x.achievements&&!Array.isArray(x.achievements));
    const schema=queries.find(x=>String(x.appid)===String(appId)&&Array.isArray(x.groups)&&x.groups.some(g=>Array.isArray(g.achievements)));
    if(!progress||!schema)throw new Error('Steam game achievements are unavailable. Check that game details are public.');
    const names=new Map();for(const group of schema.groups)for(const a of group.achievements||[]){const key=String(a.internal_key);if(names.has(key))names.set(key,null);else names.set(key,a.name);}
    entries=Object.entries(progress.achievements).filter(([,a])=>a.unlocked===true).map(([key,a])=>({name:names.get(key),seconds:Number(a.unlock_time)}));
  }
  const invalid=entries.filter(a=>!a.name || !Number.isSafeInteger(a.seconds) || a.seconds<1104537600 || a.seconds>Math.floor(Date.now()/1000)+300);
  return {entries:entries.filter(a=>!invalid.includes(a)).map(a=>({name:a.name,time:new Date(a.seconds*1000).toISOString()})),invalid:invalid.length};
}
export function matchSteamAchievements(rows, achievements) {
  const key=value=>String(value||'').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase();
  const index=new Map(), used=new Set(), matches=[], unmatched=[];
  for(const achievement of achievements){const name=key(achievement.name);if(index.has(name))index.set(name,null);else index.set(name,achievement);}
  const counts=new Map();for(const row of rows)counts.set(key(row.name),(counts.get(key(row.name))||0)+1);
  for(const row of rows){const name=key(row.name), target=index.get(name);if(!name||!target||counts.get(name)!==1||used.has(String(target.id))){unmatched.push(row.name);continue;}used.add(String(target.id));matches.push({id:String(target.id),name:target.name,time:row.time});}
  return {matches,unmatched};
}
export function matchingSteamGame(games, gameName) {
  const key=value=>String(value||'').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase();
  const name=key(gameName);if(!name||!Array.isArray(games))return null;
  const exact=games.filter(game=>/^\d+$/.test(String(game?.id??''))&&key(game?.name)===name);
  return exact.length===1?exact[0]:null;
}
