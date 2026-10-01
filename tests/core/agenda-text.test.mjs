// 대시보드의 할 일 (SPEC-01.14 2): the date and time read locally from typed words
// (src/ui/agenda-text.ts); no AI call, the text stays when nothing is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { agendaNotice, agendaWhen, dateLabel, parseAgendaText } from '../../src/ui/agenda-text.ts';

// Thursday 2026-10-01, 10:20 local.
const now = new Date(2026, 9, 1, 10, 20);
const read = (text) => parseAgendaText(text, now);

test('relative days, weekdays and afternoon hours from Korean phrases', () => {
  assert.deepEqual(read('내일 3시 구조 회의'), {
    text: '구조 회의',
    date: '2026-10-02',
    time: '15:00',
  });
  assert.deepEqual(read('오늘 오전 9시 반 현장 점검'), {
    text: '현장 점검',
    date: '2026-10-01',
    time: '09:30',
  });
  assert.deepEqual(read('모레 저녁 7시 회식'), {
    text: '회식',
    date: '2026-10-03',
    time: '19:00',
  });
  // A weekday is the next one on or after today; '이번 주'/'다음 주' weeks start on Monday.
  assert.deepEqual(read('금요일까지 도면 제출'), {
    text: '도면 제출',
    date: '2026-10-02',
    time: null,
  });
  assert.equal(read('목요일 정기 회의').date, '2026-10-01');
  assert.equal(read('수요일 정기 회의').date, '2026-10-07');
  assert.equal(read('다음 주 월요일 착수 보고').date, '2026-10-05');
  assert.equal(read('이번주 월요일 회의록 정리').date, '2026-09-28');
  assert.equal(read('3시 10분에 전화').time, '15:10');
  assert.equal(read('3시 10분에 전화').text, '전화');
  assert.equal(read('11시 설계 검토').time, '11:00');
});

test('numeric dates and 24-hour times; a month long past is next year', () => {
  assert.deepEqual(read('10/7 14:00 현장 회의'), {
    text: '현장 회의',
    date: '2026-10-07',
    time: '14:00',
  });
  assert.deepEqual(read('2026-11-03 허가 서류'), {
    text: '허가 서류',
    date: '2026-11-03',
    time: null,
  });
  assert.equal(read('10월 15일 납품').date, '2026-10-15');
  assert.equal(read('1/5 신년 회의').date, '2027-01-05');
  // A time alone is today's.
  assert.deepEqual(read('16:30 자료 회신'), {
    text: '자료 회신',
    date: '2026-10-01',
    time: '16:30',
  });
});

test('nothing read leaves the text as typed', () => {
  for (const text of [
    '구조 계산서 검토',
    '1시간 회의 준비',
    '오늘의 할일 정리법 찾기',
    '13/40 비율 확인',
    '25:00 표기 확인',
  ])
    assert.deepEqual(read(text), { text, date: null, time: null }, text);
  // Only a date and no other words keeps the words as the text too.
  assert.deepEqual(read('내일'), { text: '내일', date: '2026-10-02', time: null });
});

test('where an item stands, its label and the AI notice', () => {
  assert.equal(agendaWhen({ date: null, done: false }, '2026-10-01'), 'undated');
  assert.equal(agendaWhen({ date: '2026-09-30', done: false }, '2026-10-01'), 'overdue');
  assert.equal(agendaWhen({ date: '2026-10-01', done: false }, '2026-10-01'), 'today');
  assert.equal(agendaWhen({ date: '2026-10-09', done: false }, '2026-10-01'), 'later');
  assert.equal(dateLabel('2026-10-02', '2026-10-01'), '내일');
  assert.equal(dateLabel('2026-09-30', '2026-10-01'), '지남 · 9/30 (수)');
  assert.equal(dateLabel('2026-10-07', '2026-10-01'), '10/7 (수)');
  assert.equal(
    agendaNotice({ changes: [{ op: 'add', text: '구조 회의' }] }),
    "AI가 할 일을 더했습니다: '구조 회의'",
  );
  assert.equal(
    agendaNotice({
      changes: [
        { op: 'set', text: 'a' },
        { op: 'add', text: 'b' },
      ],
    }),
    "AI가 할 일을 바꿨습니다: 'a', 'b'",
  );
  assert.equal(agendaNotice({ changes: [] }), undefined);
});
