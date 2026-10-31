import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connectionView,queueView,spoofView,xboxRecoveryAction} from '../auth-state.js';

test('saved queue is not exposed while signing in or before the account is known',()=>{
  const saved={status:'paused',accountXuid:'123',game:'Private game',entries:[{id:'1'}]};
  for(const context of [{},{status:'signed_in',autoStatus:'connecting',xuid:'123'},{status:'signed_in',autoStatus:'connected'}])assert.deepEqual(queueView(saved,context),{status:'idle'});
  assert.equal(queueView(saved,{status:'signed_in',autoStatus:'connected',xuid:'123'}),saved);
  assert.equal(queueView(saved,{status:'signed_in',autoStatus:'refreshing',xuid:'123'}),saved);
  assert.deepEqual(queueView(saved,{status:'signed_in',autoStatus:'connected',xuid:'456'}),{status:'idle',accountMismatch:true});
  assert.equal(queueView(saved,{external:true}),saved);
});

test('initial auto-connect does not report signed in until connection finishes',()=>{
  const auth={status:'signed_in',source:'xbox-pc'};
  assert.equal(connectionView(auth,{status:'connecting'}).status,'restoring');
  assert.equal(connectionView(auth,{status:'connected'}).status,'signed_in');
  assert.equal(connectionView(auth,{status:'refreshing'}).status,'signed_in');
  assert.equal(connectionView(auth,{status:'waiting',needsReconnect:true}).status,'signed_out');
});

test('expired Xbox credentials trigger reconnect without retrying permission failures',()=>{
  const xbox={enabled:true,source:'xbox-pc'};
  assert.equal(xboxRecoveryAction({status:401},xbox),'reauthorize');
  assert.equal(xboxRecoveryAction({message:'No usable Xbox PC authorization found for this account.'},xbox),'retry');
  assert.equal(xboxRecoveryAction({status:403},xbox),'none');
  assert.equal(xboxRecoveryAction({status:401},{...xbox,external:true}),'none');
});

test('saved spoof and queue stay private to their Xbox account',()=>{
  const spoof={status:'idle',titleId:'123',accountXuid:'111',endedAt:100};
  assert.deepEqual(spoofView(spoof),{status:'idle'});
  assert.deepEqual(spoofView(spoof,{status:'signed_in',xuid:'222'}),{status:'idle'});
  assert.deepEqual(spoofView({...spoof,accountXuid:undefined},{status:'signed_in',xuid:'111'}),{status:'idle'});
  assert.deepEqual(spoofView(spoof,{status:'signed_in',xuid:'111'}),{status:'idle',titleId:'123',endedAt:100});
  assert.deepEqual(spoofView(spoof,{external:true,xuid:'222'}),{status:'idle'});
  assert.deepEqual(queueView({status:'paused',accountXuid:'111',game:'Private'},{external:true,xuid:'222'}),{status:'idle',accountMismatch:true});
});
