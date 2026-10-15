// The jig's 명세 (`README.md`, SPEC-07.2 명세 규칙, ARCH-03 §2.1·§5.3·§11, PLAN-54 T-353): the
// natural-language source of truth of a jig. Pure (no file system, no DOM) — the engine, the make
// screen and the tests share it. It reads the nine fixed sections (`## ①`…`## ⑨`), builds the
// AI 설명서 fields (`examples`·`words`·`not_for`) from section ②, writes a spec draft from the
// start form or from `jig.json` ([명세 고치기]), and compares the spec with the manifest
// (`spec-match`: inputs, settings, result kinds, gate count). The words the screen shows are
// Design's; the sentences here are the architectural ones the step rail and refusals carry.

import { parseFrontMatter } from '../ui/skill-catalog.ts';

export const SPEC_MARKS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'] as const;
export type SpecMark = (typeof SPEC_MARKS)[number];
/** The fixed section titles (SPEC-07.2 명세 규칙 1); the mark finds a section, the title may vary. */
export const SPEC_TITLES: Record<SpecMark, string> = {
  '①': '목적',
  '②': '언제 쓰나 / 언제 아니다',
  '③': '입력',
  '④': '설정값',
  '⑤': '단계',
  '⑥': '결과',
  '⑦': '통과 조건',
  '⑧': '한계·가정',
  '⑨': '이력',
};
/** The line an empty section of a draft spec holds (the AI fills it from the plan). */
export const SPEC_EMPTY = '아직 적지 않음';

export interface SpecSection {
  mark: SpecMark;
  title: string;
  /** The text under the heading up to the next `## ` line, trimmed. */
  body: string;
}
export interface ParsedSpec {
  /** The `# ` title line, when there is one. */
  title: string | null;
  sections: Partial<Record<SpecMark, SpecSection>>;
  /** Marks without a section. */
  missing: SpecMark[];
  /** Marks that appear more than once (the spec counts as missing). */
  duplicate: SpecMark[];
  /** Every section is there exactly once ('명세 없음' otherwise, ARCH-03 §2.1). */
  complete: boolean;
}

const lf = (text: string) => text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

/** The nine sections of a spec text (`## ①`…`## ⑨`, the mark right after `## `). */
export function parseSpecReadme(text: string | null | undefined): ParsedSpec {
  const sections: ParsedSpec['sections'] = {};
  const seen = new Map<SpecMark, number>();
  let title: string | null = null;
  if (typeof text === 'string') {
    let current: { mark: SpecMark; title: string; lines: string[] } | null = null;
    const close = () => {
      if (current && !sections[current.mark])
        sections[current.mark] = {
          mark: current.mark,
          title: current.title,
          body: current.lines.join('\n').trim(),
        };
    };
    let fence = false;
    for (const line of lf(text).split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      if (!fence && title === null && /^# \S/.test(line)) title = line.slice(2).trim();
      const heading = fence ? null : /^##(?!#) ?(\S)\s*(.*)$/.exec(line);
      if (heading) {
        close();
        current = null;
        const mark = heading[1] as SpecMark;
        if ((SPEC_MARKS as readonly string[]).includes(mark)) {
          seen.set(mark, (seen.get(mark) ?? 0) + 1);
          current = { mark, title: heading[2].trim(), lines: [] };
        }
        continue;
      }
      current?.lines.push(line);
    }
    close();
  }
  const missing = SPEC_MARKS.filter((mark) => !seen.has(mark));
  const duplicate = SPEC_MARKS.filter((mark) => (seen.get(mark) ?? 0) > 1);
  return {
    title,
    sections,
    missing,
    duplicate,
    complete: !missing.length && !duplicate.length,
  };
}

const asSpec = (spec: ParsedSpec | string | null | undefined) =>
  typeof spec === 'string' || spec === null || spec === undefined ? parseSpecReadme(spec) : spec;

/** The first paragraph of ① 목적 (the card's description, Design SCR-18), or null. */
export function specPurpose(spec: ParsedSpec | string | null | undefined): string | null {
  const body = asSpec(spec).sections['①']?.body;
  if (!body) return null;
  const first = body
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith('#') && !part.startsWith('|'));
  if (!first || first === SPEC_EMPTY) return null;
  return first.replace(/\s*\n\s*/g, ' ');
}

// ── Blocks inside a section ────────────────────────────────────────────────────────────────
interface SubBlock {
  /** `### ` heading, or null for the text before the first one. */
  heading: string | null;
  lines: string[];
}
function subBlocks(body: string): SubBlock[] {
  const blocks: SubBlock[] = [{ heading: null, lines: [] }];
  for (const line of body.split('\n')) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) blocks.push({ heading: heading[1], lines: [] });
    else blocks[blocks.length - 1].lines.push(line);
  }
  return blocks;
}
const cleanItem = (text: string) =>
  text.replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
/** List items (`- `, `* `, `1. `) of a block, cleaned of emphasis, without repeats. */
function listItems(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const match = /^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(line);
    if (!match) continue;
    const item = cleanItem(match[1]);
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
}

interface Table {
  header: string[];
  rows: string[][];
}
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
/** The Markdown tables of some lines (a header row, a `---` row, then rows). */
function tables(lines: readonly string[]): Table[] {
  const out: Table[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) continue;
    const header = cells(lines[i]);
    if (!/^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) continue;
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith('|'); j++) rows.push(cells(lines[j]));
    out.push({ header, rows });
    i = j - 1;
  }
  return out;
}

// ── ② → the AI 설명서 fields ──────────────────────────────────────────────────────────────
export interface SpecSkillFields {
  examples: string[];
  words: string[];
  notFor: string[];
}
const SKILL_HEADINGS: Record<keyof SpecSkillFields, string> = {
  examples: '언제 쓰나',
  words: '판정 낱말',
  notFor: '언제 아니다',
};
/** `examples`·`words`·`not_for` from the three sub-headings of ② (ARCH-03 §5.3; any order). */
export function skillFieldsFromSpec(spec: ParsedSpec | string | null | undefined): SpecSkillFields {
  const fields: SpecSkillFields = { examples: [], words: [], notFor: [] };
  const body = asSpec(spec).sections['②']?.body;
  if (!body) return fields;
  for (const block of subBlocks(body)) {
    if (!block.heading) continue;
    const name = baseName(block.heading);
    for (const key of Object.keys(SKILL_HEADINGS) as (keyof SpecSkillFields)[])
      if (name === baseName(SKILL_HEADINGS[key]) && !fields[key].length)
        fields[key] = listItems(block.lines).slice(0, 60);
  }
  return fields;
}

const needsQuote = (item: string) => /[,[\]"':#]/.test(item) || item !== item.trim();
function yamlList(key: string, items: readonly string[]): string[] {
  if (items.every((item) => !(item.includes('"') && item.includes("'"))))
    return [
      `${key}: [${items
        .map((item) => (needsQuote(item) ? (item.includes('"') ? `'${item}'` : `"${item}"`) : item))
        .join(', ')}]`,
    ];
  return [`${key}:`, ...items.map((item) => `  - ${item}`)];
}
const SKILL_KEYS: [keyof SpecSkillFields, string][] = [
  ['examples', 'examples'],
  ['words', 'words'],
  ['notFor', 'not_for'],
];
/**
 * `skill.md` with its `examples`·`words`·`not_for` replaced by the spec's (ARCH-03 §5.3): the other
 * front-matter fields and the body stay; an empty list removes its field. Without a `skill.md` (or
 * front matter) a new one is made from `name`, `description` and the three fields.
 */
export function rewriteSkillFrontMatter(
  skill: string | null | undefined,
  fields: SpecSkillFields,
  fallback: { name: string; description?: string | null },
): string {
  const lines = lf(skill ?? '').split('\n');
  const end =
    lines[0]?.trim() === '---' ? lines.findIndex((l, i) => i > 0 && l.trim() === '---') : -1;
  const generated = SKILL_KEYS.flatMap(([field, key]) =>
    fields[field].length ? yamlList(key, fields[field]) : [],
  );
  if (end < 0) {
    const description = (fallback.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const head = [
      '---',
      `name: ${fallback.name.replace(/\s+/g, ' ').trim()}`,
      ...(description ? [`description: ${description}`] : []),
      ...generated,
      '---',
      '',
    ];
    const rest = (skill ?? '').trim();
    return head.join('\n') + (rest ? `\n${rest}\n` : `\n# ${fallback.name.trim()}\n`);
  }
  const front = lines.slice(1, end);
  const kept: string[] = [];
  const fieldOf = new Map(SKILL_KEYS.map(([field, key]) => [key, field]));
  const done = new Set<string>();
  let lastOwned = -1;
  for (let i = 0; i < front.length; i++) {
    const match = /^([A-Za-z_][\w-]*)\s*:/.exec(front[i]);
    const field = match ? fieldOf.get(match[1]) : undefined;
    if (match && field) {
      // Skip the block list or block text of the key; the new value takes its place.
      while (i + 1 < front.length && (/^\s+\S/.test(front[i + 1]) || /^\s*-\s/.test(front[i + 1])))
        i++;
      if (!done.has(match[1]) && fields[field].length)
        kept.push(...yamlList(match[1], fields[field]));
      done.add(match[1]);
      lastOwned = kept.length;
      continue;
    }
    kept.push(front[i]);
  }
  // Fields the file did not have: after the last of the three, else after name/description.
  const added = SKILL_KEYS.filter(([field, key]) => !done.has(key) && fields[field].length).flatMap(
    ([field, key]) => yamlList(key, fields[field]),
  );
  const insertAt =
    lastOwned >= 0
      ? lastOwned
      : kept.reduce(
          (at, line, index) => (/^(name|description)\s*:/.test(line) ? index + 1 : at),
          0,
        );
  kept.splice(insertAt, 0, ...added);
  return ['---', ...kept, '---', ...lines.slice(end + 1)].join('\n');
}

/** The three fields as a `skill.md` front matter reads them back (for comparisons in tests). */
export function skillFieldsOf(skill: string): SpecSkillFields {
  const raw = parseFrontMatter(skill);
  const list = (value: unknown) => (Array.isArray(value) ? value : value ? [String(value)] : []);
  return { examples: list(raw.examples), words: list(raw.words), notFor: list(raw.not_for) };
}

// ── A spec draft ─────────────────────────────────────────────────────────────────────────────
export interface SpecDraftInput {
  name: string;
  purpose?: string;
  when?: string[];
  notWhen?: string[];
  /** Section ③ rows: the role and its form. */
  inputs?: { role: string; form?: string; required?: boolean; source?: string }[];
  /** Section ④ rows. */
  params?: {
    name: string;
    key?: string;
    unit?: string;
    value?: string;
    range?: string;
    basis?: string;
  }[];
  /** Section ⑤: steps in order; `person` marks the steps a person takes (【사람】). */
  steps?: { name: string; by?: string; person?: boolean; note?: string }[];
  /** Section ⑥: kind label → one line. */
  outputs?: { kind: string; text?: string }[];
  /** Section ⑦: one line per check. */
  checks?: string[];
  /** Section ⑧ lines. */
  limits?: string[];
  /** Section ⑨: the first row. */
  history?: { version: string; date: string; reason: string };
}
const cell = (text: string | undefined) =>
  (text ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim() || '-';
/** A spec in the fixed form (SPEC-07.2); an empty section holds one line `아직 적지 않음`. */
export function specDraft(input: SpecDraftInput): string {
  const out: string[] = [`# ${input.name.trim()}`, ''];
  const section = (mark: SpecMark, body: string[]) => {
    out.push(`## ${mark} ${SPEC_TITLES[mark]}`, '');
    out.push(...(body.length ? body : [SPEC_EMPTY]), '');
  };
  section('①', input.purpose?.trim() ? [input.purpose.trim()] : []);
  const when = (input.when ?? []).map((line) => line.trim()).filter(Boolean);
  const notWhen = (input.notWhen ?? []).map((line) => line.trim()).filter(Boolean);
  section(
    '②',
    when.length || notWhen.length
      ? [
          '### 언제 쓰나',
          '',
          ...(when.length ? when.map((line) => `- ${line}`) : [SPEC_EMPTY]),
          '',
          '### 언제 아니다',
          '',
          ...(notWhen.length ? notWhen.map((line) => `- ${line}`) : [SPEC_EMPTY]),
        ]
      : [],
  );
  const inputs = input.inputs ?? [];
  section(
    '③',
    inputs.length
      ? [
          '| 역할 | 형태 | 필수 | 출처 |',
          '|---|---|---|---|',
          ...inputs.map(
            (row) =>
              `| ${cell(row.role)} | ${cell(row.form)} | ${row.required === undefined ? '-' : row.required ? '필수' : '선택'} | ${cell(row.source)} |`,
          ),
        ]
      : [],
  );
  const params = input.params ?? [];
  section(
    '④',
    params.length
      ? [
          '| 이름(코드값) | 단위 | 기본 | 범위 | 근거 |',
          '|---|---|---|---|---|',
          ...params.map(
            (row) =>
              `| ${cell(row.name)}${row.key ? ` (\`${row.key}\`)` : ''} | ${cell(row.unit)} | ${cell(row.value)} | ${cell(row.range)} | ${cell(row.basis)} |`,
          ),
        ]
      : [],
  );
  const steps = input.steps ?? [];
  section(
    '⑤',
    steps.length
      ? [
          ...(steps.some((step) => step.person)
            ? ['【사람】은 사람이 확인하거나 골라야 다음으로 넘어가는 곳이다.', '']
            : []),
          ...steps.map(
            (step, index) =>
              `${index + 1}. ${step.person ? '【사람】 ' : ''}**${step.name.trim()}**${step.by ? ` — ${step.by}` : ''}${step.note?.trim() ? `. ${step.note.trim()}` : ''}`,
          ),
        ]
      : [],
  );
  const outputs = input.outputs ?? [];
  section(
    '⑥',
    outputs.map((row) => `- **${row.kind}:** ${row.text?.trim() || SPEC_EMPTY}`),
  );
  section(
    '⑦',
    (input.checks ?? []).filter((line) => line.trim()).map((line, i) => `${i + 1}. ${line.trim()}`),
  );
  section(
    '⑧',
    (input.limits ?? []).filter((line) => line.trim()).map((line) => `- ${line.trim()}`),
  );
  const history = input.history;
  section(
    '⑨',
    history
      ? [
          '| 버전 | 날짜 | 바꾼 이유 |',
          '|---|---|---|',
          `| ${cell(history.version)} | ${cell(history.date)} | ${cell(history.reason)} |`,
        ]
      : [],
  );
  return out.join('\n').replace(/\n+$/, '\n');
}

/** ⑨ with one more history row (a table is started when the section has none). */
export function appendHistory(
  text: string,
  row: { version: string; date: string; reason: string },
): string {
  const line = `| ${cell(row.version)} | ${cell(row.date)} | ${cell(row.reason)} |`;
  return replaceSection(text, '⑨', (body) => {
    const lines = body.split('\n');
    const last = lines.reduce((at, l, i) => (l.trim().startsWith('|') ? i : at), -1);
    if (last >= 0 && tables(lines).length) {
      lines.splice(last + 1, 0, line);
      return lines.join('\n');
    }
    // A history written as a list (`- v0.1.0 · 날짜 · 이유`) goes on as a list.
    const item = lines.reduce((at, l, i) => (/^\s*[-*]\s+\S/.test(l) ? i : at), -1);
    if (item >= 0) {
      lines.splice(item + 1, 0, `- ${row.version} · ${row.date} · ${row.reason}`);
      return lines.join('\n');
    }
    const rest = body.trim() === SPEC_EMPTY ? '' : body.trim();
    return [rest, '| 버전 | 날짜 | 바꾼 이유 |', '|---|---|---|', line].filter(Boolean).join('\n');
  });
}
/** The reason of the last ⑨ row (the '명세 고침 · 이력: <이유>' line), or null. */
export function lastHistoryReason(spec: ParsedSpec | string | null | undefined): string | null {
  const body = asSpec(spec).sections['⑨']?.body;
  if (!body) return null;
  const table = tables(body.split('\n'))[0];
  const row = table?.rows[table.rows.length - 1];
  if (!row) {
    // A list history: the last item's text after its last ' · '.
    const items = listItems(body.split('\n'));
    const last = items[items.length - 1];
    return last ? (last.split(' · ').pop() ?? last).trim() || null : null;
  }
  const at = table.header.findIndex((h) => h.includes('이유'));
  return cleanItem(row[at >= 0 ? at : row.length - 1] ?? '') || null;
}

/** The text with one section's body replaced (the heading line is kept; a missing one is added). */
export function replaceSection(
  text: string,
  mark: SpecMark,
  body: (current: string) => string,
): string {
  const lines = lf(text).split('\n');
  const start = lines.findIndex((line) => new RegExp(`^## ?${mark}`).test(line));
  if (start < 0) {
    const next = body('').trim();
    return `${lf(text).replace(/\n+$/, '')}\n\n## ${mark} ${SPEC_TITLES[mark]}\n\n${next}\n`;
  }
  let end = start + 1;
  while (end < lines.length && !/^## /.test(lines[end])) end++;
  const current = lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
  const next = body(current).trim();
  const tail = lines.slice(end);
  return [...lines.slice(0, start + 1), '', next, ...(tail.length ? [''] : []), ...tail]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

// ── spec-match ───────────────────────────────────────────────────────────────────────────────
export type SpecMatchSection = '③' | '④' | '⑥' | '⑦';
export interface SpecDifference {
  section: SpecMatchSection;
  /** The input, setting or kind the line is about (the gate count has '통과 조건'). */
  item: string;
  field: 'missing' | 'extra' | 'unit' | 'default' | 'count' | 'kind';
  /** The spec's value ('' when the spec has none). */
  spec: string;
  /** The manifest's value ('' when the manifest has none). */
  jig: string;
}
export interface SpecMatch {
  ok: boolean;
  differences: SpecDifference[];
}

/** The part of a name before its trailing brackets, case- and width-folded (ARCH-03 §11). */
export function baseName(name: string): string {
  let text = name.normalize('NFKC').replace(/`/g, '').trim();
  for (;;) {
    const next = text.replace(/\s*\([^()]*\)\s*$/, '').trim();
    if (next === text || !next) break;
    text = next;
  }
  return text.replace(/\s+/g, ' ').toLowerCase();
}
/** The code value in a name's last brackets (`이름 (\`key\`)`, `이름(key)`), when it is one. */
function codeOf(name: string): string | null {
  const match = /\(\s*`?([A-Za-z_][A-Za-z0-9_]*)`?\s*\)\s*$/.exec(name.normalize('NFKC'));
  return match ? match[1] : null;
}

const UNITS: Record<string, string> = {
  도: 'deg',
  '°': 'deg',
  deg: 'deg',
  '㎡': 'm2',
  'm²': 'm2',
  m2: 'm2',
  '㎥': 'm3',
  'm³': 'm3',
  m3: 'm3',
  '%': '%',
  비율: '%',
  ratio: '%',
  개: 'EA',
  ea: 'EA',
  층: 'EA',
  대: 'EA',
  번호: 'EA',
  개소: 'EA',
  선택: 'choice',
  choice: 'choice',
  '켬/끔': 'onoff',
  '켬·끔': 'onoff',
  toggle: 'onoff',
  비: '%',
  배: '%',
  '-': '',
  '—': '',
};
/** One unit in the normalized form of the ARCH-03 §11 table (unknown units as written). */
export function normalizeUnit(unit: string | undefined | null): string {
  // `m (화면 mm)`, `EL(m)`: the note in brackets is not the unit.
  const text = (unit ?? '')
    .normalize('NFKC')
    .replace(/`/g, '')
    .replace(/\s*\([^()]*\)\s*$/, '')
    .trim();
  if (!text) return '';
  const known = UNITS[text] ?? UNITS[text.toLowerCase()];
  return known ?? text;
}

interface ManifestLike {
  inputs?: unknown;
  params?: unknown;
  steps?: unknown;
  panel?: unknown;
  bake?: unknown;
  outputs?: unknown;
  reports?: unknown;
}
interface ParamLike {
  key?: unknown;
  title?: unknown;
  type?: unknown;
  unit?: unknown;
  display?: { unit?: unknown };
  default?: unknown;
  choices?: unknown;
}
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The unit a setting shows in: `display.unit` → `unit` → its type (ARCH-03 §11 ④). */
export function paramUnit(param: ParamLike): string {
  if (param.display && typeof param.display.unit === 'string')
    return normalizeUnit(param.display.unit);
  if (typeof param.unit === 'string' && param.unit) return normalizeUnit(param.unit);
  if (param.type === 'ratio') return '%';
  if (param.type === 'choice') return 'choice';
  return '';
}
/** Units a spec may write for a setting: the shown one, the stored one, or its type's (§11 ④). */
function paramUnits(param: ParamLike): Set<string> {
  const units = new Set([paramUnit(param)]);
  if (typeof param.unit === 'string') units.add(normalizeUnit(param.unit));
  if (param.type === 'ratio') units.add('%');
  if (param.type === 'count') units.add('EA');
  if (param.type === 'toggle') units.add('onoff').add('');
  if (param.type === 'choice') units.add('choice').add('');
  return units;
}
const choicesOf = (param: ParamLike) =>
  arr(param.choices) as { value?: unknown; label?: unknown }[];
/** The factor from a setting's stored value to the unit it shows in (m shown as mm, ratio as %). */
function shownFactor(param: ParamLike): number {
  const shown = paramUnit(param);
  if (param.type === 'ratio' && shown === '%') return 100;
  if (str(param.unit) === 'm' && shown === 'mm') return 1000;
  return 1;
}
const numberIn = (text: string): number | null => {
  const match = /[-+]?\d[\d,]*(?:\.\d+)?|[-+]?\.\d+/.exec(text.replace(/\s/g, ''));
  if (!match) return null;
  const value = Number(match[0].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
};
const sameNumber = (a: number, b: number) =>
  a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const TRUE_WORDS = ['예', '켬', '켜짐', 'true', '참', '포함'];
const FALSE_WORDS = ['아니오', '아니요', '끔', '꺼짐', 'false', '거짓', '안 함', '포함 안 함'];
/** Whether the spec's default text means the manifest's default (ARCH-03 §11 기본값 비교). */
function sameDefault(text: string, param: ParamLike): boolean {
  const raw = cleanItem(text);
  const value = param.default;
  if (typeof value === 'boolean') {
    const word = baseName(raw);
    return value ? TRUE_WORDS.includes(word) : FALSE_WORDS.includes(word);
  }
  if (param.type === 'choice' || typeof value === 'string') {
    const chosen = choicesOf(param).find((choice) => choice?.value === value);
    const names = [str(value), str(chosen?.label)].filter(Boolean).map(baseName);
    // `면 위 길이(arc-length)`: the whole text, its part before brackets, or the bracketed code.
    const bracket = /\(([^()]*)\)\s*$/.exec(raw.normalize('NFKC'))?.[1] ?? '';
    return [raw, bracket].filter(Boolean).some((text) => names.includes(baseName(text)));
  }
  if (typeof value === 'number') {
    // The stored value or the shown one (`1.2 (1,200 mm)`, `0.05 m(50 mm)`, `30 %`).
    const spec = numberIn(raw);
    return (
      spec !== null && (sameNumber(spec, value) || sameNumber(spec, value * shownFactor(param)))
    );
  }
  return baseName(raw) === baseName(String(value ?? ''));
}
const shownDefault = (param: ParamLike): string => {
  const value = param.default;
  if (typeof value === 'number') {
    const shown = value * shownFactor(param);
    const unit = paramUnit(param);
    const text = Number.isInteger(shown)
      ? shown.toLocaleString('en-US')
      : String(+shown.toFixed(6));
    return unit && unit !== 'choice' ? `${text} ${unit === 'deg' ? '°' : unit}` : text;
  }
  if (typeof value === 'boolean') return value ? '켬' : '끔';
  const chosen = choicesOf(param).find((choice) => choice?.value === value);
  return str(chosen?.label) || String(value ?? '');
};

/** ③: input names — `###` headings, or the first column of the tables (ARCH-03 §11). */
function specInputs(body: string): string[] {
  const names: string[] = [];
  const add = (name: string) => {
    const clean = cleanItem(name);
    if (clean && clean !== '-' && !names.some((known) => baseName(known) === baseName(clean)))
      names.push(clean);
  };
  for (const block of subBlocks(body)) {
    const found = tables(block.lines);
    if (!found.length) {
      if (block.heading) add(block.heading);
      continue;
    }
    for (const table of found) {
      const first = baseName(table.header[0] ?? '');
      // Roles of one assembled input under its own heading: the heading is the input.
      if (block.heading && first === '역할') {
        add(block.heading);
        continue;
      }
      // A table that names the input in an '입력' column (roles in another).
      const column = table.header.findIndex((h) => baseName(h) === '입력');
      for (const row of table.rows) add(row[column >= 0 ? column : 0] ?? '');
    }
  }
  return names;
}
/** ④: the rows of every table with a 기본 column — name, unit and default text. */
function specParams(body: string) {
  const rows: { name: string; unit: string | null; value: string | null }[] = [];
  for (const table of tables(body.split('\n'))) {
    const header = table.header.map((h) => baseName(h));
    const valueAt = header.findIndex((h) => h === '기본' || h === '기본값');
    if (valueAt < 0) continue;
    const unitAt = header.findIndex((h) => h === '단위');
    for (const row of table.rows)
      if (row[0]?.trim())
        rows.push({
          name: row[0],
          unit: unitAt >= 0 ? (row[unitAt] ?? '') : null,
          value: row[valueAt] ?? '',
        });
  }
  return rows;
}
const RESULT_KINDS = ['화면', 'Rhino에 만들기', '넘겨줄 결과', '파일'] as const;
type ResultKind = (typeof RESULT_KINDS)[number];
/** ⑥: the result kinds the spec names (`###` or a bold lead), a kind that says 없음 left out. */
function specKinds(body: string): Set<ResultKind> {
  const kinds = new Set<ResultKind>();
  const lines = body.split('\n');
  const kindOf = (label: string) =>
    RESULT_KINDS.find((kind) => baseName(label.replace(/[:：]\s*$/, '')) === baseName(kind));
  const says없음 = (rest: string) => /^[\s:：—–-]*없음/.test(rest);
  /** The first non-empty line after line `i`, list mark removed (a lone `- 없음.` means none). */
  const nextLine = (i: number) =>
    (lines.slice(i + 1).find((line) => line.trim()) ?? '').replace(/^\s*[-*]\s+/, '');
  for (let i = 0; i < lines.length; i++) {
    const heading = /^###\s+(.+?)\s*$/.exec(lines[i]);
    if (heading) {
      const kind = kindOf(heading[1]);
      if (!kind) continue;
      const next = nextLine(i);
      if (!/^#/.test(next) && says없음(next)) continue;
      kinds.add(kind);
      continue;
    }
    const lead = /^\s*(?:[-*]\s+)?\*\*([^*]+?)\*\*(.*)$/.exec(lines[i]);
    if (!lead) continue;
    const label = lead[1].replace(/[:：]\s*$/, '');
    const kind = kindOf(label.replace(/\s*\(.*$/, ''));
    if (!kind) continue;
    // `**Rhino에 만들기**(출력 레이어 …)` — the brackets after the bold are not the 없음 test.
    const rest = lead[2].replace(/^\s*\([^)]*\)/, '');
    if (says없음(rest)) continue;
    if (!rest.trim() && says없음(nextLine(i))) continue;
    kinds.add(kind);
  }
  return kinds;
}
/**
 * ⑦: the items of the leftmost numbered list (indented lists and paragraphs not counted). A spec
 * that writes its checks as a table counts the rows whose first cell is a number instead.
 */
function specGateCount(body: string): number {
  const lines = body.split('\n');
  const listed = lines.filter((line) => /^\d+\.\s+\S/.test(line)).length;
  if (listed) return listed;
  return lines.filter((line) => /^\|\s*\d+\s*\|/.test(line)).length;
}

/** Panel parts that give the person a file (a table's CSV, a report's HTML). */
export const FILE_PARTS = ['table', 'report', 'compliance-result', 'paneling-result'] as const;
/** Whether a `panel.json` text has a part of `FILE_PARTS`. */
export function panelWritesFiles(panel: string | null | undefined): boolean {
  if (!panel) return false;
  return FILE_PARTS.some((part) => new RegExp(`"part"\\s*:\\s*"${part}"`).test(panel));
}
export interface SpecMatchOptions {
  /** The panel has a part that writes files (`panelWritesFiles`; it counts as the 파일 kind). */
  tablePart?: boolean;
  /** The package has a report template (`reports/`). */
  reports?: boolean;
}
/** The kinds a manifest produces (ARCH-03 §11 ⑥). */
function manifestKinds(manifest: ManifestLike, options: SpecMatchOptions): Set<ResultKind> {
  const kinds = new Set<ResultKind>();
  if (manifest.panel) kinds.add('화면');
  if (manifest.bake) kinds.add('Rhino에 만들기');
  if (arr(manifest.outputs).length) kinds.add('넘겨줄 결과');
  if (arr(manifest.reports).length || options.reports || options.tablePart) kinds.add('파일');
  return kinds;
}

/**
 * `spec-match` (SPEC-07.14, ARCH-03 §11 명세 대조 규칙): the spec's inputs, settings, result kinds
 * and gate count against the manifest. A spec that is not complete is not compared (it is '명세
 * 없음'): the result is ok with no differences, and the caller shows 명세 없음 instead.
 */
export function specMatch(
  spec: ParsedSpec | string | null | undefined,
  manifest: ManifestLike,
  options: SpecMatchOptions = {},
): SpecMatch {
  const parsed = asSpec(spec);
  if (!parsed.complete) return { ok: true, differences: [] };
  const differences: SpecDifference[] = [];
  // ③ inputs
  const specIn = specInputs(parsed.sections['③']!.body);
  const jigIn = arr(manifest.inputs)
    .map((input) => str((input as { title?: unknown }).title))
    .filter(Boolean);
  for (const name of specIn)
    if (!jigIn.some((title) => baseName(title) === baseName(name)))
      differences.push({ section: '③', item: name, field: 'missing', spec: name, jig: '' });
  for (const title of jigIn)
    if (!specIn.some((name) => baseName(name) === baseName(title)))
      differences.push({ section: '③', item: title, field: 'extra', spec: '', jig: title });
  // ④ settings
  const params = arr(manifest.params) as ParamLike[];
  const rows = specParams(parsed.sections['④']!.body);
  const matched = new Set<ParamLike>();
  for (const row of rows) {
    const code = codeOf(row.name);
    const param =
      (code ? params.find((p) => p.key === code) : undefined) ??
      params.find((p) => !matched.has(p) && baseName(str(p.title)) === baseName(row.name));
    const item = cleanItem(row.name.replace(/\s*\(\s*`?[A-Za-z_][A-Za-z0-9_]*`?\s*\)\s*$/, ''));
    if (!param) {
      differences.push({ section: '④', item, field: 'missing', spec: item, jig: '' });
      continue;
    }
    matched.add(param);
    const title = str(param.title) || item;
    if (row.unit !== null && !paramUnits(param).has(normalizeUnit(cleanItem(row.unit))))
      differences.push({
        section: '④',
        item: title,
        field: 'unit',
        spec: cleanItem(row.unit),
        jig: paramUnit(param),
      });
    if (row.value !== null && !sameDefault(row.value, param))
      differences.push({
        section: '④',
        item: title,
        field: 'default',
        spec: cleanItem(row.value),
        jig: shownDefault(param),
      });
  }
  for (const param of params)
    if (!matched.has(param)) {
      const title = str(param.title) || str(param.key);
      differences.push({ section: '④', item: title, field: 'extra', spec: '', jig: title });
    }
  // ⑥ result kinds
  const specK = specKinds(parsed.sections['⑥']!.body);
  const jigK = manifestKinds(manifest, options);
  for (const kind of RESULT_KINDS)
    if (specK.has(kind) !== jigK.has(kind))
      differences.push({
        section: '⑥',
        item: kind,
        field: 'kind',
        spec: specK.has(kind) ? kind : '',
        jig: jigK.has(kind) ? kind : '',
      });
  // ⑦ gate count
  const specCount = specGateCount(parsed.sections['⑦']!.body);
  const jigCount = arr(manifest.steps).reduce<number>(
    (sum, step) => sum + arr((step as { gates?: unknown }).gates).length,
    0,
  );
  if (specCount !== jigCount)
    differences.push({
      section: '⑦',
      item: '통과 조건',
      field: 'count',
      spec: String(specCount),
      jig: String(jigCount),
    });
  return { ok: !differences.length, differences };
}

/** One difference as the architectural sentence the step rail and refusals show (SPEC-07.14). */
export function differenceSentence(d: SpecDifference): string {
  const what = d.section === '③' ? '입력' : d.section === '④' ? '설정값' : '결과';
  switch (d.field) {
    case 'missing':
      return `명세의 ${what} '${d.item}'이(가) jig에는 없습니다`;
    case 'extra':
      return `jig의 ${what} '${d.item}'이(가) 명세에는 없습니다`;
    case 'unit':
      return `명세의 설정값 '${d.item}' 단위 ${d.spec || '없음'}이(가) jig에서는 ${d.jig || '없음'}입니다`;
    case 'default':
      return `명세의 설정값 '${d.item}' 기본값 ${d.spec || '없음'}이(가) jig에서는 ${d.jig || '없음'}입니다`;
    case 'kind':
      return d.spec
        ? `명세의 결과 '${d.item}'을(를) jig가 내지 않습니다`
        : `jig가 내는 결과 '${d.item}'이(가) 명세에는 없습니다`;
    case 'count':
      return `명세의 통과 조건 ${d.spec}개가 jig에서는 ${d.jig}개입니다`;
  }
}
/** The step-rail sentence of a failed spec-match: the first differences and how many more. */
export function specMatchMessage(differences: readonly SpecDifference[]): string {
  if (!differences.length) return '';
  const shown = differences.slice(0, 3).map(differenceSentence);
  const more =
    differences.length > shown.length ? ` 외 ${differences.length - shown.length}건` : '';
  return `명세와 다름: ${shown.join(' · ')}${more}`;
}

// ── [명세 고치기]: ③~⑦ from jig.json ─────────────────────────────────────────────────────────
const INPUT_FORMS: Record<string, string> = {
  assembly: '역할별로 모으는 입력',
  zone: '사람이 그리는 구역',
  'sync-layers': 'Rhino·CAD 레이어',
  'table-file': '표 파일',
  facts: '프로젝트 자료',
  'jig-output': '다른 jig의 결과',
  'host-document': '연결 문서',
  'host-surface': 'Rhino 서피스',
  'host-curves': 'Rhino 곡선',
  'site-data': '대지 자료',
};
const STEP_BY: Record<string, string> = {
  code: '계산',
  library: '라이브러리',
  ai: 'AI 판정',
  human: '사람 확인',
  host: 'Rhino에 만들기',
};
const unitShown = (unit: string) =>
  unit === 'deg' ? '°' : unit === 'choice' ? '선택' : unit || '-';
const rangeShown = (param: ParamLike & { range?: { min?: unknown; max?: unknown } }) => {
  const choices = choicesOf(param);
  if (choices.length)
    return choices.map((choice) => str(choice.label) || String(choice.value ?? '')).join(' · ');
  const range = param.range;
  if (!range || (typeof range.min !== 'number' && typeof range.max !== 'number')) return '-';
  const factor = shownFactor(param);
  const n = (value: unknown) =>
    typeof value === 'number' ? String(+(value * factor).toFixed(6)) : '?';
  return `${n(range.min)} ~ ${n(range.max)}`;
};
/** The bodies of ③④⑤⑥⑦ written from a manifest (they pass `specMatch` with it). */
export function specSectionsFromManifest(
  manifest: ManifestLike & { steps?: unknown },
  options: SpecMatchOptions = {},
): Record<'③' | '④' | '⑤' | '⑥' | '⑦', string> {
  const inputs = arr(manifest.inputs) as { title?: unknown; kind?: unknown; required?: unknown }[];
  const params = arr(manifest.params) as (ParamLike & {
    range?: { min?: unknown; max?: unknown };
  })[];
  const steps = arr(manifest.steps) as {
    id?: unknown;
    title?: unknown;
    kind?: unknown;
    gates?: unknown;
  }[];
  const third = inputs.length
    ? [
        '| 역할 | 형태 | 필수 |',
        '|---|---|---|',
        ...inputs.map(
          (input) =>
            `| ${cell(str(input.title))} | ${cell(INPUT_FORMS[str(input.kind)] ?? str(input.kind))} | ${input.required === false ? '선택' : input.required === true ? '필수' : '-'} |`,
        ),
      ].join('\n')
    : '입력 없음.';
  const fourth = params.length
    ? [
        '| 이름(코드값) | 단위 | 기본 | 범위 |',
        '|---|---|---|---|',
        ...params.map((param) => {
          const unit = paramUnit(param);
          const value = shownDefault(param).replace(/\s*(°|mm|m|%|EA|m2|m3)$/, '');
          return `| ${cell(str(param.title))} (\`${str(param.key)}\`) | ${unitShown(unit)} | ${cell(value)} | ${cell(rangeShown(param))} |`;
        }),
      ].join('\n')
    : '설정값 없음.';
  const fifth = steps.length
    ? steps
        .map(
          (step, i) =>
            `${i + 1}. ${step.kind === 'human' ? '【사람】 ' : ''}**${str(step.title) || str(step.id)}** — ${STEP_BY[str(step.kind)] ?? str(step.kind)}`,
        )
        .join('\n')
    : SPEC_EMPTY;
  const kinds = manifestKinds(manifest, options);
  const sixth = RESULT_KINDS.map((kind) =>
    kinds.has(kind) ? `- **${kind}:** ${SPEC_EMPTY}` : `- **${kind}:** 없음.`,
  ).join('\n');
  const gates = steps.flatMap((step) =>
    (arr(step.gates) as { use?: unknown; level?: unknown }[]).map(
      (gate) =>
        `${str(step.title) || str(step.id)} — ${str(gate.use)}${gate.level ? ` (${str(gate.level) === 'warn' ? '주의' : str(gate.level) === 'block' ? '막음' : str(gate.level)})` : ''}`,
    ),
  );
  const seventh = gates.length
    ? gates.map((line, i) => `${i + 1}. ${line}`).join('\n')
    : '점검 없음.';
  return { '③': third, '④': fourth, '⑤': fifth, '⑥': sixth, '⑦': seventh };
}
