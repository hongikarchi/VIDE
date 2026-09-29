import test from 'node:test';
import assert from 'node:assert/strict';
import { routeRequest } from '../../src/ui/request-route.ts';

const objects = [
  { id: 't1', type: 'MText', layer: 'A-ANNO', name: '실명' },
  { id: 't2', type: 'DBText', layer: 'A-ANNO' },
  { id: 'l1', type: 'Line', layer: 'S-BEAM' },
  { id: 'h1', type: 'Hatch', layer: 'A-HATCH' },
  { id: 'b1', type: 'Brep', layer: '구조::보', name: 'SG1-01' },
];
const models = [{ id: 'gpt-6-astra' }, { id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5' }];

test('screen-only requests are resolved against kinds, layers and names', () => {
  const keep = routeRequest('텍스트만 남기고 숨겨줘', objects, models);
  assert.equal(keep.target, 'view');
  assert.deepEqual(keep.view, { action: 'isolate', ids: ['t1', 't2'], subject: '문자' });
  const hide = routeRequest('해치 숨겨줘', objects, models);
  assert.deepEqual(hide.view, { action: 'hide', ids: ['h1'], subject: '해치' });
  const layer = routeRequest('구조::보 레이어만 보여줘', objects, models);
  assert.deepEqual(layer.view?.ids, ['b1']);
  const named = routeRequest('SG1-01 선택해줘', objects, models);
  assert.deepEqual(named.view, { action: 'select', ids: ['b1'], subject: '이름이 맞는 객체' });
  assert.equal(routeRequest('숨긴 거 다시 다 보여줘', objects, models).view?.action, 'unhide');
  assert.deepEqual(routeRequest('이거 숨겨', objects, models, ['l1']).view?.ids, ['l1']);
  // A screen request whose objects cannot be found stays on the screen and says so.
  const unknown = routeRequest('창호 숨겨줘', objects, models);
  assert.equal(unknown.target, 'view');
  assert.deepEqual(unknown.view?.ids, []);
});

test('words that name or change the file send the request to the file', () => {
  assert.equal(routeRequest('CAD에서 텍스트 숨겨줘', objects, models).target, 'document');
  assert.equal(routeRequest('해치 지워줘', objects, models).target, 'document');
  assert.equal(routeRequest('텍스트 레이어 색 바꿔줘', objects, models).target, 'document');
});

test('modeling goes to GPT-6-Astra and programming to Claude Opus 5.5 when available', () => {
  const beam = routeRequest('줄돔 철골보 중심선을 3D로 그려줘', objects, models);
  assert.equal(beam.target, 'document');
  assert.equal(beam.task, 'modeling');
  assert.equal(beam.model, 'gpt-6-astra');
  const code = routeRequest('구조 검토 jig 개발해줘. 파이썬 스크립트로', objects, models);
  assert.equal(code.task, 'programming');
  assert.equal(code.model, 'claude-opus-5-5');
  // No suitable model installed: the user's choice stays.
  assert.equal(routeRequest('보를 그려줘', objects, [{ id: 'claude-sonnet-5' }]).model, undefined);
  assert.equal(routeRequest('이 도면 요약해줘', objects, models).model, undefined);
});

test('short kind words do not match inside other words', () => {
  // "선택" is select, not "선" (lines); "도면" is not "면" (surfaces).
  assert.equal(routeRequest('SG1-01 선택해줘', objects, models).view?.subject, '이름이 맞는 객체');
  assert.equal(routeRequest('선만 남기고 숨겨', objects, models).view?.subject, '선');
  assert.equal(routeRequest('면 숨겨줘', objects, models).view?.subject, '면');
  assert.equal(routeRequest('평면에서 해치 숨겨줘', objects, models).view?.subject, '해치');
});
