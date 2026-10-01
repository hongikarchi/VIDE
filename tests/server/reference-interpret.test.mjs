import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  emptyReferenceBoard,
  referenceOutputSchema,
  regionLetter,
  targetQuestions,
} from '../../src/contracts/reference-board.ts';
import {
  CONFIRM_TEXT_BYTES,
  ReferenceBoards,
  confirmText,
  nextVersion,
} from '../../src/server/reference-boards.ts';
import {
  imageFailureCode,
  imageJobArguments,
  runImageJob,
} from '../../src/server/reference-image.ts';
import {
  referenceTurnSchema,
  takeReferenceBlock,
  turnOutputResult,
} from '../../src/server/turn-output.ts';
import { startServer } from '../../src/server/server.ts';

// The interpretation, its 판s, the image job and [맞음] of a reference board (SPEC-09.4–09.8,
// PLAN-26 T-090 (b)–(d)). No real CLI: a mocked provider and a fake codex.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const region = (letter, element, extra = {}) => ({
  letter,
  element,
  anchor: { x: 0.4, y: 0.3 },
  values: [{ name: '간격', value: '약 600', unit: 'mm', source: 'estimated' }],
  line: `${letter}: ${element} · 간격 약 600`,
  openQuestions: ['재료'],
  target: '남측 파사드',
  ...extra,
});
const output = (regions) => ({
  summary: '남측 파사드에 수직 루버',
  imagePrompt: 'Vertical louvers on the south facade.',
  regions,
});
const drawn = (count) =>
  Array.from({ length: count }, (_, i) => ({
    letter: regionLetter(i),
    note: i === 0 ? '간격과 깊이만' : '',
    shapes: [{ kind: 'rect', x: 0.1 + i * 0.4, y: 0.2, w: 0.3, h: 0.3 }],
  }));

test('the interpretation is checked strictly and the CLI schema asks for it', () => {
  assert.ok(referenceOutputSchema.safeParse(output([region('A', '수직 루버')])).success);
  for (const bad of [
    output([{ ...region('A', '루버'), extra: 1 }]),
    output([
      { ...region('A', '루버'), values: [{ name: 'x', value: '1', unit: null, source: 'guess' }] },
    ]),
    output([region('A', '루버'), region('A', '차양')]),
    { ...output([region('A', '루버')]), summary: '' },
    output([{ ...region('A', '루버'), anchor: { x: 2, y: 0 } }]),
  ])
    assert.equal(referenceOutputSchema.safeParse(bad).success, false);
  const required = referenceTurnSchema('required');
  assert.ok(required.required.includes('reference'));
  assert.equal(required.properties.reference.additionalProperties, false);
  assert.ok(referenceTurnSchema('optional').properties.reference.anyOf);
  const turn = { structured: true, reference: 'required' };
  const good = turnOutputResult(turn, {
    text: JSON.stringify({
      status: 'done',
      text: '이렇게 이해했습니다',
      questions: [],
      reference: output([region('A', '루버')]),
    }),
  });
  assert.equal(good.text, '이렇게 이해했습니다');
  assert.equal(good.reference.regions[0].element, '루버');
  const missing = turnOutputResult(turn, {
    text: JSON.stringify({ status: 'done', text: '말만', questions: [] }),
  });
  assert.equal(missing.referenceError, 'REFERENCE_OUTPUT_MISSING');
  assert.equal(missing.text, '말만', 'the spoken answer stays');
  const wrong = turnOutputResult(turn, {
    text: JSON.stringify({
      status: 'done',
      text: '틀림',
      questions: [],
      reference: { summary: 1 },
    }),
  });
  assert.equal(wrong.referenceError, 'REFERENCE_OUTPUT_INVALID');
  // A chat turn may say nothing about the board.
  const chat = turnOutputResult(
    { structured: true, reference: 'optional' },
    { text: JSON.stringify({ status: 'done', text: '네', questions: [], reference: null }) },
  );
  assert.equal(chat.reference, undefined);
  assert.equal(chat.referenceError, undefined);
});

test('판s: the whole board needs every drawn letter; a region turn changes only its region', () => {
  const board = { ...emptyReferenceBoard('a'.repeat(24)), regions: drawn(2) };
  const turn = (action, regions, extra = {}) => ({
    action,
    output: output(regions),
    requestId: 'r-' + action,
    conversationId: 'c1',
    now: '2026-10-01T00:00:00.000Z',
    ...extra,
  });
  assert.deepEqual(nextVersion(board, turn('interpret', [region('A', '루버')])), {
    problem: 'REGION_MISMATCH',
  });
  assert.deepEqual(
    nextVersion(board, turn('interpret', [region('A', '루버'), region('C', '차양')])),
    { problem: 'REGION_MISMATCH' },
    'a letter the user did not draw',
  );
  const first = nextVersion(board, turn('interpret', [region('B', '차양'), region('A', '루버')]));
  assert.equal(first.version.number, 1);
  assert.deepEqual(
    first.version.regions.map((r) => r.letter),
    ['A', 'B'],
    'in drawing order',
  );
  const one = { ...board, versions: [first.version] };
  const corrected = nextVersion(
    one,
    turn(
      'region',
      [
        region('B', '얇은 차양', {
          values: [{ name: '길이', value: '4', unit: 'm', source: 'user' }],
        }),
        region('A', '바뀌면 안 됨'),
      ],
      { letter: 'B' },
    ),
  );
  assert.equal(corrected.version.number, 2);
  assert.deepEqual(corrected.version.changed, ['B']);
  assert.deepEqual(corrected.version.regions[0], first.version.regions[0], 'A stays as it was');
  assert.equal(corrected.version.regions[1].element, '얇은 차양');
  assert.equal(corrected.version.regions[1].values[0].source, 'user');
  assert.deepEqual(nextVersion(one, turn('region', [region('A', '루버')], { letter: 'B' })), {
    problem: 'REGION_MISMATCH',
  });
  // A chat correction names its regions; an unknown letter changes nothing.
  const spoken = nextVersion(one, turn('spoken', [region('B', '차양 아님 · 캐노피')]));
  assert.deepEqual(spoken.version.changed, ['B']);
  assert.equal(spoken.version.kind, 'spoken');
  assert.equal(nextVersion(one, turn('spoken', [region('Z', '?')])), undefined);
  // A confirmed 판 is frozen.
  const frozen = {
    ...board,
    versions: [{ ...first.version, confirmed: { at: 'x', requestId: 'y' } }],
  };
  assert.deepEqual(nextVersion(frozen, turn('region', [region('B', 'x')], { letter: 'B' })), {
    problem: 'NO_BASE',
  });
  // [맞음]'s text and the unknown target question.
  const text = confirmText(first.version, 'facade.png');
  assert.match(text, /^맞음 → 모델링 반영 · 판 1 · 참고 이미지 facade\.png/);
  assert.match(text, /A 루버 → 남측 파사드: 간격 약 600 mm\(추정\)/);
  const questions = targetQuestions({
    regions: [region('A', '루버', { target: 'unknown' }), region('B', '차양')],
  });
  assert.deepEqual(
    questions.map((q) => q.letter),
    ['A'],
  );
  assert.equal(questions[0].options.filter((o) => o.recommended).length, 1);
});

test("a host turn's correction comes as a block the engine takes out of the reply", () => {
  const block = (value) => '```json\n' + JSON.stringify({ reference: value }) + '\n```';
  assert.equal(takeReferenceBlock('그냥 답입니다'), undefined);
  assert.equal(takeReferenceBlock('```json\n{"plan":{}}\n```'), undefined, 'other blocks stay');
  const taken = takeReferenceBlock(
    `B를 캐노피로 고쳤습니다.\n\n${block(output([region('B', '캐노피')]))}`,
  );
  assert.equal(taken.text, 'B를 캐노피로 고쳤습니다.');
  assert.equal(taken.reference.regions[0].element, '캐노피');
  assert.deepEqual(takeReferenceBlock(`네.\n${block(null)}`), { text: '네.' });
  const wrong = takeReferenceBlock(`네.\n${block({ summary: 1 })}`);
  assert.equal(wrong.referenceError, 'REFERENCE_OUTPUT_INVALID');
  assert.equal(wrong.text, '네.');
});

test('the [맞음] text stays small with any number of regions (the 판 data carries them all)', () => {
  const many = Array.from({ length: 200 }, (_, i) =>
    region(regionLetter(i), '아주 긴 이름의 수직 루버 요소'.repeat(3), {
      target: '남측 파사드 2층부터 5층까지의 창호 바깥면'.repeat(3),
      values: Array.from({ length: 12 }, (_, k) => ({
        name: `값${k}`,
        value: '약 600'.repeat(10),
        unit: 'mm',
        source: 'estimated',
      })),
    }),
  );
  const version = {
    number: 3,
    summary: '요약',
    regions: many,
  };
  const text = confirmText(version, 'facade.png');
  assert.ok(Buffer.byteLength(text) <= CONFIRM_TEXT_BYTES, `${Buffer.byteLength(text)} bytes`);
  assert.ok(text.length <= 20000);
  assert.match(text, /… 영역 \d+개 더/);
  assert.match(confirmText({ ...version, regions: many.slice(0, 2) }, 'f.png'), /^B /m);
});

const fake = fileURLToPath(new URL('../fixtures/fake-codex-image.mjs', import.meta.url));

test('the image job: arguments, a picture copied out, failures named, timeout and cancel kill it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-image-job-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const generated = join(directory, 'generated');
  const work = join(directory, 'work');
  await mkdir(work);
  process.env.FAKE_CODEX_GENERATED = generated;
  const args = imageJobArguments(['a.png', 'b.png']);
  assert.ok(args.includes('--ephemeral') && args.includes('--ignore-user-config'));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(!args.some((v, i) => v === 'image_generation' && args[i - 1] === '--disable'));
  assert.ok(args.some((v, i) => v === 'shell_tool' && args[i - 1] === '--disable'));
  assert.deepEqual(args.slice(-5), ['--image', 'a.png', '--image', 'b.png', '-']);
  assert.equal(imageFailureCode('Not logged in'), 'CODEX_LOGIN_REQUIRED');
  assert.equal(imageFailureCode("You've hit your usage limit"), 'CODEX_USAGE_LIMIT');
  assert.equal(imageFailureCode('rejected by the safety system'), 'IMAGE_REFUSED');
  const run = (mode, extra = {}) => {
    process.env.FAKE_CODEX_IMAGE_MODE = mode;
    return runImageJob(
      { prompt: 'p', images: [], outFile: join(directory, `${mode}.png`), ...extra },
      {
        executable: process.execPath,
        prefixArgs: [fake],
        generatedRoot: generated,
        workRoot: work,
        timeoutMs: 1500,
        ...extra.options,
      },
    );
  };
  const ok = await run('ok');
  assert.equal(ok.ok, true);
  assert.equal(ok.size, PNG.length);
  assert.ok(existsSync(join(directory, 'ok.png')));
  assert.deepEqual(await readdir(generated), [], "Codex's own copy is removed");
  assert.equal((await run('login')).code, 'CODEX_LOGIN_REQUIRED');
  assert.equal((await run('limit')).code, 'CODEX_USAGE_LIMIT');
  assert.equal((await run('refused')).code, 'IMAGE_REFUSED');
  assert.equal((await run('nofile')).code, 'IMAGE_NOT_CREATED');
  const started = Date.now();
  const late = await run('hang');
  assert.equal(late.code, 'IMAGE_TIMEOUT');
  assert.ok(Date.now() - started < 6000, 'killed at the limit');
  assert.equal(existsSync(join(directory, 'hang.png')), false, 'the partial picture is ignored');
  // The process is ended and awaited first: its work folder and its picture folder both go.
  assert.deepEqual(await readdir(work), [], 'no work folder is left after the limit');
  assert.deepEqual(await readdir(generated), [], 'nothing of the stopped run stays in Codex');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const stopped = await run('hang', { signal: controller.signal, options: { timeoutMs: 20000 } });
  assert.equal(stopped.code, 'IMAGE_CANCELLED');
  assert.deepEqual(await readdir(work), [], 'no work folder is left after a cancel');
  assert.deepEqual(await readdir(generated), []);
  const missing = await runImageJob(
    { prompt: 'p', images: [], outFile: join(directory, 'x.png') },
    { executable: join(directory, 'no-codex.exe') },
  );
  assert.equal(missing.code, 'CODEX_UNAVAILABLE');
});

test('over HTTP: 이해 확인 → 판 1 and its image, B corrected → 판 2, [맞음] runs in 자동', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-reference-turns-'));
  const contexts = [];
  const answers = [];
  const jobs = [];
  const app = await startServer({
    filename: join(directory, 'store.sqlite'),
    providerFactory: () => ({
      status: async () => ({ available: true }),
      run: async (context) => {
        contexts.push(context);
        const next = answers.shift() ?? {
          status: 'done',
          text: '네',
          questions: [],
          reference: null,
        };
        // A plain string is a reply as written (a host turn has no structured output).
        return { text: typeof next === 'string' ? next : JSON.stringify(next) };
      },
    }),
    referenceOptions: {
      runImage: async (job) => {
        jobs.push(job);
        await writeFile(job.outFile, PNG);
        return { ok: true, elapsedMs: 1234, size: PNG.length };
      },
    },
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const login = await fetch(app.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (path, method = 'GET', body, type = 'application/json') => {
    const response = await fetch(app.origin + '/api/v1' + path, {
      method,
      headers: { Origin: app.origin, Cookie: cookie, ...(body ? { 'Content-Type': type } : {}) },
      body: typeof body === 'object' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body,
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  const project = (await call('/projects', 'POST', { name: 'p' })).data;
  const image = (
    await call(
      `/projects/${project.id}/attachments?name=facade.png`,
      'POST',
      PNG,
      'application/octet-stream',
    )
  ).data;
  const path = `/projects/${project.id}/reference-boards/${image.id}`;
  await call(path, 'PUT', {
    regions: drawn(2),
    nextIndex: 2,
    stage: 'check',
    width: 800,
    height: 560,
  });
  await call(path + '/masked', 'POST', PNG, 'application/octet-stream');
  await call(path + '/view', 'POST', PNG, 'application/octet-stream');
  const board = async () => (await call(path)).data;
  const until = async (check) => {
    for (let i = 0; i < 200; i++) {
      const value = await board();
      if (check(value)) return value;
      await new Promise((done) => setTimeout(done, 25));
    }
    throw Error('board did not settle: ' + JSON.stringify(await board()));
  };
  const send = (reference, extra = {}) =>
    call(`/projects/${project.id}/requests`, 'POST', {
      id: crypto.randomUUID(),
      body: '',
      provider: 'claude-cli',
      model: 'claude-opus-5-5',
      permission: 'review',
      pins: [],
      sketches: [],
      files: [{ id: image.id, name: 'facade.png' }],
      images: [
        {
          kind: 'reference',
          name: '영역',
          dataUrl: 'data:image/png;base64,' + PNG.toString('base64'),
        },
      ],
      conversationId: 'default',
      reference: { attachmentId: image.id, ...reference },
      ...extra,
    });

  // 이해 확인: a structured turn without the host, the board's regions in its packet.
  answers.push({
    status: 'done',
    text: 'A는 수직 루버, B는 입구 차양으로 이해했습니다.',
    questions: [],
    reference: output([region('A', '수직 루버'), region('B', '입구 차양', { target: 'unknown' })]),
  });
  const first = await send({ action: 'interpret', view: true });
  assert.equal(first.status, 202, JSON.stringify(first.data));
  assert.equal(first.data.input.hostUse, 'none');
  assert.equal(first.data.input.mode, 'plan');
  assert.match(first.data.input.body, /^이해 확인 · 참고 이미지 facade\.png · 영역 A, B/);
  const one = await until(
    (value) => value.versions.length === 1 && value.versions[0].image.state === 'ready',
  );
  const item = contexts[0].items.find((entry) => entry.type === 'reference-board');
  assert.deepEqual(
    item.data.regions.map((r) => [r.letter, r.note]),
    [
      ['A', '간격과 깊이만'],
      ['B', ''],
    ],
  );
  assert.equal(item.data.regions[0].box.length, 4);
  const schema = contexts[0].items.find((entry) => entry.type === 'turn-output').data.schema;
  assert.ok(schema.required.includes('reference'));
  assert.ok(contexts[0].items.some((entry) => entry.type === 'image'));
  assert.equal(one.pending, null);
  assert.equal(one.versions[0].number, 1);
  assert.equal(one.versions[0].image.elapsedMs, 1234);
  assert.equal(jobs.length, 1);
  assert.match(jobs[0].prompt, /Region A: A: 수직 루버/);
  assert.equal(jobs[0].images.length, 2, 'view capture + regions drawn over the reference');
  const generated = await fetch(app.origin + `/api/v1${path}/images/1`, {
    headers: { Origin: app.origin, Cookie: cookie },
  });
  assert.equal(generated.headers.get('content-type'), 'image/png');
  assert.ok(existsSync(join(directory, 'outputs', project.id, 'reference', image.id, 'v1.png')));

  // B only: the next 판, same conversation; A is kept even when the AI sends it changed.
  answers.push({
    status: 'done',
    text: 'B를 얇은 캐노피로 고쳤습니다.',
    questions: [],
    reference: output([region('B', '얇은 캐노피', { target: 'unknown' })]),
  });
  const second = await send({
    action: 'region',
    letter: 'B',
    note: '차양이 아니라 캐노피',
    view: true,
  });
  assert.equal(second.status, 202, JSON.stringify(second.data));
  assert.equal(second.data.input.conversationId, first.data.input.conversationId);
  const two = await until(
    (value) => value.versions.length === 2 && value.versions[1].image.state === 'ready',
  );
  assert.deepEqual(two.versions[1].changed, ['B']);
  assert.equal(two.versions[1].regions[0].element, '수직 루버');
  assert.equal(two.versions[1].regions[1].element, '얇은 캐노피');
  const regionItem = contexts[1].items.find((entry) => entry.type === 'reference-board');
  assert.equal(regionItem.data.letter, 'B');
  assert.equal(regionItem.data.current.number, 1);

  // A shape the board cannot use: the answer stays, the board says why.
  answers.push({ status: 'done', text: '말로만 답합니다', questions: [] });
  await send({ action: 'region', letter: 'A', note: '깊이 300', view: true });
  const problem = await until((value) => value.problem);
  assert.equal(problem.problem.code, 'REFERENCE_OUTPUT_MISSING');
  assert.deepEqual(
    [problem.problem.action, problem.problem.letter, problem.problem.note],
    ['region', 'A', '깊이 300'],
    'the board can send that region again',
  );
  assert.equal(problem.versions.length, 2);

  // [맞음] with B's target unknown: asked first, then sent in 자동 with the answer.
  const refused = await send({ action: 'confirm', version: 2 });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, 'REFERENCE_TARGET_UNKNOWN');
  const stale = await send({ action: 'confirm', version: 1, targets: { B: '새 레이어' } });
  assert.equal(stale.status, 409);
  // A request the workspace refuses (here: too large) leaves the 판 unconfirmed.
  const huge = await send(
    { action: 'confirm', version: 2, targets: { B: '새 레이어에 따로 만들기' } },
    {
      images: [
        {
          kind: 'reference',
          name: '큼',
          dataUrl: 'data:image/png;base64,' + Buffer.alloc(160_000).toString('base64'),
        },
      ],
    },
  );
  assert.equal(huge.status, 413, JSON.stringify(huge.data));
  assert.equal((await board()).versions[1].confirmed, null);
  const confirmed = await send(
    { action: 'confirm', version: 2, targets: { B: '새 레이어에 따로 만들기' } },
    { permission: 'review', mode: 'plan', images: undefined },
  );
  assert.equal(confirmed.status, 202, JSON.stringify(confirmed.data));
  assert.equal(confirmed.data.input.mode, 'auto', '계획 모드여도 [맞음]은 자동');
  assert.notEqual(confirmed.data.input.hostUse, 'none');
  assert.match(confirmed.data.input.body, /판 2/);
  assert.match(confirmed.data.input.body, /B 얇은 캐노피 → 새 레이어에 따로 만들기/);
  const frozen = await board();
  assert.equal(frozen.versions[1].confirmed.requestId, confirmed.data.id);
  // A second [맞음] (another window) runs nothing.
  const twice = await send({ action: 'confirm', version: 2, targets: { B: '새 레이어' } });
  assert.equal(twice.status, 409);
  assert.equal(twice.data.code, 'REFERENCE_FROZEN');
  assert.equal((await board()).versions[1].confirmed.requestId, confirmed.data.id);
  // The modeling turn gets the confirmed 판 with the regions it reads (SPEC-09.8 3).
  for (let i = 0; i < 200 && !contexts.some((c) => c.goal?.includes?.('맞음')); i++)
    await new Promise((done) => setTimeout(done, 25));
  const confirmItem = contexts
    .flatMap((c) => c.items)
    .find((entry) => entry.type === 'reference-board' && entry.data.number === 2);
  assert.ok(confirmItem, 'the [맞음] turn ran with the board item');
  assert.deepEqual(
    confirmItem.data.drawn.map((r) => [r.letter, r.box.length]),
    [
      ['A', 4],
      ['B', 4],
    ],
  );
  // A frozen 판 is not corrected; [새 판으로 고치기] carries it on.
  const again = await send({ action: 'region', letter: 'A', note: 'x', view: true });
  assert.equal(again.data.code, 'REFERENCE_FROZEN');
  const carried = (await call(path + '/continue', 'POST', {})).data;
  assert.equal(carried.versions.at(-1).number, 3);
  assert.equal(carried.versions.at(-1).confirmed, null);
  assert.equal(carried.versions.at(-1).image.state, 'ready');

  // A chat turn in the bound conversation that names region A makes the next 판.
  answers.push({
    status: 'done',
    text: 'A의 간격을 450으로 고쳤습니다.',
    questions: [],
    reference: output([
      region('A', '수직 루버', {
        values: [{ name: '간격', value: '450', unit: 'mm', source: 'user' }],
      }),
    ]),
  });
  const chat = await call(`/projects/${project.id}/requests`, 'POST', {
    id: crypto.randomUUID(),
    body: 'A 간격은 450이야',
    provider: 'claude-cli',
    model: 'claude-opus-5-5',
    permission: 'review',
    hostUse: 'none',
    pins: [],
    sketches: [],
    files: [],
    conversationId: first.data.input.conversationId,
    // Only the server says where a request came from.
    remote: true,
  });
  assert.equal(chat.status, 202, JSON.stringify(chat.data));
  assert.equal(chat.data.input.remote, undefined);
  const spoken = await until(
    (value) => value.versions.length === 4 && value.versions[3].image.state === 'ready',
  );
  assert.equal(spoken.versions[3].kind, 'spoken');
  assert.equal(spoken.versions[3].regions[0].values[0].value, '450');
  assert.equal(
    contexts.at(-1).items.find((entry) => entry.type === 'reference-board').data.current.number,
    3,
  );

  // The composer's own turn (plan mode, host read: no structured output) corrects it too: the
  // block at the end of the reply becomes the next 판 and leaves the text the user reads.
  // (The test engine's host takes the old proposal shape: the reply is its `message`.)
  answers.push(
    JSON.stringify({
      message:
        'B는 캐노피가 아니라 차양으로 고쳤습니다.\n\n```json\n' +
        JSON.stringify({ reference: output([region('B', '차양', { target: '정면 출입구 위' })]) }) +
        '\n```',
      operations: [],
    }),
  );
  const composed = await call(`/projects/${project.id}/requests`, 'POST', {
    id: crypto.randomUUID(),
    body: 'B는 차양이야',
    provider: 'claude-cli',
    model: 'claude-opus-5-5',
    mode: 'plan',
    pins: [],
    sketches: [],
    files: [],
    conversationId: first.data.input.conversationId,
  });
  assert.equal(composed.status, 202, JSON.stringify(composed.data));
  const fifth = await until((value) => value.versions.length === 5);
  assert.equal(fifth.versions[4].kind, 'spoken');
  assert.equal(fifth.versions[4].regions[1].element, '차양');
  assert.match(
    contexts.at(-1).items.find((entry) => entry.type === 'reference-board').data.rules,
    /fenced json block/,
  );
  const composedRow = (await call(`/projects/${project.id}/requests/${composed.data.id}`)).data;
  assert.doesNotMatch(composedRow.result.text, /```/, 'the block leaves the reply');
  assert.match(composedRow.result.text, /차양으로 고쳤습니다/);

  // The project setting turns the image job off; from then on a 판 says so.
  assert.equal(
    (await call(`/projects/${project.id}/reference-settings`, 'PUT', { images: false })).status,
    200,
  );
  assert.deepEqual((await call(`/projects/${project.id}/reference-settings`)).data, {
    images: false,
  });
  const jobsBefore = jobs.length;
  answers.push({
    status: 'done',
    text: 'A를 다시 읽었습니다.',
    questions: [],
    reference: output([region('A', '수직 루버 · 깊이 300')]),
  });
  await send({ action: 'region', letter: 'A', note: '깊이 300', view: true });
  const off = await until((value) => value.versions.length === 6);
  assert.equal(off.versions[5].image.state, 'off');
  assert.equal(jobs.length, jobsBefore, 'no image job while it is off');
});

// The board class alone (no server): when a reference turn is written down, which board a chat
// correction goes to, where it came from, and how image jobs end (T-090 review fixes).
const P = 'b'.repeat(24);
const Q = 'c'.repeat(24);
const versionOf = (number, extra = {}) => ({
  number,
  conversationId: 'c1',
  requestId: `r${number}`,
  createdAt: '2026-10-01T00:00:00.000Z',
  kind: 'all',
  changed: ['A', 'B'],
  summary: '남측 파사드에 수직 루버',
  imagePrompt: 'Vertical louvers.',
  regions: [region('A', '수직 루버'), region('B', '입구 차양')],
  confirmed: null,
  image: { state: 'ready', elapsedMs: 1000, size: PNG.length },
  ...extra,
});
async function boardsFixture(t, runImage) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-reference-class-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const jobs = [];
  const boards = new ReferenceBoards(join(directory, 'reference-boards'), {
    outputs: join(directory, 'outputs'),
    runImage:
      runImage ??
      (async (job) => {
        jobs.push(job);
        await writeFile(job.outFile, PNG);
        return { ok: true, elapsedMs: 5, size: PNG.length };
      }),
  });
  const requests = new Map();
  boards.lookup = (_project, id) => requests.get(id);
  // A board as stored: regions drawn, the masked image, a view capture and its 판s.
  const put = async (attachmentId, extra = {}) => {
    await mkdir(join(directory, 'reference-boards', 'p1'), { recursive: true });
    await writeFile(
      join(directory, 'reference-boards', 'p1', `${attachmentId}.json`),
      JSON.stringify({
        ...emptyReferenceBoard(attachmentId),
        regions: drawn(2),
        nextIndex: 2,
        stage: 'check',
        masked: { savedAt: 'x', size: PNG.length },
        conversationId: 'c1',
        versions: [versionOf(1)],
        updatedAt: '2026-10-01T00:00:00.000Z',
        ...extra,
      }),
    );
    await writeFile(join(directory, 'reference-boards', 'p1', `${attachmentId}.masked.png`), PNG);
    await mkdir(boards.outputFolder('p1', attachmentId), { recursive: true });
    await writeFile(join(boards.outputFolder('p1', attachmentId), 'view.png'), PNG);
    await writeFile(join(boards.outputFolder('p1', attachmentId), 'v1.png'), PNG);
  };
  return { directory, boards, requests, jobs, put };
}
const chatRow = (attachmentId, extra = {}) => ({
  id: 'chat-1',
  projectId: 'p1',
  state: 'succeeded',
  input: { conversationId: 'c1', body: 'B는 캐노피야', ...extra.input },
  result: {
    text: '고쳤습니다',
    reference: output([region('B', '캐노피')]),
    referenceBoard: attachmentId,
    ...extra.result,
  },
});

test('a reference request is written on its board only once the request is stored', async (t) => {
  const { boards, requests, put } = await boardsFixture(t);
  await put(P);
  const input = (reference) => ({
    id: crypto.randomUUID(),
    conversationId: 'c1',
    reference: { attachmentId: P, ...reference },
  });
  // The workspace refuses it (too large, a stale basis…): the 판 is not confirmed.
  const refused = input({ action: 'confirm', version: 1 });
  await assert.rejects(
    boards.prepare('p1', refused, { name: 'f.png' }, () => {
      throw Object.assign(Error('INPUT_TOO_LARGE'), { code: 'INPUT_TOO_LARGE' });
    }),
    /INPUT_TOO_LARGE/,
  );
  assert.equal(boards.get('p1', P).versions[0].confirmed, null);
  // Nor is a region turn left 답하는 중.
  await assert.rejects(
    boards.prepare(
      'p1',
      input({ action: 'region', letter: 'B', note: '캐노피' }),
      { name: 'f.png' },
      () => {
        throw Error('INVALID_INPUT');
      },
    ),
  );
  assert.equal(boards.get('p1', P).pending, null);
  // Stored: the 판 is confirmed by that request, and once only.
  const first = input({ action: 'confirm', version: 1 });
  await boards.prepare('p1', first, { name: 'f.png' }, () => ({ created: true }));
  assert.equal(boards.get('p1', P).versions[0].confirmed.requestId, first.id);
  assert.equal(first.mode, 'auto');
  await assert.rejects(
    boards.prepare('p1', input({ action: 'confirm', version: 1 }), { name: 'f.png' }, () => ({
      created: true,
    })),
    /REFERENCE_FROZEN/,
    'a second [맞음] on the same 판 runs nothing',
  );
  assert.equal(boards.get('p1', P).versions[0].confirmed.requestId, first.id);

  // While a check answers, its regions stay as they were sent.
  await put(Q);
  const check = input({ action: 'region', letter: 'A', note: '깊이 300' });
  check.reference.attachmentId = Q;
  await boards.prepare('p1', check, { name: 'f.png' }, () => ({ created: true }));
  requests.set(check.id, { state: 'running' });
  assert.equal(boards.get('p1', Q).pending.note, '깊이 300');
  const same = boards.get('p1', Q);
  await boards.save('p1', Q, {
    regions: same.regions,
    nextIndex: same.nextIndex,
    stage: 'mask',
  });
  await assert.rejects(
    boards.save('p1', Q, { regions: drawn(3), nextIndex: 3, stage: 'mask' }),
    /REFERENCE_BUSY/,
  );
  await assert.rejects(boards.saveMasked('p1', Q, [PNG]), /REFERENCE_BUSY/);
  requests.set(check.id, { state: 'cancelled', result: { code: 'CANCELLED' } });
  await boards.settle('p1', Q);
  const stopped = boards.get('p1', Q);
  assert.deepEqual(
    [stopped.problem.code, stopped.problem.action, stopped.problem.letter, stopped.problem.note],
    ['TURN_CANCELLED', 'region', 'A', '깊이 300'],
    'the board knows which region to send again',
  );
  await boards.save('p1', Q, { regions: drawn(3), nextIndex: 3, stage: 'mask' });
});

test('a chat correction goes to the board the turn was shown; a remote one starts no image', async (t) => {
  const { boards, jobs, put } = await boardsFixture(t);
  await put(P, { updatedAt: '2026-10-01T00:00:01.000Z' });
  await put(Q, { updatedAt: '2026-10-01T00:00:00.000Z' });
  const turn = boards.turnItem({
    id: 'chat-1',
    projectId: 'p1',
    input: { conversationId: 'c1', body: 'B는 캐노피야', mode: 'plan', provider: 'claude-cli' },
  });
  // P is newer when the turn starts: it is the one shown, and a host turn answers in a block.
  assert.equal(turn.attachmentId, P);
  assert.equal(turn.output, 'optional');
  assert.match(turn.item.data.rules, /fenced json block/);
  const hostless = boards.turnItem({
    id: 'chat-0',
    projectId: 'p1',
    input: { conversationId: 'c1', body: '네', hostUse: 'none', provider: 'claude-cli' },
  });
  assert.doesNotMatch(hostless.item.data.rules, /fenced json block/);
  // Q changes while the turn runs (now the newest); the correction still goes to P.
  await boards.save('p1', Q, { regions: drawn(2), nextIndex: 2, stage: 'check' });
  await boards.afterTurn(chatRow(P, { input: { remote: true } }));
  const corrected = boards.get('p1', P);
  assert.equal(corrected.versions.length, 2);
  assert.equal(corrected.versions[1].kind, 'spoken');
  assert.equal(corrected.versions[1].image.state, 'remote', 'no image job from a remote turn');
  assert.equal(jobs.length, 0);
  assert.equal(boards.get('p1', Q).versions.length, 1, 'the other board stays');
  // From this PC the same correction starts the job.
  await boards.afterTurn({ ...chatRow(P), id: 'chat-2' });
  assert.equal(boards.get('p1', P).versions[2].image.state, 'running');
  await boards.imageJob('p1', P);
  assert.equal(boards.get('p1', P).versions[2].image.state, 'ready');
  // A row naming a board of another conversation changes nothing.
  await boards.afterTurn({ ...chatRow(Q), input: { conversationId: 'c2' } });
  assert.equal(boards.get('p1', Q).versions.length, 1);
});

test('image jobs: turning images off, carrying a 판 on, and the engine closing', async (t) => {
  let release;
  const started = [];
  const { boards, put, directory } = await boardsFixture(t, (job) => {
    started.push(job);
    return new Promise((done) => {
      release = async () => {
        await writeFile(job.outFile, PNG);
        done({ ok: true, elapsedMs: 7, size: PNG.length });
      };
      job.signal.addEventListener('abort', () =>
        done({ ok: false, code: 'IMAGE_CANCELLED', elapsedMs: 3 }),
      );
    });
  });
  // Turned off while a job runs: the job stops and its 판 says '이미지 생성 꺼짐'.
  await put(P, { versions: [versionOf(1, { image: { state: 'off' } })] });
  await boards.retryImage('p1', P, 1);
  assert.equal(boards.get('p1', P).versions[0].image.state, 'running');
  await boards.saveSettings('p1', { images: false });
  await boards.imageJob('p1', P);
  await boards.idle();
  assert.equal(boards.get('p1', P).versions[0].image.state, 'off');
  await boards.saveSettings('p1', { images: true });

  // A confirmed 판 without a picture is carried on as it was, never as '취소됨'.
  await put(Q, {
    versions: [versionOf(1, { image: { state: 'off' }, confirmed: { at: 'x', requestId: 'r' } })],
  });
  const carried = await boards.continueBoard('p1', Q);
  assert.equal(carried.versions[1].image.state, 'off');
  // A running job fills the confirmed 판 and the one carried on from it.
  await boards.retryImage('p1', Q, 2);
  const confirmed = boards.get('p1', Q);
  await writeFile(
    join(directory, 'reference-boards', 'p1', `${Q}.json`),
    JSON.stringify({
      ...confirmed,
      versions: confirmed.versions.map((v) =>
        v.number === 2 ? { ...v, confirmed: { at: 'x', requestId: 'r2' } } : v,
      ),
    }),
  );
  const third = await boards.continueBoard('p1', Q);
  assert.equal(third.versions[2].image.state, 'running');
  await release();
  await boards.imageJob('p1', Q);
  await boards.idle();
  const filled = boards.get('p1', Q);
  assert.deepEqual(
    filled.versions.map((v) => v.image.state),
    ['off', 'ready', 'ready'],
  );
  assert.deepEqual(await boards.generated('p1', Q, 3), PNG);

  // The engine closes: the running job ends and no new one starts.
  await boards.retryImage('p1', Q, 3);
  const before = started.length;
  await boards.close();
  await boards.idle();
  assert.equal(boards.get('p1', Q).versions[2].image.state, 'failed');
  assert.equal(boards.get('p1', Q).versions[2].image.code, 'IMAGE_INTERRUPTED');
  await boards.afterTurn({ ...chatRow(P), id: 'late' });
  const late = boards.get('p1', P).versions.at(-1);
  assert.equal(late.image.code, 'IMAGE_INTERRUPTED', 'a turn ending while closing starts nothing');
  assert.equal(started.length, before);
});
