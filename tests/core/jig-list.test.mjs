import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listedTools, openDrafts } from '../../src/ui/jig-list.ts';

// PLAN-26 T-099: the JIG list shows one card per jig id, at the version pinned to this project.
const tool = (id, version, stage) => ({ id, version, kind: 'tool', stage });

test('a pinned jig shows once, at its pinned version, even with older versions installed', () => {
  const packages = [
    tool('project/s06-frame', '0.3.1', 'project'),
    tool('project/s06-frame', '0.3.2', 'project'),
    tool('project/s06-frame', '0.3.1', 'dev'),
    tool('project/other', '1.0.0', 'project'),
    { id: 'vide/geometry-kit', version: '0.2.0', kind: 'library', stage: 'official' },
  ];
  const shown = listedTools(packages, [{ jigId: 'project/s06-frame', version: '0.3.2' }]);
  assert.deepEqual(
    shown.map((entry) => `${entry.id}@${entry.version}:${entry.stage}`),
    ['project/s06-frame@0.3.2:project'],
    'the other installed jig is not pinned here; the library is no card',
  );
});

test('an unpinned checkout source shows as it is; a pinned dev version shows as the pin', () => {
  const packages = [
    tool('project/grid', '0.1.0', 'dev'),
    tool('project/s06-frame', '0.3.1', 'dev'),
  ];
  assert.deepEqual(
    listedTools(packages, []).map((entry) => entry.id),
    ['project/grid', 'project/s06-frame'],
  );
  assert.deepEqual(
    listedTools(packages, [{ jigId: 'project/grid', version: '0.1.0' }]).map(
      (entry) => `${entry.id}:${entry.stage}`,
    ),
    ['project/grid:dev', 'project/s06-frame:dev'],
  );
});

test('a pin whose version is gone falls back to the newest installed version of that id', () => {
  const packages = [
    tool('project/s06-frame', '0.3.1', 'project'),
    tool('project/s06-frame', '0.3.2', 'project'),
  ];
  assert.deepEqual(
    listedTools(packages, [{ jigId: 'project/s06-frame', version: '9.9.9' }]).map(
      (entry) => entry.version,
    ),
    ['0.3.2'],
  );
});

test('only open drafts are cards', () => {
  const drafts = [
    { id: 'a', state: 'open' },
    { id: 'b', state: 'pinned' },
    { id: 'c' },
    { id: 'd', state: 'discarded' },
  ];
  assert.deepEqual(
    openDrafts(drafts).map((draft) => draft.id),
    ['a', 'c'],
  );
});
