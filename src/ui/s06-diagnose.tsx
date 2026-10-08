import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api } from './gateway.ts';
import { layerOptions } from '../core/layer-tree.ts';
import { messageOf } from './jig-panel/instance.ts';
import type { JigContext } from './jigs.tsx';
import { openContextTab } from './workspaces.ts';
import type {
  DiagnoseOutput,
  InterferenceRow,
  Measure,
  SpanRow,
} from '../../extensions/jigs/s06-frame/steps/diagnose.ts';
import {
  diagnoseCsv,
  type DiagnoseTable,
} from '../../extensions/jigs/s06-frame/steps/diagnose-csv.ts';
import {
  JUDGEMENT_LABEL,
  ROLE_KEYS,
  ROLE_LABEL,
  VERDICT_LABEL,
  VERDICT_RANK,
  VERDICT_SYMBOL,
  type RoleKey,
  type Verdict,
} from '../../extensions/jigs/s06-frame/steps/labels.ts';
import type {
  LayerSummary,
  ObjectKind,
  RolePick,
} from '../../extensions/jigs/s06-frame/steps/sync-input.ts';

// Layout diagnosis of the structure jig (PLAN-23 T-044, SPEC-06.14, Design SCR-13 KPI 띠·결과 표):
// read the columns, girders and footings as drawn in linked Syncs, then show interference and
// spans as a KPI strip, tables with CSV, and 3D overlays. Read-only: nothing is sent to a host.
// A role may take several layers (from any chosen Sync); a result made from other roles or Syncs
// is cleared with a notice. '이 jig로 열기' opens an S-06 jig instance with the same role layers.

interface Layers {
  sources: { syncId: string; document: string; layers: LayerSummary[] }[];
  guess: Record<RoleKey, RolePick | null>;
}
type Result = DiagnoseOutput & {
  ms: number;
  sources: { syncId: string; document: string }[];
  /** The Syncs and role layers this result was made from (compared with the current picks). */
  inputKey?: string;
};
type Roles = Record<RoleKey, string[]>;
/** The S-06 jig package that takes the same roles in its 'site' assembly (jig.json). */
const S06_JIG = 'project/s06-frame';

const KIND: Record<ObjectKind, string> = {
  curve: '곡선',
  block: '블록',
  mesh: '솔리드',
  wire: '선',
  other: '기타',
};
const HINT: Record<RoleKey, string> = {
  columns: '연직 곡선으로 그린 신설 기둥',
  girders: '곡선으로 그린 거더(대각 포함)',
  newFootings: '파일캡 솔리드와 오픈컷 외곽선을 담은 블록',
  existingFootings: '기존 기초 블록(맨 아래 판을 발자국으로 씀)',
  basinGirders: '유수지 보 솔리드(평면 띠로 씀)',
};
const TABLES: [DiagnoseTable, string][] = [
  ['interference', '간섭'],
  ['spans', '경간'],
  ['curves', '곡선 길이'],
];
const pickValue = (pick: RolePick | null | undefined) =>
  pick ? `${pick.syncId}\n${pick.layer}` : '';
const pickOf = (value: string): RolePick => {
  const [syncId, layer] = value.split('\n');
  return { syncId, layer };
};
const emptyRoles = () => Object.fromEntries(ROLE_KEYS.map((r) => [r, []])) as unknown as Roles;
const inputKeyOf = (chosen: readonly string[], roles: Roles) =>
  JSON.stringify([chosen, ROLE_KEYS.map((role) => [...roles[role]].sort())]);
const m2 = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined ? '—' : value.toFixed(digits);
const distance = (value: number | null) =>
  value === null ? '—' : value < 0 ? `겹침 ${(-value).toFixed(2)}` : value.toFixed(2);
/** The document part of a Sync label ('name · date'). */
const documentOf = (label: string) => label.split(' · ')[0];
/** ' — kind counts' after a layer's name. */
const kindText = (layer: LayerSummary) =>
  ' — ' +
  Object.entries(layer.kinds)
    .map(([kind, n]) => `${KIND[kind as ObjectKind]} ${n}`)
    .join(', ');
/** A Sync's layers as picker rows: sublayers indented under their parent (kept in given order). */
function layerChoices(layers: readonly LayerSummary[]) {
  const byName = new Map(layers.map((layer) => [layer.name, layer]));
  const placed = layerOptions(layers.map((layer) => layer.name).filter(Boolean));
  const rows = placed.map((option) => ({
    key: option.value,
    label: option.label,
    layer: option.present ? byName.get(option.value) : undefined,
  }));
  // A row without a layer name keeps its place at the end.
  const unnamed = byName.get('');
  if (unnamed) rows.push({ key: '', label: '(이름 없음)', layer: unnamed });
  return rows;
}
/** 'document · layer — kind counts', as a role's layer reads in the list and in its chip. */
const layerText = (document: string, layer: LayerSummary) =>
  `${document} · ${layer.name || '(이름 없음)'} — ` +
  Object.entries(layer.kinds)
    .map(([kind, n]) => `${KIND[kind as ObjectKind]} ${n}`)
    .join(', ');

function VerdictChip({ verdict }: { verdict: Verdict }) {
  return (
    <span className="jig-verdict" data-verdict={verdict}>
      {VERDICT_SYMBOL[verdict]} {VERDICT_LABEL[verdict]}
    </span>
  );
}

function Kpi({
  title,
  value,
  unit,
  note,
  flag,
}: {
  title: string;
  value: string | number | null;
  unit?: string;
  note: string;
  flag?: { verdict: Verdict; count?: number } | null;
}) {
  return (
    <div className="jig-kpi" role="group" aria-label={title}>
      <div className="jig-kpi-title">
        {title}
        {flag ? (
          <span className="jig-verdict" data-verdict={flag.verdict}>
            {VERDICT_SYMBOL[flag.verdict]} {VERDICT_LABEL[flag.verdict]} {flag.count ?? ''}
          </span>
        ) : null}
      </div>
      <div className="jig-kpi-value">
        {value === null ? '—' : value}
        {value !== null && unit ? <small>{unit}</small> : null}
      </div>
      <div className="jig-kpi-note">{note}</div>
    </div>
  );
}

/** One check of a column: symbol (the row carries the word) and the signed distance. */
function MeasureCell({ measure }: { measure: Measure }) {
  const detail = measure.target
    ? `${VERDICT_LABEL[measure.verdict]} · ${measure.target.layer} · ${measure.target.name || measure.target.id}` +
      (measure.area > 0 ? ` · 겹침 면적 ${measure.area.toFixed(2)}㎡` : '')
    : VERDICT_LABEL[measure.verdict];
  return (
    <td className="num" title={measure.reason ?? detail}>
      {measure.verdict === 'pass' ? null : (
        <span className="jig-verdict" data-verdict={measure.verdict}>
          {VERDICT_SYMBOL[measure.verdict]}
        </span>
      )}{' '}
      {distance(measure.distance)}
    </td>
  );
}

/**
 * '이 jig로 열기': a new S-06 jig instance (SPEC-07.4: a name and an existing output layer) whose
 * 'site' assembly takes the role layers picked here — one read per Sync, then each role confirmed
 * with the layers it has (several layers or Syncs per role are kept). The tab opens on the instance.
 */
function OpenInJig({
  context,
  roles,
  onDone,
}: {
  context: JigContext;
  roles: Roles;
  onDone: () => void;
}) {
  const [jig, setJig] = useState<{ id: string; version: string; name: string } | null>();
  const [title, setTitle] = useState(
    context.projectName ? `배치 진단에서 · ${context.projectName}` : '배치 진단에서',
  );
  const [layer, setLayer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api('/jigs/packages')
      .then((value) => {
        const list =
          (
            value as {
              jigs?: {
                id: string;
                version: string;
                name: string;
                kind: string;
                corrupt?: boolean;
              }[];
            }
          ).jigs ?? [];
        const found = list.find((j) => j.id === S06_JIG && j.kind === 'tool' && !j.corrupt);
        if (live) setJig(found ? { id: found.id, version: found.version, name: found.name } : null);
      })
      .catch(() => live && setJig(null));
    return () => {
      live = false;
    };
  }, []);
  const layers = context.layers ?? [];
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!jig || !title.trim() || !layer.trim()) return;
    setBusy(true);
    setError('');
    const project = `/projects/${encodeURIComponent(context.projectId)}`;
    let opened: { id: string; title: string; jig: { name: string } } | undefined;
    try {
      opened = (await api(`${project}/jig-instances`, 'POST', {
        jig: jig.id,
        version: jig.version,
        title: title.trim(),
        layerRoot: layer.trim(),
      })) as { id: string; title: string; jig: { name: string } };
      const at = `${project}/jig-instances/${encodeURIComponent(opened.id)}`;
      // Layers of each Sync that any role takes (a layer without a name cannot be read by name).
      const picks = ROLE_KEYS.map(
        (role) => [role, roles[role].map(pickOf).filter((p) => p.layer)] as const,
      );
      const bySync = new Map<string, Set<string>>();
      for (const [, list] of picks)
        for (const pick of list)
          bySync.set(pick.syncId, (bySync.get(pick.syncId) ?? new Set()).add(pick.layer));
      const reads = new Map<string, string>();
      for (const [syncId, names] of bySync) {
        const read = (await api(`${at}/reads`, 'POST', {
          syncId,
          layers: [...names],
          purpose: 'assembly',
        })) as { readId: string };
        reads.set(syncId, read.readId);
      }
      for (const [role, list] of picks) {
        if (!list.length) continue;
        const sources = [...new Set(list.map((p) => p.syncId))].map((syncId) => ({
          readId: reads.get(syncId)!,
          layers: list.filter((p) => p.syncId === syncId).map((p) => p.layer),
        }));
        await api(`${at}/assembly/${encodeURIComponent(`site.${role}`)}`, 'PUT', {
          sources,
          confirm: true,
          reason: '배치 진단에서 고른 레이어',
        });
      }
      onDone();
    } catch (cause) {
      setError(
        (opened ? '작업본은 열었지만 역할을 모두 옮기지 못했습니다: ' : '') + messageOf(cause),
      );
      setBusy(false);
    }
    if (opened)
      openContextTab({
        instanceId: opened.id,
        label: opened.title,
        title: `${opened.jig.name} · ${opened.title}`,
      });
  };
  return (
    <form
      className="jig-new"
      aria-label="S-06 골조 배치 jig로 열기"
      onSubmit={(event) => void submit(event)}
    >
      {jig === null ? (
        <small>S-06 골조 배치 jig가 설치돼 있지 않아 열 수 없습니다.</small>
      ) : (
        <>
          <label>
            작업본 이름
            <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            출력 레이어
            <input
              value={layer}
              list={layers.length ? 's06-open-layers' : undefined}
              maxLength={1000}
              placeholder="연결 모델의 레이어"
              onChange={(e) => setLayer(e.target.value)}
            />
          </label>
          {layers.length ? (
            <datalist id="s06-open-layers">
              {layers.map((path) => (
                <option key={path} value={path} />
              ))}
            </datalist>
          ) : null}
          <button
            type="submit"
            className="primary-button"
            disabled={busy || !jig || !title.trim() || !layer.trim()}
          >
            {busy ? '여는 중…' : '열기'}
          </button>
        </>
      )}
      <button type="button" onClick={onDone}>
        취소
      </button>
      <small>
        고른 역할 레이어를 작업본의 입력 조립에 확정해 둡니다. 설정값은 jig 기본값으로 시작합니다.
      </small>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}

const severity = (a: { verdict: Verdict | null; key: string }, b: typeof a) =>
  VERDICT_RANK[b.verdict ?? 'pass'] - VERDICT_RANK[a.verdict ?? 'pass'] ||
  a.key.localeCompare(b.key);

export function S06Diagnose({ context }: { context: JigContext }) {
  const rhino = context.sources.filter((s) => s.host === 'rhino');
  // The latest Sync of each linked document (up to four) is read by default.
  const [chosen, setChosen] = useState<string[]>(() => {
    const latest = new Map<string, string>();
    for (const source of rhino) latest.set(documentOf(source.label), source.id);
    return [...latest.values()].slice(-4);
  });
  const [layers, setLayers] = useState<Layers>();
  const [roles, setRoles] = useState<Roles>(emptyRoles);
  const [params, setParams] = useState({
    spanMax: '12',
    splitTol: '0.3',
    columnSize: '0.5',
    capClearance: '0',
    openCutSize: '',
    openCutRule: 'consult' as 'consult' | 'forbid',
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState<Result>();
  const [tab, setTab] = useState<DiagnoseTable>('interference');
  const [selected, setSelected] = useState<string>();
  const [overlayOn, setOverlayOn] = useState(true);
  const [opening, setOpening] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const base = `/projects/${context.projectId}/jigs/structure`;
  const describe = (value: string) => {
    const pick = pickOf(value);
    const source = layers?.sources.find((s) => s.syncId === pick.syncId);
    const layer = source?.layers.find((l) => l.name === pick.layer);
    return source && layer ? layerText(source.document, layer) : pick.layer || '(이름 없음)';
  };

  // Layers of the chosen Syncs; roles keep their layer while it is still offered, else the guess.
  const chosenKey = chosen.join(',');
  useEffect(() => {
    if (!chosen.length) {
      setLayers(undefined);
      return;
    }
    let live = true;
    api(`${base}/layers?syncIds=${chosen.map(encodeURIComponent).join(',')}`)
      .then((data) => {
        if (!live) return;
        const next = data as Layers;
        setLayers(next);
        const offered = new Set(
          next.sources.flatMap((s) =>
            s.layers.map((l) => pickValue({ syncId: s.syncId, layer: l.name })),
          ),
        );
        setRoles(
          (previous) =>
            Object.fromEntries(
              ROLE_KEYS.map((role) => {
                const kept = previous[role].filter((value) => offered.has(value));
                const guess = pickValue(next.guess[role]);
                return [role, kept.length ? kept : guess ? [guess] : []];
              }),
            ) as unknown as Roles,
        );
      })
      .catch((error: Error) => live && setNotice(error.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenKey]);

  // A result belongs to the Syncs and role layers it was made from. When they change (or a run
  // ends after they changed) the result and its overlays go, and the notice says why.
  const inputKey = inputKeyOf(chosen, roles);
  useEffect(() => {
    if (!result || result.inputKey === inputKey) return;
    for (const layer of result.overlays) context.overlay(layer.key, null);
    setResult(undefined);
    setSelected(undefined);
    setNotice(
      '읽을 Sync나 역할 레이어가 바뀌어 이전 진단 결과를 지웠습니다. 다시 [진단]을 누르세요.',
    );
  }, [context, result, inputKey]);

  // 3D overlays follow the result and the on/off switch; the JIG panel keeps them per jig.
  useEffect(() => {
    if (!result) return;
    for (const layer of result.overlays) context.overlay(layer.key, overlayOn ? layer.items : null);
  }, [context, result, overlayOn]);

  // A click on an overlay item (a clash fill or a long span) opens its table row.
  useEffect(
    () =>
      context.onOverlayPick?.((hit) => {
        if (!result || !hit.key.startsWith('s06-')) return;
        const key = hit.itemId.split(':')[0];
        if (result.tables.interference.some((r) => r.key === key)) setTab('interference');
        else if (result.tables.spans.some((r) => r.key === key)) setTab('spans');
        else return;
        setSelected(key);
      }),
    [context, result],
  );
  useEffect(() => {
    if (selected)
      panel.current
        ?.querySelector(`tr[data-row="${CSS.escape(selected)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [selected, tab]);

  const run = async () => {
    const numbers = {
      spanMax: Number(params.spanMax),
      splitTol: Number(params.splitTol),
      columnSize: Number(params.columnSize),
      capClearance: Number(params.capClearance),
    };
    const openCutSize = params.openCutSize.trim() ? Number(params.openCutSize) : null;
    // The same bounds as the engine route, so a blank or out-of-range field is named here.
    const bounds: [string, number, number, number][] = [
      ['경간 상한', numbers.spanMax, 0.001, 100],
      ['끊기 허용오차', numbers.splitTol, 0, 5],
      ['기둥 단면', numbers.columnSize, 0.001, 5],
      ['파일캡 이격', numbers.capClearance, 0, 10],
      ['오픈컷', openCutSize ?? 1, 0.001, 20],
    ];
    const bad = bounds.find(([, v, min, max]) => !(Number.isFinite(v) && v >= min && v <= max));
    if (bad) {
      setNotice(
        `${bad[0]}은(는) ${bad[2] > 0 ? '0보다 크고' : '0 이상'} ${bad[3]} m 이하의 숫자여야 합니다.`,
      );
      return;
    }
    const picks = Object.fromEntries(
      ROLE_KEYS.flatMap((role) => (roles[role].length ? [[role, roles[role].map(pickOf)]] : [])),
    );
    const key = inputKey;
    setBusy(true);
    setNotice('');
    try {
      const out = (await api(`${base}/diagnose`, 'POST', {
        sources: chosen,
        roles: picks,
        params: { ...numbers, openCutSize, openCutRule: params.openCutRule },
      })) as Result;
      setResult({ ...out, inputKey: key });
      setSelected(undefined);
      // The result opens below the inputs; bring its KPI strip into view.
      requestAnimationFrame(() =>
        panel.current?.querySelector('.jig-s06-result')?.scrollIntoView({ block: 'start' }),
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '진단하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (!result) return;
    const url = URL.createObjectURL(
      new Blob([diagnoseCsv(result, tab)], { type: 'text/csv;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `VIDE-s06-${tab}.csv`;
    panel.current?.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const open = (row: { key: string; focus: InterferenceRow['focus'] }) => {
    setSelected(row.key);
    context.focus(row.focus);
  };

  const interference = useMemo(
    () => [...(result?.tables.interference ?? [])].sort(severity),
    [result],
  );
  const spans = useMemo(() => [...(result?.tables.spans ?? [])].sort(severity), [result]);
  const issues = (table: DiagnoseTable) =>
    !result
      ? 0
      : table === 'interference'
        ? result.tables.interference.filter((r) => r.verdict !== 'pass').length
        : table === 'spans'
          ? result.tables.spans.filter((r) => r.verdict === 'over' || r.verdict === 'incomplete')
              .length
          : result.tables.curves.filter((r) => r.overLimit).length;
  const s = result?.summary;
  const where = (row?: SpanRow) =>
    row ? `${row.girderKey} · ${row.from ?? '끝'}–${row.to ?? '끝'}` : '';
  const count = (
    summary: { count: number; incomplete: number; reason?: string } | undefined,
    verdict: Verdict,
    note: string,
  ) =>
    summary?.reason
      ? { value: null, note: `미완 — ${summary.reason}`, flag: null }
      : {
          value: summary?.count ?? 0,
          note: note + (summary?.incomplete ? ` · 미완 ${summary.incomplete}` : ''),
          flag: summary?.count ? { verdict, count: summary.count } : null,
        };

  return (
    <div className="jig-s06" ref={panel}>
      <p className="jig-s06-lede">
        지금 그려진 기둥·거더·기초를 읽기만 해서 기초 간섭과 거더 경간을 점검합니다. Rhino 원본은
        바뀌지 않습니다.
      </p>
      <fieldset className="jig-s06-sources">
        <legend>읽을 Sync (연결 문서)</legend>
        {rhino.length ? (
          rhino.map((source) => (
            <label key={source.id}>
              <input
                type="checkbox"
                checked={chosen.includes(source.id)}
                onChange={(e) =>
                  setChosen((list) =>
                    e.target.checked
                      ? rhino
                          .filter((r) => r.id === source.id || list.includes(r.id))
                          .map((r) => r.id)
                      : list.filter((id) => id !== source.id),
                  )
                }
              />
              {source.label}
            </label>
          ))
        ) : (
          <small>Rhino Sync가 없습니다. 연결 문서를 먼저 Sync하세요.</small>
        )}
      </fieldset>
      <div className="jig-s06-roles">
        {ROLE_KEYS.map((role) => (
          // One role, several layers: picked layers as chips, more added from the list.
          <div
            key={role}
            role="group"
            aria-label={ROLE_LABEL[role]}
            title={HINT[role]}
            style={{
              display: 'grid',
              gridTemplateColumns: '11em minmax(0, 1fr)',
              alignItems: 'start',
              gap: 8,
            }}
          >
            <span>{ROLE_LABEL[role]}</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, minWidth: 0 }}>
              {roles[role].length ? (
                <ul
                  className="jig-s06-picks"
                  aria-label={`${ROLE_LABEL[role]} 레이어`}
                  style={{ display: 'contents', listStyle: 'none' }}
                >
                  {roles[role].map((value) => (
                    <li key={value} className="chip">
                      <span className="jig-s06-pick">{describe(value)}</span>
                      <button
                        type="button"
                        aria-label={`${ROLE_LABEL[role]}에서 ${pickOf(value).layer || '(이름 없음)'} 빼기`}
                        onClick={() =>
                          setRoles({ ...roles, [role]: roles[role].filter((v) => v !== value) })
                        }
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <small>지정 안 함 (이 판정은 미완)</small>
              )}
              <select
                aria-label={`${ROLE_LABEL[role]} 레이어 추가`}
                value=""
                onChange={(e) =>
                  e.target.value && setRoles({ ...roles, [role]: [...roles[role], e.target.value] })
                }
              >
                <option value="">
                  {roles[role].length ? '+ 레이어 더하기' : '+ 레이어 고르기'}
                </option>
                {layers?.sources.map((source) => (
                  <optgroup key={source.syncId} label={source.document}>
                    {/* Rhino sublayers indent under their parent, in the server's panel order;
                        a parent with no objects of its own is shown but not pickable. */}
                    {layerChoices(source.layers)
                      .filter(
                        ({ layer }) =>
                          !layer ||
                          !roles[role].includes(
                            pickValue({ syncId: source.syncId, layer: layer.name }),
                          ),
                      )
                      .map(({ key, label, layer }) =>
                        layer ? (
                          <option
                            key={key}
                            value={pickValue({ syncId: source.syncId, layer: layer.name })}
                            title={layerText(source.document, layer)}
                          >
                            {label + kindText(layer)}
                          </option>
                        ) : (
                          <option key={key} value="" disabled>
                            {label}
                          </option>
                        ),
                      )}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>
        ))}
      </div>
      <details className="jig-s06-params">
        <summary>
          설정값 · 경간 상한 {params.spanMax} m · 끊기 허용오차 {params.splitTol} m · 기둥{' '}
          {params.columnSize} m 각
        </summary>
        <div className="jig-inputs">
          {(
            [
              ['spanMax', '경간 상한 m'],
              ['splitTol', '기둥 위 끊기 허용오차 m'],
              ['columnSize', '기둥 단면 m (정사각)'],
              ['capClearance', '파일캡 이격 m'],
              ['openCutSize', '외곽선 없는 블록의 오픈컷 m'],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                step="0.1"
                min="0"
                placeholder={key === 'openCutSize' ? '없음 (미완)' : undefined}
                aria-label={label}
                value={params[key]}
                onChange={(e) => setParams({ ...params, [key]: e.target.value })}
              />
            </label>
          ))}
          <label>
            오픈컷↔기존 기초
            <select
              aria-label="오픈컷 판정"
              value={params.openCutRule}
              onChange={(e) =>
                setParams({ ...params, openCutRule: e.target.value as 'consult' | 'forbid' })
              }
            >
              <option value="consult">협의 (토목 협의 목록)</option>
              <option value="forbid">불가</option>
            </select>
          </label>
        </div>
      </details>
      <div className="jig-actions">
        <button
          type="button"
          className="primary-button"
          disabled={busy || !chosen.length}
          onClick={() => void run()}
        >
          {busy ? '진단 중…' : '진단'}
        </button>
        <button
          type="button"
          aria-expanded={opening}
          disabled={!ROLE_KEYS.some((role) => roles[role].some((v) => pickOf(v).layer))}
          title="고른 역할 레이어로 S-06 골조 배치 jig 작업본을 새로 엽니다"
          onClick={() => setOpening(!opening)}
        >
          이 jig로 열기
        </button>
        <small>AI를 쓰지 않고 레이어 규칙과 기하 계산으로만 점검합니다.</small>
      </div>
      {opening ? (
        <OpenInJig context={context} roles={roles} onDone={() => setOpening(false)} />
      ) : null}
      {notice ? <p className="jig-structure-notice">{notice}</p> : null}

      {result && s ? (
        <section className="jig-s06-result" aria-label="진단 결과">
          <div className="jig-s06-head">
            <span className="pill">탐색용 예비값 · 공식 구조 검토 아님</span>
            <small>
              {result.sources.map((x) => x.document).join(' · ')} · 계산 {result.ms} ms
            </small>
          </div>
          <div className="jig-kpis">
            <Kpi
              title="신설 기둥"
              value={s.columns}
              unit="개"
              note={`거더 곡선 ${s.girders}개 · 기둥 ${result.params.columnSize} m 각`}
            />
            <Kpi
              title="파일캡 간섭"
              unit="곳"
              {...count(s.cap, 'forbidden', '기존 기초와 겹침 → 불가')}
            />
            <Kpi
              title="오픈컷 협의"
              unit="곳"
              {...count(
                s.openCut,
                result.params.openCutRule === 'consult' ? 'consult' : 'forbidden',
                '기존 기초와 겹침 → 토목 협의',
              )}
            />
            <Kpi
              title="기둥↔유수지 보"
              unit="곳"
              {...count(s.basin, 'warning', '기둥이 보 위 → 경고')}
            />
            <Kpi
              title="경간 초과"
              unit="개"
              value={s.spans.reason ? null : s.spans.over}
              note={
                s.spans.reason
                  ? `미완 — ${s.spans.reason}`
                  : `상한 ${result.params.spanMax} m · 대각 포함 경간 ${s.spans.total}개`
              }
              flag={s.spans.over ? { verdict: 'over', count: s.spans.over } : null}
            />
            <Kpi
              title="최대 경간"
              unit="m"
              value={s.spans.max === null ? null : s.spans.max.toFixed(2)}
              note={
                s.spans.max === null
                  ? `— ${s.spans.reason ?? '기둥 위에서 나뉜 경간이 없습니다'}`
                  : where(result.tables.spans.find((r) => r.key === s.spans.maxKey))
              }
              flag={
                s.spans.max !== null && s.spans.max > result.params.spanMax
                  ? { verdict: 'over' }
                  : null
              }
            />
          </div>
          {result.missing.length || result.notes.length ? (
            <ul className="jig-structure-issues">
              {result.missing.map((m) => (
                <li key={m.judgement} data-level="warning">
                  <strong>{JUDGEMENT_LABEL[m.judgement]} 미완</strong> {m.reason}
                </li>
              ))}
              {result.notes.map((note) => (
                <li key={note} data-level="info">
                  {note}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="jig-s06-bar">
            <div className="jig-tabs" role="tablist" aria-label="진단 표">
              {TABLES.map(([id, name]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => setTab(id)}
                >
                  {name}
                  {issues(id) ? <b>{issues(id)}</b> : null}
                </button>
              ))}
            </div>
            <label className="jig-s06-toggle">
              <input
                type="checkbox"
                checked={overlayOn}
                onChange={(e) => setOverlayOn(e.target.checked)}
              />
              3D 겹침
            </label>
            <button type="button" onClick={download}>
              CSV
            </button>
          </div>
          <div className="jig-table-wrap" role="tabpanel">
            {tab === 'interference' ? (
              <table className="jig-table jig-s06-table" aria-label="간섭 표">
                <thead>
                  <tr>
                    <th>기둥</th>
                    <th>판정</th>
                    <th title="파일캡↔가장 가까운 기존 기초">파일캡 m</th>
                    <th title="오픈컷↔가장 가까운 기존 기초">오픈컷 m</th>
                    <th title="기둥 단면↔가장 가까운 유수지 보">유수지 보 m</th>
                  </tr>
                </thead>
                <tbody>
                  {interference.slice(0, 1000).map((row) => (
                    <tr
                      key={row.key}
                      data-row={row.key}
                      aria-selected={selected === row.key}
                      onClick={() => open(row)}
                    >
                      <td>
                        {row.key}
                        {row.column.name ? <small> {row.column.name}</small> : null}
                      </td>
                      <td>
                        <VerdictChip verdict={row.verdict} />
                      </td>
                      <MeasureCell measure={row.cap} />
                      <MeasureCell measure={row.openCut} />
                      <MeasureCell measure={row.basin} />
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : tab === 'spans' ? (
              <table className="jig-table jig-s06-table" aria-label="경간 표">
                <thead>
                  <tr>
                    <th>구간</th>
                    <th>판정</th>
                    <th>위치</th>
                    <th>경간 m</th>
                    <th>곡선 길이 m</th>
                    <th>기준</th>
                  </tr>
                </thead>
                <tbody>
                  {spans.slice(0, 2000).map((row) => (
                    <tr
                      key={row.key}
                      data-row={row.key}
                      aria-selected={selected === row.key}
                      onClick={() => open(row)}
                      title={row.reason}
                    >
                      <td>{row.key}</td>
                      <td>{row.verdict ? <VerdictChip verdict={row.verdict} /> : '—'}</td>
                      <td>
                        {row.kind === 'unsupported'
                          ? '기둥 위에 걸리지 않음'
                          : `${row.from ?? '끝'}–${row.to ?? '끝'}${row.kind === 'overhang' ? ' 내민 구간' : ''}`}
                      </td>
                      <td className="num">{m2(row.length)}</td>
                      <td className="num">{m2(row.length3d)}</td>
                      <td>{row.kind === 'span' ? `≤ ${result.params.spanMax}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="jig-table jig-s06-table" aria-label="곡선 길이 표">
                <thead>
                  <tr>
                    <th>거더</th>
                    <th>레이어</th>
                    <th>평면 길이 m</th>
                    <th>곡선 길이 m</th>
                    <th>기둥</th>
                    <th>경간</th>
                    <th>상한 넘는 곡선</th>
                  </tr>
                </thead>
                <tbody>
                  {result.tables.curves.slice(0, 2000).map((row) => (
                    <tr
                      key={row.key}
                      data-row={row.key}
                      aria-selected={selected === row.key}
                      onClick={() => open(row)}
                    >
                      <td>{row.key}</td>
                      <td>{row.girder.layer}</td>
                      <td className="num">{m2(row.planLength)}</td>
                      <td className="num">{m2(row.length3d)}</td>
                      <td className="num">{row.supports}</td>
                      <td className="num">{row.spans}</td>
                      <td>{row.overLimit ? '참고 · 경간 초과 아님' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <small>
            {tab === 'curves'
              ? '곡선 하나의 평면 길이입니다. 경간이 아니므로 경간 초과로 세지 않습니다.'
              : tab === 'spans'
                ? `경간은 거더 곡선을 기둥 상단(허용오차 ${result.params.splitTol} m)에서 끊은 구간의 평면 길이입니다. 내민 구간은 이번 진단에서 판정하지 않습니다.`
                : '파일캡·오픈컷은 가장 가까운 기존 기초까지, 유수지 보는 기둥 단면에서 보까지의 최소 거리(m)입니다. 블록 회전을 포함한 실제 발자국으로 재며, 겹치면 깊이로 보입니다. 행을 누르면 3D에서 찾아갑니다.'}
          </small>
        </section>
      ) : null}
    </div>
  );
}
