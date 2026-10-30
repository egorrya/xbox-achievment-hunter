import { app, BrowserWindow, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

// Keep the existing data directory when changing the application name.
app.setPath('userData', join(app.getPath('appData'), 'XAU Companion'));

let backend, window, stopping = false, startupTimer;
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { stopping = true; clearTimeout(startupTimer); if (backend && !backend.killed) backend.kill(); });
  app.whenReady().then(start).catch(() => { dialog.showErrorBox('Xbox Achievment Hunter', 'Could not start the application.'); app.quit(); });
}

function start() {
  const source = app.getAppPath();
  const data = app.getPath('userData');
  backend = spawn(process.execPath, [join(source, 'server.js')], {
    cwd: source, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
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
  // Consume stderr without displaying potentially sensitive request details.
  backend.stderr.resume();
  backend.on('error', () => { if (!stopping) { dialog.showErrorBox('Xbox Achievment Hunter', 'Could not start the local service.'); app.quit(); } });
  backend.on('exit', () => { if (!stopping) { dialog.showErrorBox('Xbox Achievment Hunter', 'The local service stopped unexpectedly.'); app.quit(); } });
}

function openWindow(origin) {
  window = new BrowserWindow({
    width: 1360, height: 900, minWidth: 760, minHeight: 560, backgroundColor: '#0d1512',
    title: 'Xbox Achievment Hunter', icon: join(app.getAppPath(), 'build', 'icon.png'), autoHideMenuBar: true, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  window.once('ready-to-show', () => window.show());
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
