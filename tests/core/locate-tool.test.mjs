import assert from 'node:assert/strict';
import test from 'node:test';
import { chunk, lineBlocks, MAX_OPTIONS } from '../../tools/locate/core.mjs';
import { summarize, candidateFiles } from '../../tools/locate/index.mjs';
import { loadLocalEnv } from '../../tools/locate/jev.mjs';

test('locator chunks never exceed the Choice option limit', () => {
  const items = Array.from({ length: 612 }, (_, i) => i);
  const groups = chunk(items);
  assert.equal(groups.flat().length, 612);
  assert.ok(groups.every((g) => g.length <= MAX_OPTIONS));
});

test('line blocks cover the whole file in order and stay within the option limit', () => {
  const text = Array.from({ length: 5000 }, (_, i) =>
    i % 40 === 0 ? `export function f${i}() {` : `  x${i};`,
  ).join('\n');
  const blocks = lineBlocks(text);
  assert.ok(blocks.length <= MAX_OPTIONS);
  assert.equal(blocks[0].from, 1);
  assert.equal(blocks.at(-1).to, 5000);
  for (let i = 1; i < blocks.length; i++) assert.equal(blocks[i].from, blocks[i - 1].to + 1);
});

test('summaries come from declared structure, not guesses', () => {
  const ts = summarize(
    'src/ui/viewport.ts',
    "// Three.js viewport\nexport function createViewport() {}\nexport const MAX = 1;\nif (url.pathname === '/api/v1/host/pins') {}",
  );
  assert.match(ts, /Three\.js viewport/);
  assert.match(ts, /createViewport/);
  assert.match(ts, /route \/api\/v1\/host\/pins/);
  const md = summarize(
    'docs/x.md',
    '---\ntitle: 요청 처리 방식\n---\n# X\n## 의도 카드\n## 검증\n',
  );
  assert.match(md, /요청 처리 방식/);
  assert.match(md, /의도 카드; 검증/);
  const cs = summarize(
    'hosts/rhino/worker/X.cs',
    'public sealed class ConnectionPanel : Panel {}\npublic override string EnglishName => "VIDEPanel";',
  );
  assert.match(cs, /ConnectionPanel/);
  assert.match(cs, /command VIDEPanel/);
});

test('index excludes fixtures, spikes, node_modules and generated files', () => {
  const kept = candidateFiles(
    [
      'src/ui/app.ts',
      'docs/PRD.md',
      'docs/PRD.html',
      'tests/fixtures/a.3dm',
      'tools/spikes/x/a.mjs',
      'src/sharing/node_modules/a.js',
      'src/x.d.ts',
      'package.json',
    ].map((path) => ({ path, blob: 'x' })),
  ).map((f) => f.path);
  assert.deepEqual(kept, ['src/ui/app.ts', 'docs/PRD.md', 'package.json']);
});

test('the key is read from the environment only when present and never defaults to a value', () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    assert.equal(loadLocalEnv('does-not-exist.env').key, '');
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});
