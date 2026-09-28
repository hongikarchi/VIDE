import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { api } from './gateway.ts';

// The JIG tab: a gallery of jigs (working tools for one kind of task) and the Sync jig — the
// relation between a Rhino model and a CAD drawing, their differences, an AI review of what the
// differences mean, and edits that make one side follow the other.
const jigSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  summary: z.string(),
  inputs: z.array(z.string()),
  status: z.enum(['available', 'planned']),
  basis: z.string().optional(),
});
type Jig = z.infer<typeof jigSchema>;
const point = z.tuple([z.number(), z.number(), z.number()]);
const syncSchema = z.object({
  alignment: z.object({
    rotation: z.number(),
    translation: z.tuple([z.number(), z.number()]),
    dz: z.number(),
    pairs: z.number(),
    residual: z.object({ max: z.number(), rms: z.number() }),
    ambiguous: z.boolean(),
    source: z.string(),
    candidates: z.array(
      z.object({
        rotation: z.number(),
        translation: z.tuple([z.number(), z.number()]),
        dz: z.number(),
        votes: z.number(),
      }),
    ),
  }),
  rows: z.array(
    z.object({
      id: z.string(),
      state: z.enum(['match', 'offset', 'rhino-only', 'cad-only']),
      rhino: z
        .object({
          id: z.string(),
          nativeId: z.string(),
          layer: z.string(),
          name: z.string().optional(),
          type: z.string(),
        })
        .optional(),
      cad: z
        .object({ id: z.string(), nativeId: z.string(), layer: z.string(), type: z.string() })
        .optional(),
      deviation: z.number().optional(),
      length: z.number().optional(),
      ends: z.object({ rhino: z.tuple([point, point]), cad: z.tuple([point, point]) }).optional(),
      inRhino: z.tuple([point, point]).optional(),
    }),
  ),
  totalRows: z.number(),
  layers: z.array(z.object({ rhino: z.string(), cad: z.string(), pairs: z.number() })),
  summary: z.object({
    match: z.number(),
    offset: z.number(),
    rhinoOnly: z.number(),
    cadOnly: z.number(),
  }),
  rhinoLayers: z.array(z.object({ name: z.string(), count: z.number() })),
  cadLayers: z.array(z.object({ name: z.string(), count: z.number() })),
  counts: z.object({ rhino: z.number(), cad: z.number() }),
  cadUnits: z.string(),
});
type Sync = z.infer<typeof syncSchema>;
type Row = Sync['rows'][number];

export interface SyncSource {
  id: string;
  host: 'rhino' | 'zwcad';
  label: string;
}
export interface JigContext {
  projectId: string;
  sources: SyncSource[];
  /** Show one object of a Sync in the viewport (selected and framed). */
  show: (requestId: string, objectId: string) => void;
  /** Send a request made by a jig (AI review or edits) into the conversation. */
  send: (input: {
    body: string;
    files: { name: string; text: string }[];
    permission: 'review' | 'candidate';
    host?: 'rhino' | 'zwcad';
    baseRequestId?: string;
    applyToSource?: boolean;
    jig: Record<string, unknown>;
  }) => Promise<void>;
  /** The development extensions dialog (the previous "확장" tab). */
  extensions: () => void;
}

const dialog = document.createElement('dialog');
dialog.className = 'quantity-dialog jig-dialog';
dialog.setAttribute('aria-label', 'JIG');
document.body.append(dialog);
const root = createRoot(dialog);
const close = () => {
  dialog.close();
};
const mm = (metres: number) => `${Math.round(metres * 10000) / 10} mm`;
const stateText: Record<Row['state'], string> = {
  match: '일치',
  offset: '오차',
  'rhino-only': 'Rhino에만',
  'cad-only': 'CAD에만',
};
const unitScale: Record<string, number> = {
  Millimeters: 1000,
  Centimeters: 100,
  Meters: 1,
  Inches: 39.37007874,
  Feet: 3.280839895,
};

const round = (values: number[], k = 1e4) => values.map((v) => Math.round(v * k) / k);

function Gallery({ context, open }: { context: JigContext; open: (id: string) => void }) {
  const [jigs, setJigs] = useState<Jig[]>();
  useEffect(() => {
    void api('/jigs').then((value) => setJigs(z.array(jigSchema).parse(value)));
  }, []);
  return (
    <>
      <p className="jig-intro">
        jig는 한 가지 작업을 위한 도구입니다. 계산 단계는 매번 같은 결과를 내고, AI 단계는 계산
        결과만 근거로 판정합니다. 준비 중인 jig는 과거 작업을 옮겨 오는 중입니다.
      </p>
      <div className="jig-grid">
        {(jigs ?? []).map((jig) => (
          <article key={jig.id} className="jig-card" data-status={jig.status}>
            <div className="jig-card-head">
              <strong>{jig.name}</strong>
              <span className="pill" data-ok={String(jig.status === 'available')}>
                {jig.status === 'available' ? '사용 가능' : '준비 중'}
              </span>
            </div>
            <p>{jig.summary}</p>
            <small>
              {jig.code} · 입력: {jig.inputs.join(', ')}
              {jig.basis ? ` · 근거 ${jig.basis}` : ''}
            </small>
            {jig.status === 'available' ? (
              <button type="button" onClick={() => open(jig.id)}>
                열기
              </button>
            ) : null}
          </article>
        ))}
      </div>
      <button type="button" className="link-button" onClick={context.extensions}>
        개발용 확장 (이전 "확장" 탭)
      </button>
    </>
  );
}

function SyncJig({ context }: { context: JigContext }) {
  const rhinoSources = context.sources.filter((s) => s.host === 'rhino');
  const cadSources = context.sources.filter((s) => s.host === 'zwcad');
  const [rhino, setRhino] = useState(rhinoSources.at(-1)?.id ?? '');
  const [cad, setCad] = useState(cadSources.at(-1)?.id ?? '');
  const [tolerance, setTolerance] = useState(1);
  const [search, setSearch] = useState(100);
  const [rhinoLayers, setRhinoLayers] = useState<string[]>([]);
  const [cadLayers, setCadLayers] = useState<string[]>([]);
  const [result, setResult] = useState<Sync>();
  const [filter, setFilter] = useState<'problems' | Row['state'] | 'all'>('problems');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const run = async (extra: Record<string, unknown> = {}) => {
    if (!rhino || !cad) return;
    setBusy(true);
    setNotice('');
    try {
      const value = syncSchema.parse(
        await api(`/projects/${context.projectId}/jigs/sync`, 'POST', {
          rhino,
          cad,
          tolerance: tolerance / 1000,
          search: search / 1000,
          ...(rhinoLayers.length ? { rhinoLayers } : {}),
          ...(cadLayers.length ? { cadLayers } : {}),
          ...extra,
        }),
      );
      setResult(value);
      setPicked(new Set());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '실행하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };
  const rows = useMemo(
    () =>
      (result?.rows ?? []).filter((row) =>
        filter === 'all'
          ? true
          : filter === 'problems'
            ? row.state !== 'match'
            : row.state === filter,
      ),
    [result, filter],
  );
  const a = result?.alignment;
  const cadUnits = result?.cadUnits ?? 'Millimeters';
  const scale = unitScale[cadUnits] ?? 1000;
  const chosen = (result?.rows ?? []).filter((row) => picked.has(row.id));
  // Edits that make the drawing follow the model (coordinates in drawing units).
  const cadEdits = () => {
    const bestLayer = (layer: string) => result?.layers.find((l) => l.rhino === layer)?.cad;
    return chosen.flatMap((row): Record<string, unknown>[] => {
      const at = (p: number[]) =>
        round(
          p.map((v) => v * scale),
          1e3,
        );
      if (row.state === 'offset' && row.cad && row.ends)
        return [
          {
            row: row.id,
            action: 'move-ends',
            handle: row.cad.nativeId,
            from: row.ends.cad.map(at),
            to: row.ends.rhino.map((p) => at([p[0], p[1], row.ends!.cad[0][2]])),
          },
        ];
      if (row.state === 'rhino-only' && row.rhino && row.ends)
        return [
          {
            row: row.id,
            action: 'add-line',
            layer: bestLayer(row.rhino.layer) ?? row.rhino.layer,
            points: row.ends.rhino.map((p) => at([p[0], p[1], 0])),
          },
        ];
      if (row.state === 'cad-only' && row.cad)
        return [{ row: row.id, action: 'erase', handle: row.cad.nativeId }];
      return [];
    });
  };
  // Edits that make the model follow the drawing (metres, the AI's working units in Rhino).
  const rhinoEdits = () => {
    const bestLayer = (layer: string) => result?.layers.find((l) => l.cad === layer)?.rhino;
    return chosen.flatMap((row): Record<string, unknown>[] => {
      if (row.state === 'offset' && row.rhino && row.inRhino)
        return [
          {
            row: row.id,
            action: 'move-ends',
            id: row.rhino.nativeId,
            to: row.inRhino.map((p) => round(p)),
          },
        ];
      if (row.state === 'cad-only' && row.cad && row.inRhino)
        return [
          {
            row: row.id,
            action: 'add-line',
            layer: bestLayer(row.cad.layer) ?? row.cad.layer,
            points: row.inRhino.map((p) => round(p)),
          },
        ];
      if (row.state === 'rhino-only' && row.rhino)
        return [{ row: row.id, action: 'delete', id: row.rhino.nativeId }];
      return [];
    });
  };
  const table = () =>
    JSON.stringify({
      relation: a && {
        rotationDegrees: Math.round(((a.rotation * 180) / Math.PI) * 1e4) / 1e4,
        translationMm: round(
          a.translation.map((v) => v * 1000),
          10,
        ),
        heightDifferenceMm: Math.round(a.dz * 1e4) / 10,
        pairs: a.pairs,
        residualMm: {
          max: Math.round(a.residual.max * 1e4) / 10,
          rms: Math.round(a.residual.rms * 1e4) / 10,
        },
        ambiguous: a.ambiguous,
      },
      summary: result?.summary,
      layers: result?.layers.slice(0, 40),
      rows: (result?.rows ?? [])
        .filter((row) => row.state !== 'match')
        .slice(0, 250)
        .map((row) => ({
          row: row.id,
          state: row.state,
          rhino:
            row.rhino && `${row.rhino.name ?? ''} ${row.rhino.layer} ${row.rhino.nativeId}`.trim(),
          cad: row.cad && `${row.cad.layer} ${row.cad.nativeId} ${row.cad.type}`,
          deviationMm:
            row.deviation === undefined ? undefined : Math.round(row.deviation * 1e4) / 10,
          lengthM: row.length === undefined ? undefined : Math.round(row.length * 1000) / 1000,
        })),
    });
  const send = async (kind: 'review' | 'cad' | 'rhino') => {
    if (!result) return;
    setBusy(true);
    try {
      if (kind === 'review')
        await context.send({
          body: 'Sync jig 결과(첨부 sync-jig.json)를 검토해 줘. 위치 관계가 믿을 만한지, 레이어 대응이 맞는지, 오차·한쪽에만 있는 행이 실제 불일치인지 의도된 표현(중심선/외곽선, 층 높이, 도면 표기 관례 등)인지 판정하고, 어느 쪽을 고쳐야 할지 행 번호(R숫자)와 표의 수치만 인용해서 정리해 줘. 표에 없는 수치나 행은 만들지 마.',
          files: [{ name: 'sync-jig.json', text: table() }],
          permission: 'review',
          jig: { kind: 'sync-review', rows: result.rows.map((row) => row.id) },
        });
      else if (kind === 'cad')
        await context.send({
          body: `첨부 sync-edits.json의 편집을 열린 도면에 그대로 적용해 줘 (좌표 단위: ${cadUnits}). move-ends는 해당 핸들 선의 두 끝점을 from→to로 옮기고, add-line은 지정 레이어(없으면 만들기)에 선을 추가하고, erase는 해당 핸들을 지워. 목록에 없는 객체는 건드리지 마. 끝나면 조회해서 결과를 행 번호별로 알려 줘.`,
          files: [{ name: 'sync-edits.json', text: JSON.stringify(cadEdits()) }],
          permission: 'candidate',
          host: 'zwcad',
          baseRequestId: cad,
          jig: { kind: 'sync-apply', side: 'cad' },
        });
      else
        await context.send({
          body: '첨부 sync-edits.json의 편집을 Rhino 문서에 그대로 적용해 줘 (좌표 단위: m, 작업 사본 기준). move-ends는 해당 ID 곡선의 두 끝점을 to로 옮기고(직선 유지, ID·이름·레이어·속성 유지), add-line은 지정 레이어(없으면 만들기)에 선을 추가하고, delete는 해당 ID를 지워. 목록에 없는 객체는 건드리지 마. 끝나면 조회해서 결과를 행 번호별로 알려 줘.',
          files: [{ name: 'sync-edits.json', text: JSON.stringify(rhinoEdits()) }],
          permission: 'candidate',
          host: 'rhino',
          baseRequestId: rhino,
          applyToSource: true,
          jig: { kind: 'sync-apply', side: 'rhino' },
        });
      setNotice(
        kind === 'review'
          ? 'AI 검토를 대화에 보냈습니다.'
          : '반영 요청을 대화에 보냈습니다. 결과는 오른쪽 대화에서 확인하세요.',
      );
    } catch (error) {
      console.error(error);
      setNotice((error instanceof Error && error.message) || '보내지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };
  const layerPicker = (
    title: string,
    list: { name: string; count: number }[],
    value: string[],
    set: (v: string[]) => void,
  ) => (
    <details className="jig-layers">
      <summary>
        {title} 레이어 {value.length ? `${value.length}개 선택` : '전체'}
      </summary>
      {list.map((layer) => (
        <label key={layer.name}>
          <input
            type="checkbox"
            checked={value.includes(layer.name)}
            onChange={(event) =>
              set(
                event.target.checked
                  ? [...value, layer.name]
                  : value.filter((n) => n !== layer.name),
              )
            }
          />
          {layer.name || '(이름 없음)'} <small>{layer.count}</small>
        </label>
      ))}
    </details>
  );
  return (
    <div className="jig-sync">
      <div className="jig-inputs">
        <label>
          Rhino Sync
          <select aria-label="Rhino Sync" value={rhino} onChange={(e) => setRhino(e.target.value)}>
            {!rhinoSources.length ? <option value="">Rhino Sync가 없습니다</option> : null}
            {rhinoSources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          ZWCAD Sync
          <select aria-label="ZWCAD Sync" value={cad} onChange={(e) => setCad(e.target.value)}>
            {!cadSources.length ? <option value="">ZWCAD Sync가 없습니다</option> : null}
            {cadSources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          일치 허용 (mm)
          <input
            type="number"
            min="0.1"
            step="0.1"
            value={tolerance}
            onChange={(e) => setTolerance(Number(e.target.value) || 1)}
          />
        </label>
        <label>
          탐색 반경 (mm)
          <input
            type="number"
            min="1"
            step="10"
            value={search}
            onChange={(e) => setSearch(Number(e.target.value) || 100)}
          />
        </label>
        <button
          type="button"
          className="primary-button"
          disabled={busy || !rhino || !cad}
          onClick={() => void run()}
        >
          {busy ? '계산 중…' : '정렬·비교 실행'}
        </button>
      </div>
      {!rhinoSources.length || !cadSources.length ? (
        <small>Rhino 문서와 ZWCAD 도면을 각각 한 번 Sync하면 여기서 고를 수 있습니다.</small>
      ) : null}
      {result ? (
        <div className="jig-layer-pickers">
          {layerPicker('Rhino', result.rhinoLayers, rhinoLayers, setRhinoLayers)}
          {layerPicker('CAD', result.cadLayers, cadLayers, setCadLayers)}
        </div>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {a ? (
        <section className="jig-relation">
          <h3>위치 관계 (Rhino → CAD)</h3>
          <p>
            이동 X {mm(a.translation[0])} · Y {mm(a.translation[1])} · 높이 차 {mm(a.dz)} · 회전{' '}
            {Math.round(((a.rotation * 180) / Math.PI) * 1000) / 1000}° · 대응 {a.pairs}쌍 · 잔차
            최대 {mm(a.residual.max)} · RMS {mm(a.residual.rms)}
            {a.source === 'identity' ? ' · 대응하는 직선이 없어 원점 그대로 비교했습니다' : ''}
          </p>
          {a.ambiguous ? (
            <div className="jig-ambiguous">
              <strong>같은 간격이 반복돼 위치 관계가 하나로 정해지지 않습니다.</strong> 후보를
              고르거나, 기준 레이어(그리드 등)만 남기고 다시 실행하세요.
              {a.candidates.map((c, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() =>
                    void run({
                      candidate: { rotation: c.rotation, translation: c.translation, dz: c.dz },
                    })
                  }
                >
                  후보 {i + 1}: X {mm(c.translation[0])}, Y {mm(c.translation[1])} ({c.votes}쌍)
                </button>
              ))}
            </div>
          ) : null}
          <p className="jig-summary">
            일치 {result!.summary.match} · <b>오차 {result!.summary.offset}</b> ·{' '}
            <b>Rhino에만 {result!.summary.rhinoOnly}</b> · <b>CAD에만 {result!.summary.cadOnly}</b>{' '}
            (Rhino {result!.counts.rhino}개 · CAD {result!.counts.cad}개)
          </p>
          {result!.layers.length ? (
            <details>
              <summary>레이어 대응 {result!.layers.length}개</summary>
              <ul>
                {result!.layers.slice(0, 30).map((l) => (
                  <li key={l.rhino + '|' + l.cad}>
                    {l.rhino || '(이름 없음)'} ↔ {l.cad || '(이름 없음)'} · {l.pairs}쌍
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}
      {result ? (
        <>
          <div className="jig-filter" role="group" aria-label="차이 보기">
            {(['problems', 'offset', 'rhino-only', 'cad-only', 'match', 'all'] as const).map(
              (key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={filter === key}
                  onClick={() => setFilter(key)}
                >
                  {key === 'problems' ? '불일치 전체' : key === 'all' ? '전체' : stateText[key]}
                </button>
              ),
            )}
          </div>
          <div className="jig-table-wrap">
            <table className="jig-table">
              <thead>
                <tr>
                  <th />
                  <th>행</th>
                  <th>상태</th>
                  <th>Rhino</th>
                  <th>CAD</th>
                  <th>차이</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 500).map((row) => (
                  <tr key={row.id} data-state={row.state}>
                    <td>
                      {row.state !== 'match' ? (
                        <input
                          type="checkbox"
                          aria-label={`${row.id} 선택`}
                          checked={picked.has(row.id)}
                          onChange={(event) => {
                            const next = new Set(picked);
                            if (event.target.checked) next.add(row.id);
                            else next.delete(row.id);
                            setPicked(next);
                          }}
                        />
                      ) : null}
                    </td>
                    <td>{row.id}</td>
                    <td>{stateText[row.state]}</td>
                    <td>
                      {row.rhino ? (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => context.show(rhino, row.rhino!.id)}
                        >
                          {row.rhino.name && row.rhino.name !== 'Object'
                            ? row.rhino.name + ' · '
                            : ''}
                          {row.rhino.layer || row.rhino.type}
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {row.cad ? (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => context.show(cad, row.cad!.id)}
                        >
                          {row.cad.layer} · {row.cad.nativeId}
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{row.deviation === undefined ? '' : mm(row.deviation)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 500 ? (
              <small>처음 500행만 표시합니다 (전체 {rows.length}).</small>
            ) : null}
          </div>
          <div className="jig-actions">
            <button type="button" disabled={busy} onClick={() => void send('review')}>
              AI 검토 (차이의 의미 판정)
            </button>
            <button
              type="button"
              disabled={busy || !chosen.length}
              onClick={() => void send('cad')}
            >
              선택 {chosen.length}개 · CAD를 Rhino에 맞춤
            </button>
            <button
              type="button"
              disabled={busy || !chosen.length}
              onClick={() => void send('rhino')}
            >
              선택 {chosen.length}개 · Rhino를 CAD에 맞춤
            </button>
          </div>
          <small>
            오차는 끝점을 옮기고, 한쪽에만 있는 것은 반대쪽에 선을 추가하거나(맞출 대상 쪽이 기준)
            지웁니다. 반영은 대화에 요청으로 보내며 CAD는 열린 도면에 바로(UNDO 가능), Rhino는
            사본에서 수정 후 문서에 적용합니다.
          </small>
        </>
      ) : null}
    </div>
  );
}

function Jigs({ context }: { context: JigContext }) {
  const [open, setOpen] = useState<string>();
  return (
    <>
      <div className="quantity-head">
        <h2>{open === 'sync' ? 'Sync · 도면↔모델' : 'JIG'}</h2>
        <div>
          {open ? (
            <button type="button" onClick={() => setOpen(undefined)}>
              목록
            </button>
          ) : null}{' '}
          <button type="button" onClick={close}>
            닫기
          </button>
        </div>
      </div>
      {open === 'sync' ? (
        <SyncJig context={context} />
      ) : (
        <Gallery context={context} open={setOpen} />
      )}
    </>
  );
}
let generation = 0;
export function showJigs(context: JigContext) {
  root.render(<Jigs key={++generation} context={context} />);
  if (!dialog.open) dialog.showModal();
}
export function hideJigs() {
  if (dialog.open) dialog.close();
}
