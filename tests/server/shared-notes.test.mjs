// SPEC-10 on the PC without a site: the Markdown copy and README for the AI, the turn rule that
// names the notes folder, a note's check-list items → 할 일, the local stream of a note to the
// PC screen, offline edits kept on disk, and one kind on screen (a 협의 사항 copy reads 노트, an
// empty title '제목 없음'; T-184). The site round trip is tests/sharing/notes.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { SharedNotes } from '../../src/server/shared-notes.ts';
import { workFolderRule } from '../../src/ai/agent-connection.ts';
import { agendaRoutes } from '../../src/server/agenda-routes.ts';
import {
  NOTE_FIELD,
  noteMarkdown,
  actionItems,
  journalTitle,
} from '../../src/contracts/note-doc.ts';
import { fromBase64, toBase64 } from '../../src/contracts/note-sync.ts';

const PROJECT = 'aaaaaaaa-1111-4111-8111-111111111111';
const NOTE = '0b8f1d2e-3c4a-4b5c-8d6e-7f8091a2b3c4';
const JOURNAL = '1c9e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6';
const site = (notes) => ({
  site: 'https://site.example',
  deviceFetch: async (path, method = 'GET') => {
    if (method === 'GET' && path.startsWith(`/projects/${PROJECT}/notes`))
      return Response.json({ notes });
    if (path.endsWith('/ticket')) throw new TypeError('fetch failed');
    return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
  },
});
const note = (over) => ({
  id: NOTE,
  projectId: PROJECT,
  title: '구조 협의',
  kind: 'discussion',
  journalDate: null,
  createdAt: 1,
  updatedAt: Date.parse('2026-10-06T05:00:00Z'),
  updatedBy: 'u1',
  updatedByName: 'bob',
  revision: 3,
  snapshot: '철골 보 춤\n\n- [ ] 구조사무소에 경간 확인\n- [x] 지난 회신',
  ...over,
});
/** A socket that never opens (the site is unreachable). */
class Closed {
  readyState = 0;
  constructor() {
    setTimeout(() => this.onclose?.({ code: 1006 }), 5);
  }
  send() {}
  close() {}
}

test('the notes copy is Markdown the AI reads, named in the turn rule', async () => {
  const data = await mkdtemp(join(tmpdir(), 'vide-notes-'));
  try {
    const agenda = [];
    const notes = new SharedNotes({
      remote: site([
        note(),
        note({
          id: JOURNAL,
          title: journalTitle('2026-10-06'),
          kind: 'journal',
          journalDate: '2026-10-06',
          snapshot: '오늘: 기둥 배치 검토',
        }),
      ]),
      dataDirectory: data,
      agenda: {
        list: () => agenda.map((text) => ({ text, done: false })),
        add: (projectId, value) => {
          agenda.push(value.text);
          return value;
        },
      },
      WebSocket: Closed,
    });
    const listed = await notes.list(PROJECT);
    assert.equal(listed.online, true);
    assert.equal(listed.notes.length, 2);
    assert.equal(listed.notes[0].snapshot, undefined, 'the list sends excerpts, not bodies');
    const folder = join(data, 'projects', PROJECT, 'notes');
    const copy = await readFile(join(folder, `${NOTE}.md`), 'utf8');
    assert.match(copy, /^# 구조 협의/);
    assert.match(copy, /VIDE 공유 노트 · 노트 · id/, 'a 협의 사항 reads as a 노트');
    assert.match(copy, /- \[ \] 구조사무소에 경간 확인/);
    assert.match(await readFile(join(folder, 'journal-2026-10-06.md'), 'utf8'), /기둥 배치 검토/);
    const readme = await readFile(join(folder, 'README.md'), 'utf8');
    assert.match(readme, /\| 10월 6일 \(화\) 일지 \| 일지 \| journal-2026-10-06\.md \|/);

    // The turn's rule names the notes folder inside the project's records (ADR-031 6).
    const rule = workFolderRule({
      dirs: [],
      attachments: [],
      records: join(data, 'projects', PROJECT),
    });
    assert.ok(rule.includes(JSON.stringify(folder)), 'rule names the notes folder');
    assert.match(rule, /never write them/);
    assert.match(rule, /project_search does not search them/, 'notes are files, not search');

    // 협의 사항 → 할 일: open check-list items only, once.
    const first = await notes.toAgenda(PROJECT, NOTE);
    assert.equal(first.added.length, 1);
    assert.deepEqual(agenda, ['구조사무소에 경간 확인']);
    const again = await notes.toAgenda(PROJECT, NOTE);
    assert.equal(again.added.length, 0);
    assert.deepEqual(again.skipped, ['구조사무소에 경간 확인']);
    assert.deepEqual(notes.agendaFromText(PROJECT, '- [ ] 도면 회신\n- 그냥 줄').skipped, []);
    assert.deepEqual(agenda, ['구조사무소에 경간 확인', '도면 회신']);

    // Offline (no site): the list comes from the copy.
    const offline = new SharedNotes({
      remote: {
        site: 'https://site.example',
        deviceFetch: async () => {
          throw new TypeError('fetch failed');
        },
      },
      dataDirectory: data,
      agenda: { list: () => [], add: () => ({}) },
      WebSocket: Closed,
    });
    const last = await offline.list(PROJECT);
    assert.equal(last.online, false);
    assert.equal(last.error, 'SITE_UNREACHABLE');
    assert.deepEqual(last.notes.map((n) => n.title).sort(), ['10월 6일 (화) 일지', '구조 협의']);

    // The PC screen's stream: whole state first, its own edits not echoed, others' edits sent.
    const events = { a: [], b: [] };
    const stopA = await offline.stream(PROJECT, NOTE, 'screen-aaaa', (e) => events.a.push(e));
    const stopB = await offline.stream(PROJECT, NOTE, 'screen-bbbb', (e) => events.b.push(e));
    assert.equal(events.a[0].type, 'sync');
    const screen = new Y.Doc();
    Y.applyUpdate(screen, fromBase64(events.a[0].state));
    let update;
    screen.on('update', (u) => (update = u));
    const paragraph = new Y.XmlElement('paragraph');
    const run = new Y.XmlText();
    run.insert(0, '오프라인 메모');
    paragraph.insert(0, [run]);
    screen.getXmlFragment(NOTE_FIELD).insert(0, [paragraph]);
    await offline.receive(PROJECT, NOTE, 'screen-aaaa', { update: toBase64(update) });
    assert.ok(!events.a.some((e) => e.type === 'update'), 'no echo to the sender');
    const toB = events.b.find((e) => e.type === 'update');
    assert.ok(toB, 'the other screen gets the edit');
    assert.ok(
      events.b.some((e) => e.type === 'status' && e.status.pending),
      'unsent edit shown',
    );
    stopA();
    stopB();
    await offline.flushLocal();
    assert.ok(existsSync(join(folder, '.yjs', `${NOTE}.pending`)), 'unsent edit marked');
    assert.match(await readFile(join(folder, `${NOTE}.md`), 'utf8'), /오프라인 메모/);
    await offline.close();
    await notes.close();
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test('a new untitled note: written here, copied to notes/<id>.md; removed notes leave no replica', async () => {
  const data = await mkdtemp(join(tmpdir(), 'vide-notes-'));
  const GONE = '2d0f3a4b-5c6d-4e7f-8a91-a2b3c4d5e6f7';
  const UNSENT = '3e1a4b5c-6d7e-4f80-9a12-b3c4d5e6f708';
  try {
    let listed = [note({ title: '', kind: 'note', snapshot: '' })];
    const notes = new SharedNotes({
      remote: {
        site: 'https://site.example',
        deviceFetch: async (path, method = 'GET') => {
          if (method === 'GET' && path.startsWith(`/projects/${PROJECT}/notes`))
            return Response.json({ notes: listed });
          throw new TypeError('fetch failed');
        },
      },
      dataDirectory: data,
      agenda: { list: () => [], add: () => ({}) },
      WebSocket: Closed,
    });
    const folder = join(data, 'projects', PROJECT, 'notes');
    // Replicas of notes the site no longer lists: one fully sent, one with unsent edits.
    await mkdir(join(folder, '.yjs'), { recursive: true });
    await writeFile(join(folder, '.yjs', `${GONE}.bin`), new Uint8Array([0, 0]));
    await writeFile(join(folder, '.yjs', `${UNSENT}.bin`), new Uint8Array([0, 0]));
    await writeFile(join(folder, '.yjs', `${UNSENT}.pending`), '1');
    await notes.list(PROJECT);
    assert.match(await readFile(join(folder, `${NOTE}.md`), 'utf8'), /^# 제목 없음\n/);
    assert.match(await readFile(join(folder, 'README.md'), 'utf8'), /\| 제목 없음 \| 노트 \|/);
    assert.ok(!existsSync(join(folder, '.yjs', `${GONE}.bin`)), "a removed note's replica goes");
    assert.ok(existsSync(join(folder, '.yjs', `${UNSENT}.bin`)), 'unsent edits are kept');

    // Writing in the note on this PC: the Markdown copy the AI reads follows.
    const events = [];
    const stop = await notes.stream(PROJECT, NOTE, 'screen-cccc', (e) => events.push(e));
    const screen = new Y.Doc();
    Y.applyUpdate(screen, fromBase64(events[0].state));
    let update;
    screen.on('update', (u) => (update = u));
    const item = new Y.XmlElement('taskItem');
    item.setAttribute('checked', false);
    const paragraph = new Y.XmlElement('paragraph');
    const run = new Y.XmlText();
    run.insert(0, '창호 상세 회신');
    paragraph.insert(0, [run]);
    item.insert(0, [paragraph]);
    const list = new Y.XmlElement('taskList');
    list.insert(0, [item]);
    screen.getXmlFragment(NOTE_FIELD).insert(0, [list]);
    await notes.receive(PROJECT, NOTE, 'screen-cccc', { update: toBase64(update) });
    await notes.flushLocal();
    const copy = await readFile(join(folder, `${NOTE}.md`), 'utf8');
    assert.match(copy, /^# 제목 없음/);
    assert.match(copy, /- \[ \] 창호 상세 회신/);
    // An open note's replica stays even if a list no longer shows it.
    listed = [];
    await notes.list(PROJECT);
    assert.ok(existsSync(join(folder, '.yjs', `${NOTE}.bin`)), 'the open replica is kept');
    stop();
    // The list opened the unsent note to send it; let that finish before closing.
    await notes.pushPending(PROJECT);
    await notes.close();
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test('note Markdown: headings, lists, check lists, quotes and marks', () => {
  const doc = new Y.Doc();
  const el = (name, children, attrs = {}) => {
    const node = new Y.XmlElement(name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    node.insert(0, children);
    return node;
  };
  const text = (value, format) => {
    const node = new Y.XmlText();
    node.insert(0, value, format);
    return node;
  };
  doc
    .getXmlFragment(NOTE_FIELD)
    .insert(0, [
      el('heading', [text('회의')], { level: 2 }),
      el('paragraph', [text('굵게', { bold: {} })]),
      el('bulletList', [el('listItem', [el('paragraph', [text('하나')])])]),
      el('orderedList', [el('listItem', [el('paragraph', [text('첫째')])])]),
      el('taskList', [
        el('taskItem', [el('paragraph', [text('보낼 일')])], { checked: false }),
        el('taskItem', [el('paragraph', [text('끝난 일')])], { checked: true }),
      ]),
      el('blockquote', [el('paragraph', [text('인용')])]),
    ]);
  const markdown = noteMarkdown(doc);
  assert.equal(
    markdown,
    '## 회의\n\n**굵게**\n\n- 하나\n1. 첫째\n- [ ] 보낼 일\n- [x] 끝난 일\n\n> 인용',
  );
  assert.deepEqual(actionItems(markdown), ['보낼 일']);
});

test('퇴근하기 also sends the day line to the journal, never waiting or failing on it', async () => {
  const entry = { date: '2026-10-06', text: '2026-10-06 · 완료 2 · 도면 정리, 회의록' };
  const run = async (dayEnded) => {
    let sent;
    await agendaRoutes(new URL('http://127.0.0.1/api/v1/projects/p1/agenda/day-end'), 'POST', {
      agenda: { dayEnd: () => ({ entry, items: [] }) },
      body: async () => ({}),
      send: (status, value) => (sent = { status, value }),
      ledger: {},
      dayEnded,
    });
    return sent;
  };
  const calls = [];
  const sent = await run((projectId, line) => calls.push([projectId, line.date, line.text]));
  assert.equal(sent.status, 200);
  assert.deepEqual(calls, [['p1', '2026-10-06', entry.text]]);
  // A failing journal hook does not fail 퇴근하기.
  const failed = await run(() => {
    throw new Error('site down');
  });
  assert.equal(failed.status, 200);
});
