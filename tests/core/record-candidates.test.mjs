// 자동 후보의 규칙 (SPEC-17.3 1, ARCH-01 §5 「프로젝트 기록」, PLAN-53 T-322): finished requests →
// D/E (document Syncs → K), decision sentences → D (ten or more positive and negative each), note
// paragraphs → '?' with the daily cap, jig settings → D, confirmed review jigs → E, checkouts and
// folder roles → K; the same input always gives the same key. All sentences are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PARAGRAPHS_PER_DAY,
  candidateFromCheckout,
  candidateFromJigRun,
  candidateFromParamChange,
  candidateFromRequest,
  candidateFromSchemaConfirm,
  decisionSentences,
  isDecisionSentence,
  localDateTime,
  noteParagraphs,
  paragraphCandidates,
} from '../../src/core/record-candidates.ts';

const at = '2026-10-15T05:30:00.000Z';
const local = localDateTime(at);
const request = (extra = {}) => ({
  id: 'req-1',
  input: { body: '2층 슬래브 두께를 250으로 바꿔줘', conversationId: 'conv-1' },
  state: 'succeeded',
  result: null,
  createdAt: at,
  ...extra,
});

test('a finished request: D with changed objects, E without, K for a document Sync', () => {
  const changed = candidateFromRequest(
    request({ result: { changes: { added: ['a1'], removed: [], modified: [{ id: 'm1' }] } } }),
  );
  assert.equal(changed.type, 'D');
  assert.equal(changed.source, 'request');
  assert.equal(changed.sourceKey, 'request:req-1');
  assert.equal(changed.text, '2층 슬래브 두께를 250으로 바꿔줘');
  assert.deepEqual(changed.attachments, { requestId: 'req-1', objects: ['a1', 'm1'] });
  assert.equal(changed.date, local.date);
  assert.equal(changed.time, local.time);

  const executed = candidateFromRequest(
    request({
      result: {
        executions: [{ state: 'applied', changes: { added: [], removed: ['r9'], modified: [] } }],
      },
    }),
  );
  assert.equal(executed.type, 'D');
  assert.deepEqual(executed.attachments.objects, ['r9']);

  const read = candidateFromRequest(
    request({ input: { body: '1층 벽 길이 재어 줘' }, result: { text: '12.4 m' } }),
  );
  assert.equal(read.type, 'E');
  assert.deepEqual(read.attachments, { requestId: 'req-1' });

  const sync = candidateFromRequest(
    request({
      id: 'sync-7',
      input: { body: '열린 Rhino 문서 가져오기', source: 'document', linkId: 'l1' },
      result: { changes: { added: ['x'], removed: [], modified: [] } },
    }),
  );
  assert.equal(sync.type, 'K');
  assert.equal(sync.source, 'sync');
  assert.equal(sync.sourceKey, 'sync:sync-7');
  assert.deepEqual(sync.attachments, { requestId: 'sync-7' });
});

test('failed, cancelled and empty requests make no candidate', () => {
  for (const state of ['failed', 'cancelled', 'interrupted', 'running', 'queued'])
    assert.equal(candidateFromRequest(request({ state })), null, state);
  assert.equal(candidateFromRequest(request({ input: { body: '   ' } })), null);
  assert.equal(candidateFromRequest(request({ result: { applicationState: 'failed' } })), null);
});

const positives = [
  '외벽은 석재로 가자',
  '기둥 간격 8.4m로 확정',
  '지붕은 평지붕으로 하자',
  '주출입구는 남측으로 하기로 했어',
  '코어 위치는 동측으로 정했어',
  '1층 층고 4.5m 결정',
  '주차는 지하 2층까지로 결정했습니다',
  '커튼월 멀리언 간격은 1.5m로 갑시다',
  '계단실을 북측으로 옮기는 걸로 확정할게',
  '발코니 난간은 유리로 하기로 함',
  '캐노피 깊이는 3m로 정함',
  '로비 바닥은 테라조로 합시다',
];
const negatives = [
  '아직 결정 못 했어',
  '확정은 아직이야',
  '외벽 석재로 갈까?',
  '지붕 평지붕으로 할까',
  '결정하기 전에 단면 먼저 보자',
  '기둥 간격 확정됐어?',
  '이 부분은 미정으로 두자',
  '창호 사양은 보류',
  '어떻게 결정할지 같이 보자',
  '벽 두께 다시 검토해줘',
  '결정해야 할 게 세 가지 있어',
  '확정 안 됐어',
  '결정은 다음 회의에서',
];

test('decision words: positive sentences are decisions', () => {
  assert.ok(positives.length >= 10);
  for (const sentence of positives) assert.ok(isDecisionSentence(sentence), sentence);
});
test('decision words: open, pending or asked sentences are not', () => {
  assert.ok(negatives.length >= 10);
  for (const sentence of negatives) assert.ok(!isDecisionSentence(sentence), sentence);
});
test('decisionSentences: the user sentences that decide, then the ledger decisions', () => {
  const text =
    '오늘 회의 정리야. 외벽은 석재로 가자. 창호는 아직 결정 못 했어.\n코어는 동측으로 확정';
  assert.deepEqual(decisionSentences(text, []), ['외벽은 석재로 가자.', '코어는 동측으로 확정']);
  assert.deepEqual(
    decisionSentences('벽 두께 확인해줘', [
      '보 춤은 600으로 한다',
      { text: '설비 샤프트는 코어 옆' },
      { aiChoice: { provider: 'x' } },
      '보 춤은 600으로 한다',
    ]),
    ['보 춤은 600으로 한다', '설비 샤프트는 코어 옆'],
  );
  assert.deepEqual(decisionSentences('', []), []);
});

const note = [
  '# 3차 설계 협의',
  '',
  '<!-- VIDE 공유 노트 · 노트 · id n1 · 마지막 수정 2026-10-15 14:00 · 원본은 계정 사이트 -->',
  '',
  '건축주가 1층 상가 전면을 전부 열어 달라고 요청함.',
  '',
  '## 구조',
  '',
  '- 기존 벽체 실측 필요함',
  '- [x] 보강 보 위치 확인',
  '- 짧음',
  '',
  '| 항목 | 내용 |',
  '|---|---|',
  '| 바닥 | 기존 슬래브 유지 검토 |',
  '',
  '---',
  '',
  '```',
  '코드 블록은 문단이 아님',
  '```',
].join('\n');

test('note paragraphs: headings, comments, blank lines, separators and fences are left out', () => {
  assert.deepEqual(noteParagraphs(note), [
    '건축주가 1층 상가 전면을 전부 열어 달라고 요청함.',
    '기존 벽체 실측 필요함',
    '보강 보 위치 확인',
    '짧음',
    '항목 · 내용',
    '바닥 · 기존 슬래브 유지 검토',
  ]);
});

test('paragraphCandidates: type ?, stable keys, the 8-character floor', () => {
  const first = paragraphCandidates(note, {
    source: 'note',
    date: '2026-10-15',
    noteId: 'n1',
    dailyCount: 0,
  });
  assert.deepEqual(
    first.map((c) => c.text),
    [
      '건축주가 1층 상가 전면을 전부 열어 달라고 요청함.',
      '기존 벽체 실측 필요함',
      '보강 보 위치 확인',
      '바닥 · 기존 슬래브 유지 검토',
    ],
  );
  for (const candidate of first) {
    assert.equal(candidate.type, '?');
    assert.equal(candidate.source, 'note');
    assert.match(candidate.sourceKey, /^note:n1:[0-9a-f]{8}$/);
    assert.equal(candidate.attachments.note.id, 'n1');
  }
  const again = paragraphCandidates(note, {
    source: 'note',
    date: '2026-10-15',
    noteId: 'n1',
    dailyCount: 0,
  });
  assert.deepEqual(
    again.map((c) => c.sourceKey),
    first.map((c) => c.sourceKey),
  );
  const journal = paragraphCandidates('퇴근 기록 · 지하 주차 램프 경사 확인함', {
    source: 'journal',
    date: '2026-10-14',
    dailyCount: 0,
  });
  assert.equal(journal.length, 1);
  assert.match(journal[0].sourceKey, /^journal:2026-10-14:[0-9a-f]{8}$/);
  assert.equal(journal[0].date, '2026-10-14');
  // A note without its id cannot be keyed.
  assert.deepEqual(
    paragraphCandidates(note, { source: 'note', date: '2026-10-15', dailyCount: 0 }),
    [],
  );
});

test('paragraphCandidates: at most 30 a day, counting what the day already has', () => {
  const long = Array.from({ length: 50 }, (_, i) => `회의 메모 ${i + 1}번째 문단입니다`).join(
    '\n\n',
  );
  const options = { source: 'meeting', date: '2026-10-15', noteId: 'n2', dailyCount: 0 };
  assert.equal(paragraphCandidates(long, options).length, PARAGRAPHS_PER_DAY);
  assert.equal(paragraphCandidates(long, { ...options, dailyCount: 25 }).length, 5);
  assert.equal(paragraphCandidates(long, { ...options, dailyCount: 40 }).length, 0);
  // Keys already stored do not use up the day's cap.
  const known = new Set(
    paragraphCandidates(long, options)
      .slice(0, 10)
      .map((c) => c.sourceKey),
  );
  const next = paragraphCandidates(long, {
    ...options,
    dailyCount: 20,
    known: (k) => known.has(k),
  });
  assert.equal(next.length, 10);
  assert.ok(next.every((c) => !known.has(c.sourceKey)));
  assert.equal(next[0].text, '회의 메모 11번째 문단입니다');
});

test('a jig setting change → D with who-why text and its seq key', () => {
  const change = {
    instanceId: 'jig-9',
    seq: 4,
    key: 'beamSpacing',
    old: { value: 2.5, by: 'default', at },
    new: { value: 3, by: 'user', at },
    by: 'user',
    reason: '설비 덕트 간섭',
    at,
    jigTitle: '구조 배치',
  };
  const candidate = candidateFromParamChange(change);
  assert.equal(candidate.type, 'D');
  assert.equal(candidate.source, 'jig');
  assert.equal(candidate.text, '구조 배치 beamSpacing: 2.5 → 3(설비 덕트 간섭)');
  assert.equal(candidate.sourceKey, 'jig-param:jig-9:4');
  assert.deepEqual(candidate.attachments, { jig: { instanceId: 'jig-9', seq: 4 } });
  assert.equal(
    candidateFromParamChange({ ...change, old: null, reason: null }).text,
    '구조 배치 beamSpacing: 없음 → 3',
  );
  assert.equal(candidateFromParamChange(change).sourceKey, candidate.sourceKey);
});

test('a confirmed 법규 체크·구조 검토 run → E; other jigs, modes and failed gates give none', () => {
  const event = {
    instanceId: 'c1',
    jigId: 'vide/compliance-check',
    title: '법규 체크',
    mode: 'confirmed',
    status: 'computed',
    outputs: { report: { summary: '건폐율 58.2% 적합' } },
    runAt: at,
  };
  const candidate = candidateFromJigRun(event);
  assert.equal(candidate.type, 'E');
  assert.equal(candidate.text, '법규 체크 확정 결과: 건폐율 58.2% 적합');
  assert.equal(candidate.sourceKey, `jig-result:c1:${at}`);
  assert.deepEqual(candidate.attachments, { jig: { instanceId: 'c1', runAt: at } });
  assert.equal(
    candidateFromJigRun({ ...event, jigId: 'vide/structure-analysis', outputs: {} }).text,
    '법규 체크 확정 결과',
  );
  assert.equal(candidateFromJigRun({ ...event, mode: 'geometry' }), null);
  assert.equal(candidateFromJigRun({ ...event, mode: 'preview' }), null);
  assert.equal(candidateFromJigRun({ ...event, jigId: 'vide/paneling' }), null);
  assert.equal(candidateFromJigRun({ ...event, status: 'gate-failed' }), null);
});

test('checkout, 서버에 반영 and folder roles → K', () => {
  const taken = candidateFromCheckout({
    checkoutId: 'co1',
    role: 'drawings',
    serverPath: 'Z:\\프로젝트\\03_도면\\A-101.dwg',
    at,
  });
  assert.equal(taken.type, 'K');
  assert.equal(taken.source, 'checkout');
  assert.equal(taken.text, '체크아웃: A-101.dwg');
  assert.equal(taken.sourceKey, 'checkout:co1');
  assert.deepEqual(taken.attachments, { checkoutId: 'co1' });
  const released = candidateFromCheckout({
    checkoutId: 'co1',
    serverPath: 'Z:\\프로젝트\\03_도면\\A-101.dwg',
    released: true,
    at,
  });
  assert.equal(released.text, '서버에 반영: A-101.dwg');
  assert.equal(released.sourceKey, 'release:co1');
  const roles = candidateFromSchemaConfirm({
    confirmedAt: at,
    paths: { drawings: '03_도면', models: '04_모델', data: null },
    labels: { drawings: '도면', models: '모델' },
  });
  assert.equal(roles.type, 'K');
  assert.equal(roles.text, '폴더 역할 확정: 도면=03_도면, 모델=04_모델');
  assert.equal(roles.sourceKey, `schema:${at}`);
  assert.equal(candidateFromSchemaConfirm({ confirmedAt: 'nope', paths: {} }), null);
});
