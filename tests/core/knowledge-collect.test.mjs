// 자료 정리 (SPEC-08.9, PLAN-42 T-194·T-196): document reading without Python, the collector's
// first run and updates over a synthetic project folder with a fake AI runner, the model plan
// without Claude, drawings through a fake reader, and the 할 일·일정 proposal rules.
// Synthetic folders only; no real CLI, no ZWCAD, no user files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as doc from '../fixtures/documents.mjs';
import { extractBytes } from '../../src/knowledge/collect/documents.ts';
import { loadPdfjs } from '../../src/knowledge/collect/pdf.ts';
import { extractAll } from '../../src/knowledge/collect/extract-pool.ts';
import { KnowledgeCollector } from '../../src/knowledge/collect/collector.ts';
import { modelPlan } from '../../src/knowledge/collect/ai.ts';
import { proposalOf } from '../../src/knowledge/collect/proposals.ts';
import { knowledgeSummary, factSearch } from '../../src/jigs/knowledge.ts';

const PROJECT = '11111111-2222-4333-8444-555555555555';
const layer = { reviews: new Map(), rules: [] };

async function folderOf(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-collect-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = join(directory, 'data'),
    project = join(directory, '2601 합성 프로젝트');
  await mkdir(join(project, '회의록'), { recursive: true });
  await mkdir(data, { recursive: true });
  return { directory, data, project };
}
const claudePlan = () => modelPlan(['claude-cli', 'codex-cli'], ['gpt-6.1-sol']);

function collectorOf({ data, project }, runner, extra = {}) {
  return new KnowledgeCollector({
    dataDirectory: data,
    folders: () => [project],
    denied: (path) => /\.env$/.test(path),
    runner,
    plan: async () => claudePlan(),
    agenda: () => extra.agenda ?? [],
    now: () => new Date(2026, 9, 7, 9, 0),
    dwgReader: extra.dwgReader,
  });
}
async function collect(collector) {
  await collector.start(PROJECT);
  await collector.idle(PROJECT);
  const state = collector.status(PROJECT);
  assert.equal(state.state, 'done', state.error ?? '');
  return state;
}

test('documents are read without Python: text, mail, Office, HWPX, HWP 5 and their states', async () => {
  const docx = await extractBytes(doc.docx(['구조 회의 결과'], [['하중', '5kN']]), 'docx');
  assert.equal(docx.status, 'done');
  assert.match(docx.excerpts[0].text, /구조 회의 결과\n하중 \| 5kN/);
  // XLSX keeps column places and repeats the first row in front of each excerpt.
  const xlsx = await extractBytes(
    doc.xlsx('일정', [
      ['날짜', '내용', null, '비고'],
      ['10/10', '협의', null, '현장'],
    ]),
    'xlsx',
  );
  assert.deepEqual(
    [xlsx.excerpts[0].locator, xlsx.excerpts[0].text],
    ['sheet:일정', '날짜 | 내용 |  | 비고\n10/10 | 협의 |  | 현장'],
  );
  const pptx = await extractBytes(doc.pptx(['첫 장 슬라이드 제목', '둘째 장 내용']), 'pptx');
  assert.deepEqual(
    pptx.excerpts.map((e) => e.locator),
    ['slide1', 'slide2'],
  );
  const hwpx = await extractBytes(doc.hwpx(['한글 문단 하나']), 'hwpx');
  assert.equal(hwpx.excerpts[0].text, '한글 문단 하나');
  // HWP 5.x: compressed and plain sections, a control before the text skipped.
  for (const compressed of [true, false]) {
    const hwp = await extractBytes(doc.hwp(['본문 첫 문단', '둘째 문단'], { compressed }), 'hwp');
    assert.deepEqual([hwp.status, hwp.excerpts[0].text], ['done', '본문 첫 문단\n둘째 문단']);
  }
  assert.equal((await extractBytes(doc.hwp(['x'], { flags: 2 }), 'hwp')).status, 'encrypted');
  assert.equal((await extractBytes(doc.hwp(['x'], { flags: 4 }), 'hwp')).status, 'distribution');
  // A password-protected Office file is a compound file, not a ZIP.
  assert.equal((await extractBytes(doc.hwp(['x']), 'docx')).status, 'encrypted');
  assert.equal((await extractBytes(Buffer.from('not a zip'), 'xlsx')).status, 'error');
  const mail = await extractBytes(
    doc.eml({
      subject: '설계 협의 일정',
      date: 'Tue, 06 Oct 2026 10:00:00 +0900',
      body: '10월 10일 14시 설계 협의를 합니다.',
    }),
    'eml',
  );
  assert.deepEqual(
    [mail.mail.subject, mail.mail.from.name, mail.excerpts[0].text],
    ['설계 협의 일정', '김 대리', '10월 10일 14시 설계 협의를 합니다.'],
  );
  assert.equal((await extractBytes(Buffer.from('메모\n\n두 번째 문단'), 'md')).excerpts.length, 1);
});

test('PDF text layer per page; a page without text is a scan', async (t) => {
  if (!(await loadPdfjs())) {
    assert.equal((await extractBytes(doc.pdf('x'), 'pdf')).status, 'no-reader');
    t.skip('pdfjs-dist is not installed here');
    return;
  }
  const read = await extractBytes(doc.pdf('Structural meeting on 2099-01-10'), 'pdf');
  assert.deepEqual(read.excerpts, [
    { locator: 'p.1', text: 'Structural meeting on 2099-01-10', kind: 'page' },
  ]);
  assert.equal((await extractBytes(doc.pdf(''), 'pdf')).status, 'no-text');
});

test('first collection, an update of one changed file, a removed file and its statements', async (t) => {
  const folder = await folderOf(t);
  const { project, data } = folder;
  await writeFile(
    join(project, '회의록', '261006 구조 회의록.docx'),
    doc.docx(['기둥 간격은 9m로 확정한다.']),
  );
  // Two paragraphs long enough to be two excerpts.
  const pad = ' 이 내용은 시험용 문장이다.'.repeat(40);
  await writeFile(
    join(project, '메모.md'),
    `옥상 조경 하중은 5kN/m2로 한다.${pad}\n\n두 번째 결정 사항은 외장재 변경이다.${pad}`,
  );
  await writeFile(
    join(project, '공정표.xlsx'),
    doc.xlsx('일정', [
      ['날짜', '내용'],
      ['10/20', '인허가 서류 제출 마감'],
    ]),
  );
  await writeFile(
    join(project, '협의.eml'),
    doc.eml({
      subject: '설비 협의',
      date: 'Tue, 06 Oct 2026 10:00:00 +0900',
      body: '설비 협의는 10월 15일 오후 2시에 현장에서 합니다.',
    }),
  );
  await writeFile(join(project, '설계 기준.hwp'), doc.hwp(['내진 설계는 특등급으로 적용한다.']));
  await writeFile(join(project, '옛 문서.doc'), 'old');
  await writeFile(join(project, '.env'), 'SECRET=1');
  await writeFile(join(project, '도면.dwg'), 'AC1032 synthetic');
  const runner = doc.fakeRunner();
  const collector = collectorOf(folder, runner);
  const first = await collect(collector);
  assert.equal(first.collected, true);
  assert.ok(first.collectedAt);
  assert.equal(first.models, 'claude');
  // Five documents read, the old .doc and the drawing (no ZWCAD reader) recorded as not read;
  // the secret file is not listed at all.
  assert.equal(first.counts.read, 5);
  assert.deepEqual(first.counts.unread, { unsupported: 1, 'no-zwcad': 1 });
  assert.equal(first.counts.statements, 7, JSON.stringify(first.counts));
  assert.equal(first.counts.issues, 1);
  const roles = new Set(runner.calls.map((c) => `${c.role}:${c.model}`));
  assert.deepEqual([...roles].sort(), [
    'extract:claude-sonnet-5',
    'filter:claude-haiku-4-5-20251001',
    'issues:claude-opus-5-5',
    'propose:claude-opus-5-5',
  ]);
  assert.ok(!runner.calls.some((c) => c.prompt.includes('SECRET')));
  // The 자료 tab's reader reads the DB unchanged.
  const file = collector.file(PROJECT);
  const summary = knowledgeSummary(file);
  assert.equal(summary.available, true);
  assert.equal(summary.counts.statements, first.counts.statements);
  assert.equal(factSearch(file, layer, '기둥 간격').items.length, 1);

  // Nothing changed: an update makes no AI call.
  runner.calls.length = 0;
  await collect(collector);
  assert.equal(runner.calls.length, 0);

  // One file changed: only its new text goes to the AI; the unchanged paragraph keeps its row.
  await writeFile(
    join(project, '메모.md'),
    `옥상 조경 하중은 5kN/m2로 한다.${pad}\n\n외장재는 석재로 바꾸기로 결정했다.${pad}`,
  );
  await utimes(join(project, '메모.md'), new Date(), new Date(Date.now() + 5000));
  runner.calls.length = 0;
  const updated = await collect(collector);
  const sent = runner.calls
    .filter((c) => c.role !== 'issues')
    .map((c) => c.prompt)
    .join('\n');
  assert.match(sent, /석재로 바꾸기로/);
  assert.doesNotMatch(sent, /기둥 간격|설비 협의는|내진 설계|옥상 조경/);
  assert.equal(factSearch(file, layer, '석재').items.length, 1);
  assert.equal(factSearch(file, layer, '외장재 변경').items.length, 0);
  assert.equal(updated.counts.read, 5);

  // A removed file: its statements leave search and counts; back again, they return.
  await unlink(join(project, '회의록', '261006 구조 회의록.docx'));
  runner.calls.length = 0;
  const removed = await collect(collector);
  assert.equal(factSearch(file, layer, '기둥 간격').items.length, 0);
  assert.equal(removed.counts.statements, updated.counts.statements - 1);
  assert.ok(!runner.calls.some((c) => c.role === 'extract'));
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(
    db
      .prepare("select count(*) as n from statement where status = 'removed' and support_prob = -1")
      .get().n,
    1,
  );
  const issue = db.prepare('select statements from issue').get();
  assert.equal(issue.statements, removed.counts.statements);
  db.close();
  await writeFile(
    join(project, '회의록', '261006 구조 회의록.docx'),
    doc.docx(['기둥 간격은 9m로 확정한다.']),
  );
  await collect(collector);
  assert.equal(factSearch(file, layer, '기둥 간격').items.length, 1);
  assert.ok(!existsSync(join(data, 'knowledge-work', PROJECT)));
});

test('without a Claude login every stage runs on the Codex Sol model', () => {
  const plan = modelPlan(['codex-cli'], ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol']);
  assert.deepEqual(
    Object.values(plan).map((c) => [c.provider, c.model, c.effort]),
    [
      ['codex-cli', 'gpt-6.1-sol', 'low'],
      ['codex-cli', 'gpt-6.1-sol', 'medium'],
      ['codex-cli', 'gpt-6.1-sol', 'medium'],
      ['codex-cli', 'gpt-6.1-sol', 'medium'],
    ],
  );
  assert.equal(modelPlan([], ['gpt-6.1-sol']), null);
  assert.equal(claudePlan().issues.model, 'claude-opus-5-5');
  assert.equal(claudePlan().issues.effort, 'medium');
});

test('drawings through the hidden-ZWCAD reader: copies are read, then removed', async (t) => {
  const folder = await folderOf(t);
  await writeFile(join(folder.project, '평면도.dwg'), 'synthetic drawing bytes');
  const seen = [];
  const dwgReader = {
    available: async () => true,
    async read(files, work, progress) {
      for (const f of files) {
        assert.ok(f.path.startsWith(work), 'a copy in the data folder, not the original');
        seen.push(f.path);
      }
      progress(files.length);
      return new Map(
        files.map((f) => [
          f.id,
          {
            items: [
              {
                k: 'mtext',
                l: 'Model',
                b: null,
                y: 'A-ANNO',
                h: '1F',
                x: 0,
                v: 10,
                t: '기둥 간격 9000 확인 바람',
              },
              { k: 'text', l: 'Model', b: null, y: 'A-ANNO', h: '20', x: 0, v: 5, t: '짧음' },
            ],
            error: null,
            ms: 5,
          },
        ]),
      );
    },
  };
  const collector = collectorOf(folder, doc.fakeRunner(), { dwgReader });
  const state = await collect(collector);
  assert.equal(seen.length, 1);
  assert.equal(state.counts.read, 1);
  assert.equal(factSearch(collector.file(PROJECT), layer, '기둥 간격').items.length, 1);
  assert.ok(!existsSync(join(folder.data, 'knowledge-work', PROJECT)));
});

test('할 일·일정 proposals: evidence, no duplicates, nothing dismissed or past comes back', async (t) => {
  const folder = await folderOf(t);
  await writeFile(
    join(folder.project, '회의록', '261006 회의록.md'),
    '설비 협의는 10월 15일 오후 2시에 현장 사무실에서 한다.\n\n구조 검토서는 10월 20일까지 제출한다.\n\n지난 협의는 9월 1일에 했다.',
  );
  let round = 0;
  const runner = doc.fakeRunner({
    proposals: (statements) => {
      round++;
      const cite = (word) => statements.filter((s) => s.content.includes(word)).map((s) => s.id);
      return [
        {
          text: '설비 협의',
          kind: 'meeting',
          date: '2026-10-15',
          time: '14:00',
          endTime: '15:00',
          location: '현장 사무실',
          cite: cite('설비'),
        },
        {
          text: '구조 검토서 제출',
          kind: 'receipt',
          date: '2026-10-20',
          cite: cite('구조 검토서'),
        },
        // Past, already on the agenda, without evidence, or malformed: never proposed.
        { text: '지난 협의', kind: 'meeting', date: '2026-09-01', cite: cite('지난') },
        { text: '도면 회신', kind: 'task', date: '2026-10-09', cite: cite('설비') },
        { text: '근거 없음', kind: 'task', date: '2026-10-21', cite: [] },
        { text: '', date: '2026-10-22', cite: cite('설비') },
      ];
    },
  });
  const agenda = [{ text: '도면 회신하기', date: '2026-10-09' }];
  const collector = collectorOf(folder, runner, { agenda });
  const state = await collect(collector);
  assert.equal(round, 1);
  assert.equal(state.counts.proposals, 2);
  const proposals = collector.proposals(PROJECT);
  assert.deepEqual(
    proposals.map((p) => [p.text, p.kind, p.date, p.time, p.endTime, p.location]),
    [
      ['설비 협의', 'meeting', '2026-10-15', '14:00', '15:00', '현장 사무실'],
      ['구조 검토서 제출', 'receipt', '2026-10-20', null, null, null],
    ],
  );
  assert.match(proposals[0].evidence[0].content, /설비 협의는/);
  // One added, one dismissed; a new statement next time does not bring either back.
  collector.decide(PROJECT, [
    { id: proposals[0].id, status: 'added', agendaId: 'a1' },
    { id: proposals[1].id, status: 'dismissed' },
  ]);
  assert.deepEqual(collector.proposals(PROJECT), []);
  await writeFile(join(folder.project, '추가.md'), '설비 협의 장소는 현장 사무실로 정했다.');
  await collect(collector);
  assert.equal(round, 2);
  assert.deepEqual(collector.proposals(PROJECT), []);
});

test('a proposal is a valid future agenda item', () => {
  const today = '2026-10-07';
  assert.equal(proposalOf({ text: 'x', date: '2026-10-06' }, today), undefined);
  assert.equal(proposalOf({ text: 'x', date: '2026-02-30' }, today), undefined);
  assert.deepEqual(
    proposalOf({ text: ' 마감 ', kind: 'deadline', date: today, time: '25:00' }, today),
    {
      text: '마감',
      kind: 'deadline',
      date: today,
      time: null,
      endDate: null,
      endTime: null,
      location: null,
      attendees: null,
    },
  );
  // An end time before the start on the same day is dropped; an unknown kind is a 할 일.
  assert.deepEqual(
    [proposalOf({ text: 'x', kind: '?', date: today, time: '14:00', endTime: '13:00' }, today)].map(
      (p) => [p.kind, p.time, p.endTime],
    ),
    [['task', '14:00', null]],
  );
});

test('a file past its time limit ends its worker; the next file gets a new one', async (t) => {
  const { project } = await folderOf(t);
  const a = join(project, 'a.md'),
    b = join(project, 'b.md');
  await writeFile(a, '첫 번째 파일의 내용입니다.');
  await writeFile(b, '두 번째 파일의 내용입니다.');
  const results = [];
  let calls = 0;
  await extractAll(
    [
      { path: a, ext: 'md', size: 10 },
      { path: b, ext: 'md', size: 10 },
    ],
    (index, result) => (results[index] = result.status),
    { size: 1, limit: () => (calls++ === 0 ? 1 : 30_000) },
  );
  assert.deepEqual(results, ['timeout', 'done']);
});
