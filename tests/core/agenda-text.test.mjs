// 대시보드의 할 일 (SPEC-01.14 2): the date and time read locally from typed words
// (src/ui/agenda-text.ts); no AI call, the text stays when nothing is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgendaTurns,
  agendaNotice,
  agendaWhen,
  dateLabel,
  dayLabel,
  monthDays,
  monthLabel,
  monthOf,
  parseAgendaDraft,
  parseAgendaText,
  shiftMonth,
  todayProgress,
  extractionBody,
  spanLabel,
  timeLabel,
  weekLanes,
} from '../../src/ui/agenda-text.ts';

// Thursday 2026-10-01, 10:20 local.
const now = new Date(2026, 9, 1, 10, 20);
/** The end day and time are named only when a range was read. */
const compact = ({ endDate, endTime, ...rest }) =>
  endDate || endTime ? { ...rest, endDate, endTime } : rest;
const read = (text) => compact(parseAgendaText(text, now));

test('relative days, weekdays and afternoon hours from Korean phrases', () => {
  assert.deepEqual(read('내일 3시 구조 회의'), {
    text: '구조 회의',
    date: '2026-10-02',
    time: '15:00',
    kind: 'meeting',
  });
  assert.deepEqual(read('오늘 오전 9시 반 현장 점검'), {
    text: '현장 점검',
    date: '2026-10-01',
    time: '09:30',
    kind: 'task',
  });
  assert.deepEqual(read('모레 저녁 7시 회식'), {
    text: '회식',
    date: '2026-10-03',
    time: '19:00',
    kind: 'task',
  });
  // A weekday is the next one on or after today; '이번 주'/'다음 주' weeks start on Monday.
  assert.deepEqual(read('금요일까지 도면 제출'), {
    text: '도면 제출',
    date: '2026-10-02',
    time: null,
    // '제출' makes a 접수 even with '까지' (2026-10-06).
    kind: 'receipt',
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
    kind: 'meeting',
  });
  assert.deepEqual(read('2026-11-03 허가 서류'), {
    text: '허가 서류',
    date: '2026-11-03',
    time: null,
    kind: 'task',
  });
  assert.equal(read('10월 15일 납품').date, '2026-10-15');
  assert.equal(read('1/5 신년 회의').date, '2027-01-05');
  // A time alone is today's.
  assert.deepEqual(read('16:30 자료 회신'), {
    text: '자료 회신',
    date: '2026-10-01',
    time: '16:30',
    kind: 'task',
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
    assert.deepEqual(
      { ...read(text), kind: undefined },
      { text, date: null, time: null, kind: undefined },
      text,
    );
  // Only a date and no other words keeps the words as the text too.
  assert.deepEqual(read('내일'), { text: '내일', date: '2026-10-02', time: null, kind: 'task' });
});

test("kinds: '까지' is a 마감 (not dropped), '협의'/'회의'/'미팅' a 협의, '제출'/'접수' a 접수, others 할 일", () => {
  assert.equal(read('금요일까지 보고서').kind, 'deadline');
  assert.equal(read('금요일까지 보고서').text, '보고서');
  assert.equal(read('오후 5시까지 견적 회신').kind, 'deadline');
  assert.equal(read('금요일까지 회의 자료 준비').kind, 'deadline');
  assert.equal(read('설계 도서 마감').kind, 'deadline');
  assert.equal(read('수요일 설비 미팅').kind, 'meeting');
  assert.equal(read('1시간 회의 준비').kind, 'meeting');
  assert.equal(read('이번주 월요일 회의록 정리').kind, 'task');
  assert.equal(read('금요일 도면 제출').kind, 'receipt');
  assert.equal(read('내일부터 현장 상주').kind, 'task');
  // 2026-10-06: '협의' is the 회의 kind's name; '접수'/'제출' make a 접수 (even with '까지').
  assert.equal(read('내일 2시 구조 협의').kind, 'meeting');
  assert.equal(read('협의서 작성').kind, 'task');
  assert.equal(read('10/9 건축 허가 접수').kind, 'receipt');
  assert.equal(read('금요일까지 구조계산서 제출').kind, 'receipt');
  assert.equal(read('접수처 전화번호 확인').kind, 'task');
  assert.equal(read('제출 서류 마감').kind, 'deadline');
});

test('ranges: times and days joined by ~, - or 부터…까지; the closing 까지 is no 마감', () => {
  assert.deepEqual(read('2시~4시 구조 협의'), {
    text: '구조 협의',
    date: '2026-10-01',
    time: '14:00',
    kind: 'meeting',
    endDate: null,
    endTime: '16:00',
  });
  assert.deepEqual(read('내일 2시부터 4시까지 설비 점검'), {
    text: '설비 점검',
    date: '2026-10-02',
    time: '14:00',
    kind: 'task',
    endDate: null,
    endTime: '16:00',
  });
  assert.equal(read('10/8 14:00-15:30 현장 협의').endTime, '15:30');
  assert.equal(read('10/8 10시 ~ 12시 회의').endTime, '12:00');
  // '오후 8시~10시': the end before the start is read 12 hours later.
  assert.equal(read('오후 8시~10시 야간 타설').endTime, '22:00');
  assert.deepEqual(read('10/7~10/9 현장 점검'), {
    text: '현장 점검',
    date: '2026-10-07',
    time: null,
    kind: 'task',
    endDate: '2026-10-09',
    endTime: null,
  });
  assert.equal(read('10월 7일~9일 현장 상주').endDate, '2026-10-09');
  const until = read('10/7부터 10/9까지 현장 점검');
  assert.deepEqual([until.date, until.endDate, until.kind], ['2026-10-07', '2026-10-09', 'task']);
  // Not a range: an end before the start stays in the text, the 까지 after one date is a 마감.
  assert.equal(read('10/9~10/7 점검').endDate, undefined);
  assert.equal(read('금요일까지 보고서').kind, 'deadline');
  // '하루 종일' after a date leaves the text: an all-day item.
  assert.deepEqual(read('10/7 하루 종일 현장'), {
    text: '현장',
    date: '2026-10-07',
    time: null,
    kind: 'task',
  });
  assert.equal(timeLabel({ time: '14:00', endTime: '16:00' }), '14:00~16:00');
  assert.equal(spanLabel({ date: '2026-10-07', endDate: '2026-10-09' }), '10/7~10/9 (금)');
});

test("'마감' only as a word of its own: the finishing work of a building is not a 마감", () => {
  assert.equal(read('내일 3시 외벽 마감재 회의').kind, 'meeting');
  assert.equal(read('마감재 샘플 받기').kind, 'task');
  assert.equal(read('금요일 내부 마감 상세 검토').kind, 'task');
  assert.equal(read('외부 마감 공사 일정 확인').kind, 'task');
  assert.equal(read('회의실 예약').kind, 'task');
  assert.equal(read('설계 도서 마감').kind, 'deadline');
  assert.equal(read('입찰 마감일은 금요일').kind, 'deadline');
  assert.equal(read('보고서 마감, 금요일').kind, 'deadline');
  assert.equal(read('마감 회의').kind, 'deadline');
});

test('the calendar add box: a date the user typed wins over the picked day', () => {
  const draft = (text) => compact(parseAgendaDraft(text, now));
  assert.deepEqual(draft('2026-10-07 금요일까지 보고서'), {
    text: '보고서',
    date: '2026-10-02',
    time: null,
    kind: 'deadline',
  });
  assert.deepEqual(draft('2026-10-07 설비 미팅'), {
    text: '설비 미팅',
    date: '2026-10-07',
    time: null,
    kind: 'meeting',
  });
  assert.deepEqual(draft('2026-10-07 3시 현장 점검'), {
    text: '현장 점검',
    date: '2026-10-07',
    time: '15:00',
    kind: 'task',
  });
  assert.equal(draft('2026-10-07 10/9 견적 회신').date, '2026-10-09');
  assert.equal(draft('내일 구조 검토').date, '2026-10-02');
});

test('where an item stands, its label and the AI notice', () => {
  assert.equal(agendaWhen({ date: null, done: false }, '2026-10-01'), 'undated');
  assert.equal(agendaWhen({ date: '2026-09-30', done: false }, '2026-10-01'), 'overdue');
  assert.equal(agendaWhen({ date: '2026-10-01', done: false }, '2026-10-01'), 'today');
  assert.equal(agendaWhen({ date: '2026-10-09', done: false }, '2026-10-01'), 'later');
  // Over several days: today's while today falls in it, overdue once its last day passed.
  const span = { date: '2026-09-29', endDate: '2026-10-02', done: false };
  assert.equal(agendaWhen(span, '2026-10-01'), 'today');
  assert.equal(agendaWhen(span, '2026-10-03'), 'overdue');
  // A 협의 that passed is just past (no 지남).
  assert.equal(
    agendaWhen({ date: '2026-09-30', kind: 'meeting', done: false }, '2026-10-01'),
    'past',
  );
  assert.equal(
    agendaWhen({ date: '2026-10-01', kind: 'meeting', done: false }, '2026-10-01'),
    'today',
  );
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
  // An item added and then changed in one turn is named once, as added, with its last text.
  assert.equal(
    agendaNotice({
      changes: [
        { op: 'add', id: 'a', text: '도면 제출' },
        { op: 'set', id: 'a', text: '도면 제출 — 3장' },
      ],
    }),
    "AI가 할 일을 더했습니다: '도면 제출 — 3장'",
  );
});

test('one notice per turn: the AI 할 일 writes of a turn wait for its end and go together', () => {
  const turns = new AgendaTurns();
  const write = (id, requestId, op, text) => ({
    id,
    requestId,
    body: { appAction: 'agenda', by: 'ai', changes: [{ op, text }] },
  });
  turns.add(write('l1', 'r1', 'add', '구조 회의'));
  turns.add(write('l2', 'r1', 'set', '회의록 정리'));
  turns.add(write('l3', 'r2', 'add', '현장 사진'));
  // While the turns run nothing is shown.
  assert.deepEqual(turns.take(), []);
  const [one, ...rest] = turns.take('r1');
  assert.equal(rest.length, 0);
  assert.deepEqual(one.ledgerIds, ['l1', 'l2']);
  assert.equal(agendaNotice(one.body), "AI가 할 일을 바꿨습니다: '구조 회의', '회의록 정리'");
  assert.deepEqual(turns.take('r1'), []);
  // A write recorded without a turn is shown at once.
  turns.add(write('l4', null, 'add', '도면 제출'));
  assert.deepEqual(
    turns.take().map((group) => group.ledgerIds),
    [['l4']],
  );
  assert.deepEqual(
    turns.take('r2').map((group) => group.ledgerIds),
    [['l3']],
  );
});

test('the month view: whole weeks from Sunday, moving months, labels', () => {
  const days = monthDays('2026-10-01');
  // October 2026 starts on a Thursday: 4 days of September, 5 weeks in all.
  assert.equal(days.length, 35);
  assert.deepEqual([days[0], days[4], days.at(-1)], ['2026-09-27', '2026-10-01', '2026-10-31']);
  assert.equal(monthDays('2026-08-01').length, 42);
  assert.equal(monthDays('2026-02-01').length, 28);
  assert.equal(shiftMonth('2026-12-01', 1), '2027-01-01');
  assert.equal(shiftMonth('2026-01-01', -1), '2025-12-01');
  assert.equal(monthOf('2026-10-17'), '2026-10-01');
  assert.equal(monthLabel('2026-10-01'), '2026년 10월');
  assert.equal(dayLabel('2026-10-07'), '10월 7일 (수)');
});

test('오늘 진행 and 퇴근: dated items up to today count, undated ones never block', () => {
  const today = '2026-10-06';
  const at = (h) => new Date(2026, 9, 6, h).toISOString();
  const yesterday = new Date(2026, 9, 5, 18).toISOString();
  const item = (date, doneAt = null) => ({ date, done: Boolean(doneAt), doneAt });
  // Nothing yet: no progress, no 퇴근.
  assert.deepEqual(todayProgress([], today), { total: 0, done: 0, doneToday: 0, finished: false });
  const open = [
    item('2026-10-05'),
    item(today),
    item(today, at(10)),
    item(null),
    item('2026-10-07'),
  ];
  assert.deepEqual(todayProgress(open, today), {
    total: 3,
    done: 1,
    doneToday: 1,
    finished: false,
  });
  // All dated ones done; the open undated one does not block, nor does yesterday's finished one.
  const finished = [
    item('2026-10-05', at(9)),
    item(today, at(10)),
    item(null),
    item('2026-10-04', yesterday),
  ];
  assert.deepEqual(todayProgress(finished, today), {
    total: 2,
    done: 2,
    doneToday: 2,
    finished: true,
  });
  // Only undated work finished today: 퇴근 is offered with no n/m.
  assert.deepEqual(todayProgress([item(null, at(11))], today), {
    total: 0,
    done: 0,
    doneToday: 1,
    finished: true,
  });
  // Something finished only yesterday: nothing to leave with today.
  assert.equal(todayProgress([item(null, yesterday)], today).finished, false);
  // A 협의 has no done check: today's or yesterday's never counts nor blocks 퇴근.
  const meeting = (date) => ({ date, done: false, doneAt: null, kind: 'meeting' });
  assert.deepEqual(
    todayProgress([meeting(today), meeting('2026-10-05'), item(today, at(9))], today),
    {
      total: 1,
      done: 1,
      doneToday: 1,
      finished: true,
    },
  );
});

test('a week of the month: bars over several days first, five lines, then +n', () => {
  const week = [
    '2026-10-04',
    '2026-10-05',
    '2026-10-06',
    '2026-10-07',
    '2026-10-08',
    '2026-10-09',
    '2026-10-10',
  ];
  const at = (id, date, extra = {}) => ({ id, date, time: null, order: 0, ...extra });
  const { placed, more } = weekLanes(week, [
    at('one', '2026-10-07', { time: '10:00' }),
    at('span', '2026-10-06', { endDate: '2026-10-08' }),
    at('across', '2026-09-30', { endDate: '2026-10-05' }),
    at('allday', '2026-10-07'),
    at('next', '2026-10-12'),
  ]);
  const by = Object.fromEntries(placed.map((place) => [place.item.id, place]));
  assert.ok(!by.next, 'next week is not in this one');
  // The bar from last week comes first and is cut at the week's start.
  assert.deepEqual(
    [by.across.from, by.across.to, by.across.lane, by.across.before],
    [0, 1, 0, true],
  );
  assert.deepEqual([by.span.from, by.span.to, by.span.lane], [2, 4, 0]);
  // One-day items after the bars: all day before timed.
  assert.deepEqual([by.allday.from, by.allday.lane], [3, 1]);
  assert.deepEqual([by.one.from, by.one.lane], [3, 2]);
  assert.deepEqual(more, [0, 0, 0, 0, 0, 0, 0]);
  // Seven items on one day: five lines show, two are '+2'.
  const busy = Array.from({ length: 7 }, (_, index) =>
    at(`d${index}`, '2026-10-08', { order: index }),
  );
  const crowded = weekLanes(week, busy);
  assert.equal(crowded.placed.length, 5);
  assert.deepEqual(crowded.more, [0, 0, 0, 0, 2, 0, 0]);
});

test('글·파일에서 할 일 만들기: the turn’s words carry today, the tools, assignees and the text', () => {
  const body = extractionBody('  금요일까지 도면 제출 — 김 대리\n다음 주 화 2시 설비 회의 ', now, [
    '회의록.txt',
  ]);
  assert.match(body, /^\[글·파일에서 할 일 만들기\] 아래 글과 첨부 파일\(회의록\.txt\)에서/);
  assert.match(body, /오늘은 2026-10-01 \(목\)입니다/);
  assert.match(body, /agenda_add/);
  assert.match(body, /agenda_list/);
  assert.match(body, /attendees/);
  assert.match(body, /location/);
  assert.match(body, /'receipt'/);
  assert.match(body, /endTime/);
  assert.match(body, /묻지 말고/);
  assert.ok(body.endsWith('---\n금요일까지 도면 제출 — 김 대리\n다음 주 화 2시 설비 회의'));
  // Files only: no text block.
  const files = extractionBody('', now, ['minutes.pdf']);
  assert.match(files, /아래 첨부 파일\(minutes\.pdf\)에서/);
  assert.ok(!files.includes('---'));
});
