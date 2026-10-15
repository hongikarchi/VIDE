import { z } from 'zod';
import { workspaceResultSchema, applicationResultSchema } from '../contracts/workspace-result.ts';
import { quantityTableSchema } from '../contracts/quantities.ts';
import { sceneItems, sceneListSchema } from '../core/scene-items.ts';
const reportSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  input: z.object({
    body: z.string(),
    pins: z.array(z.object({ name: z.string().optional(), role: z.string() })).optional(),
    sketches: z
      .array(
        z.object({
          name: z.string().optional(),
          plane: z.string().optional(),
          placement: z.string().optional(),
          role: z.string().optional(),
        }),
      )
      .optional(),
    files: z.array(z.object({ name: z.string() })).optional(),
  }),
  result: workspaceResultSchema.extend({
    verified: z.boolean().optional(),
    displayUnsupported: z.array(z.string()).optional(),
    objects: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string().optional() })),
    // An array, or a stored list checked item by item as read (`Workspace.lazy`, T-129).
    scene: sceneListSchema,
  }),
  applications: z.array(applicationResultSchema).optional(),
});
import { sceneRepresentation } from '../core/scene-representation.ts';
import { validatePreview } from '../core/reviews.ts';
import { quantities } from '../core/quantities.ts';
import { DomainError } from '../core/store.ts';
import type { ReportModel } from '../jigs/runtime/report-format.ts';
import { renderReportHtml, type JigReportOrigin } from '../core/report-html.ts';
const escape = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : '—';

/** Native types of scene items the 3D view cannot show, one item at a time (T-129). */
function unsupportedTypes(scene: z.infer<typeof sceneListSchema>) {
  const out: string[] = [];
  for (const object of sceneItems(scene))
    if (!sceneRepresentation(object)) out.push(object.nativeType || '미상');
  return out;
}

export function renderReport(
  projectValue: unknown,
  requestValue: unknown,
  image: unknown,
  snapshotValue?: unknown,
) {
  const project = z.object({ name: z.string() }).parse(projectValue),
    request = reportSchema.parse(requestValue);
  const snapshot =
    snapshotValue === undefined
      ? undefined
      : z
          .object({
            table: quantityTableSchema,
            title: z.string().optional(),
            createdAt: z.string().optional(),
          })
          .parse(snapshotValue);
  if (!request.result?.hostExecuted) throw new DomainError('NOT_FOUND');
  validatePreview(image);
  const table = snapshot?.table || quantities(request);
  const rows = table.rows
    .map(
      (row) =>
        `<tr><td>${escape(row.name)}</td><td>${escape(row.type)}</td><td>${escape(row.layer ?? '미상')}</td><td>${number(row.length)}</td><td>${number(row.area)}</td><td>${number(row.volume)}</td></tr>`,
    )
    .join('');
  const applied = (request.applications || []).filter((item) => item.state === 'succeeded').length,
    unknown = (request.applications || []).filter((item) => item.state === 'unknown').length;
  const state = unknown
    ? `원본 적용 결과 미확인 ${unknown}건`
    : applied
      ? `원본 반영 기록 ${applied}건 · 파일 저장은 별도`
      : '원본 반영 기록 없음 · 작업 사본';
  const context = (request.input.pins || [])
    .map(
      (pin) =>
        `${pin.name} (${{ target: '변경', preserve: '유지', reference: '참고' }[pin.role] || pin.role})`,
    )
    .concat(
      (request.input.sketches || []).map(
        (sketch) =>
          `${sketch.name} · ${sketch.plane ?? (sketch.placement === 'surface' ? '표면' : sketch.placement === 'view' ? '화면' : '평면')}${sketch.role ? ' · ' + sketch.role : ''}`,
      ),
      (request.input.files || []).map((file) => file.name),
    )
    .join(' · ');
  const unsupported =
    request.result.displayUnsupported ?? (snapshot ? [] : unsupportedTypes(request.result.scene));
  const filter =
    [
      table.query.search && '검색: ' + table.query.search,
      table.query.type && '유형: ' + table.query.type,
      table.query.layer && '레이어: ' + table.query.layer,
      table.query.groupBy !== 'none' &&
        '그룹: ' + { type: '유형별', layer: '레이어별' }[table.query.groupBy],
    ]
      .filter(Boolean)
      .join(' · ') || '전체 객체';
  const groups = table.groups
    .map(
      (group) =>
        `<p>${escape(group.key)} · ${group.totals.count}개 · 기하 면적 ${group.totals.area.known ? number(group.totals.area.value) : '—'} m² (미상 ${group.totals.area.unknown}개 제외) · 체적 ${group.totals.volume.known ? number(group.totals.volume.value) : '—'} m³ (미상 ${group.totals.volume.unknown}개 제외)</p>`,
    )
    .join('');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(project.name)} · 검토본</title>
<style>body{max-width:1100px;margin:40px auto;padding:0 24px;font:15px/1.8 Arial,sans-serif;color:#28312c}h1{font-size:30px}p{white-space:pre-wrap}small{color:#657067}img{display:block;width:100%;max-height:420px;object-fit:contain;background:#edf0ec;border:1px solid #ddd}table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;border-bottom:1px solid #ddd;padding:10px;overflow-wrap:anywhere}td:last-child{font-size:10px}@media print{body{margin:0}img{max-height:480px;object-fit:contain}}</style>
<h1>${escape(snapshot?.title || project.name)}</h1><small>${escape(project.name)} · VIDE 검토본 · ${escape(snapshot?.createdAt || request.createdAt)} · 기준 ${escape(request.id)}</small>
<h2>작업 요청</h2><p>${escape(request.input.body)}</p><p>${escape(context)}</p><h2>검토 화면</h2><img src="${image}" alt="해당 후보의 3D 뷰포트">${unsupported.length ? `<small>3D 표시 미지원 ${unsupported.length}개 (${escape([...new Set(unsupported)].join(', '))}). 표와 파일의 객체 목록은 별도입니다.</small>` : ''}<h2>결과</h2><p>${escape(request.result.text)}</p>
<h2>호스트 측정값</h2><p>${escape(filter)} · ${table.rows.length}개</p>${groups}<table><thead><tr><th>객체</th><th>유형</th><th>레이어</th><th>길이(m)</th><th>기하 면적(m²)</th><th>체적(m³)</th></tr></thead><tbody>${rows}</tbody></table>
<p>입체의 기하 면적은 표면적이며 건축면적·연면적을 뜻하지 않습니다. 닫힌 평면 곡선은 경계 면적입니다. —는 미측정입니다.</p>
<small>${escape(state)}. 네이티브 파일 저장 확인: ${request.result.verified ? '통과' : '미확인'}.</small></html>`;
}

// --- jig study report (SPEC-07.11, ARCH-03 §5.2, PLAN-22 T-057) ---------------------------------
// The page itself (both tiers: 검토용 and 보고용) is src/core/report-html.ts, shared with the CLI
// and the browser; this wrapper keeps the engine's callers on the 검토용 page.

export type { JigReportOrigin };

/** The 검토용 study report of a jig instance (SPEC-07.11 두 등급); see src/core/report-html.ts. */
export function renderJigReport(model: ReportModel, origin: JigReportOrigin): string {
  return renderReportHtml(model, origin, { tier: 'review' });
}

// --- report inputs (PLAN-23 T-058, SPEC-07.11) -------------------------------------------------
// What a jig report reads beside the step outputs, under `inputs.…`: the settings ledger (the
// appendix), the open items (settings still on an assumed default, unanswered question cards),
// the steps whose output is only a preview (`previewOnly`), and one view of the structure summary
// shown (the confirmed result when there is one, else the preview): combinations as text, the
// items not checked, the ratio histogram, governing members, reference deflection and the column
// reactions. Pure; the engine passes it as `ReportContext.inputs`.

export interface JigReportParamRow {
  key: string;
  title?: string;
  value?: unknown;
  displayValue?: unknown;
  displayUnit?: string;
  by?: string;
  basis?: { status?: string; note?: string; question?: string };
}
export interface JigReportLedgerRow {
  kind: string;
  body: unknown;
}
const BY_TEXT: Record<string, string> = {
  default: '기본값',
  user: '사용자',
  decision: '결정',
  fact: '자료',
  ai: 'AI 제안',
  rhino: 'Rhino',
  sketch: '스케치',
};
const BASIS_TEXT: Record<string, string> = {
  confirmed: '확인됨',
  assumed: '가정',
  chosen: '선택',
  'to-ask': '물어볼 것',
};
const JUDGEMENT_TEXT: Record<string, string> = {
  ok: '통과',
  warn: '주의',
  ng: '초과',
  na: '미완',
  err: '오류',
};
type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isNum = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const short = (value: number) => String(Number(value.toFixed(3)));
const RATIO_BINS = [
  { label: '0.5 미만', below: 0.5, shade: 'base' },
  { label: '0.5–0.7', below: 0.7, shade: 'base' },
  { label: '0.7–0.9', below: 0.9, shade: 'alt' },
  { label: '0.9–1.0', below: 1.0 + 1e-9, shade: 'alt' },
  { label: '1.0 초과', below: Infinity, shade: 'strong' },
];
const isSummary = (value: unknown): value is Loose =>
  isObject(value) && value.schema === 'vide.structure.summary/1';

/**
 * The structure summary the outputs show: a confirmed result first, else a preview. A confirmed
 * result of a step that is not final (stale, waiting for re-confirmation) is not shown as confirmed.
 */
function shownSummary(outputs: Record<string, unknown>, final?: Record<string, boolean>) {
  let preview: { step: string; summary: Loose; confirmed: boolean } | undefined;
  for (const [step, output] of Object.entries(outputs)) {
    if (!isObject(output)) continue;
    const confirmed = isObject(output.confirmed) ? output.confirmed.result : undefined;
    if (isSummary(confirmed) && final?.[step] !== false)
      return { step, summary: confirmed, confirmed: true };
    if (!preview && isSummary(output.preview))
      preview = { step, summary: output.preview, confirmed: false };
  }
  return preview;
}
function structureView(shown: { step: string; summary: Loose; confirmed: boolean }) {
  const s = shown.summary;
  const members = listOf(s.members).filter(Array.isArray) as unknown[][];
  const codes = listOf(s.statusCodes).map(String);
  const clauses = listOf(s.clauses).map(String);
  const ratios = members.map((m) => m[2]).filter(isNum);
  const bins = RATIO_BINS.map((b, i) => ({
    label: b.label,
    count: ratios.filter((r) => r < b.below && (i === 0 || r >= RATIO_BINS[i - 1].below)).length,
    shade: b.shade,
  }));
  const combos = listOf(s.combos)
    .filter(isObject)
    .map((c) => ({
      id: String(c.id ?? ''),
      limitState: c.limitState === 'service' ? '사용성' : '강도',
      text: Object.entries(isObject(c.terms) ? c.terms : {})
        .flatMap(([load, f]) => (isNum(f) ? [`${short(f)}${load}`] : []))
        .join(' + '),
    }));
  const governing = members
    .filter((m) => isNum(m[2]))
    .sort((a, b) => (b[2] as number) - (a[2] as number))
    .slice(0, 10)
    .map((m) => ({
      key: String(m[0]),
      judgement: JUDGEMENT_TEXT[codes[m[1] as number] ?? ''] ?? '—',
      ratio: Number(Math.min(m[2] as number, 999).toFixed(3)),
      clause: isNum(m[3]) ? (clauses[m[3]] ?? '') : '',
    }));
  const deflections = members
    .filter((m) => isNum(m[4]))
    .map((m) => {
      const d = m[4] as number;
      const limit = isNum(m[5]) ? m[5] : null;
      return {
        key: String(m[0]),
        deflection_mm: Number(d.toFixed(1)),
        limit_mm: limit === null ? null : Number(limit.toFixed(1)),
        ratio: limit ? Number((d / limit).toFixed(3)) : null,
      };
    })
    .sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1) || a.key.localeCompare(b.key))
    .slice(0, 10);
  const perColumn = listOf(isObject(s.reactions) ? s.reactions.perColumn : undefined).filter(
    Array.isArray,
  ) as unknown[][];
  const reactions = perColumn
    .map((r) => {
      const rx = isNum(r[3]) ? r[3] : 0;
      const ry = isNum(r[4]) ? r[4] : 0;
      return {
        column: String(r[0]),
        z_m: isNum(r[1]) ? r[1] : null,
        combo: combos[r[2] as number]?.id ?? '',
        Rx_kN: rx,
        Ry_kN: ry,
        R_kN: Number(Math.hypot(rx, ry).toFixed(2)),
      };
    })
    .sort((a, b) => b.R_kN - a.R_kN || a.column.localeCompare(b.column));
  return {
    step: shown.step,
    mode: shown.confirmed ? '확정 결과' : '미확정 미리보기',
    confirmed: shown.confirmed ? 1 : 0,
    combos,
    assumptions: listOf(s.assumptions).map(String),
    unchecked: listOf(s.unchecked).map(String),
    bins,
    governing,
    deflections,
    reactions,
  };
}

/**
 * The `inputs` of a jig report: settings ledger, open items, previews, the structure view and
 * `bake.members` — the members a bake may make now (a plan output with `members` that is not a
 * preview; 0 while the members wait for a confirmed analysis).
 */
export function jigReportInputs(input: {
  params?: readonly JigReportParamRow[];
  ledger?: readonly JigReportLedgerRow[];
  outputs?: Record<string, unknown>;
  /** Report `final` flags per step: a non-final confirmed result is not shown as confirmed. */
  final?: Record<string, boolean>;
}) {
  const params = input.params ?? [];
  const ledger = input.ledger ?? [];
  const valueText = (p: JigReportParamRow) => {
    const v = p.displayValue ?? p.value;
    const text = isNum(v)
      ? short(v)
      : typeof v === 'boolean'
        ? v
          ? '예'
          : '아니오'
        : String(v ?? '—');
    return p.displayUnit && isNum(v) ? `${text} ${p.displayUnit}` : text;
  };
  const settings = params.map((p) => ({
    key: p.key,
    title: p.title ?? p.key,
    value: valueText(p),
    by: BY_TEXT[p.by ?? ''] ?? p.by ?? '—',
    basis: BASIS_TEXT[p.basis?.status ?? ''] ?? '—',
    note: p.basis?.question ?? p.basis?.note ?? '',
  }));
  // An assumed (or to-ask) setting still on its default is an open item; once someone sets it
  // (user, decision, fact …) it is no longer assumed.
  const assumed = params.filter(
    (p) => (p.basis?.status === 'assumed' || p.basis?.status === 'to-ask') && p.by === 'default',
  );
  const answered = new Set<string>();
  for (const item of ledger)
    if ((item.kind === 'answer' || item.kind === 'decision') && isObject(item.body))
      if (typeof item.body.questionId === 'string') answered.add(item.body.questionId);
  const seen = new Set<string>();
  const questions = ledger.flatMap((item) => {
    const body = item.body;
    if (item.kind !== 'question' || !isObject(body) || typeof body.id !== 'string') return [];
    if (answered.has(body.id) || seen.has(body.id)) return [];
    seen.add(body.id);
    return [{ title: String(body.title ?? body.id), blocks: String(body.blocks ?? '') }];
  });
  const open = [
    ...assumed.map((p) => ({
      kind: '가정한 설정값',
      text: `${p.title ?? p.key}: ${valueText(p)}`,
      ask: p.basis?.question ?? p.basis?.note ?? '',
    })),
    ...questions.map((q) => ({ kind: '답하지 않은 질문', text: q.title, ask: q.blocks })),
  ];
  const outputs = input.outputs ?? {};
  const preview = Object.fromEntries(
    Object.entries(outputs)
      .filter(([, o]) => isObject(o) && o.previewOnly === true)
      .map(([step]) => [step, 1]),
  );
  const shown = shownSummary(outputs, input.final);
  const bakeMembers = Object.entries(outputs).reduce((n, [step, o]) => {
    if (!isObject(o) || o.schema !== 'vide.s06.bakePlan/1' || o.previewOnly !== false) return n;
    if (input.final?.[step] === false) return n;
    return Math.max(n, listOf(o.members).length);
  }, 0);
  return {
    settings,
    open,
    counts: {
      settings: settings.length,
      assumed: assumed.length,
      questions: questions.length,
      open: open.length,
      /** Steps whose kept result is not final (a preview, or stale: 패널링 '다시 계산 필요'). */
      notFinal: Object.values(input.final ?? {}).filter((final) => final === false).length,
    },
    preview,
    bake: { members: bakeMembers },
    ...(shown ? { structure: structureView(shown) } : {}),
  };
}
