import { mkdir, readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const authFile=process.env.AUTH_FILE || join(process.cwd(),'.auth','xauth.json');
let session, manualPending = false, restoring = false, restoreError;
export function loginStatus(){return {status:restoring?'restoring':session?'signed_in':'signed_out',...(restoreError?{error:restoreError}:{})};}
export async function signOut(){
  try {await unlink(authFile)} catch(e) {if(e.code!=='ENOENT')throw new Error('Could not remove the saved token');}
  session=undefined;restoreError=undefined;
}
async function saveToken(value){
  const tmp=authFile+'.tmp';
  try {
    await mkdir(dirname(authFile),{recursive:true,mode:0o700});
    await writeFile(tmp,JSON.stringify({token:value}),{mode:0o600});
    await chmod(tmp,0o600);await rename(tmp,authFile);
  } catch(e) {try{await unlink(tmp)}catch{}throw new Error('Could not save the XAuth token');}
}
export async function restoreXauth({fetcher=fetch}={}){
  restoring=true;restoreError=undefined;
  try {
    const data=JSON.parse(await readFile(authFile,'utf8'));
    await useXauth(data.token,{fetcher,persist:false});
  } catch(e) {
    if(e.code!=='ENOENT')restoreError='Could not restore the saved XAuth token. Please sign in again.';
  } finally {restoring=false;}
}

async function token(){
  if(!session)throw new Error('Sign in with an XAuth token first');
  return session;
}
export function createXboxApi({getToken=token,fetcher=fetch}={}){
async function request(host,path,version,{method='GET',body,successStatus,userAgent}={}){
  const auth=await getToken();
  const res=await fetcher(`https://${host}${path}`,{method,headers:{Authorization:`XBL3.0 x=${auth.userHash};${auth.XSTSToken}`,'x-xbl-contract-version':String(version),Accept:'application/json','Accept-Language':'en-US',...(userAgent?{'User-Agent':userAgent}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000),redirect:'error'});
  const raw=await res.text();
  if(!res.ok || (successStatus && res.status!==successStatus)){
    const operation = host==='peoplehub.xboxlive.com' ? 'profile lookup' :
      host==='profile.xboxlive.com' ? 'gamertag/account lookup' :
      host==='titlehub.xboxlive.com' ? (method==='POST' ? 'game lookup' : 'games list') :
      host==='presence-heartbeat.xboxlive.com' ? 'game presence' :
      host==='achievements.xboxlive.com' ? (method==='POST' ? 'achievement unlock' : 'achievement list') : 'request';
    let code;try{const data=JSON.parse(raw);const value=data?.errorCode??data?.code??data?.XErr;if(typeof value==='number'||(typeof value==='string'&&/^[a-zA-Z0-9_.-]{1,80}$/.test(value)))code=String(value)}catch{}
    const hint=host==='presence-heartbeat.xboxlive.com' && res.status===403 ? '. Xbox rejected the presence request. Fumo OAuth Login tokens may not have presence permissions; try an XAuth token obtained from the Xbox app with OAuth Login disabled in Fumo.' : '';
    const error = new Error(`Xbox ${operation} failed (HTTP ${res.status}${code ? `, code ${code}` : ''})${hint}`);
    if(res.status===429){error.status=429;const value=res.headers.get('retry-after');const seconds=Number(value);const date=Date.parse(value);error.retryAfter=value && Number.isFinite(seconds) ? Math.max(0,seconds) : Number.isFinite(date) ? Math.max(0,Math.ceil((date-Date.now())/1000)) : 30;}
    throw error;
  }
  if(!raw)return {};
  try{return JSON.parse(raw)}catch{throw new Error('Xbox returned an invalid response')}
}
async function ownXuid(){
  const auth=await getToken();
  if(auth.userXUID && /^\d+$/.test(String(auth.userXUID)))return String(auth.userXUID);
  const data=await request('profile.xboxlive.com','/users/me/profile/settings?settings=Gamertag',2);
  const id=data.profileUsers?.[0]?.id;
  if(!/^\d+$/.test(String(id)))throw new Error('Could not determine the signed-in Xbox account');
  return String(id);
}
const validId=value=>{if(!/^\d+$/.test(String(value)))throw new Error('Invalid ID');return String(value)};
async function achievements(xuid,title){return request('achievements.xboxlive.com',`/users/xuid(${validId(xuid)})/achievements?titleId=${validId(title)}&maxItems=1000`,4)}
return async function xboxApi(path,options={}){
  const own=await ownXuid();
  if(path==='/api/profile/me')return request('peoplehub.xboxlive.com',`/users/me/people/xuids(${own})/decoration/detail,preferredColor,presenceDetail,multiplayerSummary`,5);
  if(path.startsWith('/api/profile/gt/')){
    const tag=path.slice('/api/profile/gt/'.length);
    const profile=await request('profile.xboxlive.com',`/users/gt(${tag})/profile/settings?settings=GameDisplayPicRaw,Gamerscore,Gamertag`,2);
    const xuid=validId(profile.profileUsers?.[0]?.id);
    return {People:[{Xuid:xuid}]};
  }
  if(path==='/api/xauth?format=json'){const auth=await getToken();return {token:`XBL3.0 x=${auth.userHash};${auth.XSTSToken}`};}
  if(path==='/api/games/me')return request('titlehub.xboxlive.com',`/users/xuid(${own})/titles/titleHistory/decoration/Achievement,detail,scid?maxItems=10000`,2);
  if(path.startsWith('/api/games/search/titleid/')){
    const title=validId(path.split('/').at(-1));
    return request('titlehub.xboxlive.com',`/users/xuid(${own})/titles/batch/decoration/GamePass,Achievement,Stats`,2,{method:'POST',body:{Pfns:null,TitleIds:[title]}});
  }
  if(path.startsWith('/api/spoof/')){
    const title=validId(path.split('/').at(-1));
    await request('presence-heartbeat.xboxlive.com',`/users/xuid(${own})/devices/current/`,3,{method:'POST',body:{titles:[{id:title,expiration:600,state:'active',sandbox:'RETAIL'}]}});
    return {message:'Spoofing started successfully.',titleId:title};
  }
  if(path==='/api/spoof-stop'){
    await request('presence-heartbeat.xboxlive.com',`/users/xuid(${own})/devices/current/`,3,{method:'DELETE'});
    return {message:'Spoofing stopped'};
  }
  if(path==='/api/achievements/unlock'){
    const input=JSON.parse(options.body);const title=validId(input.titleId), achievementId=validId(input.achievementId);
    const list=await achievements(own,title);const item=list.achievements?.find(a=>String(a.id)===achievementId);const scid=item?.serviceConfigId;
    if(typeof scid!=='string'||!/^[a-f\d-]{36}$/i.test(scid)||/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(scid))throw new Error('Could not determine the achievement service configuration');
    await request('achievements.xboxlive.com',`/users/xuid(${own})/achievements/${scid}/update`,2,{method:'POST',successStatus:200,userAgent:'XboxServicesAPI/2021.10.20211005.0 c',body:{action:'progressUpdate',serviceConfigId:scid,titleId:title,userId:own,achievements:[{id:achievementId,percentComplete:'100'}]}});
    return {message:'Achievement unlocked successfully',titleId:title,achievementId};
  }
  if(path.startsWith('/api/achievements/')){
    const title=validId(path.split('/').at(-1));
    const result=await achievements(own,title);
    if(!Array.isArray(result.achievements))throw new Error('Xbox did not return an achievement list');
    if(result.achievements.length)return result;
    const legacy=await request('achievements.xboxlive.com',`/users/xuid(${own})/titleachievements?titleId=${title}&maxItems=1000`,3);
    if(!Array.isArray(legacy.achievements))throw new Error('Xbox did not return an Xbox 360 achievement list');
    return legacy;
  }
  throw new Error('Unsupported Xbox API request');
}

}
export const xboxApi = createXboxApi();

export async function useXauth(value,{fetcher=fetch,persist=true}={}){
  if (manualPending) throw new Error('Token verification is already in progress');
  if (typeof value !== 'string' || value.length > 16384) throw new Error('Invalid XAuth token format');
  const match=value.trim().match(/^XBL3\.0 x=([^\s;]{1,128});([^\s;]{20,})$/);
  if (!match) throw new Error('Invalid XAuth token format');
  const candidate={userHash:match[1],XSTSToken:match[2],manual:true};
  manualPending=true;
  try {
    // Validate the token and resolve the account before replacing the current session.
    const api=createXboxApi({getToken:async()=>candidate,fetcher});
    const profile=await api('/api/profile/me');
    const xuid=profile?.People?.[0]?.Xuid ?? profile?.people?.[0]?.xuid;
    if(typeof xuid!=='string'||!/^\d+$/.test(xuid))throw new Error('Xbox did not return the signed-in profile');
    if(persist)await saveToken(value.trim());
    candidate.userXUID=xuid; session=candidate;restoreError=undefined;
  } finally {manualPending=false;}
}
