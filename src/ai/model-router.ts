// Automatic model choice ("자동 (Jev)"): Jev reads the request and picks a task type and a domain
// (geometry work or the rest); a priority table turns them into service, model and effort among the
// signed-in services. User decision 2026-10-02 (supersedes 2026-09-29): only creating or changing
// geometry goes to ChatGPT; lookups, explanations, proposals and organising (layers, names, file
// structure) go to Claude. Working hypothesis
// (user, 2026-09-29): a strong model at low effort is faster and better than a weaker model at high
// effort, so modelling tasks stay on the top model and vary effort. Every decision and its outcome
// go to <data>/logs/model-routing.jsonl so the table can be tuned from real runs (PLAN-05 §7).
// Failure, no key or low confidence → the fallback task's row.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One entry in the model menu; the server picks service, model and effort per request. */
export const AUTO_MODELS = [
  { id: 'auto', name: '자동 (Jev)', provider: 'claude-cli', efforts: ['default'] },
] as const;
export const isAutoModel = (model: unknown) => AUTO_MODELS.some((entry) => entry.id === model);
/**
 * Routes VIDE carries out without the AI (SPEC-02.17 2, PLAN-24 T-049): no model is chosen for them,
 * so neither this router nor the task and area questions of the route call are used.
 */
const ROUTES_WITHOUT_MODEL: readonly string[] = ['view', 'param', 'app', 'jig'];
export const needsModel = (target: string | null | undefined) =>
  !target || !ROUTES_WITHOUT_MODEL.includes(target);

export const TASKS = {
  lookup:
    'Read-only question about the model, drawing or project: count, list, measure, find, explain. Nothing is changed.',
  simple_edit:
    'A small, clear change to existing objects or their attributes: move, delete, offset or extend a few elements, rename them, or change their layer or color.',
  complex:
    'Creating or substantially changing geometry in several steps or across many objects: generate a pattern, model a stair or facade, rebuild a layout.',
  analysis:
    'Analysis, optimization or comparison of alternatives with heavy computation: structural or area checks, clash review, optimizing a parameter.',
} as const;
export type Task = keyof typeof TASKS;
/** The second question: what the request is about. It decides the service when both are signed in. */
export const DOMAINS = {
  geometry:
    'Creating or changing shapes and objects in Rhino or CAD: modelling, drafting, moving, copying, deleting, offsetting, extending or rebuilding geometry.',
  data: 'Everything that does not create or change shapes: questions and lookups, explanations, advice and proposals, organising layers, names, colors and file structure, documents, tables, project records, interpreting results, writing code or building a tool (jig).',
} as const;
export type Domain = keyof typeof DOMAINS;
export type Provider = 'claude-cli' | 'codex-cli';

/**
 * Priority per domain and task: the first candidate whose service is signed in and whose model is
 * listed wins (user, 2026-10-02): creating or changing geometry goes to ChatGPT (GPT-6-Astra);
 * lookups (even about geometry), explanations, proposals, organising, interpretation and jig building
 * go to Claude (Opus 5.5; Sonnet 5 for questions). The other service follows as the fallback when the
 * preferred one is not signed in.
 */
const GPT = (model: string, effort: string): [Provider, string, string] => [
  'codex-cli',
  model,
  effort,
];
const CLAUDE = (model: string, effort: string): [Provider, string, string] => [
  'claude-cli',
  model,
  effort,
];
export const PRIORITY: Record<Domain, Record<Task, [Provider, string, string][]>> = {
  geometry: {
    lookup: [
      CLAUDE('claude-sonnet-5', 'low'),
      CLAUDE('claude-opus-5-5', 'low'),
      GPT('gpt-6-luna', 'low'),
      GPT('gpt-6-astra', 'low'),
    ],
    simple_edit: [GPT('gpt-6-astra', 'low'), CLAUDE('claude-opus-5-5', 'low')],
    complex: [GPT('gpt-6-astra', 'medium'), CLAUDE('claude-opus-5-5', 'medium')],
    analysis: [GPT('gpt-6-astra', 'high'), CLAUDE('claude-opus-5-5', 'high')],
  },
  data: {
    lookup: [
      CLAUDE('claude-sonnet-5', 'low'),
      CLAUDE('claude-opus-5-5', 'low'),
      GPT('gpt-6-luna', 'low'),
      GPT('gpt-6-astra', 'low'),
    ],
    simple_edit: [CLAUDE('claude-opus-5-5', 'low'), GPT('gpt-6-astra', 'low')],
    complex: [CLAUDE('claude-opus-5-5', 'medium'), GPT('gpt-6-astra', 'medium')],
    analysis: [CLAUDE('claude-opus-5-5', 'high'), GPT('gpt-6-astra', 'high')],
  },
};
const FALLBACK: Task = 'complex';
/**
 * The domain when Jev gave none or was unsure: a lookup changes nothing, so it counts as data (Claude);
 * any other task counts as geometry, since VIDE is mostly model and drawing work.
 */
export const fallbackDomain = (task: Task): Domain => (task === 'lookup' ? 'data' : 'geometry');
const MIN_CONFIDENCE = 0.5;
const ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface CatalogModel {
  id: string;
  provider: string;
  efforts: string[];
}
export interface RoutingInput {
  body: string;
  host?: string;
  permission?: string;
  files?: unknown[];
  pins?: unknown[];
  sketches?: unknown[];
  linkedTargets?: unknown[];
}
export interface Choice {
  provider: Provider;
  /** Undefined model: the CLI's own default model (that service has no model catalog). */
  model?: string;
  effort: string;
}
export interface RoutingDecision extends Choice {
  by: 'jev' | 'fallback';
  task: Task;
  confidence: number;
  domain: Domain;
  domainConfidence: number;
  /** Signed-in services at decision time. */
  available: Provider[];
  ms: number;
  reason?: string;
  at: string;
}

/** The nearest supported effort at or below the wish, else the lowest above it, else default. */
function effortFor(model: CatalogModel | undefined, wish: string) {
  const supported = model?.efforts ?? ['default'];
  if (supported.includes(wish)) return wish;
  const index = ORDER.indexOf(wish);
  const below = ORDER.slice(0, index)
    .reverse()
    .find((effort) => supported.includes(effort));
  const above = ORDER.slice(index + 1).find((effort) => supported.includes(effort));
  return below ?? above ?? 'default';
}

/**
 * Walk the task's priority list over signed-in services. A service without a model catalog (only its
 * CLI placeholder) runs its own default model. Nothing signed in: undefined (the caller keeps the
 * request's own service, which then reports that it is not connected).
 */
export function choose(
  task: Task,
  catalog: CatalogModel[],
  available: Provider[],
  domain: Domain = fallbackDomain(task),
): Choice | undefined {
  const priority = PRIORITY[domain][task];
  for (const [provider, id, effort] of priority) {
    if (!available.includes(provider)) continue;
    const listed = catalog.find((model) => model.id === id && model.provider === provider);
    if (listed) return { provider, model: id, effort: effortFor(listed, effort) };
  }
  for (const provider of new Set(priority.map(([service]) => service))) {
    if (!available.includes(provider)) continue;
    const own = catalog.filter((model) => model.provider === provider && !isAutoModel(model.id));
    if (own.length && own.every((model) => model.id === provider))
      return { provider, model: undefined, effort: 'default' };
  }
  return undefined;
}

export function readJevKey(dataDirectory: string, environment = process.env) {
  if (environment.TYPESAFE_API_KEY?.trim()) return environment.TYPESAFE_API_KEY.trim();
  const file = join(dataDirectory, 'typesafe.env');
  if (!existsSync(file)) return '';
  const line = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find((entry) => /^\s*TYPESAFE_API_KEY\s*=/.test(entry));
  return line
    ? line
        .replace(/^\s*TYPESAFE_API_KEY\s*=\s*/, '')
        .trim()
        .replace(/^["']|["']$/g, '')
    : '';
}

export function describe(input: RoutingInput) {
  const count = (list?: unknown[]) => (Array.isArray(list) ? list.length : 0);
  return [
    'Request to VIDE, an AI workspace that edits Rhino models and CAD drawings for architects.',
    `Host: ${input.host ?? 'rhino'}. Mode: ${input.permission === 'review' ? 'review only (no changes)' : 'may change a working copy'}.`,
    `Attached: ${count(input.files)} files, ${count(input.pins)} pinned objects, ${count(input.sketches)} sketches${count(input.linkedTargets) ? ', two linked documents' : ''}.`,
    'User request:',
    input.body.slice(0, 4000),
  ].join('\n');
}

export interface RouterOptions {
  dataDirectory: string;
  fetchImpl?: typeof fetch;
  key?: () => string;
  url?: string;
  model?: string;
  timeoutMs?: number;
  /** False for in-memory stores (tests): no log file is written. */
  log?: boolean;
}

export class ModelRouter {
  private readonly log: string;
  private readonly options: RouterOptions;
  constructor(options: RouterOptions) {
    this.options = options;
    this.log = join(options.dataDirectory, 'logs', 'model-routing.jsonl');
  }

  /**
   * Decide service, model and effort. `available` resolves the signed-in services (checked in
   * parallel with Jev); `requested` is the service the request came with, kept when none is signed in.
   */
  async route(
    input: RoutingInput,
    catalog: CatalogModel[],
    available: Promise<Provider[]> | Provider[],
    requested: Provider = 'claude-cli',
  ): Promise<RoutingDecision> {
    const started = performance.now();
    const at = new Date().toISOString();
    const signedIn = Promise.resolve(available).catch(() => [] as Provider[]);
    const decide = async (
      by: RoutingDecision['by'],
      task: Task,
      confidence: number,
      reason?: string,
      domain: Domain = fallbackDomain(task),
      domainConfidence = 0,
    ): Promise<RoutingDecision> => {
      const services = await signedIn;
      const picked = choose(task, catalog, services, domain);
      const why = reason ?? (picked ? undefined : 'NO_SERVICE');
      return {
        by,
        task,
        confidence,
        domain,
        domainConfidence,
        ...(picked ?? { provider: requested, effort: 'default' }),
        available: services,
        ms: Math.round(performance.now() - started),
        ...(why ? { reason: why } : {}),
        at,
      };
    };
    const key = (this.options.key ?? (() => readJevKey(this.options.dataDirectory)))();
    if (!key) return decide('fallback', FALLBACK, 0, 'NO_KEY');
    try {
      const response = await (this.options.fetchImpl ?? fetch)(
        this.options.url ?? 'https://api.typesafe.ai/v1/systemone',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.options.model ?? 'jev-1.13.0',
            state: describe(input),
            questions: {
              task: {
                type: 'choice',
                instructions: 'What kind of work does this request ask for?',
                criteria: TASKS,
              },
              domain: {
                type: 'choice',
                instructions: 'What is this request mainly about?',
                criteria: DOMAINS,
              },
            },
          }),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
        },
      );
      if (!response.ok) return decide('fallback', FALLBACK, 0, 'HTTP_' + response.status);
      type Answer = { choice?: string; confidence?: number } | undefined;
      const answers = ((await response.json()) as { answers?: Record<string, Answer> }).answers;
      const task = answers?.task?.choice as Task | undefined;
      const confidence = Number(answers?.task?.confidence ?? 0);
      // The domain only chooses between signed-in services; an unsure answer falls back by task
      // (fallbackDomain: lookup → data, the rest → geometry).
      const domainConfidence = Number(answers?.domain?.confidence ?? 0);
      const domain =
        answers?.domain?.choice &&
        answers.domain.choice in DOMAINS &&
        domainConfidence >= MIN_CONFIDENCE
          ? (answers.domain.choice as Domain)
          : undefined;
      if (!task || !(task in TASKS))
        return decide('fallback', FALLBACK, 0, 'NO_ANSWER', domain, domainConfidence);
      if (confidence < MIN_CONFIDENCE)
        return decide(
          'fallback',
          FALLBACK,
          confidence,
          'LOW_CONFIDENCE:' + task,
          domain,
          domainConfidence,
        );
      return decide('jev', task, confidence, undefined, domain, domainConfidence);
    } catch (error) {
      return decide(
        'fallback',
        FALLBACK,
        0,
        error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'ERROR',
      );
    }
  }

  /** Append one line; logging never breaks a request. */
  record(entry: Record<string, unknown>) {
    if (this.options.log === false) return;
    try {
      mkdirSync(join(this.options.dataDirectory, 'logs'), { recursive: true });
      appendFileSync(this.log, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      /* The routing log is diagnostic only. */
    }
  }
}
