// 법규 체크 화면의 순수 부분 (SPEC-15.9·15.11·15.12·15.13, Design SCR-32, PLAN-48 T-239): what the
// screen and the exports make of one `ComplianceResult` — state symbols, number text that never
// hides a 위반 by rounding, the head summary, why a result is '다시 체크 필요', the 3D overlay items
// of the exceedances, the objects a row selects, the CSV and the self-contained HTML report. No
// legal number lives here: every limit is the engine's, taken from the 규제 조건 (SPEC-15.5). Pure
// (the contract's zod only) so the engine side and Node tests can use it.

import {
  COMPLIANCE_CHECKS,
  COMPLIANCE_GROUPS,
  COMPLIANCE_ROLES,
  COMPLIANCE_ROLE_LABELS,
  COMPLIANCE_STATES,
  UNCLASSIFIED_REASONS,
  checkGroup,
  complianceResultSchema,
  type ComplianceItem,
  type ComplianceResult,
  type ComplianceState,
  type Exceedance,
} from '../../contracts/compliance.ts';
import type { OverlayItem } from '../viewport.ts';

export type { ComplianceItem, ComplianceResult, ComplianceState, Exceedance };

/** The fixed notice of every result screen and report (SPEC-15.1). */
export const NOTICE = '탐색용 법규 체크 — 인허가 검토·법규 검토를 대체하지 않음';
/** Said with the notice: the check list is closed (SPEC-15.2). */
export const OUT_OF_LIST = '검사 목록 밖의 법규는 보지 않음';

/** Symbol, words and colour token of each state (Design SCR-32). */
export const STATE_META: Record<
  ComplianceState,
  { symbol: string; tone: 'ok' | 'ng' | 'warn' | 'info' | 'na' }
> = {
  적합: { symbol: '✓', tone: 'ok' },
  위반: { symbol: '✕', tone: 'ng' },
  '판단 필요': { symbol: '!', tone: 'warn' },
  '사람 입력 필요': { symbol: '✎', tone: 'info' },
  '검사 불가': { symbol: '—', tone: 'na' },
};
export { COMPLIANCE_STATES, COMPLIANCE_GROUPS };

/** Overlay layer keys of the result (SPEC-15.11). */
export const OVERLAY_EXCEEDANCE = 'compliance-exceedance';
export const OVERLAY_ENVELOPE = 'compliance-envelope';

// ── reading the step output ──────────────────────────────────────────────────────────────

export type ResultRead =
  | { kind: 'none' }
  | { kind: 'invalid'; issues: string[] }
  | { kind: 'ok'; result: ComplianceResult };

/**
 * The `check` step's output as the screen may use it: nothing yet, or a result that passes the
 * contract. A value that does not pass is never drawn as verdicts (a silent 적합 is worse than none).
 */
export function readResult(value: unknown): ResultRead {
  if (value === undefined || value === null) return { kind: 'none' };
  const parsed = complianceResultSchema.safeParse(value);
  if (parsed.success) return { kind: 'ok', result: parsed.data };
  return {
    kind: 'invalid',
    issues: parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '결과'}: ${issue.message}`),
  };
}

// ── rows ───────────────────────────────────────────────────────────────────────────────

/** Rows in the check-list order (groups as SPEC-15.2), each with its 1-based table number. */
export function orderedItems(result: ComplianceResult): (ComplianceItem & { no: number })[] {
  const rank = (id: ComplianceItem['id']) => COMPLIANCE_CHECKS.indexOf(id);
  const group = (item: ComplianceItem) => COMPLIANCE_GROUPS.indexOf(item.group);
  return [...result.items]
    .sort((a, b) => group(a) - group(b) || rank(a.id) - rank(b.id))
    .map((item, i) => ({ ...item, no: i + 1 }));
}

const RULE_LABELS: Record<string, string> = {
  roadSetback: '건축선 후퇴',
  chamfer: '가각',
  limitLine: '건축한계선',
  openSpaceRoad: '대지 안의 공지(건축선)',
  openSpaceAdjacent: '대지 안의 공지(인접 대지)',
  civilSetback: '민법상 이격',
  otherSetback: '기타 이격',
  sun: '정북 일조',
  envelope: '최대 외피',
  'outside-site': '대지 밖',
};
/** Korean name of an exceedance rule (`roadSetback`, `zone:roadSetback`, `sun` …). */
export const ruleLabel = (rule: string) => RULE_LABELS[rule.replace(/^zone:/, '')] ?? rule;
export const variantLabel = (variant: string) =>
  variant === 'base' ? '기준' : variant === 'without' ? "'판단 필요' 미적용" : variant;
export const groundLabel = (groundCase: string) =>
  ({ 'ground:min': '지반 최저', 'ground:max': '지반 최고', 'ground:value': '기준 지반' })[
    groundCase
  ] ?? groundCase;

// ── numbers (SPEC-15.9 8) ───────────────────────────────────────────────────────────────

const RATIO = '비율';
const UNIT_TEXT: Record<string, string> = { m2: '㎡', 'm²': '㎡', m3: '㎥', 'm³': '㎥' };
const unitText = (unit: string) => UNIT_TEXT[unit] ?? unit;
const defaultDecimals = (unit: string) =>
  unit === RATIO ? 2 : /^(대|층|개|n)$/.test(unit) ? 0 : unit === '㎥' || unit === 'm3' ? 3 : 2;

/** One value as text: ratios as % (0.6 → 60.00%), others with their unit. */
export function valueText(value: number, unit: string, decimals = defaultDecimals(unit)): string {
  if (unit === RATIO) return `${formatFixed(value * 100, decimals)}%`;
  const u = unitText(unit);
  return u ? `${formatFixed(value, decimals)} ${u}` : formatFixed(value, decimals);
}
function formatFixed(value: number, decimals: number) {
  const text = Math.abs(value).toLocaleString('ko-KR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return (value < 0 && Number(text.replace(/,/g, '')) !== 0 ? '−' : '') + text;
}

/**
 * The planned and limit text of a row: as many decimals as it takes for two different values not
 * to read the same (a 위반 must never look like 계획 = 한계, SPEC-15.9 8). Equal values stay equal.
 */
export function pairText(
  planned: { value: number; unit: string } | null,
  limit: { value: number; unit: string } | null,
): { planned: string; limit: string; decimals: number } {
  const unit = limit?.unit ?? planned?.unit ?? '';
  let decimals = defaultDecimals(unit);
  const text = (side: { value: number; unit: string } | null, d: number) =>
    side ? valueText(side.value, side.unit, d) : '—';
  // Values equal within the engine's comparison tolerance (relative 1e-9, SPEC-15.9 8) are equal.
  const differ =
    planned &&
    limit &&
    Math.abs(planned.value - limit.value) > 1e-9 * Math.max(1, Math.abs(limit.value));
  if (planned && limit && differ)
    while (decimals < 12 && text(planned, decimals) === text(limit, decimals)) decimals++;
  return { planned: text(planned, decimals), limit: text(limit, decimals), decimals };
}

/** 여유 = 한계 − 계획 in the limit's unit (ratios as %p), with a sign. */
export function marginText(item: Pick<ComplianceItem, 'margin' | 'limit'>, decimals?: number) {
  if (item.margin === null || !item.limit) return '—';
  const unit = item.limit.unit;
  const d = decimals ?? defaultDecimals(unit);
  const sign = item.margin > 0 ? '+' : '';
  if (unit === RATIO) return `${sign}${formatFixed(item.margin * 100, d)}%p`;
  return `${sign}${valueText(item.margin, unit, d)}`;
}

/** The planned value of a shape row is its exceedance volume (㎥). */
export function rowTexts(item: ComplianceItem) {
  const pair = pairText(item.planned, item.limit);
  return { ...pair, margin: marginText(item, pair.decimals) };
}

// ── the head (SPEC-15.9 6) ──────────────────────────────────────────────────────────────

/**
 * The head line: "위반 없음" only when every row is 적합 and nothing is unconfirmed; otherwise the
 * state counts alone (never a reassuring sentence over rows that are not 적합).
 */
export function headline(result: ComplianceResult): { text: string; tone: 'ok' | 'ng' | 'warn' } {
  const counts = COMPLIANCE_STATES.filter((s) => result.counts[s] > 0)
    .map((s) => `${s} ${result.counts[s]}`)
    .join(' · ');
  const unconfirmed = result.unconfirmedCount ? ` · 미확정 ${result.unconfirmedCount}` : '';
  if (result.counts['위반'] > 0) return { text: counts + unconfirmed, tone: 'ng' };
  const allOk = result.items.length > 0 && result.items.every((i) => i.state === '적합');
  if (allOk && result.unconfirmedCount === 0)
    return { text: `위반 없음 · 검사 ${result.items.length}항목 모두 적합`, tone: 'ok' };
  return { text: counts + unconfirmed, tone: 'warn' };
}

/** `YYYY-MM-DD HH:mm` in local time. */
export function stamp(iso: string | null | undefined) {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
/** The document revision of `<instance>|<documentId>|<revision>` (ARCH-03 §8). */
export const revisionOf = (revisionKey: string) => revisionKey.split('|').at(-1) ?? revisionKey;

// ── 다시 체크 필요 (SPEC-15.13) ────────────────────────────────────────────────────────────

/** An earlier jig result as the instance's `jig-output` input sees it now. */
export interface SourceNow {
  instanceId: string | null;
  at: string | null;
  /** That work copy must be computed again (its own inputs moved), or cannot be read. */
  needsRecompute: boolean;
  /** Its output moved after this instance last computed (the runtime's own comparison). */
  moved: boolean;
  /** The runtime has a value to give (a work copy's output or a service's). */
  ready?: boolean;
}
/**
 * The limits source was read and has no work copy to give (null: no such input; no instance id
 * and not ready: no '건축 가능 영역·매스' work copy). undefined = not read yet or unknown.
 */
export function limitsMissing(limits: SourceNow | null | undefined): boolean {
  return limits === null || (limits !== undefined && !limits.instanceId && limits.ready === false);
}

export interface CurrentInputs {
  /** The project's classification store version now (undefined = not known). */
  rolesVersion?: number;
  /** The linked document's revision now; null = cannot be compared (closed, other Link, offline). */
  modelRevisionKey?: string | null;
  limits?: SourceNow | null;
  siteModel?: SourceNow | null;
  /** A setting or 수정 사항 changed after the check (the engine marks the step stale). */
  settingsChanged?: boolean;
  /** The engine says the check step is stale, whatever the reason. */
  stepStale?: boolean;
}

/**
 * Why a kept result no longer matches what it read; empty = up to date. Nothing re-reads or
 * recomputes on its own: the screen only says so and dims the result (SPEC-15.13).
 */
export function staleReasons(result: ComplianceResult, now: CurrentInputs): string[] {
  const reasons: string[] = [];
  const model = result.inputs.model;
  if (now.modelRevisionKey === null) reasons.push('모델 판 확인 불가');
  else if (
    model &&
    now.modelRevisionKey !== undefined &&
    now.modelRevisionKey !== model.revisionKey
  )
    reasons.push('Rhino 모델이 바뀜');
  if (model && now.rolesVersion !== undefined && now.rolesVersion !== model.rolesVersion)
    reasons.push('분류가 바뀜');
  const source = (
    kept: ComplianceResult['inputs']['limits'],
    current: SourceNow | null | undefined,
    words: string,
    recompute: string,
  ) => {
    if (current === undefined) return;
    if (current?.needsRecompute) reasons.push(recompute);
    else if (current?.moved || (current?.instanceId ?? null) !== (kept?.instanceId ?? null))
      reasons.push(words);
  };
  source(
    result.inputs.limits,
    now.limits,
    '규제 조건이 바뀜',
    '규제 조건이 바뀜(건축 가능 영역·매스를 다시 계산)',
  );
  source(
    result.inputs.siteModel,
    now.siteModel,
    '대지가 바뀜',
    '대지가 바뀜(사이트 모델링을 다시 계산)',
  );
  if (now.settingsChanged) reasons.push('설정값·수정 사항이 바뀜');
  if (now.stepStale && !reasons.length) reasons.push('입력이 바뀜');
  return [...new Set(reasons)];
}

/** Why exports are off, or null when they may go out (SPEC-15.12). */
export function exportBlock(result: ComplianceResult | null, stale: boolean): string | null {
  if (!result) return '아직 체크하지 않았습니다 · [법규 체크] 뒤 내보낼 수 있습니다';
  if (stale) return '다시 체크한 뒤 내보낼 수 있습니다';
  return null;
}

// ── 3D (SPEC-15.11) ─────────────────────────────────────────────────────────────────

const shifted = (v: readonly number[], origin: readonly number[]) =>
  v.map((value, i) => value + origin[i % 3]);
const originOf = (result: ComplianceResult) => result.display?.origin ?? [0, 0, 0];

/** Every exceedance once (by marker number), across rows. */
export function exceedancesOf(result: ComplianceResult): (Exceedance & { check: string })[] {
  const seen = new Map<number, Exceedance & { check: string }>();
  for (const item of result.items)
    for (const piece of item.exceedances)
      if (!seen.has(piece.no)) seen.set(piece.no, { ...piece, check: item.id });
  return [...seen.values()].sort((a, b) => a.no - b.no);
}

/** The exceedances as translucent clash bodies with the table's marker numbers, in world metres. */
export function exceedanceItems(result: ComplianceResult): OverlayItem[] {
  const origin = originOf(result);
  return exceedancesOf(result).map((piece) => ({
    id: `x${piece.no}`,
    kind: 'mesh',
    v: shifted(piece.mesh.v, origin),
    f: piece.mesh.f,
    tone: 'ov-clash',
    label: String(piece.no),
  }));
}

/** The base variant's 최대 외피 as a light outline, when the result carries it. */
export function envelopeItems(result: ComplianceResult): OverlayItem[] {
  const envelope = result.display?.envelope;
  if (!envelope) return [];
  return [
    {
      id: 'envelope',
      kind: 'mesh',
      v: shifted(envelope.v, originOf(result)),
      f: envelope.f,
      fill: false,
      tone: 'ov-existing',
    },
  ];
}

/** The host objects a row names (its own and its exceedances'), for `vide:select-native`. */
export function rowObjects(result: ComplianceResult, item: ComplianceItem) {
  const ids = [...new Set([...item.objectIds, ...item.exceedances.flatMap((e) => e.objectIds)])];
  const linkId = result.inputs.model?.linkId;
  return linkId && ids.length ? [{ linkId, nativeIds: ids }] : [];
}

// ── 근거 (SPEC-15.9 4) ──────────────────────────────────────────────────────────────────

/** A link the screen may open: http(s) only. */
export const safeLink = (link: string | null | undefined) =>
  link && /^https?:\/\//i.test(link) ? link : null;

/** 법규 답 번호 the result rests on (`L3` …), in order of first use. */
export function answersOf(result: ComplianceResult): string[] {
  return [
    ...new Set(result.items.flatMap((i) => i.basis.flatMap((b) => (b.answer ? [b.answer] : [])))),
  ];
}

/** Role counts in the role order, without zero rows. */
export function roleCounts(result: ComplianceResult) {
  return COMPLIANCE_ROLES.flatMap((role) => {
    const n = result.classification.byRole[role] ?? 0;
    return n ? [{ role, label: COMPLIANCE_ROLE_LABELS[role], count: n }] : [];
  });
}
/** Unused-object counts by reason, without zero rows. */
export function unusedCounts(result: ComplianceResult) {
  return UNCLASSIFIED_REASONS.flatMap((reason) => {
    const n = result.classification.unusedByReason[reason] ?? 0;
    return n ? [{ reason, count: n }] : [];
  });
}
/** Reasons that keep rows from 적합 (SPEC-15.9 7); the rest (other jigs, unchosen) do not. */
export const BLOCKING_UNUSED: readonly string[] = [
  '역할 없음',
  '역할과 모양이 맞지 않음',
  '닫히지 않음',
  '평면이 아님',
  '숨김',
];

// ── CSV (SPEC-15.12) ───────────────────────────────────────────────────────────────────

const CSV_HEAD = [
  '번호',
  '검사',
  '묶음',
  '상태',
  '계획 값',
  '한계 값',
  '단위',
  '여유',
  '한계 값 확정 상태',
  '출처 구분',
  '근거 조항',
  '이유',
  '미확정 사항',
];
function csvCell(value: unknown) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = String(value);
  // A cell that a spreadsheet would read as a formula is kept as words.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** The result table as CSV: unrounded values, the limit's unit, every check once (UTF-8 BOM). */
export function resultCsv(result: ComplianceResult): string {
  const rows: unknown[][] = orderedItems(result).map((item) => [
    item.no,
    item.title,
    item.group,
    item.state,
    item.planned?.value ?? null,
    item.limit?.value ?? null,
    item.limit?.unit ?? item.planned?.unit ?? '',
    item.margin,
    item.limit?.status ?? '',
    item.limit?.origin ?? '',
    item.basis.map((b) => [b.clause, b.answer].filter(Boolean).join(' ')).join(' / '),
    item.reason,
    item.unconfirmed.join(' / '),
  ]);
  for (const na of result.notApplicable)
    rows.push([
      '',
      na.title,
      checkGroup(na.check),
      '미적용 항목',
      null,
      null,
      '',
      null,
      '',
      '',
      na.basis,
      `규제 조건 ${na.id} 미적용(확정)`,
      '',
    ]);
  const lines = [CSV_HEAD, ...rows].map((row) => row.map(csvCell).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// ── 보고서 (SPEC-15.12) ─────────────────────────────────────────────────────────────────

const escape = (value: unknown) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const REPORT_CSS = `
body{margin:0;padding:32px;font:14px/1.55 system-ui,-apple-system,'Segoe UI','Malgun Gothic',sans-serif;color:#1f1f1f;background:#fff}
main{max-width:1080px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}
h3{font-size:14px;margin:16px 0 6px}
.notice{padding:10px 14px;border:1px solid #a8660b;border-radius:6px;background:#fdf6ea;font-weight:600}
.muted{color:#6b6b6b}.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}
table{width:100%;border-collapse:collapse;margin:6px 0 12px;font-variant-numeric:tabular-nums}
th,td{border-bottom:1px solid #e3e3e3;padding:4px 8px;text-align:left;vertical-align:top}
th{background:#f4f4f2;font-weight:600}td.num,th.num{text-align:right;white-space:nowrap}
.state{white-space:nowrap;font-weight:600}
.s-ok{color:#2f7d4f}.s-ng{color:#b42323}.s-warn{color:#a8660b}.s-info{color:#2f5aa8}.s-na{color:#808080}
.counts{display:flex;flex-wrap:wrap;gap:8px 20px;margin:12px 0}.counts b{font-size:20px}
.tag{display:inline-block;border:1px solid #bbb;border-radius:4px;padding:0 4px;font-size:11px;margin-left:4px}
@media print{body{padding:0}h2{break-after:avoid}tr{break-inside:avoid}}
`;

/** The self-contained HTML report (no script, no outside files). */
export function reportHtml(result: ComplianceResult): string {
  const rows = orderedItems(result);
  const head = headline(result);
  const model = result.inputs.model;
  const state = (s: ComplianceState) =>
    `<span class="state s-${STATE_META[s].tone}">${STATE_META[s].symbol} ${escape(s)}</span>`;
  const basis = (item: ComplianceItem) =>
    item.basis.length
      ? item.basis
          .map((b) => {
            const link = safeLink(b.link);
            const clause = link
              ? `<a href="${escape(link)}">${escape(b.clause || '원문')}</a>`
              : escape(b.clause || '근거 없음');
            return clause + (b.answer ? ` <span class="tag">${escape(b.answer)}</span>` : '');
          })
          .join('<br>')
      : item.limit
        ? '근거 없음'
        : '—';
  const table = rows
    .map((item) => {
      const texts = rowTexts(item);
      const assumed = item.limit?.status === '가정' ? '<span class="tag">가정</span>' : '';
      return `<tr><td class="num mono">${item.no}</td><td>${escape(item.group)}</td><td>${escape(item.title)}</td><td>${state(item.state)}</td><td class="num">${escape(texts.planned)}</td><td class="num">${escape(texts.limit)}${assumed}</td><td class="num">${escape(texts.margin)}</td><td>${basis(item)}</td><td>${escape(item.reason)}</td></tr>`;
    })
    .join('');
  const details = rows
    .filter((item) => item.numbers.length || item.cases.length || item.parts.length)
    .map((item) => {
      const numbers = item.numbers.length
        ? `<table><thead><tr><th>숫자</th><th class="num">값</th><th>출처</th><th>참조</th><th>비고</th></tr></thead><tbody>${item.numbers
            .map(
              (n) =>
                `<tr><td>${escape(n.label)}</td><td class="num">${n.value === null ? '—' : escape(valueText(n.value, n.unit))}</td><td>${escape(n.kind)}</td><td class="mono">${escape(n.ref)}</td><td>${escape(n.note ?? '')}</td></tr>`,
            )
            .join('')}</tbody></table>`
        : '';
      const cases = item.cases.length
        ? `<p>경우별 결과: ${item.cases
            .map((c) => `${escape(c.label)} → ${state(c.state)}`)
            .join(' · ')}</p>`
        : '';
      const parts = item.parts.length
        ? `<p>구간별 결과: ${item.parts
            .map(
              (p) =>
                `${escape(p.label)} → ${state(p.state)}${p.reason ? ` (${escape(p.reason)})` : ''}`,
            )
            .join(' · ')}</p>`
        : '';
      const unconfirmed = item.unconfirmed.length
        ? `<p class="muted">미확정 사항: ${item.unconfirmed.map(escape).join(' · ')}</p>`
        : '';
      return `<h3>${item.no}. ${escape(item.title)} — ${state(item.state)}</h3>${numbers}${cases}${parts}${unconfirmed}`;
    })
    .join('');
  const pieces = exceedancesOf(result);
  const exceedances = pieces.length
    ? `<table><thead><tr><th class="num">번호</th><th>규칙</th><th>변형</th><th>지반</th><th class="num">부피</th><th class="num">높이 범위</th><th>구간</th><th class="num">객체</th></tr></thead><tbody>${pieces
        .map(
          (p) =>
            `<tr><td class="num mono">${p.no}</td><td>${escape(ruleLabel(p.rule))}${p.rooftopOnly ? '<span class="tag">옥탑만</span>' : ''}</td><td>${escape(variantLabel(p.variant))}</td><td>${escape(groundLabel(p.groundCase))}</td><td class="num">${escape(valueText(p.volume, '㎥'))}</td><td class="num">${escape(`${formatFixed(p.min[2], 2)}~${formatFixed(p.max[2], 2)} m`)}</td><td>${escape(p.segments.join(', ') || '—')}</td><td class="num">${p.objectIds.length}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="muted">초과 부분 없음</p>';
  const notApplicable = result.notApplicable.length
    ? `<table><thead><tr><th>항목</th><th>규제 조건</th><th>근거</th></tr></thead><tbody>${result.notApplicable
        .map(
          (n) =>
            `<tr><td>${escape(n.title)}</td><td class="mono">${escape(n.id)}</td><td>${escape(n.basis || '—')}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="muted">없음</p>';
  const roles = roleCounts(result)
    .map((r) => `${escape(r.label)} ${r.count}`)
    .join(' · ');
  const unused = unusedCounts(result)
    .map((u) => `${escape(u.reason)} ${u.count}`)
    .join(' · ');
  const c = result.classification;
  const answers = answersOf(result);
  const source = (label: string, ref: ComplianceResult['inputs']['limits']) =>
    `<tr><th>${label}</th><td>${ref ? `${escape(ref.title)} · 계산 ${escape(stamp(ref.at))}` : '없음'}</td></tr>`;
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>법규 체크 보고서 ${escape(stamp(result.checkedAt))}</title><style>${REPORT_CSS}</style></head>
<body><main>
<p class="notice">${escape(result.notice)} · ${escape(OUT_OF_LIST)}</p>
<h1>법규 체크 보고서</h1>
<p class="muted">체크 ${escape(stamp(result.checkedAt))}${model ? ` · 문서 ${escape(model.documentKey)} · 판 ${escape(revisionOf(model.revisionKey))}` : ''}</p>
<p class="state s-${head.tone === 'ok' ? 'ok' : head.tone === 'ng' ? 'ng' : 'warn'}">${escape(head.text)}</p>
<div class="counts">${COMPLIANCE_STATES.map((s) => `<span>${state(s)} <b>${result.counts[s]}</b></span>`).join('')}<span>미확정 <b>${result.unconfirmedCount}</b></span></div>
<h2>결과</h2>
<table><thead><tr><th class="num">번호</th><th>묶음</th><th>항목</th><th>상태</th><th class="num">계획</th><th class="num">한계</th><th class="num">여유</th><th>근거</th><th>이유</th></tr></thead><tbody>${table}</tbody></table>
<h2>숫자 출처와 경우별 결과</h2>${details || '<p class="muted">없음</p>'}
<h2>초과 부분</h2>${exceedances}
<h2>미적용 항목</h2>${notApplicable}
<h2>분류 요약</h2>
<p>${roles || '역할이 정해진 객체 없음'}</p>
<p class="muted">쓰지 못한 객체: ${unused || '없음'} · AI 제안을 받은 객체 ${c.aiAccepted} · 숨긴 역할 객체 ${c.hiddenWithRole} · 형상이 바뀐 객체 ${c.geometryChanged}</p>
<h2>입력</h2>
<table><tbody>
<tr><th>읽은 문서</th><td>${model ? `${escape(model.documentKey)} · 판 ${escape(revisionOf(model.revisionKey))} · 읽음 ${escape(stamp(model.readAt))} · 객체 ${model.objects} · 역할 없음·쓰지 못함 ${model.unclassified} · 분류 판 ${model.rolesVersion}` : '없음'}</td></tr>
${source('규제 조건 · 건축 가능 영역·매스', result.inputs.limits)}
${source('대지 · 사이트 모델링', result.inputs.siteModel)}
<tr><th>법규 답 번호</th><td>${answers.length ? answers.map(escape).join(' · ') : '없음'}</td></tr>
</tbody></table>
<p class="muted">${escape(result.notice)} · ${escape(OUT_OF_LIST)}</p>
</main></body></html>
`;
}

/** File name stem of the exports: `법규-체크-YYYYMMDD-HHmm`. */
export function exportName(result: ComplianceResult) {
  return `법규-체크-${stamp(result.checkedAt).replace(/[-: ]/g, (c) => (c === ' ' ? '-' : ''))}`;
}
