import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initial,chooseModel,pinSelection,attachSketch,packet,validate} from './model.mjs';
test('free text needs neither a pin nor a fixed height',()=>{const s=initial();s.body='이 모델을 검토해 줘';assert.equal(validate(s),'');assert.equal(packet(s).body,s.body);assert.equal('height' in packet(s),false);});
test('pin keeps its target independently of selection; duplicates ignored',()=>{const s=initial();pinSelection(s);pinSelection(s);s.selected='mass-b';assert.equal(s.pins.length,1);assert.equal(s.pins[0].id,'mass-a');});
test('model change retains draft and selects supported effort',()=>{const s=initial();s.body='초안';s.effort='xhigh';chooseModel(s,'gpt-5.6-terra');assert.equal(s.effort,'medium');assert.equal(s.body,'초안');});
test('sketch retains plane and original points, packet is immutable',()=>{const s=initial();attachSketch(s,[[0,0],[2,3]],'XZ','path');const p=packet(s);s.sketches[0].points[0][0]=9;assert.equal(p.sketches[0].points[0][0],0);assert.deepEqual(p.sketches[0].axisV,[0,0,1]);assert.throws(()=>attachSketch(s,[[0,0]],'XY','path'));});
test('empty request and unsupported permission are rejected',()=>{const s=initial();assert.throws(()=>packet(s));s.body='검토';s.permission='unrestricted';assert.throws(()=>packet(s));});
