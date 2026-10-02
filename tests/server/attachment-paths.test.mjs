import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentStore } from '../../src/server/attachments.ts';
import { attachFromPath, imagesAtPath } from '../../src/server/attachment-paths.ts';
import { pathCandidates, referenceIntent } from '../../src/ui/reference-check.ts';

// The check before sending (SPEC-09.11, PLAN-26 T-090 (e)): reference words, paths in the words,
// the images at a path and the copy into the project's attachments.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('reference words are read by rules', () => {
  for (const text of ['이런 느낌으로', '이 루버처럼', '레퍼런스 참고해서', '분위기만 비슷하게'])
    assert.equal(referenceIntent(text), true, text);
  for (const text of ['보 간격 검토해줘', '기둥 번호 맞춰줘'])
    assert.equal(referenceIntent(text), false);
});

test('a path in a sentence gives shortest-first candidates without particles', () => {
  const candidates = pathCandidates('C:\\자료\\05_레퍼런스\\기둥에 있는 사진 느낌으로');
  assert.equal(candidates[0], 'C:\\자료\\05_레퍼런스\\기둥에');
  assert.ok(candidates.includes('C:\\자료\\05_레퍼런스\\기둥'));
  assert.ok(candidates.length <= 8);
  assert.deepEqual(pathCandidates('"D:\\My Pictures\\ref.png" 이거처럼'), [
    'D:\\My Pictures\\ref.png',
  ]);
  assert.deepEqual(pathCandidates('경로 없음'), []);
});

test('images at a folder path are listed by name, others and denied places are left out', async () => {
  const data = await mkdtemp(join(tmpdir(), 'vide-paths-data-'));
  const pictures = await mkdtemp(join(tmpdir(), 'vide-paths-'));
  try {
    const folder = join(pictures, '기둥');
    await mkdir(folder);
    await writeFile(join(folder, '기둥 10.png'), PNG);
    await writeFile(join(folder, '기둥 2.png'), PNG);
    await writeFile(join(folder, 'notes.txt'), '메모');
    await mkdir(join(folder, 'sub'));
    const context = { dataDirectory: data };
    const found = await imagesAtPath([join(pictures, '없음'), folder + ' 이', folder], context);
    assert.equal(found.path, folder);
    assert.equal(found.kind, 'folder');
    assert.deepEqual(
      found.images.map((image) => image.name),
      ['기둥 2.png', '기둥 10.png'],
    );
    // A single image file, and nothing for a folder without images or the data folder.
    const one = await imagesAtPath([join(folder, '기둥 2.png')], context);
    assert.equal(one.kind, 'file');
    assert.equal((await imagesAtPath([join(folder, 'sub')], context)).path, null);
    await writeFile(join(data, 'inside.png'), PNG);
    assert.equal((await imagesAtPath([data], context)).path, null);
    // The copy keeps the image as an attachment; a text file and the data folder are refused.
    const store = new AttachmentStore(join(data, 'attachments'));
    const kept = await attachFromPath(store, 'p1', join(folder, '기둥 2.png'), context);
    assert.equal(kept.kind, 'image');
    assert.equal(kept.name, '기둥 2.png');
    assert.equal(store.get('p1', kept.id)?.kind, 'image');
    await assert.rejects(
      attachFromPath(store, 'p1', join(folder, 'notes.txt'), context),
      /INVALID_INPUT/,
    );
    await assert.rejects(
      attachFromPath(store, 'p1', join(data, 'inside.png'), context),
      /FILE_FORBIDDEN/,
    );
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(pictures, { recursive: true, force: true });
  }
});
