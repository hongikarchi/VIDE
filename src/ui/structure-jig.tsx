import { useEffect, useMemo, useState } from 'react';
import { api } from './gateway.ts';
import type { JigContext } from './jigs.tsx';
import { S06Diagnose } from './s06-diagnose.tsx';
import { VerdictLegend, type VerdictBand } from './kit/status.tsx';
import { tokenColor } from './tokens.ts';

// Structure analysis jig (J-09, SPEC-06): pick Syncs → draft (computed + AI help) → check and fix →
// confirm & analyse → member table and verdict colours. Results are exploratory, never sign-off.
// A second view, '배치 진단' (PLAN-23 T-044), reads the drawn layout without building a model.

type Level = 'error' | 'warning' | 'info';
interface Issue {
  level: Level;
  code: string;
  message: string;
  nodes?: string[];
  members?: string[];
}
interface Provenance {
  by: 'auto' | 'ai' | 'user';
  assumed: boolean;
  note?: string;
}
interface Member {
  id: string;
  i: string;
  j: string;
  section: string;
  role: string;
  source?: { documentId: string; objectId: string };
  provenance?: Provenance;
}
interface Model {
  nodes: { id: string; xyz_m: [number, number, number]; support?: Record<string, boolean> }[];
  members: Member[];
  sections: { id: string; name: string; provenance?: Provenance }[];
  areaLoads?: { id: string; pattern: string; value_kPa: number }[];
  combinations: { id: string }[];
}
interface Draft {
  createdAt: string;
  model: Model;
  issues: Issue[];
  checks: Issue[];
  sources: { syncId: string; mode: string }[];
}
interface Check {
  member: string;
  status: 'pass' | 'fail' | 'incomplete' | 'error';
  ratio: number | null;
  governing: { combo: string; clause: string } | null;
  parts: { clause: string; ratio: number; combo: string; values: Record<string, number> }[];
  cause?: 'member' | 'input-suspect';
  notes: string[];
}
interface Confirmed {
  confirmedAt: string;
  modelHash: string;
  model: Model;
  ledger: {
    area: string;
    pattern: string;
    input_kN: number;
    delivered_kN: number;
    undelivered_kN: number;
  }[];
  result: {
    status: 'ok' | 'error';
    error?: string;
    diagnostics: { mechanisms: { node: string; dof: string }[]; warnings: string[] };
    checks: Check[];
    summary: {
      steel_kN: number;
      maxRatio: number | null;
      failCount: number;
      incompleteCount: number;
    };
    notChecked: string[];
  };
  /** Summary of the same analysis: '확정 결과' or '미확정 미리보기' and the verdict band edges. */
  summary?: { mode: 'confirmed' | 'preview'; label: string; colorBands: [number, number] };
  colorBands?: [number, number];
}
interface State {
  draft: Draft | null;
  confirmed: Confirmed | null;
  stale: boolean;
  draftStale: boolean;
}

const ROLE: Record<string, string> = {
  column: '기둥',
  girder: '거더',
  beam: '보',
  brace: '가새',
  other: '기타',
};
const STATUS: Record<Check['status'], string> = {
  pass: '통과',
  fail: '초과',
  incomplete: '미완',
  error: '오류',
};
// Verdict bands (SPEC-06.7): 미판정 / 통과 / 주의 / 초과, edges from the analysis' colorBands.
const DEFAULT_BANDS: [number, number] = [0.7, 1.0];
export const verdictBand = (
  check: Pick<Check, 'status' | 'ratio'>,
  bands: [number, number] = DEFAULT_BANDS,
): VerdictBand =>
  check.status === 'incomplete' || check.status === 'error' || check.ratio === null
    ? 'na'
    : check.ratio >= bands[1]
      ? 'ng'
      : check.ratio >= bands[0]
        ? 'warn'
        : 'ok';
// Verdict colours are the judgement tokens of tokens.css (--ok / --warn / --ng / --na), the same
// ones the legend and verdict chips use.
export const verdictColor = (
  check: Pick<Check, 'status' | 'ratio'>,
  bands: [number, number] = DEFAULT_BANDS,
) => tokenColor(verdictBand(check, bands));
/** Worse verdicts win when one object holds several members. */
const BAND_RANK: VerdictBand[] = ['ok', 'na', 'warn', 'ng'];
/** The check table as CSV (SPEC-06.7), with the result label so a preview never reads as final. */
export function checksCsv(
  rows: readonly Check[],
  label: string,
  member: (id: string) => { role: string; section: string } | undefined,
) {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = [
    '결과',
    '부재',
    '역할',
    '단면',
    '검정비',
    '지배 조합',
    '조항',
    '판정',
    '원인',
    '메모',
  ];
  const body = rows.map((c) => {
    const m = member(c.member);
    return [
      label,
      c.member,
      ROLE[m?.role ?? 'other'] ?? m?.role,
      m?.section ?? '',
      c.ratio === null ? '' : c.ratio.toFixed(3),
      c.governing?.combo ?? '',
      c.governing?.clause ?? '',
      STATUS[c.status],
      c.cause === 'input-suspect' ? '입력·모델 의심' : c.cause === 'member' ? '부재 부족' : '',
      c.notes.join(' · '),
    ];
  });
  return '\uFEFF' + [head, ...body].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
const fmt = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined ? '—' : v.toFixed(digits);
/** Roles a Rhino layer can be given in the draft (layer hints); a role may take several layers. */
const PICK_ROLES = ['column', 'girder', 'beam', 'brace'] as const;
type PickRole = (typeof PICK_ROLES)[number];
const noRoleLayers = () =>
  Object.fromEntries(PICK_ROLES.map((role) => [role, []])) as unknown as Record<PickRole, string[]>;

export function StructureJig({ context }: { context: JigContext }) {
  const rhino = context.sources.filter((s) => s.host === 'rhino');
  const cad = context.sources.filter((s) => s.host === 'zwcad');
  const [state, setState] = useState<State>();
  const [syncId, setSyncId] = useState(context.sources.at(-1)?.id ?? '');
  const [mode, setMode] = useState<'curves' | 'breps' | 'cad'>('curves');
  const [levels, setLevels] = useState('4');
  const [beamLayers, setBeamLayers] = useState('');
  const [columnLayers, setColumnLayers] = useState('');
  const [baseFixity, setBaseFixity] = useState<'pin' | 'fixed'>('pin');
  const [load, setLoad] = useState({ dead: 1, live: 1 });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState<'problems' | 'all'>('problems');
  const [only, setOnly] = useState<VerdictBand>();
  const [colored, setColored] = useState(false);
  const [view, setView] = useState<'analysis' | 'diagnose'>('analysis');
  const [diagnoseOpened, setDiagnoseOpened] = useState(false);
  // Role layers of a Rhino Sync (several per role): sent as layer hints, and optionally as the only
  // layers read. The key of the inputs a draft was made from tells when the draft no longer fits.
  const [roleLayers, setRoleLayers] = useState<Record<PickRole, string[]>>(noRoleLayers);
  const [onlyPicked, setOnlyPicked] = useState(false);
  const [syncLayers, setSyncLayers] = useState<{ name: string; count: number }[]>();
  const [draftedKey, setDraftedKey] = useState<string>();
  const base = `/projects/${context.projectId}/jigs/structure`;

  const call = async (path: string, method: 'GET' | 'POST', body?: unknown) => {
    setBusy(true);
    setNotice('');
    try {
      return await api(base + path, method, body);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '요청하지 못했습니다.');
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    const next = (await call('', 'GET')) as State | undefined;
    setState(next);
    return next;
  };
  useEffect(() => {
    // An existing draft brings back the Sync and input form it was made from.
    void refresh().then((first) => {
      const made = first?.draft?.sources[0];
      if (made && context.sources.some((s) => s.id === made.syncId)) {
        setSyncId(made.syncId);
        if (made.mode === 'curves' || made.mode === 'breps' || made.mode === 'cad')
          setMode(made.mode);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hostOf = (id: string) => context.sources.find((s) => s.id === id)?.host;
  useEffect(() => {
    if (hostOf(syncId) === 'zwcad') setMode('cad');
    else if (mode === 'cad') setMode('curves');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncId]);
  // Layers of the chosen Rhino Sync for the role pickers; picks keep the layers still offered.
  useEffect(() => {
    setSyncLayers(undefined);
    if (!syncId || hostOf(syncId) !== 'rhino') return;
    let live = true;
    api(`${base}/layers?syncIds=${encodeURIComponent(syncId)}`)
      .then((value) => {
        if (!live) return;
        const list = (value as { sources: { layers: { name: string; count: number }[] }[] })
          .sources[0]?.layers;
        setSyncLayers(list ?? []);
        const names = new Set((list ?? []).map((l) => l.name));
        setRoleLayers(
          (previous) =>
            Object.fromEntries(
              PICK_ROLES.map((role) => [role, previous[role].filter((n) => names.has(n))]),
            ) as unknown as Record<PickRole, string[]>,
        );
      })
      .catch(() => live && setSyncLayers([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncId]);

  const list = (text: string) =>
    text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const picked = PICK_ROLES.flatMap((role) => roleLayers[role]);
  // What a draft is made from: a draft (and its result) made from other inputs is marked.
  const inputKey = JSON.stringify(
    mode === 'cad'
      ? [syncId, mode, levels, list(beamLayers), list(columnLayers), baseFixity]
      : [syncId, mode, PICK_ROLES.map((r) => [...roleLayers[r]].sort()), onlyPicked, baseFixity],
  );
  const made = state?.draft?.sources[0];
  const inputsChanged =
    !!state?.draft &&
    (draftedKey !== undefined
      ? draftedKey !== inputKey
      : made?.syncId !== syncId || made?.mode !== mode);

  const makeDraft = async () => {
    const key = inputKey;
    const layerHints = Object.fromEntries(
      PICK_ROLES.flatMap((role) => roleLayers[role].map((layer) => [layer, { role }])),
    );
    const source =
      mode === 'cad'
        ? {
            syncId,
            mode,
            cad: {
              levels_m: list(levels).map(Number).filter(Number.isFinite),
              base_m: 0,
              beamLayers: list(beamLayers),
              columnLayers: list(columnLayers),
            },
          }
        : { syncId, mode, ...(onlyPicked && picked.length ? { layers: picked } : {}) };
    const options = mode !== 'cad' && picked.length ? { baseFixity, layerHints } : { baseFixity };
    const draft = await call('/draft', 'POST', { sources: [source], options });
    if (draft) {
      setDraftedKey(key);
      // A new draft makes the confirmed result old: its verdict colours leave the model.
      if (colored) {
        context.clearTint();
        setColored(false);
      }
      setOnly(undefined);
      await refresh();
    }
  };
  const edit = async (edits: Record<string, unknown>) => {
    if (await call('/edit', 'POST', edits)) await refresh();
  };
  const analyse = async () => {
    const out = await call('/analyze', 'POST', { confirm: true });
    if (out) {
      // Colours of the previous result would read as this one's: switch them off.
      if (colored) {
        context.clearTint();
        setColored(false);
      }
      setOnly(undefined);
      await refresh();
    }
  };

  const draft = state?.draft;
  const groups = useMemo(() => {
    if (!draft) return [];
    const sections = new Map(draft.model.sections.map((s) => [s.id, s]));
    const map = new Map<
      string,
      { role: string; section: string; members: string[]; assumed: boolean }
    >();
    for (const m of draft.model.members) {
      const key = `${m.role}|${m.section}`;
      const entry = map.get(key) ?? {
        role: m.role,
        section: m.section,
        members: [],
        assumed: false,
      };
      entry.members.push(m.id);
      entry.assumed ||=
        !!sections.get(m.section)?.provenance?.assumed || m.section === 'UNASSIGNED';
      map.set(key, entry);
    }
    return [...map.values()].sort((a, b) => a.role.localeCompare(b.role));
  }, [draft]);

  // A rectangular roof area over the highest beam level, from the draft's own nodes.
  const roofArea = () => {
    if (!draft) return [];
    const nodes = new Map(draft.model.nodes.map((n) => [n.id, n.xyz_m]));
    const beams = draft.model.members.filter((m) => m.role === 'beam' || m.role === 'girder');
    const z = Math.max(...beams.flatMap((m) => [nodes.get(m.i)![2], nodes.get(m.j)![2]]));
    const pts = beams
      .flatMap((m) => [nodes.get(m.i)!, nodes.get(m.j)!])
      .filter((p) => Math.abs(p[2] - z) < 0.05);
    if (!pts.length) return [];
    const [x0, x1] = [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))];
    const [y0, y1] = [Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))];
    const polygon_m = [
      [x0, y0, z],
      [x1, y0, z],
      [x1, y1, z],
      [x0, y1, z],
    ];
    return [
      { id: 'roof-D', pattern: 'D', polygon_m, value_kPa: load.dead },
      { id: 'roof-L', pattern: 'L', polygon_m, value_kPa: load.live },
    ];
  };

  const askAi = async () => {
    if (!draft) return;
    const summary = {
      counts: Object.fromEntries(
        Object.keys(ROLE).map((r) => [r, draft.model.members.filter((m) => m.role === r).length]),
      ),
      groups: groups.map((g) => ({
        role: g.role,
        section: g.section,
        count: g.members.length,
        assumed: g.assumed,
      })),
      issues: [...draft.issues, ...draft.checks].map(({ level, code, message }) => ({
        level,
        code,
        message,
      })),
      assumedMembers: draft.model.members
        .filter((m) => m.provenance?.assumed)
        .slice(0, 200)
        .map((m) => ({ id: m.id, role: m.role, note: m.provenance?.note })),
    };
    await context.send({
      body: '구조 분석 jig 초안(첨부 structure-draft.json)을 검토해 줘. 입력은 Sync한 도면·모델에서 코드로 만든 해석 모델 초안이야. 역할(기둥·거더·보·가새) 판정, 단면 추정, 가정 표시 항목, 점검 문제를 보고, 레이어·그룹별로 무엇을 어떻게 고치면 되는지(역할, KS H형강 단면 이름 H-높이x폭x웨브x플랜지, 지점 조건) 표로 제안해 줘. 첨부에 없는 부재 ID나 수치는 만들지 말고, 확실하지 않은 것은 확인 질문으로 남겨 줘.',
      files: [{ name: 'structure-draft.json', text: JSON.stringify(summary) }],
      permission: 'review',
      jig: { kind: 'structure-draft-review' },
    });
    setNotice('AI 검토를 대화에 보냈습니다. 제안은 여기서 단면·역할로 반영하세요.');
  };

  const confirmed = state?.confirmed;
  const bands = confirmed?.colorBands ?? confirmed?.summary?.colorBands ?? DEFAULT_BANDS;
  // '미확정 미리보기' results are marked as such everywhere they show (SPEC-06.3·.7).
  const preview = confirmed?.summary?.mode === 'preview';
  const resultLabel = confirmed?.summary?.label ?? (preview ? '미확정 미리보기' : '확정 결과');
  // An out-of-date result keeps no colours on the model; the notice says why they went.
  const stale = !!state?.stale;
  useEffect(() => {
    if (!stale || !colored) return;
    context.clearTint();
    setColored(false);
    setNotice('입력이 바뀌어 이전 결과의 판정색을 지웠습니다. 초안을 다시 만들고 해석하세요.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stale, colored]);
  const checks = useMemo(() => {
    const all = [...(confirmed?.result.checks ?? [])].sort(
      (a, b) => (b.ratio ?? Infinity) - (a.ratio ?? Infinity),
    );
    if (only) return all.filter((c) => verdictBand(c, bands) === only);
    return filter === 'all'
      ? all
      : all.filter((c) => c.status !== 'pass' || verdictBand(c, bands) !== 'ok');
  }, [confirmed, filter, only, bands]);
  const legend = useMemo(() => {
    const count = { ok: 0, warn: 0, ng: 0, na: 0 };
    for (const c of confirmed?.result.checks ?? []) count[verdictBand(c, bands)]++;
    const [a, b] = bands.map((v) => v.toFixed(2));
    return [
      { band: 'ok' as const, symbol: '○', text: '통과', range: `< ${a}`, count: count.ok },
      { band: 'warn' as const, symbol: '△', text: '주의', range: `${a}~${b}`, count: count.warn },
      { band: 'ng' as const, symbol: '✕', text: '초과', range: `≥ ${b}`, count: count.ng },
      { band: 'na' as const, symbol: '—', text: '미판정', range: '미완·오류', count: count.na },
    ];
  }, [confirmed, bands]);
  const exportCsv = () => {
    if (!confirmed) return;
    const text = checksCsv(confirmed.result.checks, resultLabel, (id) => {
      const m = memberOf(id);
      return m && { role: m.role, section: sectionName(m.section) };
    });
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `부재검정-${preview ? '미리보기' : '확정'}-${confirmed.confirmedAt.slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const memberOf = (id: string) => confirmed?.model.members.find((m) => m.id === id);
  const sectionName = (id: string) =>
    confirmed?.model.sections.find((s) => s.id === id)?.name ?? id;
  const show = (id: string) => {
    const source = memberOf(id)?.source;
    if (source) context.show(source.documentId, source.objectId);
  };
  const tint = () => {
    if (!confirmed || !context.tint) return;
    const bySync = new Map<string, Record<string, VerdictBand>>();
    for (const check of confirmed.result.checks) {
      const source = memberOf(check.member)?.source;
      if (!source) continue;
      const worst = bySync.get(source.documentId) ?? {};
      // One Rhino object can hold several analysis members; keep the worst verdict.
      const next = verdictBand(check, bands);
      const held = worst[source.objectId];
      if (!held || BAND_RANK.indexOf(next) > BAND_RANK.indexOf(held)) worst[source.objectId] = next;
      bySync.set(source.documentId, worst);
    }
    for (const [sync, worst] of bySync) {
      const colors: Record<string, string> = {};
      for (const [id, band] of Object.entries(worst)) colors[id] = tokenColor(band);
      context.tint(sync, colors);
    }
  };

  const issues = draft ? [...draft.issues, ...draft.checks] : [];
  const blocking = issues.some((i) => i.level === 'error');
  return (
    <div className="jig-sync jig-structure">
      <p className="jig-structure-warning">
        탐색용 예비값입니다. 구조계산서와 구조기술사의 최종 검토를 대체하지 않습니다.
      </p>
      <div className="jig-filter jig-mode" role="group" aria-label="구조 jig 보기">
        <button
          type="button"
          aria-pressed={view === 'analysis'}
          onClick={() => setView('analysis')}
        >
          해석 모델
        </button>
        <button
          type="button"
          aria-pressed={view === 'diagnose'}
          onClick={() => {
            setView('diagnose');
            setDiagnoseOpened(true);
          }}
        >
          배치 진단
        </button>
      </div>
      {/* Both views stay mounted once opened, so switching keeps their inputs and results. */}
      {diagnoseOpened ? (
        <div hidden={view !== 'diagnose'}>
          <S06Diagnose context={context} />
        </div>
      ) : null}
      <div hidden={view !== 'analysis'}>
        <div className="jig-inputs">
          <label>
            입력 Sync
            <select
              aria-label="입력 Sync"
              value={syncId}
              onChange={(e) => setSyncId(e.target.value)}
            >
              {!context.sources.length ? <option value="">Sync가 없습니다</option> : null}
              {[...rhino, ...cad].map((s) => (
                <option key={s.id} value={s.id}>
                  {s.host === 'zwcad' ? 'CAD · ' : 'Rhino · '}
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            입력 형태
            <select
              aria-label="입력 형태"
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
            >
              {hostOf(syncId) === 'zwcad' ? (
                <option value="cad">CAD 평면(보·기둥 레이어)</option>
              ) : (
                <>
                  <option value="curves">중심선 곡선</option>
                  <option value="breps">부재 솔리드</option>
                </>
              )}
            </select>
          </label>
          {mode === 'cad' ? (
            <>
              <label>
                보 레벨 m (쉼표)
                <input
                  aria-label="보 레벨"
                  value={levels}
                  onChange={(e) => setLevels(e.target.value)}
                />
              </label>
              <label>
                보 레이어
                <input
                  aria-label="보 레이어"
                  placeholder="쉼표로 여러 레이어"
                  value={beamLayers}
                  onChange={(e) => setBeamLayers(e.target.value)}
                />
              </label>
              <label>
                기둥 레이어
                <input
                  aria-label="기둥 레이어"
                  placeholder="쉼표로 여러 레이어"
                  value={columnLayers}
                  onChange={(e) => setColumnLayers(e.target.value)}
                />
              </label>
            </>
          ) : null}
          <label>
            기둥 하단
            <select
              aria-label="기둥 하단"
              value={baseFixity}
              onChange={(e) => setBaseFixity(e.target.value as 'pin' | 'fixed')}
            >
              <option value="pin">핀</option>
              <option value="fixed">고정</option>
            </select>
          </label>
          <button
            type="button"
            className="primary-button"
            disabled={busy || !syncId}
            onClick={() => void makeDraft()}
          >
            {busy ? '처리 중…' : '초안 만들기'}
          </button>
        </div>
        {mode !== 'cad' && syncLayers?.length ? (
          <details className="jig-s06-params">
            <summary>
              역할 레이어 지정 (선택){picked.length ? ` · ${picked.length}개 레이어` : ''} — 비워
              두면 레이어·이름으로 역할을 추정합니다
            </summary>
            <div className="jig-s06-roles">
              {PICK_ROLES.map((role) => (
                <div
                  key={role}
                  role="group"
                  aria-label={`${ROLE[role]} 레이어`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '6em minmax(0, 1fr)',
                    alignItems: 'start',
                    gap: 8,
                  }}
                >
                  <span>{ROLE[role]}</span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, minWidth: 0 }}>
                    {roleLayers[role].map((layer) => (
                      <span key={layer} className="chip">
                        {layer || '(이름 없음)'}
                        <button
                          type="button"
                          aria-label={`${ROLE[role]}에서 ${layer || '(이름 없음)'} 빼기`}
                          onClick={() =>
                            setRoleLayers({
                              ...roleLayers,
                              [role]: roleLayers[role].filter((n) => n !== layer),
                            })
                          }
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <select
                      aria-label={`${ROLE[role]} 레이어 추가`}
                      value=""
                      onChange={(e) =>
                        e.target.value &&
                        setRoleLayers({
                          ...roleLayers,
                          [role]: [...roleLayers[role], e.target.value],
                        })
                      }
                    >
                      <option value="">+ 레이어</option>
                      {syncLayers
                        .filter((l) => l.name && !picked.includes(l.name))
                        .map((l) => (
                          <option key={l.name} value={l.name}>
                            {l.name} — {l.count}개
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
              ))}
            </div>
            <label>
              <input
                type="checkbox"
                checked={onlyPicked}
                disabled={!picked.length}
                onChange={(e) => setOnlyPicked(e.target.checked)}
              />{' '}
              지정한 레이어만 읽기
            </label>
          </details>
        ) : null}
        {notice ? <p className="jig-structure-notice">{notice}</p> : null}

        {draft ? (
          <section className="jig-relation" aria-label="해석 모델 초안">
            <h3>
              해석 모델 초안 · 절점 {draft.model.nodes.length} · 부재 {draft.model.members.length}
              {state?.draftStale ? (
                <span className="pill"> 입력 Sync가 더 새것으로 바뀜</span>
              ) : null}
              {inputsChanged ? (
                <span className="pill" data-state="changed">
                  {' '}
                  입력이 초안과 다름
                </span>
              ) : null}
            </h3>
            {inputsChanged ? (
              <p className="jig-structure-notice" role="status">
                Sync·입력 형태·역할 레이어가 이 초안을 만든 때와 다릅니다. [초안 만들기]를 다시 눌러
                바뀐 입력으로 초안을 만든 뒤 확정하세요.
              </p>
            ) : null}
            {issues.length ? (
              <ul className="jig-structure-issues">
                {issues.map((issue, k) => (
                  <li key={k} data-level={issue.level}>
                    <strong>
                      {issue.level === 'error'
                        ? '오류'
                        : issue.level === 'warning'
                          ? '경고'
                          : '참고'}
                    </strong>{' '}
                    {issue.message}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="jig-table-wrap">
              <table className="jig-table" aria-label="부재 그룹">
                <thead>
                  <tr>
                    <th>역할</th>
                    <th>단면</th>
                    <th>부재 수</th>
                    <th>단면 지정</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <GroupRow
                      key={`${g.role}|${g.section}`}
                      group={g}
                      name={draft.model.sections.find((s) => s.id === g.section)?.name ?? g.section}
                      apply={(name) => void edit({ sections: [{ members: g.members, name }] })}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="jig-inputs">
              <label>
                지붕 고정하중 kN/㎡
                <input
                  type="number"
                  step="0.1"
                  aria-label="지붕 고정하중"
                  value={load.dead}
                  onChange={(e) => setLoad({ ...load, dead: Number(e.target.value) })}
                />
              </label>
              <label>
                지붕 활하중 kN/㎡
                <input
                  type="number"
                  step="0.1"
                  aria-label="지붕 활하중"
                  value={load.live}
                  onChange={(e) => setLoad({ ...load, live: Number(e.target.value) })}
                />
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={() => void edit({ areaLoads: roofArea() })}
              >
                최상층 면하중 적용
              </button>
              <button type="button" disabled={busy} onClick={() => void askAi()}>
                AI에게 초안 검토 요청
              </button>
            </div>
            <small>
              면하중 {draft.model.areaLoads?.length ?? 0}개 · 하중조합{' '}
              {draft.model.combinations.map((c) => c.id).join(', ')} · 자중 포함
            </small>
            <div className="jig-actions">
              <button
                type="button"
                className="primary-button"
                disabled={busy || blocking || inputsChanged}
                onClick={() => void analyse()}
              >
                확정하고 해석
              </button>
              {blocking ? <small>오류를 고친 뒤 확정할 수 있습니다.</small> : null}
              {!blocking && inputsChanged ? (
                <small>바뀐 입력으로 초안을 다시 만든 뒤 확정할 수 있습니다.</small>
              ) : null}
            </div>
          </section>
        ) : null}

        {confirmed ? (
          <section className="jig-relation" aria-label="해석 결과">
            <h3>
              결과 · {new Date(confirmed.confirmedAt).toLocaleString('ko-KR')}{' '}
              <span className="pill" data-mode={preview ? 'preview' : 'confirmed'}>
                {resultLabel}
              </span>
              {state?.stale ? <span className="pill"> 오래된 결과 — 입력이 바뀜</span> : null}
            </h3>
            {confirmed.result.status === 'error' ? (
              <p>
                {resultLabel} · 해석 실패: {confirmed.result.error}
                {confirmed.result.diagnostics.mechanisms.length
                  ? ` · 구속되지 않은 절점 ${[...new Set(confirmed.result.diagnostics.mechanisms.map((m) => m.node))].join(', ')}`
                  : ''}
              </p>
            ) : (
              <>
                <p className="jig-structure-summary" data-mode={preview ? 'preview' : 'confirmed'}>
                  {resultLabel} · 강재 {fmt(confirmed.result.summary.steel_kN / 9.80665, 1)} t ·
                  최대 검정비 {fmt(confirmed.result.summary.maxRatio)} · 초과{' '}
                  {confirmed.result.summary.failCount} · 미완{' '}
                  {confirmed.result.summary.incompleteCount}
                </p>
                {confirmed.ledger.map((row) => (
                  <small key={row.area}>
                    면하중 {row.area}({row.pattern}) 입력 {fmt(row.input_kN, 1)} kN → 부재 전달{' '}
                    {fmt(row.delivered_kN, 1)} kN
                    {Math.abs(row.undelivered_kN) > 0.01 * Math.abs(row.input_kN)
                      ? ` · 미전달 ${fmt(row.undelivered_kN, 1)} kN`
                      : ''}
                  </small>
                ))}
                <div className="jig-filter">
                  <button
                    type="button"
                    aria-pressed={filter === 'problems'}
                    onClick={() => setFilter('problems')}
                  >
                    확인할 것
                  </button>
                  <button
                    type="button"
                    aria-pressed={filter === 'all'}
                    onClick={() => setFilter('all')}
                  >
                    전체
                  </button>{' '}
                  <button type="button" onClick={exportCsv}>
                    CSV로 내보내기
                  </button>
                </div>
                <VerdictLegend
                  title={`판정 범례 · ${resultLabel}`}
                  total={confirmed.result.checks.length}
                  bands={legend}
                  only={only}
                  colored={context.tint ? colored : true}
                  onOnly={setOnly}
                  onColored={(on) => {
                    if (!context.tint) return;
                    setColored(on);
                    if (on) tint();
                    else context.clearTint();
                  }}
                />
                <div className="jig-table-wrap">
                  <table className="jig-table" aria-label="부재 검정">
                    <caption style={{ textAlign: 'left' }}>부재 검정 · {resultLabel}</caption>
                    <thead>
                      <tr>
                        <th>부재</th>
                        <th>역할</th>
                        <th>단면</th>
                        <th>검정비</th>
                        <th>지배</th>
                        <th>판정</th>
                        <th>원인·메모</th>
                      </tr>
                    </thead>
                    <tbody>
                      {checks.slice(0, 500).map((c) => {
                        const m = memberOf(c.member);
                        return (
                          <tr key={c.member} data-status={c.status} onClick={() => show(c.member)}>
                            <td>{c.member}</td>
                            <td>{ROLE[m?.role ?? 'other']}</td>
                            <td>{m ? sectionName(m.section) : ''}</td>
                            <td>
                              <span
                                className="jig-structure-swatch"
                                style={{ background: verdictColor(c, bands) }}
                              />
                              {fmt(c.ratio)}
                            </td>
                            <td>
                              {c.governing ? `${c.governing.clause} · ${c.governing.combo}` : '—'}
                            </td>
                            <td>{STATUS[c.status]}</td>
                            <td>
                              {c.cause === 'input-suspect'
                                ? '입력·모델 의심 · '
                                : c.cause === 'member'
                                  ? '부재 부족 · '
                                  : ''}
                              {c.notes.join(' · ')}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <small>검토하지 않음: {confirmed.result.notChecked.join(' · ')}</small>
              </>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function GroupRow({
  group,
  name,
  apply,
}: {
  group: { role: string; section: string; members: string[]; assumed: boolean };
  name: string;
  apply: (name: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <tr data-state={group.assumed ? 'offset' : 'match'}>
      <td>{ROLE[group.role] ?? group.role}</td>
      <td>
        {name}
        {group.assumed ? ' (가정)' : ''}
      </td>
      <td>{group.members.length}</td>
      <td>
        <input
          aria-label={`${ROLE[group.role] ?? group.role} 단면`}
          placeholder="H-400x200x8x13"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />{' '}
        <button type="button" disabled={!value.trim()} onClick={() => apply(value.trim())}>
          적용
        </button>
      </td>
    </tr>
  );
}
