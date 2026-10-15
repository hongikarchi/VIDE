// The jig study report as one self-contained page, in two tiers (SPEC-07.11 두 등급, PLAN-54
// T-341, ARCH-01 산출물 경로). A resolved report frame (src/jigs/runtime/report-format.ts) or any
// other ReportModel (법규 체크) becomes HTML with no scripts (a CSP without script-src), no
// external requests and print CSS for A3 landscape. Pure — no DOM, no node: — so the engine, the
// CLI and the browser share it. The look follows tools/mockups/jig-platform/s06-report.html.
//
// - 검토용 (`review`): everything — every section, assumption, source and `[S#]` citation, the
//   settings ledger, gate ids — and the line "VIDE에서 열기: 프로젝트 · 작업본 · 판". Never a
//   control that changes settings.
// - 보고용 (`public`): only the chosen sections (default: the frame's `public` ones), with the
//   first-page 가정·미검토 summary and the jig's notices kept; no internal ids, no `[S#]` markers,
//   no settings history, no buttons. The head names the 검토용 run it came from.

import type {
  ClaimOut,
  ReportBlock,
  ReportBlockOut,
  ReportModel,
} from '../jigs/runtime/report-format.ts';

export interface JigReportOrigin {
  project: string;
  /** The instance (작업본) title. */
  instance: string;
  /** The jig version, e.g. `0.1.0`. */
  version: string;
  /** When the page was made (shown in the source line). */
  at?: string;
}

export type ReportTier = 'review' | 'public';
export interface ReportHtmlOptions {
  tier: ReportTier;
  /** The 보고용 title (page title and the line above the headline); default the frame's title. */
  title?: string;
  /** The 검토용 run the 보고용 comes from (instance id, report id, when that run was made). */
  sourceRun?: { instanceId: string; reportId: string; at: string };
  /** Section ids of the 보고용; default the sections the frame marks `public`. */
  sections?: string[];
}

const escape = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** `[S1]`, `[S1, S3]`, `[S2–S4]` citation markers of fact sentences (SPEC-08.7). */
const CITATION = /\s*\[S\d+(?:\s*[,·~–-]\s*S?\d+)*\]/g;
/** Text without its `[S#]` citation markers (the 보고용 paper does not carry them). */
export function stripCitations(text: string): string {
  return text.replace(CITATION, '');
}
/** The sections the frame marks for the 보고용 paper, in order. */
export function publicSectionIds(model: ReportModel): string[] {
  return model.sections.filter((s) => s.public).map((s) => s.id);
}

type Text = (text: string) => string;
const plain: Text = (text) => text;

const JIG_REPORT_CSS = `:root{--ink:#292c2d;--paper:#fff;--line:#dde1de;--muted:#737b7d;--soft:#f6f7f4;--bar-base:#dfe2df;--bar-alt:#a9c4ad;--bar-strong:#4f7a60;--bar-actual:#d97660;--bar-na:#c9cecb;--ng:#c8553d}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.6 'Pretendard','Noto Sans KR','Malgun Gothic',Arial,sans-serif;font-variant-numeric:tabular-nums;word-break:keep-all;overflow-wrap:break-word}
.wrap{max-width:1344px;margin:0 auto;padding:48px 24px 64px}
.eyebrow{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin:0}
h1{font-size:44px;line-height:1.2;letter-spacing:-.025em;margin:14px 0 18px;max-width:1100px}
.lede{font-size:15px;color:#565e60;max-width:680px;margin:0}
.src{display:flex;flex-wrap:wrap;gap:6px 20px;margin-top:18px;font-size:12px;color:var(--muted)}
.caveat{margin:28px 0 0;padding:14px 16px;background:var(--soft);border-left:2px solid var(--ink);font-size:13px;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px 32px}
.caveat h4{margin:0 0 4px;font-size:12px;color:var(--muted);font-weight:400}.caveat ul{margin:0;padding-left:18px}.caveat p{margin:0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));border-top:2px solid var(--ink);margin-top:36px}
.kpi{padding:18px 24px 20px 0}.kpi+.kpi{padding-left:24px;border-left:1px solid var(--line)}
.kpi h3{font-size:12px;font-weight:400;color:var(--muted);margin:0}.kpi .v{font-size:32px;font-weight:500;letter-spacing:-.02em;line-height:1.25;margin:8px 0}
.kpi .v small{font-size:13px;color:var(--muted);font-weight:400;margin-left:4px}.kpi p{font-size:12px;color:var(--muted);margin:0}
section{border-top:1px solid var(--line);margin-top:64px;padding-top:48px}
.no{font-size:11px;letter-spacing:.16em;color:var(--muted)}
h2{font-size:28px;line-height:1.35;letter-spacing:-.02em;margin:12px 0;max-width:880px}
.sec-lede{color:#565e60;max-width:680px;margin:0 0 24px}
.flag{display:inline-block;margin-left:8px;padding:0 6px;border:1px solid var(--ng);color:var(--ng);border-radius:2px;font-size:11.5px;font-weight:400;vertical-align:middle;letter-spacing:0}
.flag.pv{border-color:var(--muted);color:var(--muted)}
h4{font-size:14px;margin:24px 0 8px}
table{border-collapse:collapse;width:100%}th{font-size:11.5px;font-weight:400;color:var(--muted);text-align:left;padding:8px;border-bottom:1px solid var(--ink);white-space:nowrap}
td{padding:7px 8px;border-bottom:1px solid var(--line);font-size:13px}.num{text-align:right;white-space:nowrap}
.bars{max-width:880px}.bar{display:grid;grid-template-columns:160px minmax(0,1fr);gap:12px;align-items:center;height:32px}
.bar .l{font-size:12px;color:#565e60;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.track{position:relative;height:18px;margin-right:72px}.fill{position:absolute;left:0;top:0;bottom:0;border-radius:0 2px 2px 0}
.val{position:absolute;top:50%;transform:translate(6px,-50%);font-size:12.5px;font-weight:700;white-space:nowrap}
.limit{position:absolute;top:-6px;bottom:-6px;border-left:1.5px dashed var(--ink)}
.limit-l{font-size:11px;margin:6px 0 0 172px}
.s-base{background:var(--bar-base)}.s-alt{background:var(--bar-alt)}.s-strong{background:var(--bar-strong)}.s-actual{background:var(--bar-actual)}.s-na{background:var(--bar-na)}
.ledger{display:grid;grid-template-columns:260px minmax(0,1fr);gap:32px;align-items:start}.ledger ol{margin:0;padding:0;list-style:none;font-size:13px}
.ledger li{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)}.ledger li span:last-child{color:var(--muted)}
.grp td{background:var(--soft);font-weight:700}
.open{margin-top:64px;padding-top:16px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
.gates{font-size:12px;color:var(--ng)}
.notice{margin:0 0 20px;padding:10px 14px;border:1px solid var(--line);background:var(--soft);font-size:13px;font-weight:500}.notice p{margin:0}.notice.foot{margin:48px 0 0}
@page{size:A3 landscape;margin:14mm}
@media print{.wrap{max-width:none;padding:0}section{margin-top:28px;padding-top:20px;break-inside:avoid-page}h1{font-size:36px}thead{display:table-header-group}tr{break-inside:avoid}}
@media (max-width:720px){h1{font-size:30px}.ledger{grid-template-columns:1fr}.bar{grid-template-columns:96px minmax(0,1fr)}.limit-l{margin-left:108px}}`;

const claimHtml = (claim: ClaimOut, t: Text = plain) =>
  escape(t(claim.text)) +
  (claim.check ? `<span class="flag">${escape(claim.check)}</span>` : '') +
  (claim.provisional ? '<span class="flag pv">확정 전 미리보기</span>' : '');
const cellHtml = (cell: string, numeric: boolean | undefined, t: Text) =>
  `<td${numeric ? ' class="num"' : ''}>${escape(t(cell))}</td>`;

function jigBlockHtml(block: ReportBlock, t: Text = plain): string {
  const head = block.title ? `<h4>${escape(t(block.title))}</h4>` : '';
  if (block.kind === 'list')
    return `${head}<ul>${block.items.map((item) => `<li>${escape(t(item))}</li>`).join('')}</ul>`;
  const th =
    block.kind === 'compare-bars'
      ? ''
      : block.columns
          .map(
            (c) =>
              `<th${c.numeric ? ' class="num"' : ''}>${escape(c.label)}${c.unit ? ` (${escape(c.unit)})` : ''}</th>`,
          )
          .join('');
  if (block.kind === 'table') {
    const body = block.rows
      .map(
        (row) =>
          `<tr>${row.map((cell, i) => cellHtml(cell, block.columns[i]?.numeric, t)).join('')}</tr>`,
      )
      .join('');
    return `${head}<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>${block.more > 0 ? `<p class="src">외 ${block.more}행은 CSV에 있습니다.</p>` : ''}`;
  }
  if (block.kind === 'ledger') {
    const toc = block.groups
      .map((g) => `<li><span>${escape(t(g.name))}</span><span>${g.count}</span></li>`)
      .join('');
    let last: string | undefined;
    const body = block.rows
      .map((row) => {
        const group =
          row.group !== last
            ? `<tr class="grp"><td colspan="${block.columns.length}">${escape(t(row.group))}</td></tr>`
            : '';
        last = row.group;
        return `${group}<tr>${row.cells.map((cell, i) => cellHtml(cell, block.columns[i]?.numeric, t)).join('')}</tr>`;
      })
      .join('');
    return `${head}<div class="ledger"><ol>${toc}</ol><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
  }
  const pct = (value: number) =>
    `${Math.max(0, Math.min(100, (value / block.max) * 100)).toFixed(2)}%`;
  const unit = block.unit ? ' ' + escape(block.unit) : '';
  const rows = block.rows
    .map((row) => {
      const at = row.value === null ? '0%' : pct(row.value);
      const fill =
        row.value === null ? '' : `<span class="fill s-${row.shade}" style="width:${at}"></span>`;
      const limit = block.limit
        ? `<span class="limit" style="left:${pct(block.limit.value)}"></span>`
        : '';
      return `<div class="bar"><span class="l">${escape(t(row.label))}</span><div class="track">${fill}<span class="val" style="left:${at}">${escape(row.text)}${row.value === null ? '' : unit}</span>${limit}</div></div>`;
    })
    .join('');
  const limit = block.limit
    ? `<p class="limit-l">┆ ${escape(block.limit.label ?? '한도')} ${escape(block.limit.text)}${unit}</p>`
    : '';
  return `${head}<div class="bars">${rows}${limit}</div>`;
}

/**
 * A report as a self-contained page. `review` is the 검토용 paper (what `renderJigReport` always
 * made); `public` is the 보고용 paper of the chosen sections.
 */
export function renderReportHtml(
  model: ReportModel,
  origin: JigReportOrigin,
  options: ReportHtmlOptions,
): string {
  const isPublic = options.tier === 'public';
  const t: Text = isPublic ? stripCitations : plain;
  const kpis = model.kpis.length
    ? `<div class="kpis">${model.kpis
        .map(
          (k) =>
            `<div class="kpi"><h3>${escape(t(k.label))}</h3><div class="v">${escape(t(k.value))}${k.unit ? `<small>${escape(k.unit)}</small>` : ''}</div>${k.note || k.provisional ? `<p>${escape(t(k.note ?? ''))}${k.provisional ? ' 확정 전 미리보기' : ''}</p>` : ''}</div>`,
        )
        .join('')}</div>`
    : '';
  const list = (items: readonly string[]) =>
    items.length
      ? `<ul>${items.map((item) => `<li>${escape(t(item))}</li>`).join('')}</ul>`
      : '<p>없음</p>';
  const failed = model.gates.filter((g) => !g.ok);
  const chosen = new Set(options.sections ?? publicSectionIds(model));
  const shown = isPublic ? model.sections.filter((s) => chosen.has(s.id)) : model.sections;
  const sections = shown
    .map((s, i) => {
      // 보고용: numbered again in the chosen order, no section ids, no settings ledger blocks.
      const blocks = isPublic ? s.blocks.filter((b: ReportBlockOut) => !b.settings) : s.blocks;
      const no = isPublic ? String(i + 1).padStart(2, '0') : s.id === 'appendix' ? '부록' : s.no;
      const id = isPublic ? '' : ` id="${escape(s.id)}"`;
      return `<section${id}><span class="no">${escape(no)}</span><h2>${claimHtml(s.title, t)}</h2>${s.lede ? `<p class="sec-lede">${claimHtml(s.lede, t)}</p>` : ''}${blocks.map((b) => jigBlockHtml(b, t)).join('')}</section>`;
    })
    .join('');
  const run = options.sourceRun;
  const source = isPublic
    ? [
        origin.at ? `만든 날 ${origin.at}` : undefined,
        run ? `검토용 ${run.at} 회차에서 만듦 · 회차 ${run.instanceId.slice(0, 8)}` : undefined,
      ]
    : [...model.source, origin.at ? `보고서 ${origin.at}` : undefined];
  const sourceLine = source
    .filter((text): text is string => !!text)
    .map((text) => `<span>${escape(text)}</span>`)
    .join('');
  const gates = failed.length
    ? isPublic
      ? '<p class="gates">확인 필요한 문장이 있습니다.</p>'
      : `<p class="gates">확인 필요: ${failed.map((g) => escape(g.id)).join(' · ')}</p>`
    : '';
  const notice = (where: string) =>
    model.notices?.length
      ? `<div class="notice${where}">${model.notices.map((n) => `<p>${escape(t(n))}</p>`).join('')}</div>`
      : '';
  const title = isPublic ? (options.title ?? model.title) : model.title;
  const eyebrow = isPublic ? (options.title ?? model.eyebrow) : model.eyebrow;
  const foot = isPublic
    ? notice(' foot')
    : // A page without a project (법규 체크 has no instance page to open) has no open line.
      `${notice(' foot')}${origin.project ? `<p class="open">VIDE에서 열기: ${escape(origin.project)} · ${escape(origin.instance)} · ${escape(origin.version)}</p>` : ''}`;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${JIG_REPORT_CSS}</style></head><body><main class="wrap">
${notice('')}${eyebrow ? `<p class="eyebrow">${escape(eyebrow)}</p>` : ''}<h1>${claimHtml(model.headline, t)}</h1>${model.lede ? `<p class="lede">${claimHtml(model.lede, t)}</p>` : ''}<div class="src">${sourceLine}</div>
${gates}${model.provisional.length ? '<p class="src">확정 전 미리보기 결과가 섞여 있습니다. 확정 결과로 읽지 마십시오.</p>' : ''}
<div class="caveat"><div><h4>가정</h4>${list(model.assumptions)}</div><div><h4>검토하지 않은 항목</h4>${list(model.unchecked)}</div></div>
${kpis}${sections}
${foot}
</main></body></html>`;
}
