import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

// Use Chromium's software compositor to avoid graphics-driver tile corruption.
if (process.platform === 'win32') {
  app.disableHardwareAcceleration();
  nativeTheme.themeSource = 'dark';
  app.commandLine.appendSwitch('force-color-profile', 'srgb');
  app.commandLine.appendSwitch('disable-partial-raster');
}

// Keep the existing data directory when changing the application name.
app.setPath('userData', join(app.getPath('appData'), 'XAU Companion'));

let backend, window, stopping = false, shutdownComplete = false, startupTimer;
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    stopping = true; clearTimeout(startupTimer);
    if (shutdownComplete || !backend || backend.exitCode !== null || backend.signalCode !== null) return;
    event.preventDefault();
    const finish = () => { if (shutdownComplete) return; shutdownComplete=true; clearTimeout(timer); app.quit(); };
    const timer=setTimeout(() => { if (!backend.killed) backend.kill(); finish(); }, 30000);
    backend.once('exit', finish);
    if (backend.connected) backend.send('shutdown', error => { if (error && !backend.killed) backend.kill(); });
    else if (!backend.killed) backend.kill();
  });
  app.whenReady().then(start).catch(() => { dialog.showErrorBox('Xbox Achievment Hunter', 'Could not start the application.'); app.quit(); });
}

function start() {
  const source = app.getAppPath();
  const data = app.getPath('userData');
  backend = spawn(process.execPath, [join(source, 'server.js')], {
    cwd: source, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: '0', STATE_FILE: join(data, 'state.json'), AUTH_FILE: join(data, 'auth', 'xauth.json'), XAU_DESKTOP: '1' }
  });
  let started = false;
  startupTimer = setTimeout(() => { if (!started && !stopping) { dialog.showErrorBox('Xbox Achievment Hunter', 'The local service did not start.'); app.quit(); } }, 30000);
  const lines = createInterface({ input: backend.stdout });
  lines.on('line', line => {
    const match = line.match(/^XAU Companion: (http:\/\/127\.0\.0\.1:\d+) /);
    if (!match || started) return;
    started = true; clearTimeout(startupTimer); openWindow(match[1]);
  });
  // Retain only a known error category; stderr may contain credentials or user data.
  let backendFailure = '', diagnostic = '';
  backend.stderr.on('data', chunk => {
    diagnostic = (diagnostic + String(chunk)).slice(-12000);
    const text = diagnostic;
    const known = text.match(/\b(ENOENT|EACCES|EPERM|ENOSPC|EADDRINUSE|ERR_MODULE_NOT_FOUND)\b/);
    if (known) backendFailure = known[1];
    else if (text.includes('SyntaxError')) { const match = text.match(/(?:server|stats|xbox-client|windows-auth)\.js:(\d+):(\d+)/); backendFailure = match ? `JavaScript syntax error at ${match[0]}` : 'JavaScript syntax error (location unavailable)'; }
  });
  backend.on('error', () => { if (!stopping) { dialog.showErrorBox('Xbox Achievment Hunter', 'Could not start the local service.'); app.quit(); } });
  backend.on('exit', (code, signal) => { if (!stopping) { const detail = (signal ? `Signal: ${signal}` : `Exit code: ${code ?? 'unknown'}`) + (backendFailure ? `\nReason: ${backendFailure}` : ''); dialog.showErrorBox('Xbox Achievment Hunter', `The local service stopped unexpectedly.\n${detail}`); app.quit(); } });
}

function openWindow(origin) {
  window = new BrowserWindow({
    width: 1360, height: 900, minWidth: 760, minHeight: 560, backgroundColor: '#202020',
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#202020', symbolColor: '#ffffff', height: 32 } } : {}),
    title: 'Xbox Achievment Hunter', icon: join(app.getAppPath(), 'build', 'icon.png'), autoHideMenuBar: true, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.on('before-input-event', (event, input) => {
    if(input.type!=='keyDown'||!input.control||!input.shift||input.key!=='F12'||input.isAutoRepeat)return;
    event.preventDefault();void saveRendererScreenshot(window);
  });
  window.on('closed', () => { window = null; });
  window.webContents.setWindowOpenHandler(({url}) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin === origin) return;
      event.preventDefault(); if (url.startsWith('https://')) void shell.openExternal(url);
    } catch { event.preventDefault(); }
  });
  window.loadURL(origin).catch(() => { if (!stopping) { dialog.showErrorBox('Xbox Achievment Hunter', 'Could not open the application window.'); app.quit(); } });
}

let capturingRenderer=false;
async function saveRendererScreenshot(target) {
  if(capturingRenderer||!target||target.isDestroyed())return;
  capturingRenderer=true;
  try {
    const image=await target.webContents.capturePage();
    if(image.isEmpty())throw new Error('Could not capture the application window.');
    const result=await dialog.showSaveDialog(target,{title:'Save application screenshot',defaultPath:join(app.getPath('desktop'),'xbox-achievement-render.png'),filters:[{name:'PNG image',extensions:['png']}]});
    if(result.canceled||!result.filePath)return;
    await writeFile(result.filePath,image.toPNG());
    let gpuStatus={},hardwareAcceleration=null;
    try {gpuStatus=app.getGPUFeatureStatus();hardwareAcceleration=app.isHardwareAccelerationEnabled();} catch {}
    await writeFile(result.filePath+'.json',JSON.stringify({appVersion:app.getVersion(),electron:process.versions.electron,chromium:process.versions.chrome,platform:process.platform,arch:process.arch,hardwareAcceleration,gpuStatus},null,2));
    await dialog.showMessageBox(target,{type:'info',message:'Application screenshot and rendering details saved.',detail:'Compare the PNG with a Windows screenshot taken at the same time. The JSON file contains graphics status and application versions.'});
  } catch {if(!target.isDestroyed())dialog.showErrorBox('Screenshot','Could not save the application screenshot.');}
  finally {capturingRenderer=false;}
}
