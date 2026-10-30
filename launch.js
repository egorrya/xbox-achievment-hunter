import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';

const child = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: process.env, stdio: ['inherit', 'pipe', 'inherit'] });
let opened = false;
createInterface({ input: child.stdout }).on('line', line => {
  console.log(line);
  const match = line.match(/^XAU Companion: (http:\/\/127\.0\.0\.1:\d+) /);
  if (!match || opened) return;
  opened = true;
  const url = match[1];
  const command = process.platform === 'win32' ? 'rundll32' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  execFile(command, args, error => { if (error) console.error(`Не удалось открыть браузер. Откройте ${url} вручную.`); });
});
child.on('error', error => { console.error('Не удалось запустить сервер:', error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { if (!signal && code) process.exitCode = code; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (!child.killed) child.kill(signal); });
