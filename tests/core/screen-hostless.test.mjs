// T-190: a request sent from the records screens (노트·일지, 대시보드, 자료) goes without the host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostlessFromScreen } from '../../src/ui/screen-hostless.ts';

const draft = (extra = {}) => ({
  body: '노트 요약해줘',
  pins: [],
  sketches: [],
  files: [],
  ...extra,
});

test('records screens send hostless requests; the model screens keep the host', () => {
  for (const screen of ['notes', 'dashboard', 'data'])
    assert.equal(hostlessFromScreen(screen, draft()), true, screen);
  for (const screen of ['model', 'jig', 'make', 'output', 'jig:abc'])
    assert.equal(hostlessFromScreen(screen, draft()), false, screen);
  // Words about notes and 할 일 stay hostless; words naming the file or program do not.
  assert.equal(hostlessFromScreen('notes', draft({ body: '회의 메모로 할 일 추가해줘' })), true);
  assert.equal(hostlessFromScreen('notes', draft({ body: '라이노에서 기둥 개수 세줘' })), false);
  assert.equal(hostlessFromScreen('data', draft({ body: '원본 파일 레이어 정리' })), false);
});

test('pins, sketches, linked targets, a Sync basis or a host file keep the host', () => {
  assert.equal(hostlessFromScreen('notes', draft({ pins: [{ id: 'p' }] })), false);
  assert.equal(hostlessFromScreen('notes', draft({ sketches: [{ id: 's' }] })), false);
  assert.equal(
    hostlessFromScreen('notes', draft({ linkedTargets: [{ baseRequestId: 'r', host: 'rhino' }] })),
    false,
  );
  assert.equal(hostlessFromScreen('notes', draft({ baseRequestId: 'sync-1' })), false);
  assert.equal(hostlessFromScreen('notes', draft({ baseRequestId: null })), true);
  assert.equal(hostlessFromScreen('notes', draft({ files: [{ name: 'tower.3DM' }] })), false);
  assert.equal(
    hostlessFromScreen('notes', draft({ paths: [{ path: 'C:/p/plan.dwg', label: 'x' }] })),
    false,
  );
  assert.equal(hostlessFromScreen('notes', draft({ files: [{ name: '회의록.pdf' }] })), true);
});
