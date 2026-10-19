// 자료 정리 and folders it cannot reach (SPEC-08.9 1, PLAN-51 T-364): a folder whose listing fails
// (access denied, busy, a dropped share, a project folder not there) keeps its files and their
// statements as they were and is counted as unreached; only a file or folder that is gone from a
// parent that was listed is removed. Synthetic folders only; readdir failures are simulated.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp, { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inventory, rootsOf } from '../../src/knowledge/collect/inventory.ts';
import { openKnowledgeDb } from '../../src/knowledge/collect/schema.ts';

const original = fsp.readdir;
/** Makes readdir of `folder` throw an error with `code` (the module's import sees it too). */
function failListing(folder, code) {
  const target = resolve(folder);
  fsp.readdir = async (path, ...rest) => {
    if (resolve(String(path)) === target) throw Object.assign(new Error(code), { code });
    return original(path, ...rest);
  };
  syncBuiltinESMExports();
}
afterEach(() => {
  fsp.readdir = original;
  syncBuiltinESMExports();
});

/** A project folder with two subfolders, one statement per file, after a first inventory. */
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'vide-unreachable-'));
  const project = join(dir, 'project');
  await mkdir(join(project, 'a'), { recursive: true });
  await mkdir(join(project, 'b'), { recursive: true });
  await writeFile(join(project, 'a', '회의록.txt'), '구조 검토 결과 기둥 간격 8 m로 한다.');
  await writeFile(join(project, 'b', '협의내용.txt'), '외벽 마감은 석재로 정했다.');
  await writeFile(join(project, 'b', '사진.png'), 'binary');
  const db = openKnowledgeDb(join(dir, 'knowledge.sqlite'));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const roots = rootsOf([project]);
  await inventory(db, roots, () => false);
  for (const { id } of db.prepare("select id from source where kind <> 'binary'").all()) {
    const excerpt = db
      .prepare("insert into excerpt(source_id, text, text_sha) values(?, 'x', ?)")
      .run(id, `sha-${id}`).lastInsertRowid;
    db.prepare(
      "insert into statement(excerpt_id, content, quote_ok, support_prob, status) values(?, 'c', 1, 0.9, 'ai')",
    ).run(excerpt);
  }
  return { dir, project, db, roots };
}
const states = (db) =>
  Object.fromEntries(
    db
      .prepare(
        `select s.rel_path, s.skip, st.status, st.support_prob from source s
          left join excerpt e on e.source_id = s.id left join statement st on st.excerpt_id = e.id`,
      )
      .all()
      .map((r) => [r.rel_path, [r.skip, r.status, r.support_prob]]),
  );

for (const code of ['EACCES', 'EBUSY', 'EIO']) {
  test(`a subfolder whose listing fails with ${code} keeps its files and statements`, async (t) => {
    const { project, db, roots } = await fixture(t);
    const before = states(db);
    failListing(join(project, 'b'), code);
    const result = await inventory(db, roots, () => false);
    assert.equal(result.removed, 0);
    assert.deepEqual(result.unreachable, { folders: ['b'], documents: 1 });
    assert.deepEqual(states(db), before);
  });
}

test('a project folder that is not there is unreached, not emptied', async (t) => {
  const { dir, project, db } = await fixture(t);
  const other = join(dir, 'other');
  await mkdir(other);
  await writeFile(join(other, '견적.txt'), '공사비 견적은 다음 주에 받는다.');
  const roots = rootsOf([project, other]);
  await inventory(db, roots, () => false);
  const before = states(db);
  await rm(other, { recursive: true });
  const result = await inventory(db, roots, () => false);
  assert.equal(result.removed, 0);
  assert.deepEqual(result.unreachable, { folders: ['other'], documents: 1 });
  assert.deepEqual(states(db), before);
});

test('a file gone from a folder that was listed is removed, and comes back', async (t) => {
  const { project, db, roots } = await fixture(t);
  await rm(join(project, 'b', '협의내용.txt'));
  const result = await inventory(db, roots, () => false);
  assert.equal(result.removed, 1);
  assert.deepEqual(result.unreachable, { folders: [], documents: 0 });
  assert.deepEqual(states(db)['b/협의내용.txt'].slice(0, 2), ['removed', 'removed']);
  assert.deepEqual(states(db)['a/회의록.txt'], [null, 'ai', 0.9]);
  await writeFile(join(project, 'b', '협의내용.txt'), '외벽 마감은 석재로 정했다.');
  const back = await inventory(db, roots, () => false);
  assert.equal(back.returned, 1);
  assert.deepEqual(states(db)['b/협의내용.txt'], [null, 'ai', 0.9]);
});

test('a subfolder gone from a parent that was listed is removed', async (t) => {
  const { project, db, roots } = await fixture(t);
  await rm(join(project, 'b'), { recursive: true });
  const result = await inventory(db, roots, () => false);
  assert.equal(result.removed, 2);
  assert.deepEqual(result.unreachable.folders, []);
  assert.equal(states(db)['b/협의내용.txt'][1], 'removed');
});

test('a subfolder listed by its parent but gone before it is read is removed (ENOENT)', async (t) => {
  const { project, db, roots } = await fixture(t);
  failListing(join(project, 'b'), 'ENOENT');
  const result = await inventory(db, roots, () => false);
  assert.equal(result.removed, 2);
  assert.deepEqual(result.unreachable.folders, []);
});
