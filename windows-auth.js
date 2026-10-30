import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./windows/read-xbox-auth.ps1', import.meta.url));

// Candidate credentials travel only through the child process pipe and stay in memory.
export async function readXboxPcCandidates({platform=process.platform, run=execute}={}) {
  if (platform !== 'win32') throw new Error('Xbox PC connection is available only on Windows.');
  let stdout;
  try {
    ({stdout}=await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,timeout:120000,maxBuffer:256000,encoding:'utf8'}));
  } catch (error) {
    // Never surface PowerShell output: it may contain credentials.
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

// Start the installed Xbox application only if its process is absent.
export async function ensureXboxPc({platform=process.platform,run=execute}={}) {
  if (platform !== 'win32') throw new Error('Xbox PC is available only on Windows.');
  try {
    await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',
      "if (-not (Get-Process -Name XboxPcApp -ErrorAction SilentlyContinue)) { Start-Process explorer.exe -ArgumentList 'shell:appsFolder\\Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App' }"],
      {windowsHide:true,timeout:15000,encoding:'utf8'});
  } catch { throw new Error('Could not open the Xbox app. Open it manually and sign in.'); }
}
