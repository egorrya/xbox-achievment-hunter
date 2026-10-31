import test from 'node:test';
import assert from 'node:assert/strict';
import { setReferenceStep } from '../public/reference-flow.js';

function elements(){return Object.fromEntries(['input','review','dialogBack','dialogNext','inlineBack','inlineNext','hint'].map(key=>[key,{hidden:false,disabled:false,textContent:''}]));}
test('loaded reference moves from input to review and can go back in both layouts',()=>{
  for(const dialogOpen of [false,true]) {
    const el=elements();
    setReferenceStep(el,{review:false,dialogOpen,hasEntries:false,canUpdate:true});
    assert.equal(el.input.hidden,false);assert.equal(el.review.hidden,true);assert.equal(el.dialogNext.disabled,true);
    setReferenceStep(el,{review:true,dialogOpen,hasEntries:true,canUpdate:true});
    assert.equal(el.input.hidden,true);assert.equal(el.review.hidden,false);assert.equal(el.dialogBack.hidden,false);
    assert.equal(el.inlineBack.hidden,dialogOpen);assert.equal(el.hint.hidden,true);
    setReferenceStep(el,{review:false,dialogOpen,hasEntries:true,canUpdate:true});
    assert.equal(el.input.hidden,false);assert.equal(el.review.hidden,true);assert.equal(el.inlineNext.hidden,dialogOpen);
  }
});
test('the edit warning is visible only in an active unpaused dialog',()=>{
  const el=elements();setReferenceStep(el,{review:true,dialogOpen:true,hasEntries:true,canUpdate:false});assert.equal(el.hint.hidden,false);
  setReferenceStep(el,{review:true,dialogOpen:false,hasEntries:true,canUpdate:false});assert.equal(el.hint.hidden,true);
});
