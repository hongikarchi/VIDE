// Where a request goes when it is sent (SPEC-02.17): seven routes — the VIDE screen (`view`), a
// setting of the open jig (`param`), one app action (`app`), opening a jig (`jig`), a question on
// the project records (`ask`), work on the file (`document`) and making a jig (`make`). The first
// four run without the AI and without a model choice. Pure code shared by the screen (its rules when
// Jev is off, absent or unsure) and the server (src/ai/request-router.ts: the words decided without
// Jev), so no DOM and no Node imports here. The model is chosen when a conversation opens
// (src/ai/model-router.ts), not here.

export type RouteTarget = 'view' | 'param' | 'app' | 'jig' | 'ask' | 'document' | 'make';
export const ROUTE_TARGETS: readonly RouteTarget[] = [
  'view',
  'param',
  'app',
  'jig',
  'ask',
  'document',
  'make',
];
/** Routes that go to the conversation AI; the others are done by VIDE itself (SPEC-02.17 2). */
export const AI_ROUTES: readonly RouteTarget[] = ['ask', 'document', 'make'];
export type ViewAction = 'hide' | 'isolate' | 'unhide' | 'select' | 'fit';
export type AppAction =
  | 'login'
  | 'logout'
  | 'switch_account'
  | 'sync_link'
  | 'install_connector'
  | 'export'
  | 'offline_view';
export const APP_ACTIONS: readonly AppAction[] = [
  'login',
  'logout',
  'switch_account',
  'sync_link',
  'install_connector',
  'export',
  'offline_view',
];
/** SPEC-02.19 7: R read, T1 VIDE state with an undo, T2 a confirmation card, M people only. */
export type Tier = 'R' | 'T1' | 'T2' | 'M';
export const APP_TIER: Record<AppAction, Tier> = {
  login: 'T2',
  logout: 'T2',
  switch_account: 'T2',
  sync_link: 'T1',
  install_connector: 'T2',
  export: 'T1',
  offline_view: 'T2',
};
export type Service = 'claude-cli' | 'codex-cli';
const SERVICE_NAME: Record<Service, string> = { 'claude-cli': 'Claude', 'codex-cli': 'Codex' };

export interface RouteObject {
  id: string;
  type?: unknown;
  layer?: unknown;
  name?: unknown;
}
/** A setting of the open jig as far as routing needs it (ARCH-03 §3 ParamDecl). */
export interface RouteParam {
  key: string;
  title: string;
  help?: string;
  type?:
    | 'length'
    | 'area'
    | 'force'
    | 'lineLoad'
    | 'areaLoad'
    | 'angle'
    | 'ratio'
    | 'count'
    | 'level'
    | 'choice'
    | 'toggle';
  /** Stored unit (SI); the display unit is what a bare number means. */
  unit?: string;
  display?: { unit: string; decimals: number };
  default?: number | string | boolean;
  range?: { min: number; max: number; step: number };
  choices?: { value: string; label: string }[];
  /** Direction of relative words (SPEC-07.6): `more` words move by `sign` × one step. */
  words?: { more: string[]; less: string[]; sign: 1 | -1 };
  fixedAtPin?: boolean;
}
export interface RouteJig {
  id: string;
  name?: string;
  /** Rule words (skill.md `words`) that open this jig without Jev. */
  words?: readonly string[];
  /** skill.md `not_for`: words that mean this jig is not wanted. */
  notFor?: readonly string[];
  /**
   * `skill`: words from a jig's skill.md, many of them topic words ("기둥", "해석"), so a single
   * word opens the jig only when the request neither acts on objects nor asks a question.
   * `legacy` (default): the official list's phrases, decisive as they are.
   */
  source?: 'skill' | 'legacy';
}
export interface RouteContext {
  /** Settings of the jig open now; none when no jig is open. */
  params?: readonly RouteParam[];
  /** Their current values in stored units. */
  values?: Readonly<Record<string, number | string | boolean>>;
  /** Routing candidates in order (this project's jigs first, src/ui/skill-catalog.ts). */
  jigs?: readonly RouteJig[];
  /** The jig id of the open instance: its own words then change its settings, not reopen it. */
  openJig?: string;
}
export type ParamChange =
  | { ok: true; value: number | string | boolean; text: string }
  | {
      ok: false;
      code: 'PARAM_FIXED' | 'NO_VALUE' | 'NO_DIRECTION' | 'UNIT_MISMATCH' | 'OUT_OF_RANGE';
      text: string;
    };
export interface Route {
  target: RouteTarget;
  /** Who decided: Jev, or the words decided without it. */
  by?: 'jev' | 'rules';
  view?: { action: ViewAction; ids: string[]; subject: string };
  /** The request uses screen-action words (worth showing where it goes, even to the file). */
  viewWords?: boolean;
  param?: { key: string; title: string; change: ParamChange };
  /** Several settings in one request ("경간 11로, 작은보 간격 2.2"): all applied together. */
  params?: { key: string; title: string; change: ParamChange }[];
  app?: { action: AppAction; tier: Tier; provider?: Service; link?: string };
  jig?: { id: string; name: string };
  reason: string;
}

/**
 * Jev descriptions (`intent_en`: English judges best) and rule words of the official jigs, until
 * their v3 manifests carry them in skill.md (ARCH-03 §5.3).
 */
export const OFFICIAL_JIG_ROUTING: Record<string, { intent: string; words: string[] }> = {
  structure: {
    intent:
      'Steel frame structural check from columns, girders and beams drawn in Rhino or CAD: linear analysis, KDS member checks, section sizing, schedules.',
    words: ['구조 검토', '구조 해석', '구조 분석', '구조 계산', '검정비', '부재 검정', '단면 산정'],
  },
  sync: {
    intent:
      'Compare a Rhino model with a CAD drawing: how they sit relative to each other (move, rotation, error) and which objects do not match.',
    words: [
      '도면이랑 모델 어긋',
      '도면과 모델 어긋',
      '모델이랑 도면 어긋',
      '모델과 도면 어긋',
      '도면 모델 비교',
      '정합 검토',
    ],
  },
  knowledge: {
    intent:
      'Status report of the project records (mail, minutes, documents, drawings): what is decided, what is blocked and what changed recently.',
    words: ['프로젝트 현황', '현황 보고'],
  },
};

// Words that name the file itself or change it: these requests always go to the file.
const documentWords =
  /(원본|도면에서|도면을|cad\s*에서|캐드|zwcad|rhino\s*에서|라이노에서|파일에|삭제|지워|없애|레이어[^.]{0,12}(바꿔|변경|옮)|색(상|깔)?[을를]?\s*(바꿔|변경|바꾸)|수정|이동|옮겨|만들어|그려|생성|추가|복사|회전|늘려|줄여|저장)/i;
/** Words that name the file or change it (a jig conversation's turn then uses the host). */
export const worksOnFile = (body: string) => documentWords.test(body) || FILE_WORDS.test(body);
/** Naming the file or program means work on the file, whatever else the words say (decided without Jev). */
export const FILE_WORDS =
  /(원본|파일에서|파일에|도면에서|cad\s*에서|캐드에서|zwcad|rhino\s*에서|라이노에서)/i;
const viewActions: [ViewAction, RegExp][] = [
  [
    'unhide',
    /(모두|전부|다시|숨긴\s*(것|거|객체)?[을를]?)\s*(다\s*)?(보여|보이게|표시)|\bunhide\b|숨김\s*(해제|풀)/i,
  ],
  // English words only as whole words ("selected mass" is not a select request).
  ['isolate', /(만\s*남기고|만\s*(보여|보이게|표시)|격리|\bisolate\b)/i],
  ['hide', /(숨겨|숨기|안\s*보이게|가려|감춰|\bhide\b)/i],
  ['select', /(선택해|골라|\bselect\b(?!ed))/i],
  ['fit', /(확대해|줌|가까이\s*보여|맞춰\s*보여|\bfit\b|\bzoom\b)/i],
];
// Object kinds by the words people use; matched against the object's native type. Short Korean
// words must stand alone: "선" is not in "선택", "면" not in "도면", "점" not in "시점".
const alone = (word: string) => `(?<![가-힣])${word}(?=[만을를들은는이가도\\s]|$)`;
const kinds: [RegExp, RegExp, string][] = [
  [/(텍스트|문자|글자|글씨|주석|text)/i, /(text|annotation|leader)/i, '문자'],
  [/(치수|dimension)/i, /dim/i, '치수'],
  [/(해치|hatch)/i, /hatch/i, '해치'],
  [/(블록|block)/i, /(block|instance)/i, '블록'],
  [
    new RegExp(`(${alone('면')}|서피스|솔리드|메시|surface|solid|brep|mesh)`, 'i'),
    /(brep|surface|extrusion|mesh|subd)/i,
    '면',
  ],
  [
    new RegExp(`(곡선|직선|커브|${alone('선')}|라인|폴리라인|curve|line)`, 'i'),
    /(line|curve|polyline|arc|circle|spline)/i,
    '선',
  ],
  [new RegExp(`(${alone('점')}|point)`, 'i'), /point/i, '점'],
];
const text = (value: unknown) => (typeof value === 'string' ? value : '');
/** Comparison form of words: lower case, no spaces ("구조검토" = "구조 검토"). */
const squash = (value: string) => value.toLowerCase().replace(/\s+/g, '');

// ── Numbers and units (code, not Jev; RESEARCH-10 §8.2). ──────────────────────────────────────
type Dimension = 'length' | 'force' | 'lineLoad' | 'areaLoad' | 'angle' | 'ratio' | 'count';
/** Spoken unit (lower case) → canonical unit. */
const UNIT_WORDS: Record<string, string> = {
  mm: 'mm',
  밀리미터: 'mm',
  밀리: 'mm',
  cm: 'cm',
  센티미터: 'cm',
  센티: 'cm',
  m: 'm',
  미터: 'm',
  'kn/m2': 'kN/m2',
  'kn/㎡': 'kN/m2',
  'kn/m²': 'kN/m2',
  kpa: 'kN/m2',
  'kn/m': 'kN/m',
  kn: 'kN',
  '°': 'deg',
  deg: 'deg',
  도: 'deg',
  '%': '%',
  퍼센트: '%',
  개: 'EA',
  ea: 'EA',
};
/** Canonical unit → dimension and factor to that dimension's base. */
const UNITS: Record<string, [Dimension, number]> = {
  m: ['length', 1],
  mm: ['length', 0.001],
  cm: ['length', 0.01],
  EL: ['length', 1],
  kN: ['force', 1],
  'kN/m': ['lineLoad', 1],
  'kN/m2': ['areaLoad', 1],
  deg: ['angle', 1],
  '%': ['ratio', 1],
  EA: ['count', 1],
};
const TYPE_UNIT: Partial<Record<NonNullable<RouteParam['type']>, string>> = {
  length: 'm',
  level: 'm',
  force: 'kN',
  lineLoad: 'kN/m',
  areaLoad: 'kN/m2',
  angle: 'deg',
  ratio: '%',
  count: 'EA',
};
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// Longest unit first ("900mm" is 900 mm, not 900 m followed by "m"); no letter may follow the unit,
// no digit or identifier may touch the number ("C12", "B-3" are names, not values).
const QUANTITY = new RegExp(
  `(?<![\\w.\\-])(-?\\d+(?:\\.\\d+)?)(?!\\d|\\.\\d)\\s*(${Object.keys(UNIT_WORDS)
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join('|')})?(?![a-zA-Z])`,
  'gi',
);
export interface Quantity {
  value: number;
  /** Canonical unit, or undefined for a bare number. */
  unit?: string;
  end: number;
}
/** Every number in the text with its unit. */
export function quantities(body: string): Quantity[] {
  return [...body.matchAll(QUANTITY)].map((match) => ({
    value: Number(match[1]),
    ...(match[2] ? { unit: UNIT_WORDS[match[2].toLowerCase()] } : {}),
    end: (match.index ?? 0) + match[0].length,
  }));
}
/** The number the request sets: the one followed by 로/으로/까지, else the last one. */
function targetQuantity(body: string) {
  const list = quantities(body);
  return list.filter((q) => /^\s*(으로|로|까지)/.test(body.slice(q.end))).at(-1) ?? list.at(-1);
}
const canonical = (unit: string | undefined) =>
  unit ? (UNITS[unit] ? unit : UNIT_WORDS[unit.toLowerCase()]) : undefined;
const clean = (value: number) => Number(value.toPrecision(12));
/** A value in a unit converted to another of the same dimension, or undefined. */
export function convert(value: number, from: string, to: string): number | undefined {
  const a = UNITS[canonical(from) ?? ''],
    b = UNITS[canonical(to) ?? ''];
  if (!a || !b || a[0] !== b[0]) return undefined;
  return clean((value * a[1]) / b[1]);
}

const storedUnit = (param: RouteParam) =>
  canonical(param.unit) ?? (param.type ? TYPE_UNIT[param.type] : undefined);
const displayUnit = (param: RouteParam) => canonical(param.display?.unit) ?? storedUnit(param);
/** A stored value in the setting's display unit, e.g. "11 m", "900 mm". */
export function formatParam(param: RouteParam, value: number | string | boolean) {
  if (typeof value !== 'number') {
    const choice = param.choices?.find((entry) => entry.value === value);
    return choice?.label ?? (value === true ? '켬' : value === false ? '끔' : String(value));
  }
  const stored = storedUnit(param),
    shown = displayUnit(param);
  const converted = stored && shown ? (convert(value, stored, shown) ?? value) : value;
  const number = String(Number(converted.toFixed(Math.min(param.display?.decimals ?? 3, 6))));
  const raw = param.display?.unit ?? param.unit ?? shown;
  const label = raw === 'EA' ? '개' : raw === 'deg' ? '°' : raw;
  if (!label) return number;
  return ['개', '°', '%'].includes(label) ? number + label : `${number} ${label}`;
}

const TWICE = /(두\s*배|2\s*배)/;
const HALF = /(절반|반으로|반만|반\s*배)/;
// Relative words without a declared direction are not applied (SPEC-07.6): they become a question.
const RELATIVE =
  /(조금\s*더|좀\s*더|촘촘|성기|넓게|좁게|크게|작게|길게|짧게|높게|낮게|늘려|줄여|키워|낮춰|높여|올려|내려)/;
const hits = (body: string, words: readonly string[] | undefined) =>
  (words ?? []).some((word) => word.trim() && squash(body).includes(squash(word)));
const particle = (word: string, withBatchim: string, without: string) => {
  const last = word.charCodeAt(word.length - 1);
  return last >= 0xac00 && last <= 0xd7a3 && (last - 0xac00) % 28 ? withBatchim : without;
};

/**
 * The new value of one setting read from the words (SPEC-02.17 1, SPEC-07.6): an absolute value in
 * any unit of the right kind (a bare number is in the display unit), or a relative change whose
 * direction only the declaration's `words` give (one step, twice, half). A value outside the range,
 * a fixed setting or a direction the declaration does not give is not applied; the text says why.
 */
export function paramChange(
  body: string,
  param: RouteParam,
  current?: number | string | boolean,
): ParamChange {
  const title = param.title;
  const objectMark = particle(title, '을', '를');
  if (param.fixedAtPin)
    return {
      ok: false,
      code: 'PARAM_FIXED',
      text: `${title}${particle(title, '은', '는')} 작업본을 만들 때 정한 값이라 말로 바꿀 수 없습니다.`,
    };
  const before = current ?? param.default;
  const done = (value: number | string | boolean): ParamChange => ({
    ok: true,
    value,
    text:
      before !== undefined && before !== value
        ? `${title} ${formatParam(param, before)} → ${formatParam(param, value)}`
        : `${title} → ${formatParam(param, value)}`,
  });
  if (param.type === 'choice') {
    const choice = param.choices?.find(
      (entry) => hits(body, [entry.label]) || hits(body, [entry.value]),
    );
    return choice
      ? done(choice.value)
      : {
          ok: false,
          code: 'NO_VALUE',
          text: `${title}${objectMark} 무엇으로 바꿀지 찾지 못했습니다.`,
        };
  }
  if (param.type === 'toggle') {
    if (/(끄|꺼|끔|안\s*씀|사용\s*안|\boff\b)/i.test(body)) return done(false);
    if (/(켜|켬|사용|\bon\b)/i.test(body)) return done(true);
    return {
      ok: false,
      code: 'NO_VALUE',
      text: `${title}${objectMark} 켤지 끌지 찾지 못했습니다.`,
    };
  }
  const stored = storedUnit(param);
  const now = typeof before === 'number' ? before : undefined;
  let next: number | undefined;
  const spoken = targetQuantity(body);
  if (spoken) {
    const unit = spoken.unit ?? displayUnit(param);
    next =
      unit && stored ? convert(spoken.value, unit, stored) : spoken.unit ? undefined : spoken.value;
    if (next === undefined)
      return {
        ok: false,
        code: 'UNIT_MISMATCH',
        text: `${title}의 단위(${param.display?.unit ?? param.unit ?? '-'})와 맞지 않는 값입니다.`,
      };
  } else {
    const more = hits(body, param.words?.more),
      less = !more && hits(body, param.words?.less);
    const direction = param.words && (more || less) ? (more ? 1 : -1) * param.words.sign : 0;
    const factor = TWICE.test(body) ? 2 : HALF.test(body) ? 0.5 : undefined;
    if ((factor || direction) && now === undefined)
      return { ok: false, code: 'NO_VALUE', text: `${title}의 지금 값을 몰라 바꾸지 않았습니다.` };
    if (factor && now !== undefined)
      next = clean(
        direction > 0
          ? now * Math.max(factor, 1 / factor)
          : direction < 0
            ? now * Math.min(factor, 1 / factor)
            : now * factor,
      );
    else if (direction && now !== undefined) {
      const step = param.range?.step;
      if (!step)
        return {
          ok: false,
          code: 'NO_VALUE',
          text: `${title}${objectMark} 얼마나 바꿀지 숫자로 말해 주세요.`,
        };
      next = clean(now + direction * step);
    } else if (RELATIVE.test(body))
      return {
        ok: false,
        code: 'NO_DIRECTION',
        text: `이 말이 ${title}${objectMark} 늘리는지 줄이는지 정해져 있지 않습니다. 값을 숫자로 말하거나 AI에 물어 보세요.`,
      };
    else
      return {
        ok: false,
        code: 'NO_VALUE',
        text: `${title}${objectMark} 얼마로 바꿀지 찾지 못했습니다.`,
      };
  }
  const range = param.range;
  if (range && (next < range.min - 1e-9 || next > range.max + 1e-9)) {
    const [low, high] = [range.min, range.max].map((value) => formatParam(param, value));
    const unit = param.display?.unit ?? param.unit ?? '';
    const bare = (value: string) =>
      unit && value.endsWith(' ' + unit) ? value.slice(0, -unit.length - 1) : value;
    return {
      ok: false,
      code: 'OUT_OF_RANGE',
      text: `${title} ${formatParam(param, next)}${particle(formatParam(param, next), '은', '는')} 범위 ${bare(low)}~${high} 밖이라 바꾸지 않았습니다.`,
    };
  }
  return done(next);
}

// ── Words decided without Jev (SPEC-02.17 1, in this order). ─────────────────────────────────
const LOGIN = /(로그인|로그아웃|log\s*-?\s*(in|out)|sign\s*-?\s*(in|out))/i;
const LOGOUT = /(로그아웃|log\s*-?\s*out|sign\s*-?\s*out)/i;
const SERVICES: [RegExp, Service][] = [
  [/(codex|코덱스|chat\s*gpt|챗\s*gpt|챗지피티|gpt|openai)/i, 'codex-cli'],
  [/(claude|클로드)/i, 'claude-cli'],
];
const SYNC = /(sync|싱크|동기화|다시\s*읽)/i;
const SYNC_OBJECT = /(파일|도면|모델|cad|캐드|rhino|라이노|zwcad|dwg|3dm)/i;
const MAKE = /(도구로\s*만들|jig\s*로\s*만들|지그로\s*만들|자동화\s*해)/i;
/** Questions are not setting changes ("보 간격 900 회신 왔어?"). */
const QUESTION = /(\?|왜|어디|뭐야|무엇|알려|찾아)/;
/**
 * Words that act on objects, the file or the screen, or pick objects by a limit ("경간 12 m 넘는
 * 거더 숨겨"): a number beside a setting's key word is then not a value for it. Such a request goes
 * on to the screen rules, the file words or the AI — never to an automatic setting change.
 */
const NOT_A_SETTING =
  /(숨겨|숨기|가려|보여|보이|남기|격리|선택|골라|찍어|확대|줌|그려|만들어|생성|추가|삭제|지워|없애|이동|옮겨|복사|회전|저장|넘는|넘어가는|초과하는|이상인|이하인|미만인)/;
/** Title words that name no setting on their own ("경간 상한" is found by "경간"). */
const GENERIC = new Set([
  '상한',
  '하한',
  '최대',
  '최소',
  '간격',
  '크기',
  '길이',
  '높이',
  '기준',
  '허용',
  '두께',
  '개수',
]);

/** The open setting a request names by the key words of its title, with a value or direction. */
export function paramFor(body: string, params: readonly RouteParam[] | undefined) {
  if (!params?.length || QUESTION.test(body) || NOT_A_SETTING.test(body)) return undefined;
  const words = squash(body);
  const scored = params
    .map((param) => {
      const tokens = param.title
        .split(/[\s·,()/:_-]+/)
        .map(squash)
        .filter((token) => token.length >= 2);
      const own = tokens.filter((token) => !GENERIC.has(token));
      const naming = own.length ? own : tokens;
      if (!naming.some((token) => words.includes(token))) return { param, score: 0 };
      const valued =
        targetQuantity(body) !== undefined ||
        hits(body, param.words?.more) ||
        hits(body, param.words?.less) ||
        TWICE.test(body) ||
        HALF.test(body) ||
        (param.type === 'choice' && param.choices?.some((entry) => hits(body, [entry.label]))) ||
        (param.type === 'toggle' && /(켜|꺼|끄)/.test(body));
      return { param, score: valued ? tokens.filter((token) => words.includes(token)).length : 0 };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  // Two settings named equally ("경간 상한" and "경간 하한" by "경간"): not decided by the rules.
  if (!scored.length || (scored[1] && scored[1].score === scored[0].score)) return undefined;
  return scored[0].param;
}

/** Parts of one request that each may set one value ("경간 11로, 작은보 간격 2.2"). */
const CLAUSES = /[,，;·]|\s(?:그리고|하고|및|또)\s/;
/**
 * Several settings named in one request, each read from its own clause (the one-setting rule of
 * {@link paramFor} per clause). At least two different settings, else undefined.
 */
export function paramsFor(
  body: string,
  params: readonly RouteParam[] | undefined,
): (RouteParam & { text: string })[] | undefined {
  if (!params?.length || QUESTION.test(body)) return undefined;
  const found = new Map<string, RouteParam & { text: string }>();
  for (const clause of body.split(CLAUSES)) {
    const param = paramFor(clause, params);
    if (param) found.set(param.key, { ...param, text: clause });
  }
  return found.size >= 2 ? [...found.values()] : undefined;
}
/**
 * The values a request gives for the settings a jig reads from requests (jig.json
 * `from_request`) when it starts: every clause that names one of them with a value. Settings the
 * words do not give, or give wrongly (out of range, fixed), are left out with their reason.
 */
export function requestValues(
  body: string,
  params: readonly RouteParam[],
  values: Readonly<Record<string, number | string | boolean>> = {},
  keys?: readonly string[],
) {
  const allowed = keys ? params.filter((param) => keys.includes(param.key)) : params;
  const changes = new Map<string, { key: string; title: string; change: ParamChange }>();
  if (!allowed.length) return [];
  for (const clause of body.split(CLAUSES)) {
    // "구조 분석 해줘" names no setting; "경간 11로 해서 구조 분석" names one with its value.
    const param = paramFor(clause.replace(QUESTION, ' '), allowed);
    if (!param) continue;
    changes.set(param.key, {
      key: param.key,
      title: param.title,
      change: paramChange(clause, param, values[param.key]),
    });
  }
  return [...changes.values()];
}

/**
 * The jig a request names by its rule words: the best hit (a phrase over a single word), the
 * catalog's order breaking ties (this project's jigs first). skill.md words are guarded: a
 * request that acts on objects, the file or the screen never opens a jig by them, a single word
 * needs at least two letters and no question, and a `not_for` word rules the jig out.
 */
export function jigFor(body: string, jigs: readonly RouteJig[] | undefined) {
  const acting =
    NOT_A_SETTING.test(body) ||
    FILE_WORDS.test(body) ||
    viewActions.some(([, pattern]) => pattern.test(body));
  const words = squash(body);
  let best: { jig: RouteJig; score: number } | undefined;
  for (const jig of jigs ?? []) {
    const skill = jig.source === 'skill';
    if (skill && hits(body, jig.notFor)) continue;
    let score = 0;
    for (const word of jig.words ?? []) {
      const squashed = squash(word);
      if (!squashed || !words.includes(squashed)) continue;
      const phrase = /\s/.test(word.trim());
      if (skill && (acting || (!phrase && (squashed.length < 2 || QUESTION.test(body))))) continue;
      score = Math.max(score, phrase ? 2 : 1);
    }
    if (score > (best?.score ?? 0)) best = { jig, score };
  }
  return best;
}

/** A route from words that decide it without Jev, or undefined. */
export function decisiveRoute(body: string, context: RouteContext = {}): Route | undefined {
  if (!body.trim()) return undefined;
  if (LOGIN.test(body)) {
    const service = SERVICES.find(([words]) => words.test(body))?.[1];
    if (service) {
      const action: AppAction = LOGOUT.test(body) ? 'logout' : 'login';
      return {
        target: 'app',
        by: 'rules',
        app: { action, tier: APP_TIER[action], provider: service },
        reason: `앱 동작 · ${SERVICE_NAME[service]} ${action === 'login' ? '로그인' : '로그아웃'}`,
      };
    }
  }
  if (SYNC.test(body) && SYNC_OBJECT.test(body))
    return {
      target: 'app',
      by: 'rules',
      app: { action: 'sync_link', tier: APP_TIER.sync_link },
      reason: '앱 동작 · Sync 받기',
    };
  const found = jigFor(body, context.jigs);
  const several = paramsFor(body, context.params);
  const param = several ? undefined : paramFor(body, context.params);
  // The open jig's own words ("끝 붙임 0.5로") and a single topic word beside a setting change
  // its setting; a phrase naming another jig opens that one.
  const settingFirst =
    !!found && (!!param || !!several) && (found.jig.id === context.openJig || found.score < 2);
  // A single word (score 1) is too weak to open a jig by itself ('06-사선격자형이 좋아' is not the
  // grid jig, 2026-10-02): Jev judges it, and without Jev the request goes to the conversation.
  if (found && found.score >= 2 && !settingFirst)
    return {
      target: 'jig',
      by: 'rules',
      jig: { id: found.jig.id, name: found.jig.name ?? found.jig.id },
      reason: 'jig 열기',
    };
  if (MAKE.test(body)) return { target: 'make', by: 'rules', reason: 'jig 만들기' };
  if (several) {
    return {
      target: 'param',
      by: 'rules',
      params: several.map((entry) => ({
        key: entry.key,
        title: entry.title,
        change: paramChange(entry.text, entry, context.values?.[entry.key]),
      })),
      reason: '설정값 변경',
    };
  }
  if (param)
    return {
      target: 'param',
      by: 'rules',
      param: {
        key: param.key,
        title: param.title,
        change: paramChange(body, param, context.values?.[param.key]),
      },
      reason: '설정값 변경',
    };
  if (FILE_WORDS.test(body))
    return {
      target: 'document',
      by: 'rules',
      ...(viewActions.some(([, pattern]) => pattern.test(body)) ? { viewWords: true } : {}),
      reason: '파일 작업',
    };
  return undefined;
}

/** Objects named by the request: by kind words, then layer names, then object names. */
function subjectOf(body: string, objects: readonly RouteObject[]) {
  const lower = body.toLowerCase();
  for (const [words, types, label] of kinds)
    if (words.test(body)) {
      const ids = objects.filter((o) => types.test(text(o.type))).map((o) => o.id);
      if (ids.length) return { ids, subject: label };
    }
  const layers = [...new Set(objects.map((o) => text(o.layer)).filter((l) => l.length >= 2))]
    // Longest first so "구조::보" wins over "보".
    .sort((a, b) => b.length - a.length);
  const layer = layers.find((name) => lower.includes(name.toLowerCase()));
  if (layer)
    return {
      ids: objects.filter((o) => text(o.layer) === layer).map((o) => o.id),
      subject: '레이어 ' + layer,
    };
  const named = objects.filter((o) => {
    const name = text(o.name);
    return name.length >= 2 && lower.includes(name.toLowerCase());
  });
  if (named.length) return { ids: named.map((o) => o.id), subject: '이름이 맞는 객체' };
  return undefined;
}

/**
 * The rules' route: first the words decided without Jev, then screen words without words that
 * name or change the file (view), else the conversation AI (document).
 */
export function routeRequest(
  body: string,
  objects: readonly RouteObject[],
  selected: readonly string[] = [],
  context: RouteContext = {},
): Route {
  const decided = decisiveRoute(body, context);
  if (decided) return decided;
  const found = viewActions.find(([, pattern]) => pattern.test(body));
  if (found && !documentWords.test(body)) {
    const [action] = found;
    if (action === 'unhide')
      return {
        target: 'view',
        view: { action, ids: [], subject: '숨긴 객체' },
        reason: '화면 표시만 바꿉니다',
      };
    const subject =
      subjectOf(body, objects) ??
      (selected.length && /(이것|이거|선택한|선택된|고른)/.test(body)
        ? { ids: [...selected], subject: '선택한 객체' }
        : undefined);
    if (subject)
      return {
        target: 'view',
        view: { action, ...subject },
        reason: '화면 표시만 바꿉니다 · 원본은 그대로',
      };
    return {
      target: 'view',
      view: { action, ids: [], subject: '' },
      reason: '화면에서 어떤 객체인지 찾지 못했습니다',
    };
  }
  return {
    target: 'document',
    ...(found ? { viewWords: true } : {}),
    reason: '파일 작업',
  };
}

/** Object groups offered to Jev: kinds, layers and the current selection (SPEC-02.17). */
export interface Subject {
  id: string;
  label: string;
  ids: string[];
  subject: string;
}
const KIND_NAMES: Record<string, string> = {
  문자: 'text annotations',
  치수: 'dimensions',
  해치: 'hatches',
  블록: 'blocks',
  면: 'surfaces, solids, meshes',
  선: 'lines and curves',
  점: 'points',
};
export function routeSubjects(
  objects: readonly RouteObject[],
  selected: readonly string[] = [],
): Subject[] {
  const out: Subject[] = [];
  if (selected.length)
    out.push({
      id: 'selection',
      label: `the objects the user selected (이것, 선택한 것), ${selected.length} objects`,
      ids: [...selected],
      subject: '선택한 객체',
    });
  for (const [, types, label] of kinds) {
    const ids = objects.filter((o) => types.test(text(o.type))).map((o) => o.id);
    if (ids.length)
      out.push({
        id: 'kind:' + label,
        label: `${label} (${KIND_NAMES[label] ?? label}), ${ids.length} objects`,
        ids,
        subject: label,
      });
  }
  const layers = new Map<string, string[]>();
  for (const o of objects) {
    const layer = text(o.layer);
    if (layer) layers.set(layer, [...(layers.get(layer) ?? []), o.id]);
  }
  for (const [layer, ids] of [...layers].sort((a, b) => b[1].length - a[1].length).slice(0, 30))
    out.push({
      id: 'layer:' + layer,
      label: `layer "${layer}", ${ids.length} objects`,
      ids,
      subject: '레이어 ' + layer,
    });
  return out;
}

/** The server's `/route` answer (src/ai/request-router.ts RouteDecision); `target: null` = rules. */
export interface RouteAnswer {
  target: RouteTarget | null;
  by?: 'jev' | 'rules';
  action?: ViewAction;
  subject?: string;
  param?: string;
  app?: AppAction;
  provider?: Service;
  link?: string;
  jig?: string;
  jigName?: string;
}
/** A checked `/route` answer; anything malformed counts as "leave it to the rules". */
export function routeAnswer(raw: unknown): RouteAnswer {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pick = <T extends string>(field: unknown, allowed: readonly T[]) =>
    allowed.includes(field as T) ? (field as T) : undefined;
  const target = pick(value.target, ROUTE_TARGETS);
  if (!target) return { target: null };
  const string = (field: unknown) =>
    typeof field === 'string' && field.length <= 300 ? field : undefined;
  const entries = {
    by: pick(value.by, ['jev', 'rules'] as const),
    action: pick(value.action, ['hide', 'isolate', 'unhide', 'select', 'fit'] as const),
    subject: string(value.subject),
    param: string(value.param),
    app: pick(value.app, APP_ACTIONS),
    provider: pick(value.provider, ['claude-cli', 'codex-cli'] as const),
    link: string(value.link),
    jig: string(value.jig),
    jigName: string(value.jigName),
  };
  const answer: RouteAnswer = { target };
  for (const [key, field] of Object.entries(entries))
    if (field !== undefined) (answer as unknown as Record<string, unknown>)[key] = field;
  return answer;
}

/**
 * Jev's (or the server rules') answer as a route; undefined keeps the rules' route. When Jev names
 * no objects, the ones the rules found (e.g. "이거" → the selection) are used. A setting answer needs
 * the open setting's declaration (context) and the words (body) for the value.
 */
export function jevRoute(
  decision:
    | RouteAnswer
    | { target: 'view' | 'document' | null; action?: ViewAction; subject?: string },
  subjects: readonly Subject[],
  rules?: Route,
  context: RouteContext = {},
  body = '',
): Route | undefined {
  const answer = decision as RouteAnswer;
  const by = answer.by ?? 'jev';
  const who = by === 'jev' ? 'Jev · ' : '';
  switch (answer.target) {
    case 'document':
      return { target: 'document', by, reason: who + '파일 작업' };
    case 'ask':
      return { target: 'ask', by, reason: who + '자료 질문' };
    case 'make':
      return { target: 'make', by, reason: who + 'jig 만들기' };
    case 'param': {
      const param = context.params?.find((entry) => entry.key === answer.param);
      if (!param) return undefined;
      return {
        target: 'param',
        by,
        param: {
          key: param.key,
          title: param.title,
          change: paramChange(body, param, context.values?.[param.key]),
        },
        reason: who + '설정값 변경',
      };
    }
    case 'app':
      if (!answer.app) return undefined;
      return {
        target: 'app',
        by,
        app: {
          action: answer.app,
          tier: APP_TIER[answer.app],
          ...(answer.provider ? { provider: answer.provider } : {}),
          ...(answer.link ? { link: answer.link } : {}),
        },
        reason: who + '앱 동작',
      };
    case 'jig': {
      if (!answer.jig) return undefined;
      const known = context.jigs?.find((entry) => entry.id === answer.jig);
      return {
        target: 'jig',
        by,
        jig: { id: answer.jig, name: answer.jigName ?? known?.name ?? answer.jig },
        reason: who + 'jig 열기',
      };
    }
    case 'view':
      break;
    default:
      return undefined;
  }
  if (!answer.action) return undefined;
  if (answer.action === 'unhide')
    return {
      target: 'view',
      by,
      view: { action: 'unhide', ids: [], subject: '숨긴 객체' },
      reason: who + '화면 표시만',
    };
  const chosen = subjects.find((subject) => subject.id === answer.subject);
  const found = rules?.view?.ids.length ? rules.view : undefined;
  return {
    target: 'view',
    by,
    view: chosen
      ? { action: answer.action, ids: chosen.ids, subject: chosen.subject }
      : found
        ? { action: answer.action, ids: found.ids, subject: found.subject }
        : { action: answer.action, ids: [], subject: '' },
    reason: who + '화면 표시만',
  };
}

/** What the notice or proposal card of a route without the AI says and offers (SPEC-02.17 2·3). */
export interface RouteCard {
  text: string;
  /** 'auto': already applied (screen or a setting read from the words) — offer the undo. */
  tier: Tier | 'auto';
  /** The one button that carries out a proposal (T1/T2); none for notices. */
  run?: string;
  /** Every notice and card offers 'AI 작업으로 보내기' (undo, then the same words to the AI). */
  toAi: true;
}
/** The route row of a jig start: "S-06 골조 배치로 진행". */
export const jigRouteText = (name: string) => {
  const last = name.charCodeAt(name.length - 1);
  const batchim = last >= 0xac00 && last <= 0xd7a3 ? (last - 0xac00) % 28 : 0;
  // 받침 없음·ㄹ(8) → 로, 그 밖의 받침 → 으로; 한글이 아니면 로.
  return `${name}${batchim && batchim !== 8 ? '으로' : '로'} 진행`;
};
export function routeCard(
  route: Route,
  status: { signedIn?: Partial<Record<Service, boolean>> } = {},
): RouteCard | undefined {
  if (route.param) {
    const change = route.param.change;
    return change.ok
      ? { text: `설정값 ${change.text} · 다시 계산합니다.`, tier: 'auto', toAi: true }
      : { text: change.text, tier: 'R', toAi: true };
  }
  if (route.params?.length) {
    const done = route.params.filter((entry) => entry.change.ok);
    return done.length
      ? {
          text: `설정값 ${done.map((entry) => entry.change.text).join(' · ')} · 다시 계산합니다.`,
          tier: 'auto',
          toAi: true,
        }
      : { text: route.params.map((entry) => entry.change.text).join(' '), tier: 'R', toAi: true };
  }
  // A jig opens at once (user decision 2026-10-01): the route row says so and offers the way back.
  if (route.jig) return { text: jigRouteText(route.jig.name), tier: 'auto', toAi: true };
  if (!route.app) return undefined;
  const service = route.app.provider ? SERVICE_NAME[route.app.provider] : '';
  switch (route.app.action) {
    // Accounts are signed in and switched outside VIDE (ADR-025): the card says where.
    case 'login':
      if (route.app.provider && status.signedIn?.[route.app.provider])
        return { text: `${service}는 이미 로그인돼 있습니다.`, tier: 'R', toAi: true };
      return {
        text: `${service || 'AI 서비스'} 로그인은 터미널이나 AccountSwitch에서 합니다. 로그인하면 VIDE가 그 계정으로 보냅니다.`,
        tier: 'R',
        toAi: true,
      };
    case 'logout':
      return {
        text: `${service || 'AI 서비스'} 로그아웃은 터미널이나 AccountSwitch에서 합니다.`,
        tier: 'R',
        toAi: true,
      };
    case 'switch_account':
      return {
        text: `${service ? service + ' ' : ''}계정 전환은 AccountSwitch에서 합니다. 바꾼 뒤 보내는 요청부터 그 계정으로 갑니다.`,
        tier: 'R',
        toAi: true,
      };
    case 'sync_link':
      return {
        text: `${route.app.link ? route.app.link + '을(를) ' : '연결 파일을 '}다시 Sync 받을까요?`,
        tier: 'T1',
        run: 'Sync 받기',
        toAi: true,
      };
    case 'install_connector':
      return {
        text: '연결 프로그램(Rhino·ZWCAD 플러그인)을 설치할까요? 프로그램을 다시 열어야 적용됩니다.',
        tier: 'T2',
        run: '설치',
        toAi: true,
      };
    case 'export':
      return { text: '내보내기 창을 열까요?', tier: 'T1', run: '내보내기', toAi: true };
    case 'offline_view':
      return {
        text: '계정 사이트의 오프라인 보기 설정을 열까요?',
        tier: 'T2',
        run: '설정 열기',
        toAi: true,
      };
  }
}

// ── The composer's side (T-049): what it tells the router and what it records. ───────────────
/** Screen names of the official jigs offered by their rule words. */
const OFFICIAL_JIG_NAMES: Record<string, string> = {
  structure: '구조 검토',
  sync: '모델·도면 정합',
  knowledge: '프로젝트 현황',
};
/** The official jigs as the rules see them (their words open a jig without Jev). */
export function officialRouteJigs(): RouteJig[] {
  return Object.entries(OFFICIAL_JIG_ROUTING).map(([id, entry]) => ({
    id,
    name: OFFICIAL_JIG_NAMES[id] ?? id,
    words: entry.words,
  }));
}
const PARAM_TYPES = new Set<NonNullable<RouteParam['type']>>([
  'length',
  'area',
  'force',
  'lineLoad',
  'areaLoad',
  'angle',
  'ratio',
  'count',
  'level',
  'choice',
  'toggle',
]);
/**
 * The open jig instance's settings (the engine's ParamView, ARCH-03 §4) as routing context: the
 * declarations the words are read against and the current values in stored units. Malformed rows
 * are left out, so a setting the screen cannot read is never changed from words.
 */
export function instanceRouteContext(params: unknown): {
  params: RouteParam[];
  values: Record<string, number | string | boolean>;
} {
  const out: RouteParam[] = [];
  const values: Record<string, number | string | boolean> = {};
  for (const raw of Array.isArray(params) ? params : []) {
    const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (typeof p.key !== 'string' || typeof p.title !== 'string') continue;
    const param: RouteParam = { key: p.key, title: p.title };
    if (typeof p.help === 'string') param.help = p.help;
    if (PARAM_TYPES.has(p.type as NonNullable<RouteParam['type']>))
      param.type = p.type as RouteParam['type'];
    if (typeof p.unit === 'string' && p.unit) param.unit = p.unit;
    if (typeof p.displayUnit === 'string' && p.displayUnit)
      param.display = {
        unit: p.displayUnit,
        decimals: typeof p.decimals === 'number' ? p.decimals : 3,
      };
    const range = p.range as RouteParam['range'] | undefined;
    if (
      range &&
      typeof range.min === 'number' &&
      typeof range.max === 'number' &&
      typeof range.step === 'number'
    )
      param.range = { min: range.min, max: range.max, step: range.step };
    if (Array.isArray(p.choices))
      param.choices = (p.choices as { value?: unknown; label?: unknown }[])
        .filter((c) => typeof c?.value === 'string')
        .map((c) => ({
          value: c.value as string,
          label: typeof c.label === 'string' ? c.label : (c.value as string),
        }));
    const words = p.words as RouteParam['words'] | undefined;
    if (
      words &&
      Array.isArray(words.more) &&
      Array.isArray(words.less) &&
      (words.sign === 1 || words.sign === -1)
    )
      param.words = { more: words.more, less: words.less, sign: words.sign };
    if (p.fixedAtPin === true) param.fixedAtPin = true;
    out.push(param);
    if (['number', 'string', 'boolean'].includes(typeof p.value))
      values[p.key] = p.value as number | string | boolean;
  }
  return { params: out, values };
}
/** The `/route` query: the words, the object groups and the open jig's settings (title and help only). */
export function routeQuery(body: string, subjects: readonly Subject[], context: RouteContext = {}) {
  return {
    body,
    ...(context.openJig ? { openJig: context.openJig } : {}),
    subjects: subjects.map(({ id, label }) => ({ id, label })),
    ...(context.params?.length
      ? {
          params: context.params.map(({ key, title, help }) => ({
            key,
            title,
            ...(help ? { help } : {}),
          })),
        }
      : {}),
  };
}
/** What 'AI 작업으로 보내기' records (`/route/revert`): the route it undid and who chose it. */
export const routeRevert = (route: Route) => ({ target: route.target, by: route.by ?? 'rules' });
/** Routes the composer hands to the conversation AI unchanged (SPEC-02.17 2). */
export const goesToAi = (route: Route) => AI_ROUTES.includes(route.target);
