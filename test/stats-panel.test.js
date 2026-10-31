import test from 'node:test';
import assert from 'node:assert/strict';
import { initStatsPanel } from '../public/stats-panel.js';

function element(tag='div') {
  return {tag,children:[],hidden:false,disabled:false,textContent:'',value:'',attrs:{},classList:{add(){},remove(){}},
    append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},setAttribute(key,value){this.attrs[key]=value;},focus(){}};
}
test('stats start in view mode, edit separately and fall back to game time',async()=>{
  const previous={document:globalThis.document,fetch:globalThis.fetch},elements=new Map();
  let title='1',fetches=0,playtimeCalls=0;
  globalThis.document={querySelector(selector){if(!elements.has(selector))elements.set(selector,element());return elements.get(selector);},createElement:element};
  globalThis.fetch=async()=>({ok:true,json:async()=>({stats:++fetches===1?[{name:'Kills',displayName:'Kills',value:'5',writable:true,scid:'s'}]:[]})});
  try {
    const reset=initStatsPanel(()=>title,async()=>{playtimeCalls++;return {minutesPlayed:1182};});reset();elements.get('#statsTab').onclick();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(elements.get('#statsEdit').disabled,false);
    assert.equal(elements.get('#statsList').children[0].children[1].textContent,'5');
    elements.get('#statsEdit').onclick();assert.equal(elements.get('#statsList').children[0].children[1].tag,'input');
    elements.get('#statsEdit').onclick();assert.equal(elements.get('#statsList').children[0].children[1].tag,'strong');
    title='2';reset();elements.get('#statsTab').onclick();await new Promise(resolve=>setImmediate(resolve));
    const row=elements.get('#statsList').children[0];assert.equal(row.children[0].children[0].textContent,'Time in game');assert.equal(row.children[1].textContent,'19h 42m');
    assert.equal(elements.get('#statsEdit').disabled,true);assert.equal(playtimeCalls,1);
  } finally {Object.assign(globalThis,previous);}
});
