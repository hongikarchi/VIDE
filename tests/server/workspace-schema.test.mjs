// 연결 폴더의 구조 읽기와 역할 추정 (SPEC-01.13 8, PLAN-52 T-309): the top two levels of a
// share-shaped folder, the evidence strings, competing guesses, an empty folder, a folder that
// cannot be read, and what a person's choice stores. Synthetic folders only (mkdtemp); the
// `\\fileserver\…` root is mapped onto a temporary folder by the test's directory reader.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evidenceOf,
  inferRole,
  memoryFromChoice,
  memorySummary,
  namedBy,
  nameRoles,
  scanConnectedFolder,
} from '../../src/server/workspace-schema.ts';

const SHARE = '\\\\fileserver\\projects\\2601-나진상가';

async function tree(t, files) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-schema-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of files) {
    const path = join(directory, ...file.split('/'));
    if (file.endsWith('/')) await mkdir(path, { recursive: true });
    else {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'x');
    }
  }
  return directory;
}
/** The share-shaped root read from the temporary folder. */
const mapped = (directory, fail = {}) => ({
  readDir: async (path) => {
    for (const [suffix, code] of Object.entries(fail))
      if (path.endsWith(suffix)) throw Object.assign(new Error(code), { code });
    return readdir(path.replace(SHARE, directory), { withFileTypes: true });
  },
});

test('scan: roles from names and files, evidence strings, sub folder rows, competing guesses, missing', async (t) => {
  const directory = await tree(t, [
    '01 운영/회의록 1002.docx',
    '01 운영/레퍼런스/a.jpg',
    '02 자료/법규1.pdf',
    '02 자료/법규2.pdf',
    '02 자료/대장.hwp',
    '03 참고/a.jpg',
    '03 참고/b.png',
    '03 참고/c.jpeg',
    '04 라이노/매스.3dm',
    '04 라이노/대안.3dm',
    '05 도면/A-101.dwg',
    '05 도면/A-102.dwg',
    '05 도면/A-103.dwg',
    '05 도면/A-104.dwg',
    '05 도면/A-105.dwg',
    '05 도면/xref/X-base.dwg',
    '05 도면/xref/X-grid.dwg',
    '05 도면/xref/X-core.dwg',
    '05 도면/~$lock.dwg',
    '06 도면 모델/',
    '07 구버전/old1.dwg',
    '07 구버전/old2.dwg',
    '07 구버전/old3.dwg',
    '08 기타/a/',
    '08 기타/b/',
    '.git/config',
    'Thumbs.db',
  ]);
  const proposal = await scanConnectedFolder(SHARE, {
    ...mapped(directory),
    now: () => new Date('2026-10-15T09:00:00Z'),
  });
  assert.equal(proposal.status, 'ok');
  assert.equal(proposal.root, SHARE);
  assert.equal(proposal.readAt, '2026-10-15T09:00:00.000Z');
  const rows = Object.fromEntries(proposal.folders.map((row) => [row.path, row]));
  assert.deepEqual(Object.keys(rows), [
    '01 운영',
    join('01 운영', '레퍼런스'),
    '02 자료',
    '03 참고',
    '04 라이노',
    '05 도면',
    '06 도면 모델',
    '07 구버전',
    '08 기타',
  ]);
  // 도면: its own DWG and the xref sub folder's, the lock file left out.
  assert.deepEqual(
    [rows['05 도면'].guess, rows['05 도면'].confidence, rows['05 도면'].reason],
    ['cad', 'high', 'DWG 8개 · xref 3'],
  );
  assert.equal(rows['05 도면'].hasXref, true);
  assert.deepEqual([rows['04 라이노'].guess, rows['04 라이노'].reason], ['rhino', '3dm 2개']);
  assert.deepEqual(
    [rows['03 참고'].guess, rows['03 참고'].reason],
    ['references', 'JPEG 1개 · JPG 1개'],
  );
  assert.equal(rows['02 자료'].guess, 'raw');
  assert.equal(rows['01 운영'].guess, 'ops');
  // A sub folder whose name says another role is a row of its own.
  assert.equal(rows[join('01 운영', '레퍼런스')].guess, 'references');
  assert.equal(rows[join('01 운영', '레퍼런스')].depth, 2);
  // An old-version folder full of drawings is an archive, not a competing guess.
  assert.deepEqual([rows['07 구버전'].guess, rows['07 구버전'].candidates], ['archive', []]);
  // Two roles in one name: no guess, both shown for the person to pick.
  assert.deepEqual(
    [rows['06 도면 모델'].guess, rows['06 도면 모델'].candidates, rows['06 도면 모델'].reason],
    [null, ['rhino', 'cad'], '비어 있음'],
  );
  assert.deepEqual(proposal.conflicts, ['06 도면 모델']);
  assert.deepEqual([rows['08 기타'].guess, rows['08 기타'].reason], [null, '하위 폴더 2개']);
  // No folder for reports: named, so the card says it will ask when something goes back.
  assert.deepEqual(proposal.missing, ['output']);
  assert.equal(proposal.shallow, false);
  // Too many top folders: one level only.
  const shallow = await scanConnectedFolder(SHARE, { ...mapped(directory), maxTopFolders: 3 });
  assert.equal(shallow.shallow, true);
  assert.equal(shallow.folders.find((row) => row.path === '05 도면').reason, 'DWG 5개');
});

test('scan: empty, no access, a sub folder that cannot be read, not reachable', async (t) => {
  const empty = await tree(t, ['.git/config', 'desktop.ini']);
  assert.equal((await scanConnectedFolder(SHARE, mapped(empty))).status, 'empty');
  const some = await tree(t, ['05 도면/a.dwg', '09 비공개/x.pdf']);
  assert.equal(
    (await scanConnectedFolder(SHARE, mapped(some, { [SHARE]: 'EACCES' }))).status,
    'no-access',
  );
  const partial = await scanConnectedFolder(SHARE, mapped(some, { '09 비공개': 'EPERM' }));
  assert.equal(partial.status, 'ok');
  const locked = partial.folders.find((row) => row.path === '09 비공개');
  assert.deepEqual([locked.unreadable, locked.reason], [true, '읽을 권한 없음']);
  assert.equal(
    (await scanConnectedFolder(join(some, '없는 폴더'))).status,
    'unreachable',
    'a folder that is gone',
  );
  assert.equal(
    (await scanConnectedFolder(SHARE, mapped(some, { [SHARE]: 'UNKNOWN' }))).status,
    'unreachable',
  );
});

test('inference pieces: names, files, evidence', () => {
  assert.deepEqual(nameRoles('05_도면'), ['cad']);
  assert.deepEqual(nameRoles('검토본'), ['snapshots']);
  assert.deepEqual(nameRoles('prefab'), []);
  assert.deepEqual(nameRoles('Ref images'), ['references']);
  // A folder named for drawings holding only models: the person picks.
  assert.deepEqual(inferRole('04 도면', { files: 4, byExtension: { '3dm': 4 }, xrefs: 0 }), {
    guess: null,
    candidates: ['cad', 'rhino'],
    confidence: null,
  });
  assert.deepEqual(inferRole('무제', { files: 5, byExtension: { dwg: 5 }, xrefs: 2 }), {
    guess: 'cad',
    candidates: [],
    confidence: 'medium',
  });
  assert.equal(evidenceOf({ files: 0, byExtension: {}, xrefs: 0 }, 0), '비어 있음');
});

test("a person's choice: guesses, picks, competing rows left out, one folder per role, later", () => {
  const record = {
    folders: [
      { path: '05 도면', depth: 1, guess: 'cad', candidates: [], reason: '' },
      { path: '06 도면 모델', depth: 1, guess: null, candidates: ['rhino', 'cad'], reason: '' },
      { path: '02 자료', depth: 1, guess: 'raw', candidates: [], reason: '' },
      { path: '02 법규', depth: 1, guess: 'raw', candidates: [], reason: '' },
      { path: '08 기타', depth: 1, guess: null, candidates: [], reason: '' },
    ],
  };
  assert.equal(memoryFromChoice(record, { option: 'later' }), null);
  assert.deepEqual(memoryFromChoice(record, { option: 'remember' }), {
    paths: { cad: '05 도면', raw: '02 자료' },
    skipped: ['06 도면 모델'],
    extra: ['02 법규'],
  });
  assert.deepEqual(
    memoryFromChoice(record, {
      option: 'edit',
      roles: { '06 도면 모델': 'rhino', '02 자료': null, '08 기타': 'references' },
    }),
    {
      paths: { cad: '05 도면', rhino: '06 도면 모델', raw: '02 법규', references: '08 기타' },
      skipped: [],
      extra: [],
    },
  );
  assert.throws(
    () => memoryFromChoice(record, { option: 'edit', roles: { '없는 폴더': 'cad' } }),
    /INVALID_INPUT/,
  );
  assert.equal(
    memorySummary({ paths: { cad: '05 도면' }, targets: { output: '05 보고서\\VIDE' } }),
    '폴더 역할 기억 · 도면=05 도면 · 보고서→05 보고서\\VIDE',
  );
  assert.equal(namedBy(['앞으로 보고서는 05 보고서\\VIDE에'], '05 보고서/VIDE'), true);
  assert.equal(namedBy(['보고서는 알아서'], '05 보고서\\VIDE'), false);
});

test('a remembered place must be one the person said whole; clearing needs their words', async () => {
  const { namedBy, saidNoPlace } = await import('../../src/server/workspace-schema.ts');
  const words = [String.raw`보고서는 05 보고서\VIDE에 둬`];
  assert.equal(namedBy(words, String.raw`05 보고서\VIDE`), true);
  assert.equal(namedBy(words, '05 보고서/VIDE/'), true);
  assert.equal(namedBy(words, '05'), false);
  assert.equal(namedBy(words, 'VIDE'), false);
  assert.equal(namedBy(words, '05 보고서'), false);
  assert.equal(saidNoPlace(['보고서는 둘 곳 없음으로 해 줘']), true);
  assert.equal(saidNoPlace(words), false);
});
