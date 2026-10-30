import { watch } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';

let child, timer, stopping = false, opened = false, restartRequested = false;
const backendFiles = new Set(['server.js', 'xbox-client.js', 'package.json']);
function startServer() {
  if (stopping) return;
  child = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, DEV_MODE:'1' }, stdio:['inherit','pipe','inherit'] });
  createInterface({input:child.stdout}).on('line', line => {
    console.log(line);
    const match=line.match(/^XAU Companion: (http:\/\/127\.0\.0\.1:\d+) /);
    if (!match || opened) return;
    opened=true;
    const command=process.platform==='win32'?'rundll32':process.platform==='darwin'?'open':'xdg-open';
    const args=process.platform==='win32'?['url.dll,FileProtocolHandler',match[1]]:[match[1]];
    execFile(command,args,error=>{if(error)console.error(`Could not open the browser. Open ${match[1]} manually.`)});
  });
  child.on('error', error=>console.error('Could not start the server:',error.message));
  child.on('exit',(code,signal)=>{
    child=undefined;
    if(stopping)return;
    if(restartRequested){restartRequested=false;startServer();}
    else if(code === 0) stop();
    else if(code) console.error(`Server stopped (exit ${code}). Edit a backend file to retry.`);
    else if(signal) console.error(`Server stopped (${signal}). Edit a backend file to retry.`);
  });
}
const watcher=watch('.', (_event, filename)=>{
  if(!filename || !backendFiles.has(String(filename)))return;
  clearTimeout(timer);
  timer=setTimeout(()=>{
    console.log('Backend changed. Restarting server…');
    if(child){restartRequested=true;child.kill('SIGTERM');}
    else startServer();
  },5000);
});
function stop(){if(stopping)return;stopping=true;clearTimeout(timer);watcher.close();if(child)child.kill('SIGTERM');}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
startServer();
