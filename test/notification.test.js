import test from 'node:test';
import assert from 'node:assert/strict';
import { showNotification } from '../public/notification.js';

test('notifications close by button or after ten seconds and restart their timer', () => {
  const old={document:globalThis.document,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};
  const timers=new Map();let id=0;
  const create=()=>({children:[],hidden:true,replaceChildren(){this.children=[];},append(child){this.children.push(child);},setAttribute(){}});
  globalThis.document={createElement:create};globalThis.setTimeout=(fn,ms)=>{const key=++id;timers.set(key,{fn,ms});return key;};globalThis.clearTimeout=key=>timers.delete(key);
  try {
    const notification=create();showNotification(notification,'first');assert.equal(notification.hidden,false);assert.equal(timers.get(1).ms,10000);
    showNotification(notification,'second');assert.equal(timers.has(1),false);assert.equal(notification.children[0].textContent,'second');
    notification.children[1].onclick();assert.equal(notification.hidden,true);assert.equal(timers.size,0);
    showNotification(notification,'third');timers.get(3).fn();assert.equal(notification.hidden,true);
    showNotification(notification,'loading',{dismissible:false});assert.equal(notification.children.length,1);assert.equal(timers.size,0);
  } finally {Object.assign(globalThis,old);}
});
