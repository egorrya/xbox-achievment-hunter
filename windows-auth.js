import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./windows/read-xbox-auth.ps1', import.meta.url));

// Candidate credentials travel only through the child process pipe and stay in memory.
export async function readXboxPcCandidates({platform=process.platform, run=execute, signal}={}) {
  if (platform !== 'win32') throw new Error('Xbox PC connection is available only on Windows.');
  let stdout;
  try {
    ({stdout}=await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,timeout:30000,maxBuffer:256000,encoding:'utf8',signal}));
  } catch (error) {
    // Never surface PowerShell output: it may contain credentials.
    if (signal?.aborted) throw signal.reason;
    if (error.killed || error.signal === 'SIGTERM') throw new Error('Xbox PC authorization scan timed out. Close and reopen the Xbox app, then try again.');
    if (error.code === 'ENOENT') throw new Error('Windows PowerShell was not found. Enable Windows PowerShell and try again.');
    if (typeof error.stderr === 'string' && error.stderr.includes('XAU_AUTH_INIT_FAILED')) throw new Error('Could not initialize the Xbox PC authorization reader. Check that Windows PowerShell is enabled.');
    if (typeof error.stderr === 'string' && error.stderr.includes('XAU_AUTH_SCAN_FAILED')) throw new Error('Xbox PC authorization scan failed. Restart the Xbox app and try again.');
    throw new Error('Could not start the Xbox PC authorization reader. Check Windows PowerShell and try again.');
  }
  let data;try{data=JSON.parse(stdout)}catch{throw new Error('Could not read Xbox PC authorization.');}
  if(!Array.isArray(data)||data.length>8||data.some(value=>typeof value!=='string'||value.length>16384))throw new Error('Could not read Xbox PC authorization.');
  if(!data.length)throw new Error('No Xbox PC authorization found. Open the Xbox app, sign in and try again.');
  return data;
}

// Detect the app separately so a running process is never started a second time.
async function launchXbox() {
  await new Promise((resolve,reject)=>{
    const child=spawn('explorer.exe', ['shell:appsFolder\\Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App'], {detached:true,windowsHide:true,stdio:'ignore'});
    child.once('error',reject);
    child.once('spawn',()=>{child.unref();resolve();});
  });
}
export async function ensureXboxPc({platform=process.platform,run=execute,launch=launchXbox}={}) {
  if (platform !== 'win32') throw new Error('Xbox PC is available only on Windows.');
  let stdout;
  try {
    ({stdout}=await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',
      "if (Get-Process -Name XboxPcApp -ErrorAction SilentlyContinue) { 'running' } else { 'stopped' }"],
      {windowsHide:true,timeout:10000,encoding:'utf8'}));
  } catch { throw new Error('Could not check whether the Xbox app is running.'); }
  const status=String(stdout).trim().toLowerCase();
  if (status==='running') return {launched:false};
  if (status!=='stopped') throw new Error('Could not check whether the Xbox app is running.');
  try { await launch(); } catch { throw new Error('Could not open the Xbox app. Open it manually and sign in.'); }
  return {launched:true};
}

// Bound the entire scan and token validation, not just the pause between attempts.
export async function waitForXboxPcAuthorization(attach, {timeout=90000, interval=5000, now=Date.now, sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  const deadline=now()+timeout, controller=new AbortController();
  const timeoutError=new Error('Connecting to Xbox timed out. Check that the Xbox app is open and signed in, then try again.');
  let rejectTimeout; const timedOut=new Promise((_,reject)=>{rejectTimeout=reject;});
  const timer=setTimeout(()=>{controller.abort(timeoutError);rejectTimeout(timeoutError);},timeout);
  try {
    while (true) {
      try { return await Promise.race([attach({signal:controller.signal}),timedOut]); }
      catch (error) {
        if (controller.signal.aborted) throw timeoutError;
        if (!/No (?:usable )?Xbox PC authorization found/.test(error.message)) throw error;
        if (now()>=deadline) throw timeoutError;
        await Promise.race([sleep(Math.min(interval, Math.max(0,deadline-now()))),timedOut]);
      }
    }
  } finally { clearTimeout(timer); }
}
