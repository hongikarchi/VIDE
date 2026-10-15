// 노트 종류와 회의록 틀 (SPEC-10.9 1·4, PLAN-54 T-356): 'meeting' is a stored kind, the 일정 row is
// not; a new meeting gets 날짜·참석·결정·할 일 (H2) with today and one empty check item, only while
// nothing is typed; the 할 일 lines go through the same action-item rule as any note.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {
  actionItems,
  appendParagraphs,
  ensureFirstBlock,
  meetingMarkdown,
  meetingTitle,
  NOTE_KINDS,
  noteKindMark,
  noteLabel,
  noteMarkdown,
  SCHEDULE_KIND,
  seedMeeting,
} from '../../src/contracts/note-doc.ts';

test('kinds: meeting is stored, the schedule row is not; labels and marks', () => {
  assert.deepEqual([...NOTE_KINDS], ['note', 'discussion', 'journal', 'meeting']);
  assert.ok(!NOTE_KINDS.includes(SCHEDULE_KIND));
  assert.deepEqual(['note', 'discussion', 'journal', 'meeting', 'schedule'].map(noteLabel), [
    '노트',
    '노트',
    '일지',
    '회의록',
    '일정',
  ]);
  assert.deepEqual(['note', 'discussion', 'journal', 'meeting', 'schedule'].map(noteKindMark), [
    '',
    '',
    '퇴근 기록',
    '회의록',
    '일정',
  ]);
  assert.equal(meetingTitle('2026-10-15'), '10월 15일 회의');
});

test('seedMeeting: the four sections over the server’s empty paragraph, once', () => {
  const doc = new Y.Doc();
  ensureFirstBlock(doc, 'init');
  assert.equal(seedMeeting(doc, '2026-10-15'), true);
  assert.equal(noteMarkdown(doc), meetingMarkdown('2026-10-15'));
  assert.equal(
    noteMarkdown(doc),
    '## 날짜\n\n2026-10-15\n\n## 참석\n\n## 결정\n\n## 할 일\n\n- [ ]',
  );
  // A second screen (or a second call) adds nothing.
  assert.equal(seedMeeting(doc, '2026-10-16'), false);
  assert.equal(noteMarkdown(doc).match(/## 날짜/g)?.length, 1);
  // Typed text is never replaced.
  const typed = new Y.Doc();
  appendParagraphs(typed, '이미 적은 글');
  assert.equal(seedMeeting(typed, '2026-10-15'), false);
  assert.equal(noteMarkdown(typed), '이미 적은 글');
});

test('the 할 일 section’s check items are action items as in any note', () => {
  const doc = new Y.Doc();
  seedMeeting(doc, '2026-10-15');
  const fragment = doc.getXmlFragment('default');
  const list = fragment.get(fragment.length - 1);
  const item = list.get(0);
  const typed = new Y.XmlText();
  item.get(0).insert(0, [typed]);
  typed.insert(0, '설비 업체에 배관 경로 회신 요청');
  const more = new Y.XmlElement('taskItem');
  more.setAttribute('checked', true);
  const paragraph = new Y.XmlElement('paragraph');
  const run = new Y.XmlText();
  run.insert(0, '구조 도면 받기');
  paragraph.insert(0, [run]);
  more.insert(0, [paragraph]);
  list.insert(1, [more]);
  assert.deepEqual(actionItems(noteMarkdown(doc)), ['설비 업체에 배관 경로 회신 요청']);
});
