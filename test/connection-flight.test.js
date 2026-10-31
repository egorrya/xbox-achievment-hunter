import {test} from 'node:test';
import assert from 'node:assert/strict';
import {singleFlight} from '../connection-flight.js';

test('concurrent Xbox connection requests share one attempt and later retries start afresh',async()=>{
  let calls=0,finish;
  const connect=singleFlight(()=>{calls++;return new Promise((resolve,reject)=>{finish={resolve,reject};});});
  const first=connect(),second=connect();assert.equal(first,second);await Promise.resolve();assert.equal(calls,1);
  finish.reject(new Error('Xbox is still starting'));await assert.rejects(first,/still starting/);await assert.rejects(second,/still starting/);
  const retry=connect(),joined=connect();assert.equal(retry,joined);await Promise.resolve();assert.equal(calls,2);finish.resolve({status:'signed_in'});assert.deepEqual(await retry,{status:'signed_in'});
  const next=connect();await Promise.resolve();assert.equal(calls,3);finish.resolve({status:'signed_in'});await next;
});
