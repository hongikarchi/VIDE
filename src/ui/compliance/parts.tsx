import { Fragment, useEffect, useMemo, useState } from 'react';
import type { PanelHost } from '../jig-panel/panel.tsx';
import { messageOf, type InstanceState } from '../jig-panel/instance.ts';
import { selectNative } from '../legal-target.ts';
import type { ComplianceView } from './context.ts';
import {
  COMPLIANCE_GROUPS,
  COMPLIANCE_STATES,
  NOTICE,
  OUT_OF_LIST,
  OVERLAY_ENVELOPE,
  OVERLAY_EXCEEDANCE,
  STATE_META,
  answersOf,
  envelopeItems,
  exceedanceItems,
  exceedancesOf,
  exportBlock,
  exportName,
  groundLabel,
  headline,
  orderedItems,
  reportHtml,
  resultCsv,
  revisionOf,
  roleCounts,
  rowObjects,
  rowTexts,
  ruleLabel,
  safeLink,
  stamp,
  unusedCounts,
  valueText,
  variantLabel,
  type ComplianceItem,
  type ComplianceResult,
  type ComplianceState,
} from './model.ts';
import './compliance.css';

// 법규 체크 jig 화면의 부품 (Design SCR-32, SPEC-15.9·15.11·15.12·15.13, PLAN-48 T-239):
// `compliance-run` — [법규 체크] and the last check; `compliance-summary` — '다시 체크 필요' band,
// the five state cells and 미확정; `compliance-result` — the result drawer (결과 · 미적용 · 분류 ·
// 입력), the exceedances in 3D, row → VIDE viewport selection, CSV and the HTML report. They draw
// the engine's `ComplianceResult` as it is: no verdict is made or softened here.

function StateChip({ state }: { state: ComplianceState }) {
  const meta = STATE_META[state];
  return (
    <span className="cmp-state" data-tone={meta.tone} data-state={state}>
      <b aria-hidden="true">{meta.symbol}</b> {state}
    </span>
  );
}

function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── [법규 체크] ─────────────────────────────────────────────────────────────────────────

/**
 * [법규 체크] (SPEC-15.1 3): read the linked document again, then compute the `check` step by
 * name. A read that fails stops here with its reason (SPEC-15.14) and the result stays as it was.
 */
function useCheck(view: ComplianceView, jig: InstanceState) {
  const [problem, setProblem] = useState<string>();
  const [reading, setReading] = useState(false);
  const run = async () => {
    setProblem(undefined);
    setReading(true);
    try {
      await view.readDocument(true);
    } catch (error) {
      setProblem(messageOf(error));
      return;
    } finally {
      setReading(false);
    }
    await jig.runStep(view.step);
  };
  return { run, problem, busy: reading || jig.busy || jig.computing, reading };
}

export function ComplianceRun({ view, jig }: { view: ComplianceView; jig: InstanceState }) {
  const result = view.read.kind === 'ok' ? view.read.result : null;
  const model = result?.inputs.model;
  const check = useCheck(view, jig);
  // Why the last [법규 체크] did not go through: the read, the run request, or the step itself.
  const why = check.problem ?? (jig.notice && !check.busy ? jig.notice : undefined) ?? view.failure;
  return (
    <section className="kit-section cmp-run" aria-label="법규 체크 실행">
      {view.remote ? (
        <p className="kit-muted" data-remote="">
          법규 체크는 작업 PC 화면에서 합니다.
        </p>
      ) : (
        <button
          type="button"
          className="kit-button cmp-run-button"
          data-primary
          disabled={check.busy}
          onClick={() => void check.run()}
        >
          {check.reading
            ? '모델을 읽는 중…'
            : jig.busy || jig.computing
              ? '계산하는 중…'
              : why
                ? '법규 체크 다시 누르기'
                : '법규 체크'}
        </button>
      )}
      {why ? (
        <p className="cmp-warn" role="alert" data-check-failed="">
          {why}
          {result ? ' · 아래는 이전 결과입니다' : ''}
        </p>
      ) : null}
      <p className="kit-muted" data-last-check="">
        {result
          ? `${why ? '마지막 체크 실패 · 이전 결과 ' : '마지막 체크 '}${stamp(result.checkedAt)}${model ? ` · 문서 판 ${revisionOf(model.revisionKey)}` : ''}`
          : '아직 체크하지 않았습니다 · 누를 때만 모델을 읽고 계산합니다'}
      </p>
    </section>
  );
}

// ── 머리: 다시 체크 필요 · 상태 칸 ────────────────────────────────────────────────────────────

export function ComplianceSummary({ view, jig }: { view: ComplianceView; jig: InstanceState }) {
  const result = view.read.kind === 'ok' ? view.read.result : null;
  const check = useCheck(view, jig);
  const head = result ? headline(result) : null;
  return (
    <div className="cmp-summary" data-stale={view.stale ? 'true' : undefined}>
      <p className="cmp-notice" data-notice="">
        탐색용 법규 체크 · 인허가 검토 아님
      </p>
      {view.stale ? (
        <div className="cmp-stale" role="status" data-stale-band="">
          <span>
            <strong>다시 체크 필요</strong> · {view.reasons.join(' · ')}
          </span>
          {view.limitsNeedRecompute ? (
            <span className="kit-muted">
              먼저 건축 가능 영역·매스를 다시 계산하세요. 그 전에 체크하면 규제 조건 항목이 사람
              입력 필요로 나옵니다.
            </span>
          ) : null}
          {view.remote ? null : (
            <button
              type="button"
              className="kit-button"
              disabled={check.busy}
              onClick={() => void check.run()}
            >
              법규 체크
            </button>
          )}
        </div>
      ) : null}
      {!result && (view.failure || check.problem) ? (
        <p className="cmp-warn" role="alert" data-check-failed="">
          {check.problem ?? view.failure}
        </p>
      ) : null}
      <div className="kit-kpis cmp-kpis" role="group" aria-label="상태별 수">
        {COMPLIANCE_STATES.map((state) => {
          const meta = STATE_META[state];
          return (
            <div key={state} className="kit-kpi" data-kpi={state} data-tone={meta.tone}>
              <div className="kit-kpi-title">
                <span>
                  <b aria-hidden="true">{meta.symbol}</b> {state}
                </span>
                {state === '위반' && result && result.counts['위반'] > 0 ? (
                  <span className="kit-over">위반 있음</span>
                ) : null}
              </div>
              {result ? (
                <div className="kit-kpi-value">{result.counts[state]}</div>
              ) : (
                <div className="kit-kpi-value" data-empty>
                  — 체크 전
                </div>
              )}
            </div>
          );
        })}
        <div className="kit-kpi" data-kpi="미확정">
          <div className="kit-kpi-title">
            <span>미확정</span>
          </div>
          {result ? (
            <div className="kit-kpi-value">{result.unconfirmedCount}</div>
          ) : (
            <div className="kit-kpi-value" data-empty>
              — 체크 전
            </div>
          )}
        </div>
      </div>
      {head ? (
        <p className="cmp-headline" data-tone={head.tone} data-headline="">
          {head.text}
        </p>
      ) : null}
    </div>
  );
}

// ── 결과 서랍 ──────────────────────────────────────────────────────────────────────────

function Basis({ item }: { item: ComplianceItem }) {
  if (!item.basis.length)
    return <span className="kit-muted">{item.limit ? '근거 없음' : '—'}</span>;
  return (
    <span className="cmp-basis">
      {item.basis.map((b, i) => {
        const link = safeLink(b.link);
        return (
          <Fragment key={i}>
            {link ? (
              <a
                className="cmp-chip"
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
              >
                {b.clause || '원문'}
              </a>
            ) : (
              <span className="cmp-chip">{b.clause || '근거 없음'}</span>
            )}
            {b.answer ? (
              <span className="cmp-chip" data-answer="">
                {b.answer}
              </span>
            ) : null}
          </Fragment>
        );
      })}
    </span>
  );
}

function RowDetail({
  item,
  onPiece,
  onClassification,
}: {
  item: ComplianceItem;
  onPiece: (no: number) => void;
  onClassification: () => void;
}) {
  const blocked = /역할|숨긴|쓰지 못한/.test(item.reason);
  return (
    <div className="cmp-detail">
      {item.numbers.length ? (
        <table className="kit-table" aria-label={`${item.title} 숫자 출처`}>
          <thead>
            <tr>
              <th>숫자</th>
              <th data-num>값</th>
              <th>출처</th>
              <th>참조</th>
            </tr>
          </thead>
          <tbody>
            {item.numbers.map((n, i) => (
              <tr key={i}>
                <td>
                  {n.label}
                  {n.note ? <small className="kit-muted"> · {n.note}</small> : null}
                </td>
                <td data-num>{n.value === null ? '—' : valueText(n.value, n.unit)}</td>
                <td>{n.kind}</td>
                <td className="cmp-mono">{n.ref}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {item.cases.length ? (
        <p data-cases="">
          <span className="kit-muted">경우별 결과 </span>
          {item.cases.map((c, i) => (
            <span key={i} className="cmp-case">
              {c.label} → <StateChip state={c.state} />
            </span>
          ))}
        </p>
      ) : null}
      {item.parts.length ? (
        <p data-parts="">
          <span className="kit-muted">구간별 결과 </span>
          {item.parts.map((p, i) => (
            <span key={i} className="cmp-case">
              {p.label} → <StateChip state={p.state} />
              {p.reason ? <small className="kit-muted"> {p.reason}</small> : null}
            </span>
          ))}
        </p>
      ) : null}
      {item.exceedances.length ? (
        <table className="kit-table" aria-label={`${item.title} 초과 부분`}>
          <thead>
            <tr>
              <th data-num>번호</th>
              <th>규칙</th>
              <th data-num>부피</th>
              <th data-num>높이 범위</th>
              <th>구간</th>
              <th data-num>객체</th>
            </tr>
          </thead>
          <tbody>
            {item.exceedances.map((piece) => (
              <tr
                key={piece.no}
                data-exceedance={piece.no}
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  onPiece(piece.no);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    onPiece(piece.no);
                  }
                }}
              >
                <td data-num className="cmp-mono">
                  {piece.no}
                </td>
                <td>
                  {ruleLabel(piece.rule)} · {variantLabel(piece.variant)} ·{' '}
                  {groundLabel(piece.groundCase)}
                  {piece.rooftopOnly ? <span className="cmp-tag">옥탑만</span> : null}
                </td>
                <td data-num>{valueText(piece.volume, '㎥')}</td>
                <td data-num>
                  {piece.min[2].toFixed(2)}~{piece.max[2].toFixed(2)} m
                </td>
                <td>{piece.segments.join(', ') || '—'}</td>
                <td data-num>{piece.objectIds.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {item.unconfirmed.length ? (
        <p className="kit-muted" data-unconfirmed="">
          미확정 사항: {item.unconfirmed.join(' · ')}
        </p>
      ) : null}
      {blocked ? (
        <button type="button" className="kit-button" onClick={onClassification}>
          분류 보기
        </button>
      ) : null}
    </div>
  );
}

const COLUMNS = 8;

function ResultTable({
  result,
  open,
  onRow,
  onPiece,
  onClassification,
}: {
  result: ComplianceResult;
  open?: number;
  onRow: (item: ComplianceItem & { no: number }) => void;
  onPiece: (no: number) => void;
  onClassification: () => void;
}) {
  const rows = orderedItems(result);
  return (
    <div className="kit-table-wrap cmp-table-wrap">
      <table className="kit-table cmp-table" aria-label="법규 체크 결과">
        <thead>
          <tr>
            <th data-num>번호</th>
            <th>상태</th>
            <th>항목</th>
            <th data-num>계획</th>
            <th data-num>한계</th>
            <th data-num>여유</th>
            <th>근거</th>
            <th>이유</th>
          </tr>
        </thead>
        {COMPLIANCE_GROUPS.map((group) => {
          const inGroup = rows.filter((row) => row.group === group);
          if (!inGroup.length) return null;
          return (
            <tbody key={group} data-group={group}>
              <tr className="cmp-group">
                <th colSpan={COLUMNS} scope="rowgroup">
                  {group}
                </th>
              </tr>
              {inGroup.map((item) => {
                const texts = rowTexts(item);
                const expanded = open === item.no;
                return (
                  <Fragment key={item.id}>
                    <tr
                      className="cmp-row"
                      data-check={item.id}
                      data-state={item.state}
                      aria-selected={expanded}
                      aria-expanded={expanded}
                      tabIndex={0}
                      onClick={() => onRow(item)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onRow(item);
                        }
                      }}
                    >
                      <td data-num className="cmp-mono cmp-no">
                        {item.no}
                      </td>
                      <td className="cmp-cell-state">
                        <StateChip state={item.state} />
                      </td>
                      <td className="cmp-title">{item.title}</td>
                      <td data-num className="cmp-planned">
                        {texts.planned}
                      </td>
                      <td data-num className="cmp-limit">
                        {texts.limit}
                        {item.limit?.status === '가정' ? (
                          <span className="cmp-tag">가정</span>
                        ) : null}
                      </td>
                      <td
                        data-num
                        className="cmp-margin"
                        data-over={item.margin !== null && item.margin < 0 ? '' : undefined}
                      >
                        {texts.margin}
                      </td>
                      <td className="cmp-cell-basis">
                        <Basis item={item} />
                      </td>
                      <td className="cmp-reason">{item.reason}</td>
                    </tr>
                    {expanded ? (
                      <tr className="cmp-detail-row">
                        <td colSpan={COLUMNS}>
                          <RowDetail
                            item={item}
                            onPiece={onPiece}
                            onClassification={onClassification}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

function NotApplicable({ result }: { result: ComplianceResult }) {
  if (!result.notApplicable.length)
    return <p className="kit-muted">적용 여부가 '미적용'으로 확정된 항목이 없습니다.</p>;
  return (
    <table className="kit-table" aria-label="미적용 항목">
      <thead>
        <tr>
          <th>항목</th>
          <th>규제 조건</th>
          <th>근거</th>
        </tr>
      </thead>
      <tbody>
        {result.notApplicable.map((n) => (
          <tr key={n.check}>
            <td>{n.title}</td>
            <td className="cmp-mono">{n.id}</td>
            <td>{n.basis || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Classification({ result }: { result: ComplianceResult }) {
  const roles = roleCounts(result);
  const unused = unusedCounts(result);
  const c = result.classification;
  return (
    <div className="cmp-classification" data-classification="">
      <table className="kit-table" aria-label="역할별 객체 수">
        <thead>
          <tr>
            <th>역할</th>
            <th data-num>객체</th>
          </tr>
        </thead>
        <tbody>
          {roles.length ? (
            roles.map((r) => (
              <tr key={r.role}>
                <td>{r.label}</td>
                <td data-num>{r.count}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={2} className="kit-muted">
                역할이 정해진 객체가 없습니다
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p>
        쓰지 못한 객체:{' '}
        {unused.length ? unused.map((u) => `${u.reason} ${u.count}`).join(' · ') : '없음'}
      </p>
      <p className="kit-muted">
        AI 제안을 사람이 받은 객체 {c.aiAccepted} · 숨긴 역할 객체 {c.hiddenWithRole} · 형상이 바뀐
        객체 {c.geometryChanged}
        {c.byRole.ignore ? ` · 검사에서 뺌 ${c.byRole.ignore}` : ''}
      </p>
    </div>
  );
}

function Inputs({ result }: { result: ComplianceResult }) {
  const model = result.inputs.model;
  const answers = answersOf(result);
  const ref = (r: ComplianceResult['inputs']['limits']) =>
    r ? `${r.title} · 계산 ${stamp(r.at)}` : '없음';
  return (
    <table className="kit-table" aria-label="입력">
      <tbody>
        <tr>
          <th>읽은 문서</th>
          <td>
            {model ? (
              <>
                <span className="cmp-mono">{model.documentKey}</span> · 판{' '}
                {revisionOf(model.revisionKey)} · 읽음 {stamp(model.readAt)} · 객체 {model.objects}{' '}
                · 역할 없음·쓰지 못함 {model.unclassified} · 분류 판 {model.rolesVersion}
              </>
            ) : (
              '없음'
            )}
          </td>
        </tr>
        <tr>
          <th>규제 조건 · 건축 가능 영역·매스</th>
          <td>{ref(result.inputs.limits)}</td>
        </tr>
        <tr>
          <th>대지 · 사이트 모델링</th>
          <td>{ref(result.inputs.siteModel)}</td>
        </tr>
        <tr>
          <th>법규 답 번호</th>
          <td>{answers.length ? answers.join(' · ') : '없음'}</td>
        </tr>
        <tr>
          <th>체크</th>
          <td>{stamp(result.checkedAt)}</td>
        </tr>
      </tbody>
    </table>
  );
}

type Tab = 'result' | 'na' | 'classification' | 'inputs';

export function ComplianceResultPart({
  view,
  host,
}: {
  view: ComplianceView;
  host: Pick<PanelHost, 'overlay' | 'focus' | 'onOverlayPick'>;
}) {
  const result = view.read.kind === 'ok' ? view.read.result : null;
  const [tab, setTab] = useState<Tab>('result');
  const [open, setOpen] = useState<number>();
  const [envelope, setEnvelope] = useState(false);
  const exceedances = useMemo(() => (result ? exceedanceItems(result) : []), [result]);
  const outline = useMemo(() => (result ? envelopeItems(result) : []), [result]);

  // 3D: the exceedances while the drawer is open; the 최대 외피 outline when asked for.
  useEffect(() => {
    host.overlay(OVERLAY_EXCEEDANCE, exceedances.length ? exceedances : null);
  }, [host, exceedances]);
  useEffect(() => {
    host.overlay(OVERLAY_ENVELOPE, envelope && outline.length ? outline : null);
  }, [host, envelope, outline]);
  useEffect(
    () => () => {
      host.overlay(OVERLAY_EXCEEDANCE, null);
      host.overlay(OVERLAY_ENVELOPE, null);
    },
    [host],
  );
  // A picked exceedance in 3D opens the first row that lists it.
  useEffect(
    () =>
      host.onOverlayPick?.((hit) => {
        if (hit.key !== OVERLAY_EXCEEDANCE || !result) return;
        const no = Number(hit.itemId.replace(/^x/, ''));
        const row = orderedItems(result).find((item) =>
          item.exceedances.some((piece) => piece.no === no),
        );
        if (row) {
          setTab('result');
          setOpen(row.no);
        }
      }),
    [host, result],
  );

  const blocked = exportBlock(result, view.stale);
  const exports = (
    <div className="cmp-exports" data-exports="">
      <button
        type="button"
        className="kit-button"
        disabled={!!blocked}
        onClick={() =>
          result &&
          download(`${exportName(result)}.csv`, resultCsv(result), 'text/csv;charset=utf-8')
        }
      >
        CSV
      </button>
      <button
        type="button"
        className="kit-button"
        disabled={!!blocked}
        onClick={() =>
          result &&
          download(`${exportName(result)}.html`, reportHtml(result), 'text/html;charset=utf-8')
        }
      >
        보고서
      </button>
      {blocked ? <span className="kit-reason">{blocked}</span> : null}
    </div>
  );

  if (view.read.kind === 'invalid')
    return (
      <div className="kit-drawer cmp-drawer">
        <p className="kit-notice" data-level="error" role="alert">
          결과가 법규 체크 형식과 맞지 않아 판정을 보이지 않습니다.
        </p>
        <ul className="kit-issues">
          {view.read.issues.map((issue, i) => (
            <li key={i}>{issue}</li>
          ))}
        </ul>
      </div>
    );
  if (!result)
    return (
      <div className="kit-drawer cmp-drawer" data-empty="">
        <p className="kit-muted" role="status">
          아직 체크하지 않았습니다. [법규 체크]를 누르면 연결된 Rhino 문서를 읽어 규모·형상 제한·
          주차·조경·공개공지를 항목마다 판정합니다.
        </p>
        {exports}
      </div>
    );

  const select = (item: ComplianceItem & { no: number }) => {
    const opening = open !== item.no;
    setOpen(opening ? item.no : undefined);
    if (!opening) return;
    // VIDE's own selection (SPEC-15.11): the row's objects, then the exceedances in frame.
    const objects = rowObjects(result, item);
    if (objects.length) selectNative({ label: item.title, objects });
    const first = item.exceedances[0];
    if (first) host.focus({ overlay: OVERLAY_EXCEEDANCE, itemId: `x${first.no}` });
  };
  const tabs: { id: Tab; title: string; count?: number }[] = [
    { id: 'result', title: '결과', count: result.items.length },
    { id: 'na', title: '미적용', count: result.notApplicable.length },
    { id: 'classification', title: '분류' },
    { id: 'inputs', title: '입력' },
  ];
  return (
    <div
      className="kit-drawer cmp-drawer"
      data-compliance-result=""
      data-stale={view.stale ? 'true' : undefined}
    >
      <div className="cmp-drawer-head">
        <div className="kit-tabs" role="tablist" aria-label="법규 체크 결과">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.title}
              {t.count !== undefined ? <b>{t.count}</b> : null}
            </button>
          ))}
        </div>
        {exports}
      </div>
      <p className="cmp-notice" data-notice="">
        {NOTICE} · {OUT_OF_LIST}
      </p>
      <div role="tabpanel" className="cmp-body">
        {tab === 'result' ? (
          <>
            <ResultTable
              result={result}
              open={open}
              onRow={select}
              onPiece={(no) => host.focus({ overlay: OVERLAY_EXCEEDANCE, itemId: `x${no}` })}
              onClassification={() => setTab('classification')}
            />
            <div className="cmp-layers">
              <span className="kit-muted">
                3D: 초과 부분 {exceedancesOf(result).length}개 (번호는 표와 같음)
              </span>
              {outline.length ? (
                <label>
                  <input
                    type="checkbox"
                    checked={envelope}
                    onChange={(event) => setEnvelope(event.currentTarget.checked)}
                  />{' '}
                  최대 외피 윤곽
                </label>
              ) : null}
            </div>
          </>
        ) : tab === 'na' ? (
          <NotApplicable result={result} />
        ) : tab === 'classification' ? (
          <Classification result={result} />
        ) : (
          <Inputs result={result} />
        )}
      </div>
    </div>
  );
}
