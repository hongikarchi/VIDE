// A project jig with one `host-surface` input (PLAN-49 T-251 tests): its step reports what it was
// given. Synthetic, no project data.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SURFACE_TEST_JIG = 'project/paneling-read-test';

export function surfaceTestJig(root) {
  const dir = join(root, 'jigs', 'paneling-read-test');
  mkdirSync(join(dir, 'steps'), { recursive: true });
  writeFileSync(
    join(dir, 'jig.json'),
    JSON.stringify(
      {
        contractVersion: 3,
        id: SURFACE_TEST_JIG,
        version: '0.1.0',
        kind: 'tool',
        name: '기준 면 읽기 시험',
        summary: '고른 기준 면의 표본을 받는지 보는 시험용 jig(합성 자료용).',
        icon: 'grid',
        inputs: [{ key: 'surface', title: '기준 면', kind: 'host-surface', host: 'rhino' }],
        params: [],
        steps: [
          {
            id: 'look',
            title: '표본 보기',
            kind: 'code',
            entry: 'steps/look.ts#look',
            reads: ['input.surface'],
            writes: 'look',
            speed: 'live',
          },
        ],
        capabilities: [{ name: 'sync.read', reason: '연결 Rhino 문서의 면을 읽습니다' }],
        panel: 'panel.json',
        selftest: { fixtures: 'fixtures', requiresHost: false },
        skill: 'skill.md',
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, 'steps', 'look.ts'),
    `export function look(inputs: { surface: { source: { objectId: string }; faces: { nu: number; nv: number }[] } | null }) {
  const s = inputs.surface;
  return { read: s !== null, objectId: s?.source.objectId ?? null, points: s ? s.faces.reduce((n, f) => n + f.nu * f.nv, 0) : 0 };
}
`,
  );
  writeFileSync(
    join(dir, 'panel.json'),
    JSON.stringify({ layout: 'jig-run', left: [{ part: 'step-rail' }], center: { views: [] } }),
  );
  mkdirSync(join(dir, 'fixtures', 'empty'), { recursive: true });
  writeFileSync(join(dir, 'fixtures', 'empty', 'input.json'), JSON.stringify({ surface: null }));
  writeFileSync(join(dir, 'fixtures', 'empty', 'params.json'), '{}');
  writeFileSync(
    join(dir, 'fixtures', 'empty', 'expect.json'),
    JSON.stringify({ steps: { look: { read: false, objectId: null, points: 0 } } }),
  );
  writeFileSync(
    join(dir, 'skill.md'),
    '---\nname: 기준 면 읽기 시험\nintent_en: read a picked surface\nwords: [시험]\nnot_for: [실제 패널링]\ntools: []\nlimits: [시험용]\n---\n\n# 시험\n\n합성 자료만 읽는다.\n',
  );
  return dir;
}
