// 작업 폴더의 안내 파일과 기본 .gitignore (PLAN-52 T-308, T-314; ARCH-01 「작업 폴더(PLAN-52)」): VIDE
// rewrites only its marked section of README.md / AGENTS.md and keeps the person's text; the
// default ignore list follows the manifest's role paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  upsertVideBlock,
  videBlock,
  writeGuideFiles,
  VIDE_BLOCK_END,
  VIDE_BLOCK_START,
} from '../../src/core/workspace-files.ts';
import { defaultGitignore } from '../../src/server/workspace-git.ts';

const cfg = {
  schema: 'vide-workspace/1',
  title: '시험',
  paths: { ops: '01_운영', raw: '02 자료', review: '05_검토', archive: '10_아카이브' },
  server: {
    root: '\\\\fileserver\\share\\2601',
    paths: { cad: '05 도면' },
    targets: {},
    checkout: { rhino: 'local', cad: 'server' },
  },
  vide: { projectId: '00000000-0000-4000-8000-000000000001' },
};

test('the VIDE section: replaced between markers, appended when absent, text outside kept', () => {
  const block = videBlock('AGENTS.md', { name: '시험', cfg });
  assert.ok(block.startsWith(VIDE_BLOCK_START) && block.endsWith(VIDE_BLOCK_END));
  assert.match(block, /`02 자료` \| 원본 자료/);
  assert.match(block, /\\\\fileserver\\share\\2601/);
  assert.match(block, /CAD 도면=`05 도면`/);
  assert.doesNotMatch(block, /03_모델/);

  const human = '# 메모\r\n\r\n사람이 쓴 글.\r\n';
  const appended = upsertVideBlock(human, block);
  assert.ok(appended.startsWith('# 메모\r\n\r\n사람이 쓴 글.\r\n\r\n' + VIDE_BLOCK_START));
  const replaced = upsertVideBlock(
    appended + '\r\n끝 메모\r\n',
    `${VIDE_BLOCK_START}\n새 내용\n${VIDE_BLOCK_END}`,
  );
  assert.equal(
    replaced,
    `# 메모\r\n\r\n사람이 쓴 글.\r\n\r\n${VIDE_BLOCK_START}\n새 내용\n${VIDE_BLOCK_END}\r\n\r\n끝 메모\r\n`,
  );
  // An opening marker without its end is not a section: appended, nothing lost.
  const half = `앞 ${VIDE_BLOCK_START} 뒤`;
  assert.ok(upsertVideBlock(half, block).startsWith(half));
});

test('writeGuideFiles creates both files, rewrites only the section, skips unchanged ones', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vide-guide-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await writeGuideFiles(root, { name: '시험', cfg, agents: '팀 규칙 한 줄' }), [
    'README.md',
    'AGENTS.md',
  ]);
  assert.match(await readFile(join(root, 'AGENTS.md'), 'utf8'), /팀 규칙 한 줄\n<!-- vide:end -->/);
  assert.deepEqual(await writeGuideFiles(root, { name: '시험', cfg, agents: '팀 규칙 한 줄' }), []);
  const before = await readFile(join(root, 'README.md'), 'utf8');
  await writeFile(join(root, 'README.md'), '사람 머리말\n\n' + before + '\n사람 꼬리말\n');
  const next = { ...cfg, paths: { ...cfg.paths, output: '06_산출물' } };
  assert.deepEqual(await writeGuideFiles(root, { name: '시험', cfg: next }), [
    'README.md',
    'AGENTS.md',
  ]);
  const after = await readFile(join(root, 'README.md'), 'utf8');
  assert.ok(after.startsWith('사람 머리말\n\n# 시험\n\n<!-- vide:start -->'));
  assert.ok(after.endsWith('<!-- vide:end -->\n\n사람 꼬리말\n'));
  assert.match(after, /`06_산출물` \| 보고용 산출물/);
});

test('the default .gitignore follows the role paths', () => {
  const text = defaultGitignore({
    raw: '02 자료',
    output: '06_산출물\\보고',
    archive: '10_아카이브',
    review: '05_검토',
    rhino: '03_모델',
  });
  const lines = text.split('\n');
  // Secrets never reach the first commit (or a later remote).
  for (const line of ['.env', '.env.*', '*.pem', '*.key', '*.pfx', '.git-credentials'])
    assert.ok(lines.includes(line), line);
  for (const line of ['/02 자료/', '/06_산출물/보고/', '/10_아카이브/', '*.3dm', '*.dwg', '~$*'])
    assert.ok(lines.includes(line), line);
  // Imported KakaoTalk chats and mail never reach a remote (PLAN-53 T-331).
  assert.ok(defaultGitignore({ ops: '01_운영' }).split('\n').includes('/01_운영/기록/원문/'));
  for (const line of ['/05_검토/', '/03_모델/', '*.json', '*.md', '*.html'])
    assert.ok(!lines.includes(line), line);
  // A role at the root itself is never ignored whole.
  assert.ok(!defaultGitignore({ raw: '.' }).split('\n').includes('/./'));
  assert.ok(!defaultGitignore({ raw: '.' }).split('\n').includes('//'));
});
