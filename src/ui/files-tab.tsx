// 파일 tab (PLAN-52 T-319, Design SCR-38): the project's files as a list or as a map of relations
// over time. [목록] · [지도] chips choose the view (목록 first). The map draws rows (역할 or 프로그램)
// × time: a glyph per file, the relations as lines (legend folded at the top right), events as small
// ticks, a time cursor with [재생]. Choosing a file keeps the files tied to it and fades the rest to
// 25%; Esc or a second press clears it. Server files with no remembered role, and rows past 60
// files, fold into '그 밖 n'. The data is the engine's map (src/ui/workspace-map-api.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ChartDefs,
  ChartLinks,
  Glyph,
  GLYPH_NAMES,
  Timeline,
  atCursor,
  connectedSet,
  layoutChart,
  shortTime,
  timeScale,
  type ChartItem,
  type ChartLink,
  type ChartModel,
  type GlyphKind,
  type LinkStyle,
} from './chart/index.ts';
import {
  EVENT_LABEL,
  HOST_LABEL,
  LINK_LABEL,
  ROLE_LABEL,
  fetchWorkspaceMap,
  type MapNode,
  type WorkspaceMap,
} from './workspace-map-api.ts';
import { MAP_LINK_KINDS, type MapLinkKind, type MapRole } from '../contracts/workspace-map.ts';
import { setWorkspace } from './workspaces.ts';
import { statusState } from './store/status.ts';
import { useStore } from './store/core.ts';
import { pairOf } from './sync-pairs-api.ts';
import { SyncPairStrip, useSyncPairs } from './sync-pair-strip.tsx';
import './files-tab.css';

type View = 'list' | 'map';
type RowBasis = 'role' | 'host';

const ROW_ORDER: (MapRole | 'other')[] = [
  'rhino',
  'cad',
  'raw',
  'review',
  'output',
  'snapshots',
  'ops',
  'references',
  'tools',
  'archive',
  'other',
];
const HOST_ORDER: MapNode['host'][] = ['rhino', 'zwcad', 'vide', 'doc'];
const FOLD_OVER = 60;
const NAME_COLUMN = 180;

const LINK_STYLES: Record<MapLinkKind, LinkStyle> = {
  xref: { width: 1, label: LINK_LABEL.xref },
  'sync-pair': { width: 2.6, label: LINK_LABEL['sync-pair'] },
  'jig-io': { width: 1.2, arrow: true, label: LINK_LABEL['jig-io'] },
  'data-report': { width: 1.2, dash: '4 3', label: LINK_LABEL['data-report'] },
  checkout: { width: 1, label: LINK_LABEL.checkout },
  reference: { width: 0.8, dash: '2 3', label: LINK_LABEL.reference },
  mention: { width: 0.8, dash: '1 4', faint: true, label: LINK_LABEL.mention },
};

const roleRow = (node: MapNode) => (node.role && !node.folded ? node.role : 'other');
const rowOf = (node: MapNode, basis: RowBasis) => (basis === 'role' ? roleRow(node) : node.host);
const rowLabel = (id: string, basis: RowBasis) =>
  basis === 'host'
    ? (HOST_LABEL[id as MapNode['host']] ?? id)
    : id === 'other'
      ? '그 밖'
      : (ROLE_LABEL[id as MapRole] ?? id);
const time = (at: string | null | undefined) => (at ? Date.parse(at) : NaN);

function readView(projectId: string): View {
  try {
    return localStorage.getItem(`vide:files-view:${projectId}`) === 'map' ? 'map' : 'list';
  } catch {
    return 'list';
  }
}
function saveView(projectId: string, view: View) {
  try {
    localStorage.setItem(`vide:files-view:${projectId}`, view);
  } catch {
    /* a viewer convenience only */
  }
}

/** The last event of each node, for the list and the tooltip. */
function lastEvents(map: WorkspaceMap) {
  const out = new Map<string, WorkspaceMap['events'][number]>();
  for (const event of map.events) for (const id of event.nodeIds) out.set(id, event);
  return out;
}

function FileList({
  map,
  focus,
  onMap,
}: {
  map: WorkspaceMap;
  focus: string | undefined;
  onMap: (id: string) => void;
}) {
  const last = useMemo(() => lastEvents(map), [map]);
  const groups = ROW_ORDER.map((row) => ({
    row,
    nodes: map.nodes
      .filter((node) => roleRow(node) === row)
      .sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((group) => group.nodes.length);
  const focused = useRef<HTMLLIElement | null>(null);
  // Braced: a scroll method that returns a value would be taken for the effect's cleanup.
  useEffect(() => {
    focused.current?.scrollIntoView({ block: 'nearest' });
  }, [focus]);
  if (!map.nodes.length)
    return (
      <p className="files-empty">
        작업 폴더나 연결 파일이 아직 없습니다. 대시보드의 프로젝트 폴더에서 폴더를 연결하면 여기에
        보입니다.
      </p>
    );
  return (
    <div className="files-list">
      {groups.map(({ row, nodes }) => {
        const body = (
          <ul>
            {nodes.map((node) => {
              const event = last.get(node.id);
              return (
                <li
                  key={node.id}
                  ref={node.id === focus ? focused : undefined}
                  className={node.id === focus ? 'files-row files-row-focus' : 'files-row'}
                  title={node.path ?? node.name}
                >
                  <span className="files-name">{node.name}</span>
                  <span className="files-meta">
                    {node.origin === 'server' ? '서버' : '로컬'}
                    {node.checkout?.state === 'out' ? ' · 작업 중' : ''}
                    {event ? ` · ${shortTime(time(event.at))} ${EVENT_LABEL[event.kind]}` : ''}
                  </span>
                  <button type="button" className="link-button" onClick={() => onMap(node.id)}>
                    지도에서 보기
                  </button>
                </li>
              );
            })}
          </ul>
        );
        return (
          <section key={row} className="files-group" aria-label={rowLabel(row, 'role')}>
            {row === 'other' ? (
              <details>
                <summary>그 밖 {nodes.length}</summary>
                {body}
              </details>
            ) : (
              <>
                <h4>
                  {rowLabel(row, 'role')} <span className="files-count">{nodes.length}</span>
                </h4>
                {body}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

function FileMap({
  projectId,
  map,
  selected,
  onSelect,
  onList,
}: {
  projectId: string;
  map: WorkspaceMap;
  selected: string[];
  onSelect: (ids: string[]) => void;
  onList: (id?: string) => void;
}) {
  const [basis, setBasis] = useState<RowBasis>('role');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [width, setWidth] = useState(720);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | undefined>();
  // 동기화 쌍 (Design SCR-47): the Rhino↔CAD Sync line pressed, and the project's designated pairs.
  const [pickedLink, setPickedLink] = useState<{ from: string; to: string } | undefined>();
  const { pairs, reload: reloadPairs } = useSyncPairs(projectId);
  const remote = useStore(statusState, (slice) => slice.remote);
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const fit = () => setWidth(Math.max(320, element.clientWidth - NAME_COLUMN - 16));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const linked = useMemo(() => {
    const ids = new Set<string>();
    for (const link of map.links) ids.add(link.from).add(link.to);
    return ids;
  }, [map]);
  const firstAt = useMemo(() => {
    const out = new Map<string, number>();
    for (const event of map.events)
      for (const id of event.nodeIds) if (!out.has(id)) out.set(id, time(event.at));
    return out;
  }, [map]);
  const last = useMemo(() => lastEvents(map), [map]);
  // Rows, items and the folded groups ('그 밖 n') of each row.
  const { model, folded } = useMemo(() => {
    const rows = (basis === 'role' ? ROW_ORDER : HOST_ORDER).map((id) => ({
      id,
      label: rowLabel(id, basis),
    }));
    const items: ChartItem[] = [];
    const folded = new Map<string, MapNode[]>();
    for (const row of rows) {
      const nodes = map.nodes.filter((node) => rowOf(node, basis) === row.id);
      const tooMany = nodes.length > FOLD_OVER;
      for (const node of nodes) {
        const fold = (node.folded || (tooMany && !linked.has(node.id))) && !open.has(row.id);
        if (fold) {
          folded.set(row.id, [...(folded.get(row.id) ?? []), node]);
          continue;
        }
        const at = firstAt.get(node.id) ?? time(node.modifiedAt);
        items.push({
          id: node.id,
          row: row.id,
          t: Number.isFinite(at) ? at : null,
          kind: node.kind,
          label: node.name,
        });
      }
    }
    const model: ChartModel = {
      rows: rows.filter((row) => items.some((item) => item.row === row.id) || folded.has(row.id)),
      items,
      links: map.links.map((link) => ({ ...link, t: link.at ? time(link.at) : null })),
      milestones: map.events.map((event) => ({
        t: time(event.at),
        kind: event.kind,
        label: EVENT_LABEL[event.kind],
        items: event.nodeIds,
      })),
    };
    return { model, folded };
  }, [map, basis, open, linked, firstAt]);
  const layout = useMemo(() => layoutChart(model, { width }), [model, width]);
  const [cursor, setCursor] = useState(() => layout.domain.end);
  const [playing, setPlaying] = useState(false);
  useEffect(() => setCursor(layout.domain.end), [layout.domain.end]);
  const chain = useMemo(
    () => (selected.length ? connectedSet(model.links, selected) : undefined),
    [model.links, selected],
  );
  const x = timeScale(layout.domain, width);
  const nodeById = useMemo(() => new Map(map.nodes.map((node) => [node.id, node])), [map]);
  const later = useMemo(
    () => new Set(atCursor(model.links, cursor).later as ChartLink[]),
    [model.links, cursor],
  );
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && selected.length) onSelect([]);
    };
    addEventListener('keydown', escape);
    return () => removeEventListener('keydown', escape);
  }, [selected, onSelect]);
  const linkState = (link: ChartLink) =>
    later.has(link)
      ? 'later'
      : chain
        ? chain.has(link.from) && chain.has(link.to)
          ? 'on'
          : 'dim'
        : 'base';
  if (!map.links.length)
    return (
      <div className="files-map-empty">
        <p>아직 파일 사이의 관계가 없습니다.</p>
        <p>연결 파일을 동기화하거나 jig를 계산하면 여기에 이어집니다.</p>
        <button type="button" className="link-button" onClick={() => onList()}>
          목록으로
        </button>
      </div>
    );
  const tipText = (node: MapNode) => {
    const event = last.get(node.id);
    return [
      node.name,
      node.role ? ROLE_LABEL[node.role] : '역할 없음',
      event ? `${shortTime(time(event.at))} ${EVENT_LABEL[event.kind]}` : '사건 없음',
      node.origin === 'server' ? '서버' : '로컬',
    ].join(' · ');
  };
  const height = layout.height + 8;
  return (
    <div className="files-map" ref={frame}>
      <div className="files-map-head">
        <label className="files-basis">
          행 기준
          <select value={basis} onChange={(event) => setBasis(event.target.value as RowBasis)}>
            <option value="role">역할</option>
            <option value="host">프로그램</option>
          </select>
        </label>
        <details className="files-legend">
          <summary>범례</summary>
          <ul>
            {MAP_LINK_KINDS.map((kind) => (
              <li key={kind}>
                <svg width="36" height="10" style={{ width: 36, height: 10 }} aria-hidden="true">
                  <path
                    className={`chart-link chart-link-base${LINK_STYLES[kind].faint ? ' chart-link-faint' : ''}`}
                    d="M2,5 L34,5"
                    strokeWidth={LINK_STYLES[kind].width}
                    strokeDasharray={LINK_STYLES[kind].dash}
                  />
                </svg>
                {LINK_STYLES[kind].label}
              </li>
            ))}
            {(Object.keys(GLYPH_NAMES) as GlyphKind[]).map((kind) => (
              <li key={kind}>
                <svg width="36" height="12" style={{ width: 36, height: 12 }} aria-hidden="true">
                  <Glyph kind={kind} x={18} y={6} />
                </svg>
                {
                  {
                    model: '모델(3dm)',
                    drawing: '도면(dwg)',
                    jig: 'jig 결과',
                    report: '보고서',
                    note: '노트',
                    image: '이미지',
                    file: '그 밖 파일',
                  }[kind]
                }
              </li>
            ))}
          </ul>
        </details>
      </div>
      {pickedLink && nodeById.get(pickedLink.from) && nodeById.get(pickedLink.to) ? (
        <SyncPairStrip
          projectId={projectId}
          model={nodeById.get(pickedLink.from)!}
          drawing={nodeById.get(pickedLink.to)!}
          pairs={pairs}
          remote={remote}
          onChanged={() => void reloadPairs()}
          onClose={() => setPickedLink(undefined)}
        />
      ) : null}
      <div className="files-map-body" onMouseLeave={() => setTip(undefined)}>
        <div className="files-map-names" style={{ width: NAME_COLUMN }}>
          {layout.rows.map((row) => (
            <div key={row.id} className="files-map-row-name" style={{ height: row.height }}>
              <span>{row.label}</span>
              {folded.get(row.id)?.length ? (
                <button
                  type="button"
                  className="link-button files-fold"
                  onClick={() => setOpen(new Set([...open, row.id]))}
                >
                  {row.id === 'other'
                    ? `${folded.get(row.id)!.length}개 펼치기`
                    : `그 밖 ${folded.get(row.id)!.length}`}
                </button>
              ) : open.has(row.id) ? (
                <button
                  type="button"
                  className="link-button files-fold"
                  onClick={() => setOpen(new Set([...open].filter((id) => id !== row.id)))}
                >
                  접기
                </button>
              ) : null}
            </div>
          ))}
        </div>
        <svg
          className="files-map-svg"
          width={width}
          height={height}
          style={{ width, height }}
          role="group"
          aria-label="파일 지도"
          onClick={(event) => {
            if (event.target === event.currentTarget && selected.length) onSelect([]);
          }}
        >
          <ChartDefs />
          {layout.rows.map((row, index) =>
            index ? (
              <line
                key={row.id}
                className="chart-row-rule"
                x1={0}
                x2={width}
                y1={row.y}
                y2={row.y}
              />
            ) : null,
          )}
          <ChartLinks
            links={model.links}
            placed={layout.items}
            styles={LINK_STYLES}
            state={linkState}
            pickable={(link) => link.kind === 'sync-pair'}
            onPick={(link) => setPickedLink({ from: link.from, to: link.to })}
            marked={(link) =>
              link.kind === 'sync-pair' &&
              !!pairOf(pairs, nodeById.get(link.from)?.path, nodeById.get(link.to)?.path)
            }
          />
          {model.milestones.map((milestone, index) => {
            const placed = milestone.items
              .map((id) => layout.items.get(id))
              .find((item) => item !== undefined);
            if (!placed || !Number.isFinite(milestone.t)) return null;
            const after = milestone.t > cursor;
            const dim = chain && !milestone.items.some((id) => chain.has(id));
            const names = milestone.items
              .map((id) => nodeById.get(id)?.name)
              .filter(Boolean)
              .join(', ');
            return (
              <line
                key={index}
                className={`chart-event${after ? ' chart-event-later' : ''}${dim ? ' chart-faded' : ''}`}
                data-kind={milestone.kind}
                x1={x(milestone.t)}
                x2={x(milestone.t)}
                y1={placed.y - 12}
                y2={placed.y - 6}
              >
                <title>{`${shortTime(milestone.t)} · ${milestone.label} · ${names}`}</title>
              </line>
            );
          })}
          {model.items.map((item) => {
            const placed = layout.items.get(item.id);
            const node = nodeById.get(item.id);
            if (!placed || !node) return null;
            const on = !chain || chain.has(item.id);
            const chosen = selected.includes(item.id);
            return (
              <g
                key={item.id}
                className={`chart-item ${on ? 'chart-item-on' : 'chart-item-faded chart-faded'}${chosen ? ' chart-item-chosen' : ''}`}
                data-node-id={item.id}
                role="button"
                tabIndex={0}
                aria-label={`${node.name} · ${node.role ? ROLE_LABEL[node.role] : '역할 없음'}`}
                aria-pressed={chosen}
                onClick={() => onSelect(chosen ? [] : [item.id])}
                onDoubleClick={() => onList(item.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(chosen ? [] : [item.id]);
                  }
                }}
                onMouseEnter={() => setTip({ x: placed.x, y: placed.y, text: tipText(node) })}
                onMouseLeave={() => setTip(undefined)}
              >
                <circle className="chart-hit" cx={placed.x} cy={placed.y} r={8} />
                <Glyph kind={item.kind} x={placed.x} y={placed.y} />
                <text
                  className="chart-label"
                  x={placed.x > width - 140 ? placed.x - 8 : placed.x + 8}
                  y={placed.y + 4 + placed.lane * 14}
                  textAnchor={placed.x > width - 140 ? 'end' : 'start'}
                >
                  {item.label}
                </text>
              </g>
            );
          })}
        </svg>
        {tip ? (
          <div
            className="files-tip"
            role="tooltip"
            style={{ left: NAME_COLUMN + tip.x + 12, top: tip.y + 10 }}
          >
            {tip.text}
          </div>
        ) : null}
      </div>
      <Timeline
        domain={layout.domain}
        width={width}
        offset={NAME_COLUMN}
        times={model.milestones.map((milestone) => milestone.t)}
        cursor={cursor}
        onCursor={setCursor}
        playing={playing}
        onPlaying={setPlaying}
      />
    </div>
  );
}

function FilesTab({ projectId }: { projectId: string }) {
  const [view, setView] = useState<View>(() =>
    pending?.projectId === projectId ? 'map' : readView(projectId),
  );
  const [map, setMap] = useState<WorkspaceMap | undefined>();
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string[]>(() =>
    pending?.projectId === projectId ? pending.nodeIds : [],
  );
  const [focus, setFocus] = useState<string | undefined>();
  const load = useCallback(
    (fresh = false) => {
      setError(false);
      fetchWorkspaceMap(projectId, fresh).then(setMap, () => setError(true));
    },
    [projectId],
  );
  useEffect(() => load(true), [load]);
  useEffect(() => {
    const follow = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; nodeIds: string[] }>).detail;
      if (detail.projectId !== projectId) return;
      setSelected(detail.nodeIds);
      setView('map');
      load();
    };
    addEventListener(SHOW_MAP, follow);
    pending = undefined;
    return () => removeEventListener(SHOW_MAP, follow);
  }, [projectId, load]);
  const choose = (next: View) => {
    setView(next);
    saveView(projectId, next);
  };
  return (
    <div className="files-tab">
      <div className="files-head">
        <div className="files-views" role="tablist" aria-label="파일 보기">
          {(
            [
              ['list', '목록'],
              ['map', '지도'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              className="files-view-chip"
              onClick={() => choose(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="link-button" onClick={() => load(true)}>
          다시 읽기
        </button>
        {map?.truncated ? <span className="files-note">파일이 많아 일부만 보입니다</span> : null}
      </div>
      {error ? (
        <p className="files-empty">파일 목록을 읽지 못했습니다. [다시 읽기]로 다시 시도하세요.</p>
      ) : !map ? (
        <p className="files-empty">읽는 중…</p>
      ) : !map.root ? (
        <p className="files-empty">
          이 프로젝트에는 작업 폴더가 없습니다. 대시보드의 프로젝트 폴더에서 [폴더로 만들기]나 [폴더
          열기]로 작업 폴더를 정하면 파일 목록과 파일 지도가 보입니다.
        </p>
      ) : view === 'list' ? (
        <FileList
          map={map}
          focus={focus}
          onMap={(id) => {
            setSelected([id]);
            choose('map');
          }}
        />
      ) : (
        <FileMap
          projectId={projectId}
          map={map}
          selected={selected}
          onSelect={setSelected}
          onList={(id) => {
            setFocus(id);
            choose('list');
          }}
        />
      )}
    </div>
  );
}

const SHOW_MAP = 'vide:files-map';
let root: Root | undefined;
let shownFor: string | undefined;
let pending: { projectId: string; nodeIds: string[] } | undefined;

/** Show the 파일 tab of a project (mounts once; later calls keep what is open). */
export function showFiles(projectId: string) {
  const workspace = document.querySelector<HTMLElement>('.workspace');
  if (!workspace) return;
  if (!root) {
    const host = document.createElement('section');
    host.className = 'files-workspace';
    host.setAttribute('aria-label', '파일');
    workspace.append(host);
    root = createRoot(host);
  }
  if (shownFor !== projectId) {
    shownFor = projectId;
    root.render(<FilesTab key={projectId} projectId={projectId} />);
  }
}

/** [지도에서 보기] of the 영향 띠: the 파일 tab's map with that chain chosen. */
export function showFilesMap(projectId: string, nodeIds: string[]) {
  if (shownFor === projectId)
    dispatchEvent(new CustomEvent(SHOW_MAP, { detail: { projectId, nodeIds } }));
  else pending = { projectId, nodeIds };
  setWorkspace('files');
}
