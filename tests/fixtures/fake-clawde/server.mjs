// Fake cLAWde server (PLAN-46 T-216): the ARCH-01 「cLAWde 연결 계약」 endpoints with scripted
// answers, so the VIDE side (T-217~T-224) is built and tested before the real service exists.
// All legal text here is fixture text marked [시험 문구]. Use `startFakeClawde()` in tests, or run
// `node tests/fixtures/fake-clawde/server.mjs [--port N] [--token T]` for browser tests; it prints
// `{"url": …}` on one line. Out of process, `POST /__control` (same Bearer token) applies the same
// patch as `control()`.
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import {
  clawdeAskRequestSchema,
  clawdeChecklistRequestSchema,
  clawdeContributionRequestSchema,
} from '../../../src/contracts/clawde.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

export const FAKE_CLAWDE_TOKEN = 'fake-clawde-token';
export const FAKE_LAW_DB_DATE = '2026-09-01';
export const ARTICLES = readJson(join(here, 'articles.json')).articles;
export const CHECKLIST = readJson(join(here, 'checklist.json')).items;
export const CASES = readdirSync(join(here, 'cases'))
  .filter((name) => name.endsWith('.json'))
  .map((name) => ({ file: name, ...readJson(join(here, 'cases', name)) }))
  .sort((a, b) => a.order - b.order);

export const STAGES = [
  { id: 'feasibility', label: '규모검토' },
  { id: 'schematic', label: '계획설계' },
  { id: 'design', label: '기본설계' },
  { id: 'construction', label: '실시설계' },
];
export const PROFILE_KEYS = [
  { key: 'site.area', label: '대지 면적', unit: '㎡' },
  { key: 'site.zoning', label: '용도지역' },
  { key: 'plan.mainUse', label: '주용도' },
  { key: 'plan.gfa', label: '연면적', unit: '㎡' },
  { key: 'plan.floorsAbove', label: '지상 층수' },
  { key: 'plan.height', label: '높이', unit: 'm' },
];
/** Contribution bases the service never takes (SPEC-13.10: assumed, AI or service guesses). */
const UNACCEPTED_BASES = new Set(['assumed', 'ai', 'service']);

const FIGURE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><path d="M10 50 L10 20 L40 5" fill="none" stroke="black"/><text x="45" y="55" font-size="6">fixture</text></svg>';

/** The case `/v1/ask` answers with: every keyword in the question, `unlessProfile` absent. */
export function pickCase(question, profile = {}) {
  const hit = CASES.find(
    (c) =>
      !c.fallback &&
      c.match.every((word) => question.includes(word)) &&
      !(c.unlessProfile && c.unlessProfile in profile),
  );
  return hit ?? CASES.find((c) => c.fallback);
}

/** A case's served answer: citations given as refs expand from articles.json. */
export function buildAnswer(caseDef, { base, lawDbDate = FAKE_LAW_DB_DATE } = {}) {
  const answer = structuredClone(caseDef.answer);
  answer.citations = answer.citations.map((entry) => {
    if (typeof entry !== 'string') return entry;
    const article = ARTICLES.find((a) => a.ref === entry);
    if (!article) throw Error(`fake-clawde: no article ${entry}`);
    return { ...article, lawDbDate };
  });
  for (const figure of answer.figures ?? []) figure.url = figure.url.replace('{base}', base ?? '');
  answer.lawDbDate = lawDbDate;
  answer.generatedAt = new Date().toISOString();
  return answer;
}

const initialControl = () => ({
  delayMs: 0,
  failStatus: null,
  lawDbDate: FAKE_LAW_DB_DATE,
  rejectKeys: [],
});

export async function startFakeClawde({ port = 0, token = FAKE_CLAWDE_TOKEN } = {}) {
  let control = initialControl();
  /** Every /v1 request as received (method, path, auth, VIDE version, body). */
  const received = [];
  /** idempotencyKey → receipt; a repeat returns the first receipt and stores nothing new. */
  const receipts = new Map();
  /** Accepted contribution items, once each. */
  const stored = [];
  const timers = new Set();
  let base = '';

  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const fail = (res, status, code, message = code) =>
    send(res, status, { error: { code, message } });

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return undefined;
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  function contribute(request) {
    const known = new Set(PROFILE_KEYS.map((k) => k.key));
    const previous = receipts.get(request.idempotencyKey);
    if (previous) return previous;
    const accepted = [];
    const rejected = [];
    for (const item of request.items) {
      if (!known.has(item.key)) rejected.push({ key: item.key, reason: 'unknown key' });
      else if (UNACCEPTED_BASES.has(item.basis))
        rejected.push({ key: item.key, reason: 'not user-confirmed' });
      else if (control.rejectKeys.includes(item.key))
        rejected.push({ key: item.key, reason: 'rejected by service review' });
      else {
        accepted.push(item.key);
        stored.push({ projectRef: request.projectRef, ...item });
      }
    }
    const receipt = { receiptId: `fake-receipt-${receipts.size + 1}`, accepted, rejected };
    receipts.set(request.idempotencyKey, receipt);
    return receipt;
  }

  async function route(req, res, url, body) {
    const path = url.pathname;
    if (req.method === 'GET' && path === '/v1/meta')
      return send(res, 200, {
        service: 'clawde',
        apiVersion: '1.0',
        lawDbDate: control.lawDbDate,
        stages: STAGES,
        profileKeys: PROFILE_KEYS,
      });
    if (req.method === 'POST' && path === '/v1/ask') {
      const parsed = clawdeAskRequestSchema.safeParse(body);
      if (!parsed.success) return fail(res, 400, 'BAD_REQUEST', parsed.error.message);
      const caseDef = pickCase(parsed.data.question, parsed.data.profile);
      return send(res, 200, buildAnswer(caseDef, { base, lawDbDate: control.lawDbDate }));
    }
    if (req.method === 'POST' && path === '/v1/checklist') {
      const parsed = clawdeChecklistRequestSchema.safeParse(body);
      if (!parsed.success) return fail(res, 400, 'BAD_REQUEST', parsed.error.message);
      if (!STAGES.some((s) => s.id === parsed.data.stage))
        return fail(res, 400, 'BAD_REQUEST', 'unknown stage');
      return send(res, 200, { lawDbDate: control.lawDbDate, items: CHECKLIST });
    }
    if (req.method === 'GET' && path.startsWith('/v1/articles/')) {
      const ref = decodeURIComponent(path.slice('/v1/articles/'.length));
      const article = ARTICLES.find((a) => a.ref === ref);
      if (!article) return fail(res, 404, 'NOT_FOUND', 'no such article');
      return send(res, 200, { ...article, lawDbDate: control.lawDbDate });
    }
    if (req.method === 'GET' && path === '/v1/search') {
      const q = url.searchParams.get('q') ?? '';
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 10));
      const hits = ARTICLES.filter((a) =>
        [a.ref, a.lawName, a.title, a.excerpt].some((field) => q && field?.includes(q)),
      )
        .slice(0, limit)
        .map(({ ref, lawName, article, title, excerpt }) => ({
          ref,
          lawName,
          article,
          title,
          excerpt,
        }));
      return send(res, 200, { hits });
    }
    if (req.method === 'POST' && path === '/v1/contributions') {
      const parsed = clawdeContributionRequestSchema.safeParse(body);
      if (!parsed.success) return fail(res, 400, 'BAD_REQUEST', parsed.error.message);
      return send(res, 200, contribute(parsed.data));
    }
    if (req.method === 'GET' && path === '/v1/figures/sunlight.svg')
      return send(res, 200, FIGURE_SVG, 'image/svg+xml');
    return fail(res, 404, 'NOT_FOUND', 'no such endpoint');
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const authorized = req.headers.authorization === `Bearer ${token}`;
    let body;
    try {
      body = await readBody(req);
    } catch {
      return fail(res, 400, 'BAD_REQUEST', 'body is not JSON');
    }
    if (url.pathname === '/__control') {
      if (!authorized) return fail(res, 401, 'UNAUTHORIZED', 'token missing or wrong');
      api.control(body ?? {});
      return send(res, 200, { control });
    }
    received.push({
      method: req.method,
      path: url.pathname + url.search,
      authorization: req.headers.authorization ?? null,
      videVersion: req.headers['x-vide-version'] ?? null,
      body,
    });
    if (!authorized) return fail(res, 401, 'UNAUTHORIZED', 'token missing or wrong');
    const respond = () => {
      if (control.failStatus === 401) return fail(res, 401, 'UNAUTHORIZED', 'token expired');
      if (control.failStatus)
        return fail(res, control.failStatus, 'SERVICE_ERROR', 'scripted failure');
      return route(req, res, url, body);
    };
    if (!control.delayMs) return respond();
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!res.destroyed) respond();
    }, control.delayMs);
    timers.add(timer);
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const api = {
    url: base,
    token,
    received,
    stored,
    /** Script the next responses: `{delayMs, failStatus: 401|500|503|null, lawDbDate, rejectKeys}`. */
    control(patch) {
      control = { ...control, ...patch };
      return control;
    },
    reset() {
      control = initialControl();
      received.length = 0;
      stored.length = 0;
      receipts.clear();
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  return api;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const arg = (name) => {
    const at = process.argv.indexOf(name);
    return at > 0 ? process.argv[at + 1] : undefined;
  };
  const fake = await startFakeClawde({
    port: Number(arg('--port') ?? 0),
    token: arg('--token') ?? FAKE_CLAWDE_TOKEN,
  });
  console.log(JSON.stringify({ url: fake.url }));
}
