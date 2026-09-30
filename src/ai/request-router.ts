// Where a request goes (SPEC-02.17), judged by Jev when a key is set (user, 2026-09-29: "jev가
// 판정하면 안되나? 규칙으로 하니까 칩을 눌러야 하는 횟수가 너무 많아"). One call asks every question
// at once: the route (view, param, app, jig, ask, document, make), the view action and objects, the
// open jig's setting, the app action, the jig, whether the request keeps the current conversation's
// purpose, and — only when a conversation opens — the model's task and area. Words decided without
// Jev come first (decisiveRoute, shared with the screen). No key, the transmission switched off
// (FR-18), a failure, 3 s or an unsure answer: no decision, and the screen uses its rules. Only the
// fixed items below reach Jev (SPEC-02.17 4): never file names, paths, record text or geometry.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DOMAINS, TASKS, needsModel, readJevKey, type Domain, type Task } from './model-router.ts';
import {
  APP_ACTIONS,
  OFFICIAL_JIG_ROUTING,
  decisiveRoute,
  type AppAction,
  type RouteTarget,
  type Service,
} from '../ui/request-route.ts';

export const VIEW_ACTIONS = {
  hide: 'Hide these objects or turn their layer off in the view (숨겨, 안 보이게, 꺼, 가려).',
  isolate: 'Show only these objects and hide everything else (만 보여, 만 남기고, 만 켜, 격리).',
  unhide: 'Show all hidden objects again (다시 보여, 모두 보여, 숨김 해제).',
  select: 'Select or pick these objects (선택해, 골라, 찍어).',
  fit: 'Zoom or move the view to these objects (확대, 줌, 가까이, 맞춰 보여).',
} as const;
export type ViewAction = keyof typeof VIEW_ACTIONS;
const APP_CRITERIA: Record<AppAction, string> = {
  login: 'Sign in to an AI service (Claude, or ChatGPT/Codex).',
  logout: 'Sign out of an AI service.',
  switch_account: 'Switch to another account of an AI service.',
  sync_link: 'Sync (read again) a linked Rhino model or CAD drawing into VIDE.',
  install_connector: 'Install or update the Rhino or ZWCAD connection plug-in.',
  export: 'Export a result, table or report to a file (PDF, CSV, image).',
  offline_view: 'Turn on or change the offline view on the account site.',
};
export interface RouteSubject {
  id: string;
  /** What the group is, e.g. "문자 (text annotations), 120 objects" or "layer A-ANNO, 30 objects". */
  label: string;
}
/** A setting of the open jig: only its title and help go to Jev. */
export interface RouteParamQuery {
  key: string;
  title: string;
  help?: string;
}
export interface RouteJigQuery {
  id: string;
  name?: string;
  /** `intent_en`: the one English line Jev judges by. */
  intent: string;
  /** Rule words (kept here, never sent). */
  words?: readonly string[];
  /** skill.md `not_for` (rules only, never sent). */
  notFor?: readonly string[];
  /** Words from a skill.md (guarded) or the official list (src/ui/request-route.ts RouteJig). */
  source?: 'skill' | 'legacy';
}
/** A linked file by its role label ('Rhino 모델 1', 'CAD 2'), never its name. */
export interface RouteLink {
  id: string;
  label: string;
}
export interface RouteQuery {
  body: string;
  subjects: RouteSubject[];
  params?: RouteParamQuery[];
  jigs?: RouteJigQuery[];
  links?: RouteLink[];
  /** The kind of the current conversation (T-061), for `same_conversation`. */
  conversation?: string;
  /** A conversation opens with this request: also ask the model's task and area. */
  opening?: boolean;
  /** The jig id of the open instance (its own words change its settings). */
  openJig?: string;
}
export interface RouteDecision {
  target: RouteTarget;
  by: 'jev' | 'rules';
  action?: ViewAction;
  /** The chosen subject id, or undefined when none fits. */
  subject?: string;
  /** The chosen setting key of the open jig. */
  param?: string;
  app?: AppAction;
  provider?: Service;
  /** The chosen link id. */
  link?: string;
  jig?: string;
  jigName?: string;
  /** Jev's Noul that the request keeps the current conversation's purpose. */
  sameConversation?: number;
  task?: Task;
  domain?: Domain;
  /** False: VIDE does it without the AI, and no model is chosen (model-router needsModel). */
  ai: boolean;
  confidence: number;
  ms: number;
}
export interface RouterOptions {
  dataDirectory?: string;
  key?: () => string;
  fetchImpl?: typeof fetch;
  url?: string;
  model?: string;
  timeoutMs?: number;
  /** The user's FR-18 switch; false = rules only, no Jev call. */
  enabled?: boolean;
}
export interface RouteJudgement {
  decision?: RouteDecision;
  /** Why there is no Jev decision (diagnostics only). */
  reason?: string;
  ms: number;
}
const MIN_CONFIDENCE = 0.6;
/** A jig is proposed only when Jev thinks some listed tool fits (RESEARCH-02:87). */
const MIN_JIG_FIT = 0.3;
const MAX_SUBJECTS = 40;
const MAX_PARAMS = 30;
const MAX_JIGS = 30;
const MAX_LINKS = 20;

// ── The fixed payload (SPEC-02.17 4). ─────────────────────────────────────────────────────────
const PATH = /(?:\b[a-zA-Z]:[\\/]|\\\\)[^\s"'<>|]*|(?:\/[\w.-]+){2,}/g;
const FILE =
  /[^\s"'<>|\\/:]+\.(?:3dm|3dmbak|dwg|dxf|dgn|rvt|rfa|ifc|skp|gh|ghx|pdf|xlsx?|csv|docx?|hwpx?|pptx?|txt|json|jpe?g|png|zip|eml|msg)\b/gi;
/** Paths and file names in free text are replaced before anything leaves the PC. */
export function redact(text: string) {
  return text.replace(PATH, '[경로]').replace(FILE, '[파일]');
}
/** A group label without an xref's file prefix ("plan|A-WALL" → "A-WALL"), paths or file names. */
const label = (text: string, max: number) => redact(text.replace(/[^\s"|]+\|/g, '')).slice(0, max);

/** The Jev request body for a query: only the fixed items, each clipped and cleaned. */
export function routePayload(query: RouteQuery, model = 'jev-1.13.0') {
  const subjects = query.subjects.slice(0, MAX_SUBJECTS);
  const params = (query.params ?? []).slice(0, MAX_PARAMS);
  const jigs = (query.jigs ?? []).slice(0, MAX_JIGS);
  const links = (query.links ?? []).slice(0, MAX_LINKS);
  const criteria: Record<string, string> = {
    view: 'Only change what the VIDE viewer shows: hide, turn off, show only, show again, select or zoom to objects or layers. The Rhino model or CAD drawing is not changed and no AI work is needed.',
  };
  if (params.length)
    criteria.param =
      'Change one setting of the jig that is open (a value such as a span limit, a spacing or a count, or a relative change such as "a bit denser"). The open settings are listed in the question "param".';
  criteria.app =
    'One action on the VIDE app itself: sign in or out of Claude or ChatGPT/Codex, switch account, Sync (read again) a linked file, install the connection plug-in, export, offline view. Nothing is designed, changed in the file or analysed.';
  if (jigs.length)
    criteria.jig =
      'The user wants a task that one of the registered tools (jigs, listed in the question "jig") does, e.g. a structural check or a comparison of drawing and model: open that tool.';
  criteria.ask =
    'A question about the project records: mail, minutes, replies, who decided what and when. The model and drawing are not needed.';
  criteria.document =
    'Work on the Rhino model or CAD drawing itself (create, change, delete, move, recolour or rename in the file; also anything said to happen in CAD, in Rhino, in the drawing or in the original), or a question, count, check or analysis of the model or drawing for the AI assistant.';
  criteria.make = 'Make a new tool (jig) or automate a repeated task as a reusable tool.';
  const questions: Record<string, unknown> = {
    target: {
      type: 'choice',
      instructions: 'Where should this request be carried out?',
      criteria,
    },
    action: {
      type: 'choice',
      instructions: 'If the request only changes the VIDE view, which change is it?',
      criteria: VIEW_ACTIONS,
    },
  };
  if (subjects.length)
    questions.subject = {
      type: 'choice',
      instructions:
        'Which objects does the request name (the ones to hide, show, keep, select or zoom to)? Korean words: 문자·텍스트·글자 = text, 치수 = dimensions, 해치 = hatches, 블록 = blocks, 면 = surfaces, 선 = lines, 점 = points, 보 = beams, 기둥 = columns, 벽 = walls, 슬래브 = slabs, 창호 = windows and doors. A layer whose code or name matches the word counts (S-BEAM for 보, A-WALL for 벽).',
      criteria: {
        ...Object.fromEntries(subjects.map((subject, i) => [`s${i}`, label(subject.label, 300)])),
        none: 'None of these, or all objects',
      },
    };
  if (params.length)
    questions.param = {
      type: 'choice',
      instructions: 'Which setting of the open jig does the request change?',
      criteria: {
        ...Object.fromEntries(
          params.map((param, i) => [
            `p${i}`,
            label(param.help ? `${param.title} — ${param.help}` : param.title, 240),
          ]),
        ),
        none: 'None of these settings',
      },
    };
  questions.app_action = {
    type: 'choice',
    instructions: 'If the request is one action on the VIDE app, which one?',
    criteria: { ...APP_CRITERIA, none: 'Not an app action' },
  };
  questions.provider = {
    type: 'choice',
    instructions: 'Which AI service does the request name, if any?',
    criteria: {
      'claude-cli': 'Claude (Anthropic, Claude Code)',
      'codex-cli': 'ChatGPT, GPT or Codex (OpenAI)',
      none: 'No AI service is named',
    },
  };
  if (links.length)
    questions.link = {
      type: 'choice',
      instructions: 'Which linked file does the request mean, if one?',
      criteria: {
        ...Object.fromEntries(links.map((link, i) => [`l${i}`, label(link.label, 60)])),
        none: 'No particular file, or all of them',
      },
    };
  if (jigs.length) {
    questions.jig = {
      type: 'choice',
      instructions: 'Which registered tool (jig) does the request want?',
      criteria: {
        ...Object.fromEntries(jigs.map((jig, i) => [`j${i}`, label(jig.intent, 300)])),
        none: 'None of these tools',
      },
    };
    questions.jig_fit = {
      type: 'noul',
      instructions: 'Is there a registered tool (jig) that does what the user asks for?',
      criteria: {
        true: 'Yes, one of the listed tools does this task',
        false: 'No listed tool does this task',
      },
    };
  }
  if (query.conversation)
    questions.same_conversation = {
      type: 'noul',
      instructions: `Does the request keep the purpose of the current conversation (${label(query.conversation, 60)})?`,
      criteria: {
        true: 'Yes, it continues the same purpose',
        false: 'No, it is about another purpose and belongs in a new conversation',
      },
    };
  if (query.opening) {
    questions.task = {
      type: 'choice',
      instructions: 'What kind of work does this request ask for?',
      criteria: TASKS,
    };
    questions.domain = {
      type: 'choice',
      instructions: 'What is this request mainly about?',
      criteria: DOMAINS,
    };
  }
  return {
    model,
    state: `A user of VIDE, an AI workspace that shows Rhino models and CAD drawings and runs small design tools (jigs), typed a request.\nRequest: ${redact(query.body.slice(0, 2000))}`,
    questions,
  };
}

/** The route with the reason when Jev does not decide (for the diagnostic log). */
export async function judgeRoute(
  query: RouteQuery,
  options: RouterOptions = {},
): Promise<RouteJudgement> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  if (!query.body.trim()) return { reason: 'EMPTY', ms: ms() };
  const ruled = decisiveRoute(query.body, {
    params: query.params,
    jigs: query.jigs?.map(({ id, name, words, notFor, source }) => ({
      id,
      name,
      words,
      ...(notFor ? { notFor } : {}),
      ...(source ? { source } : {}),
    })),
    ...(query.openJig ? { openJig: query.openJig } : {}),
  });
  if (ruled) {
    const jig = ruled.jig ? query.jigs?.find((entry) => entry.id === ruled.jig!.id) : undefined;
    return {
      decision: {
        target: ruled.target,
        by: 'rules',
        ...(ruled.param ? { param: ruled.param.key } : {}),
        ...(ruled.app
          ? {
              app: ruled.app.action,
              ...(ruled.app.provider ? { provider: ruled.app.provider } : {}),
            }
          : {}),
        ...(ruled.jig ? { jig: ruled.jig.id, jigName: jig?.name ?? ruled.jig.name } : {}),
        ai: needsModel(ruled.target),
        confidence: 1,
        ms: ms(),
      },
      ms: ms(),
    };
  }
  if (options.enabled === false) return { reason: 'OFF', ms: ms() };
  const key = options.key?.() ?? (options.dataDirectory ? readJevKey(options.dataDirectory) : '');
  if (!key) return { reason: 'NO_KEY', ms: ms() };
  const payload = routePayload(query, options.model);
  const subjects = query.subjects.slice(0, MAX_SUBJECTS);
  const params = (query.params ?? []).slice(0, MAX_PARAMS);
  const jigs = (query.jigs ?? []).slice(0, MAX_JIGS);
  const links = (query.links ?? []).slice(0, MAX_LINKS);
  try {
    const response = await (options.fetchImpl ?? fetch)(
      options.url ?? 'https://api.typesafe.ai/v1/systemone',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
      },
    );
    if (!response.ok) return { reason: 'HTTP_' + response.status, ms: ms() };
    type Answer = { choice?: string; confidence?: number; noul?: number } | undefined;
    const answers = ((await response.json()) as { answers?: Record<string, Answer> }).answers;
    const target = answers?.target?.choice as RouteTarget | undefined;
    const confidence = Number(answers?.target?.confidence ?? 0);
    const asked = (payload.questions.target as { criteria: Record<string, string> }).criteria;
    if (!target || !(target in asked)) return { reason: 'NO_ANSWER', ms: ms() };
    if (confidence < MIN_CONFIDENCE) return { reason: 'LOW_CONFIDENCE', ms: ms() };
    const indexed = <T>(list: readonly T[], choice: string | undefined, prefix: string) => {
      const index = choice?.startsWith(prefix) ? Number(choice.slice(prefix.length)) : NaN;
      return Number.isInteger(index) ? list[index] : undefined;
    };
    const decision: RouteDecision = {
      target,
      by: 'jev',
      ai: needsModel(target),
      confidence,
      ms: 0,
    };
    const same = answers?.same_conversation?.noul;
    if (query.conversation && typeof same === 'number') decision.sameConversation = same;
    if (target === 'view') {
      const action = answers?.action?.choice;
      if (!action || !(action in VIEW_ACTIONS)) return { reason: 'NO_ANSWER', ms: ms() };
      decision.action = action as ViewAction;
      const subject = indexed(subjects, answers?.subject?.choice, 's');
      if (subject) decision.subject = subject.id;
    } else if (target === 'param') {
      const param = indexed(params, answers?.param?.choice, 'p');
      if (!param) return { reason: 'NO_ANSWER', ms: ms() };
      decision.param = param.key;
    } else if (target === 'app') {
      const action = answers?.app_action?.choice as AppAction | undefined;
      if (!action || !APP_ACTIONS.includes(action)) return { reason: 'NO_ANSWER', ms: ms() };
      decision.app = action;
      const provider = answers?.provider?.choice;
      if (provider === 'claude-cli' || provider === 'codex-cli') decision.provider = provider;
      const link = indexed(links, answers?.link?.choice, 'l');
      if (link) decision.link = link.id;
    } else if (target === 'jig') {
      const jig = indexed(jigs, answers?.jig?.choice, 'j');
      const fit = Number(answers?.jig_fit?.noul ?? 0);
      if (!jig || fit < MIN_JIG_FIT) return { reason: 'NO_JIG', ms: ms() };
      decision.jig = jig.id;
      if (jig.name) decision.jigName = jig.name;
    } else if (query.opening && needsModel(target)) {
      // The model is chosen with the conversation (SPEC-02.17 5), from the same call.
      const task = answers?.task?.choice;
      const domain = answers?.domain?.choice;
      if (task && task in TASKS && Number(answers?.task?.confidence ?? 0) >= 0.5)
        decision.task = task as Task;
      if (domain && domain in DOMAINS && Number(answers?.domain?.confidence ?? 0) >= 0.5)
        decision.domain = domain as Domain;
    }
    decision.ms = ms();
    return { decision, ms: decision.ms };
  } catch (error) {
    return {
      reason: error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'ERROR',
      ms: ms(),
    };
  }
}

export async function decideRoute(
  query: RouteQuery,
  options: RouterOptions = {},
): Promise<RouteDecision | undefined> {
  return (await judgeRoute(query, options)).decision;
}

/**
 * The official jigs with their Jev line and words: the fallback when the project's skill catalog
 * cannot be read (src/server/skill-catalog.ts builds the full list).
 */
export function officialJigs(
  entries: readonly { id: string; name: string; status: string }[],
): RouteJigQuery[] {
  return entries
    .filter((entry) => entry.status === 'available' && OFFICIAL_JIG_ROUTING[entry.id])
    .map((entry) => ({ id: entry.id, name: entry.name, ...OFFICIAL_JIG_ROUTING[entry.id] }));
}

/** Linked files by role label, numbered per program in link order; names never leave. */
export function linkLabels(
  links: readonly { id: string; host: 'rhino' | 'zwcad'; hidden?: boolean }[],
): RouteLink[] {
  const count = { rhino: 0, zwcad: 0 };
  return links
    .filter((link) => !link.hidden)
    .map((link) => ({
      id: link.id,
      label: link.host === 'rhino' ? `Rhino 모델 ${++count.rhino}` : `CAD ${++count.zwcad}`,
    }));
}

// ── FR-18: the user's switch for sending route questions to Jev. ──────────────────────────────
export interface RouteSettingsValue {
  /** Send route questions to Jev (when a key is set on this PC). */
  jev: boolean;
}
/**
 * Stored in <data>/route-settings.json; in memory for in-memory stores. A missing file means on
 * (the user chose Jev routing, 2026-09-29); an unreadable one means off, so a switch the user turned
 * off is never read as on.
 */
export class RouteSettings {
  private readonly file?: string;
  private memory: RouteSettingsValue = { jev: true };
  constructor(file?: string) {
    this.file = file;
  }
  get(): RouteSettingsValue {
    if (!this.file) return { ...this.memory };
    if (!existsSync(this.file)) return { jev: true };
    try {
      const stored = JSON.parse(readFileSync(this.file, 'utf8')) as { jev?: unknown };
      return { jev: stored.jev === true };
    } catch {
      return { jev: false };
    }
  }
  set(value: RouteSettingsValue): RouteSettingsValue {
    if (!this.file) {
      this.memory = { jev: value.jev };
      return this.get();
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ jev: value.jev }) + '\n', 'utf8');
    return this.get();
  }
}
const settingsOf = new WeakMap<object, RouteSettings>();
/** One settings object per server (keyed by its store), so in-memory servers keep theirs apart. */
export function routeSettingsFor(owner: object, file?: string) {
  let settings = settingsOf.get(owner);
  if (!settings) settingsOf.set(owner, (settings = new RouteSettings(file)));
  return settings;
}
/** Whether this PC has a Jev key (the key itself never leaves the engine). */
export const hasJevKey = (dataDirectory: string) => Boolean(readJevKey(dataDirectory));

// ── Input roles (SPEC-07.5 1, PLAN-24 T-049). ────────────────────────────────────────────────
// For the roles the layer-name rules left empty, one AI step without tools proposes which linked
// file's layer plays the role, with a one-line reason. It runs as a jig review request
// (`jig.kind = 'input-roles'`: no host, no document context, execution.ts) and its answer passes the
// whitelist gate below before anyone sees it. The AI never makes geometry: the declared extractor
// reads the shapes from the chosen layers, and people confirm each role.
export interface InputRole {
  role: string;
  title: string;
  shape: string;
  many?: boolean;
  required?: boolean;
  hints?: { layers?: string[]; words?: string[] };
}
export interface InputSource {
  /** Link or read id. */
  id: string;
  /** Role label ('Rhino 모델 1', 'CAD 2'). */
  label: string;
  layers: { name: string; count: number; kinds?: Record<string, number> }[];
}
export interface RoleProposal {
  role: string;
  source: string;
  layers: string[];
  reason: string;
}
export interface RoleRejection {
  role?: string;
  source?: string;
  layer?: string;
  why:
    | 'NOT_JSON'
    | 'UNKNOWN_ROLE'
    | 'ALREADY_PICKED'
    | 'DUPLICATE_ROLE'
    | 'UNKNOWN_SOURCE'
    | 'UNKNOWN_LAYER'
    | 'NO_LAYER';
}
const ROLE_FILE = 'input-roles.json';
/** Workspace request limit for one attached file is 50,000 characters. */
const ROLE_FILE_MAX = 48000;

/** The request fields of the input-role step; the caller adds id, provider and model. */
export function inputRolesRequest(input: {
  roles: readonly InputRole[];
  sources: readonly InputSource[];
  /** Roles the layer-name rules (or people) already filled; the AI proposes only the others. */
  picked?: readonly { role: string; source: string; layers: string[] }[];
  /** Project record search lines, after the records work (optional). */
  facts?: readonly string[];
}) {
  const picked = new Set((input.picked ?? []).map((entry) => entry.role));
  const open = input.roles.filter((role) => !picked.has(role.role));
  let perSource = 400;
  let text = '';
  for (;;) {
    text = JSON.stringify({
      roles: open.map(({ role, title, shape, many, required, hints }) => ({
        role,
        title,
        shape,
        many: Boolean(many),
        required: Boolean(required),
        ...(hints ? { hints } : {}),
      })),
      filled: (input.picked ?? []).map(({ role, source, layers }) => ({ role, source, layers })),
      sources: input.sources.map((source) => ({
        id: source.id,
        label: label(source.label, 60),
        layers: [...source.layers]
          .sort((a, b) => b.count - a.count)
          .slice(0, perSource)
          .map((layer) => ({
            name: layer.name.slice(0, 200),
            count: layer.count,
            ...(layer.kinds ? { kinds: layer.kinds } : {}),
          })),
      })),
      ...(input.facts?.length
        ? { facts: input.facts.slice(0, 40).map((f) => f.slice(0, 300)) }
        : {}),
    });
    if (text.length <= ROLE_FILE_MAX || perSource <= 20) break;
    perSource = Math.floor(perSource / 2);
  }
  return {
    body: `jig 입력 조립: 첨부 ${ROLE_FILE}의 roles(아직 정하지 않은 입력 역할)마다 sources(연결 파일)의 어느 레이어가 그 역할인지 제안해 줘. 근거는 레이어 이름·객체 수·객체 종류, 역할의 모양·힌트, filled(이미 정한 역할)와 facts(있으면)만 써. 첨부에 없는 파일 id·레이어 이름은 쓰지 말고, 좌표·치수는 만들지 마. 맞는 레이어가 없으면 그 역할은 빼. 답은 JSON 하나만: {"roles":[{"role":"역할 키","source":"파일 id","layers":["레이어 이름"],"reason":"이유 한 줄"}]}`,
    files: [{ name: ROLE_FILE, text }],
    permission: 'review' as const,
    pins: [],
    sketches: [],
    jig: { kind: 'input-roles' as const, roles: open.map((role) => role.role) },
  };
}

/** The JSON object in an answer: a fenced block, else the outermost braces. */
function jsonIn(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidates = [fenced, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const candidate of candidates)
    if (candidate?.trim())
      try {
        return JSON.parse(candidate);
      } catch {
        /* Try the next form. */
      }
  return undefined;
}

/**
 * Gate of the input-role answer (`ref-whitelist`): only declared, still open roles, only listed
 * sources and only layers that exist in that source's table pass. Everything else is reported, not
 * silently kept or fixed.
 */
export function checkInputRoles(
  text: string,
  input: {
    roles: readonly InputRole[];
    sources: readonly InputSource[];
    picked?: readonly { role: string }[];
  },
) {
  const proposals: RoleProposal[] = [];
  const rejected: RoleRejection[] = [];
  const answer = jsonIn(text) as { roles?: unknown } | undefined;
  if (!answer || !Array.isArray(answer.roles))
    return { gate: 'ref-whitelist' as const, proposals, rejected: [{ why: 'NOT_JSON' as const }] };
  const declared = new Set(input.roles.map((role) => role.role));
  const picked = new Set((input.picked ?? []).map((entry) => entry.role));
  const sources = new Map(
    input.sources.map((source) => [source.id, new Set(source.layers.map((layer) => layer.name))]),
  );
  for (const item of answer.roles.slice(0, 100)) {
    const entry = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const role = typeof entry.role === 'string' ? entry.role : '';
    const source = typeof entry.source === 'string' ? entry.source : '';
    if (!declared.has(role)) {
      rejected.push({ role, why: 'UNKNOWN_ROLE' });
      continue;
    }
    if (picked.has(role)) {
      rejected.push({ role, why: 'ALREADY_PICKED' });
      continue;
    }
    if (proposals.some((proposal) => proposal.role === role)) {
      rejected.push({ role, why: 'DUPLICATE_ROLE' });
      continue;
    }
    const layers = sources.get(source);
    if (!layers) {
      rejected.push({ role, source, why: 'UNKNOWN_SOURCE' });
      continue;
    }
    const named = Array.isArray(entry.layers)
      ? entry.layers.filter((layer): layer is string => typeof layer === 'string')
      : [];
    const kept: string[] = [];
    for (const layer of [...new Set(named)].slice(0, 8))
      if (layers.has(layer)) kept.push(layer);
      else rejected.push({ role, source, layer, why: 'UNKNOWN_LAYER' });
    if (!kept.length) {
      rejected.push({ role, source, why: 'NO_LAYER' });
      continue;
    }
    const reason = typeof entry.reason === 'string' ? entry.reason : '';
    proposals.push({
      role,
      source,
      layers: kept,
      reason: reason.replace(/\s+/g, ' ').trim().slice(0, 200),
    });
  }
  return { gate: 'ref-whitelist' as const, proposals, rejected };
}
