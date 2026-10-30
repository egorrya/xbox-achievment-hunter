import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, appendFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

test('dev mode debounces frontend changes and restarts backend changes', {timeout:25000,skip:process.platform==='win32'}, async () => {
  const dir=await mkdtemp(join(tmpdir(),'xau-dev-test-'));
  for(const name of ['dev.js','server.js','xbox-client.js','package.json','public']) await cp(name,join(dir,name),{recursive:true});
  const opener=join(dir,process.platform==='darwin'?'open':'xdg-open');await writeFile(opener,'#!/bin/sh\nexit 0\n');await chmod(opener,0o755);
  const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const child=spawn(process.execPath,['dev.js'],{cwd:dir,env:{...process.env,PORT:String(port),STATE_FILE:join(dir,'state.json'),PATH:dir+':'+process.env.PATH},stdio:'ignore'});
  const base=`http://127.0.0.1:${port}`;
  async function version(){try{const r=await fetch(base+'/api/dev/version');return r.ok?(await r.json()).version:null}catch{return null}}
  async function changed(before){for(let i=0;i<90;i++){const v=await version();if(v&&v!==before)return v;await sleep(100)}throw new Error('dev version did not change')}
  try {
    let first;for(let i=0;i<50;i++){first=await version();if(first)break;await sleep(50)}assert.ok(first);
    const page=await (await fetch(base+'/games')).text();assert.match(page,/dev-reload\.js/);
    await appendFile(join(dir,'public','style.css'),'\n/* dev change */\n');await sleep(1500);assert.equal(await version(),first);
    const front=await changed(first);assert.ok(front);
    await appendFile(join(dir,'xbox-client.js'),'\n');await sleep(1500);assert.equal(await version(),front);
    assert.ok(await changed(front));
  }finally{child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));await rm(dir,{recursive:true,force:true});}
});
