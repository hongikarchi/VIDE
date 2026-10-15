// 부위×시간 차트 (PLAN-53 T-328, Design SCR-45, SPEC-17.4): the 기록 tab's [차트] view. Rows by
// 부위 · 유형 · 장 over time; one glyph per record (shape = type, filled = 남김, hollow = 후보), label
// lanes above and below, follows lines, milestones, the 알려짐 선 of existing parts, the time axis
// with density and cursor (src/ui/chart Timeline). Pressing a glyph opens the 자세히 column (the
// list's) and keeps only its chain dark; every change (O/X · 부위 · 이어짐) is made there, so the
// chart itself only reads. Data and layout: src/core/records-chart.ts.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CHAIN_DASHES,
  CHART_TYPES,
  buildRecordsChart,
  chainMembers,
  layoutRecordsChart,
  type ChainStyle,
  type LabelMode,
  type RecordsChartModel,
  type RowMode,
} from '../core/records-chart.ts';
import { ChartDefs, ChartLinks, Timeline, type LinkStyle } from './chart/index.ts';
import {
  TYPE_NAME,
  listMilestones,
  type MilestoneRow,
  type PartRow,
  type RecordRow,
  type RecordType,
} from './records-api.ts';
// The shared chart parts' rules (.chart-*) live with the 파일 지도 (PLAN-52).
import './files-tab.css';
import './records-chart.css';

const NAME_COLUMN = 180;
const TOP = 18;
const DRAWN_TYPES: RecordType[] = [...CHART_TYPES, '?'];

interface Prefs {
  mode: RowMode;
  types: RecordType[];
  relations: boolean;
  known: boolean;
  group: boolean;
  chainStyle: ChainStyle;
  labels: LabelMode;
  open: boolean;
}
const DEFAULT_PREFS: Prefs = {
  mode: 'part',
  types: DRAWN_TYPES,
  relations: true,
  known: true,
  group: true,
  chainStyle: 'same',
  labels: 'text',
  open: false,
};
function readPrefs(projectId: string): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(`vide:records-chart:${projectId}`) ?? '{}');
    return { ...DEFAULT_PREFS, ...(saved && typeof saved === 'object' ? saved : {}) };
  } catch {
    return DEFAULT_PREFS;
  }
}
function savePrefs(projectId: string, prefs: Prefs) {
  try {
    localStorage.setItem(`vide:records-chart:${projectId}`, JSON.stringify(prefs));
  } catch {
    /* a viewer convenience only */
  }
}

/** One record glyph in a 10px box: R 사각 · I 삼각 · K 겹원 · E 마름모 · D 원. */
export function RecordGlyph({
  type,
  x,
  y,
  hollow = false,
  root = false,
}: {
  type: RecordType;
  x: number;
  y: number;
  hollow?: boolean;
  root?: boolean;
}) {
  const className = `records-glyph${hollow ? ' records-glyph-hollow' : ''}${root ? ' records-glyph-root' : ''}`;
  switch (type) {
    case 'R':
      return <rect className={className} x={x - 4.5} y={y - 4.5} width={9} height={9} />;
    case 'I':
      return (
        <polygon
          className={className}
          points={`${x},${y - 5} ${x + 5},${y + 4.5} ${x - 5},${y + 4.5}`}
        />
      );
    case 'K':
      return (
        <g className={className}>
          <circle cx={x} cy={y} r={5} className="records-glyph-outer" />
          <circle cx={x} cy={y} r={2.75} />
        </g>
      );
    case 'E':
      return (
        <polygon
          className={className}
          points={`${x},${y - 5} ${x + 5},${y} ${x},${y + 5} ${x - 5},${y}`}
        />
      );
    case 'D':
      return <circle className={className} cx={x} cy={y} r={4.5} />;
    default:
      return <circle className={`${className} records-glyph-unknown`} cx={x} cy={y} r={3} />;
  }
}

/** Prints the sheet: a copy goes into the page body, the print rules hide everything else. */
function printSheet(node: HTMLElement | null) {
  if (!node) return;
  const root = document.createElement('div');
  root.className = 'records-print-root';
  root.append(node.cloneNode(true));
  document.body.append(root);
  document.body.dataset.recordsPrint = '';
  let done = false;
  const clean = () => {
    if (done) return;
    done = true;
    root.remove();
    delete document.body.dataset.recordsPrint;
    window.removeEventListener('afterprint', clean);
  };
  window.addEventListener('afterprint', clean);
  try {
    window.print();
  } finally {
    setTimeout(clean, 500);
  }
}

const LINK_STYLES: Record<string, LinkStyle> = {
  follows: { width: 1, arrow: true, label: '이어짐' },
  ...Object.fromEntries(
    CHAIN_DASHES.map((dash, i) => [
      `follows-${i}`,
      { width: 1, arrow: true, label: '이어짐', ...(dash ? { dash } : {}) },
    ]),
  ),
};

export function RecordsChart({
  projectId,
  rows,
  parts,
  keptOnly,
  openId,
  onOpen,
  onList,
}: {
  projectId: string;
  /** The records the 기록 tab's filters chose (undefined while reading). */
  rows: RecordRow[] | undefined;
  parts: PartRow[];
  /** The state chips are at their default: draw 남김 only. */
  keptOnly: boolean;
  openId: string | undefined;
  onOpen: (id: string | undefined) => void;
  onList: () => void;
}) {
  const [prefs, setPrefsState] = useState<Prefs>(() => readPrefs(projectId));
  const setPrefs = (next: Partial<Prefs>) => {
    const value = { ...prefs, ...next };
    setPrefsState(value);
    savePrefs(projectId, value);
  };
  const [milestones, setMilestones] = useState<MilestoneRow[]>([]);
  useEffect(() => {
    let live = true;
    void listMilestones(projectId)
      .then((list) => live && setMilestones(list))
      .catch(() => live && setMilestones([]));
    return () => {
      live = false;
    };
  }, [projectId, rows]);
  const [width, setWidth] = useState(720);
  const frame = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const fit = () => setWidth(Math.max(320, element.clientWidth - NAME_COLUMN - 16));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [rows === undefined]);
  const [hover, setHover] = useState<string | undefined>();
  const [playing, setPlaying] = useState(false);

  const model: RecordsChartModel = useMemo(
    () =>
      buildRecordsChart({
        records: rows ?? [],
        parts,
        milestones,
        rowMode: prefs.mode,
        states: keptOnly ? ['kept'] : ['candidate', 'kept', 'dropped'],
        types: prefs.types,
        groupByGrp: prefs.group,
        labelMode: prefs.labels,
        chainStyle: prefs.chainStyle,
      }),
    [rows, parts, milestones, prefs, keptOnly],
  );
  const layout = useMemo(() => layoutRecordsChart(model, { width }), [model, width]);
  const [cursor, setCursor] = useState(() => layout.domain.end);
  useEffect(() => setCursor(layout.domain.end), [layout.domain.end]);
  const byRecord = useMemo(() => new Map((rows ?? []).map((row) => [row.id, row])), [rows]);
  const drawn = useMemo(() => new Set(model.items.map((item) => item.record)), [model]);
  const chosen = openId && drawn.has(openId) ? openId : undefined;
  const chain = useMemo(
    () => (chosen ? chainMembers(model.chains, chosen) : undefined),
    [model.chains, chosen],
  );
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && openId && document.body.dataset.workspace === 'records')
        onOpen(undefined);
    };
    addEventListener('keydown', escape);
    return () => removeEventListener('keydown', escape);
  }, [openId, onOpen]);
  const partNames = useMemo(() => new Map(parts.map((part) => [part.id, part.name])), [parts]);
  const recordOf = useMemo(
    () => new Map(model.items.map((item) => [item.id, item.record])),
    [model],
  );

  if (!rows) return <p className="records-empty">그리는 중…</p>;
  const typesOn = new Set(prefs.types);
  const switches = (
    <details className="records-chart-switches" open={prefs.open}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          setPrefs({ open: !prefs.open });
        }}
      >
        보기와 범례
      </summary>
      <div className="records-chart-switch-box">
        <fieldset>
          <legend>유형</legend>
          {CHART_TYPES.map((type) => {
            const on = typesOn.has(type);
            const last = on && CHART_TYPES.filter((each) => typesOn.has(each)).length === 1;
            return (
              <label key={type} className="records-chart-check">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={last}
                  onChange={() =>
                    setPrefs({
                      types: on
                        ? prefs.types.filter((each) => each !== type)
                        : DRAWN_TYPES.filter((each) => each === type || typesOn.has(each)),
                    })
                  }
                />
                <svg width="14" height="12" style={{ width: 14, height: 12 }} aria-hidden="true">
                  <RecordGlyph type={type} x={7} y={6} />
                </svg>
                {TYPE_NAME[type]} {type}
                <span className="records-chart-count">{model.typeCounts[type]}</span>
              </label>
            );
          })}
        </fieldset>
        <fieldset>
          <legend>선</legend>
          <label className="records-chart-check">
            <input
              type="checkbox"
              checked={prefs.relations}
              onChange={() => setPrefs({ relations: !prefs.relations })}
            />
            관계 선
          </label>
          <label className="records-chart-check">
            <input
              type="checkbox"
              checked={prefs.known}
              onChange={() => setPrefs({ known: !prefs.known })}
            />
            알려짐 선
          </label>
          {prefs.mode === 'part' ? (
            <label className="records-chart-check">
              <input
                type="checkbox"
                checked={prefs.group}
                onChange={() => setPrefs({ group: !prefs.group })}
              />
              신설/기존 묶기
            </label>
          ) : null}
          <span className="records-chart-sub">이어진 기록</span>
          {(
            [
              ['same', '모두 같은 선'],
              ['dashed', '이야기마다 다른 점선'],
            ] as const
          ).map(([id, label]) => (
            <label key={id} className="records-chart-check">
              <input
                type="radio"
                name={`records-chain-${projectId}`}
                checked={prefs.chainStyle === id}
                onChange={() => setPrefs({ chainStyle: id })}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>주석</legend>
          {(
            [
              ['text', '본문'],
              ['number', '번호와 색인'],
              ['episodes', '주요 이야기만'],
            ] as const
          ).map(([id, label]) => (
            <label key={id} className="records-chart-check">
              <input
                type="radio"
                name={`records-labels-${projectId}`}
                checked={prefs.labels === id}
                onChange={() => setPrefs({ labels: id })}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <Legend />
      </div>
    </details>
  );
  const head = (
    <div className="records-chart-head">
      <div className="records-chart-modes" role="group" aria-label="행 기준">
        {(
          [
            ['part', '부위'],
            ['type', '유형'],
            ['chapter', '장'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="records-view-chip"
            aria-pressed={prefs.mode === id}
            onClick={() => setPrefs({ mode: id })}
          >
            {label}
          </button>
        ))}
      </div>
      <span className="records-spacer" />
      {model.items.length ? (
        <button type="button" className="link-button" onClick={() => printSheet(sheet.current)}>
          인쇄
        </button>
      ) : null}
      {switches}
    </div>
  );
  if (!model.items.length)
    return (
      <div className="records-chart" ref={frame}>
        {head}
        <div className="records-empty">
          <p>남긴 기록이 아직 없습니다. 목록에서 후보를 거르면 여기에 놓입니다.</p>
          <button type="button" className="link-button" onClick={onList}>
            목록으로
          </button>
        </div>
      </div>
    );

  const height = layout.height + TOP + 6;
  const linkState = (link: { from: string; to: string; t?: number | null }) => {
    if (!chain) return 'base' as const;
    const from = recordOf.get(link.from);
    const to = recordOf.get(link.to);
    return from && to && chain.has(from) && chain.has(to) ? ('on' as const) : ('dim' as const);
  };
  const hovered = hover ? model.items.find((item) => item.id === hover) : undefined;
  const hoveredPlaced = hovered ? layout.items.get(hovered.id) : undefined;
  const hoveredRow = hovered ? byRecord.get(hovered.record) : undefined;
  const indexShown =
    prefs.labels === 'number' ? new Set(model.index.map((entry) => entry.record)) : layout.numbered;
  let lastGroup: string | null = null;
  return (
    <div className="records-chart" ref={frame}>
      {head}
      <div className="records-chart-sheet" ref={sheet}>
        <p className="records-chart-print-legend">
          요구 R 사각 · 의도 I 삼각 · 앎 K 겹원 · 근거 E 마름모 · 결정 D 원 · 채움 = 남김 · 빈 모양
          = 후보 · 굵은 테두리 = 이야기의 시작 · 점선 → 실선 = 열어 보기 전 → 뒤
        </p>
        <div className="records-chart-body" onMouseLeave={() => setHover(undefined)}>
          <div className="records-chart-names" style={{ width: NAME_COLUMN, paddingTop: TOP }}>
            {layout.rows.map((placed, i) => {
              const row = model.rows[i]!;
              const groupHead = row.group && row.group !== lastGroup ? row.group : null;
              lastGroup = row.group;
              return (
                <div
                  key={placed.id}
                  className="records-chart-row-name"
                  style={{ height: placed.height }}
                >
                  {groupHead ? <span className="records-chart-group">{groupHead}</span> : null}
                  <span className="records-chart-row-label">{placed.label}</span>
                  {row.role ? <span className="records-chart-role">{row.role}</span> : null}
                </div>
              );
            })}
          </div>
          <svg
            className="records-chart-svg"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            style={{ width, height }}
            role="group"
            aria-label="부위와 시간의 기록"
            onClick={(event) => {
              if (event.target === event.currentTarget && openId) onOpen(undefined);
            }}
          >
            <ChartDefs />
            {model.monthGrid.map((month) => (
              <line
                key={month.t}
                className="records-chart-month"
                x1={layout.x(month.t)}
                x2={layout.x(month.t)}
                y1={TOP}
                y2={height}
              />
            ))}
            {model.milestones.map((milestone, i) => (
              <g key={`${milestone.t}-${i}`} className="records-chart-milestone">
                <line x1={layout.x(milestone.t)} x2={layout.x(milestone.t)} y1={12} y2={height} />
                <text x={layout.x(milestone.t) + 3} y={10}>
                  {milestone.label}
                </text>
              </g>
            ))}
            <g transform={`translate(0,${TOP})`}>
              {layout.rows.map((row, i) =>
                i ? (
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
              {prefs.known
                ? model.known.map((line) => {
                    const row = layout.rows.find((each) => each.id === line.row);
                    const first = model.items.find((item) => item.row === line.row);
                    const y = first ? layout.items.get(first.id)!.y : row ? row.y + 14 : 0;
                    if (!row) return null;
                    return (
                      <g key={line.row} className="records-chart-known">
                        {line.dashed ? (
                          <line
                            className="records-chart-known-before"
                            x1={layout.x(line.dashed[0])}
                            x2={layout.x(line.dashed[1])}
                            y1={y}
                            y2={y}
                          />
                        ) : null}
                        {line.solid ? (
                          <line
                            className="records-chart-known-after"
                            x1={layout.x(line.solid[0])}
                            x2={layout.x(line.solid[1])}
                            y1={y}
                            y2={y}
                          />
                        ) : null}
                      </g>
                    );
                  })
                : null}
              {prefs.relations ? (
                <ChartLinks
                  links={model.links}
                  placed={layout.items}
                  styles={LINK_STYLES}
                  state={linkState}
                />
              ) : null}
              {model.items.map((item) => {
                const placed = layout.items.get(item.id);
                if (!placed) return null;
                const on = !chain || chain.has(item.record);
                const isChosen = chosen === item.record;
                const later = item.t !== null && item.t > cursor;
                const row = byRecord.get(item.record);
                const type = item.kind.slice('record:'.length) as RecordType;
                return (
                  <g
                    key={item.id}
                    className={`chart-item records-chart-item${on ? '' : ' chart-faded'}${later ? ' records-chart-later' : ''}${isChosen ? ' chart-item-chosen' : ''}`}
                    data-record-id={item.record}
                    data-type={type}
                    data-hollow={item.hollow ? '1' : '0'}
                    role="button"
                    tabIndex={0}
                    aria-label={`${item.number}. ${row?.date ?? ''} · ${TYPE_NAME[type]} · ${row?.text.split('\n')[0] ?? ''}`}
                    aria-pressed={isChosen}
                    onClick={() => onOpen(isChosen ? undefined : item.record)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onOpen(isChosen ? undefined : item.record);
                      }
                    }}
                    onMouseEnter={() => setHover(item.id)}
                    onMouseLeave={() => setHover(undefined)}
                  >
                    {hover === item.id ? (
                      <circle className="records-chart-hover" cx={placed.x} cy={placed.y} r={8} />
                    ) : null}
                    <circle className="chart-hit" cx={placed.x} cy={placed.y} r={8} />
                    <RecordGlyph
                      type={type}
                      x={placed.x}
                      y={placed.y}
                      hollow={item.hollow}
                      root={item.root}
                    />
                    {placed.label ? (
                      <text
                        className={`chart-label${placed.label.numbered || prefs.labels === 'number' ? ' records-chart-number' : ''}`}
                        x={placed.label.anchor === 'end' ? placed.label.x1 : placed.label.x0}
                        y={placed.label.y}
                        textAnchor={placed.label.anchor}
                      >
                        {placed.label.text}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </g>
          </svg>
          {hovered && hoveredPlaced && hoveredRow ? (
            <div
              className="records-chart-tip"
              role="tooltip"
              style={{
                left: NAME_COLUMN + Math.min(hoveredPlaced.x + 12, Math.max(0, width - 290)),
                top: TOP + hoveredPlaced.y + 12,
              }}
            >
              <span className="records-chart-tip-head">
                {hoveredRow.date.slice(5)} ·{' '}
                {hoveredRow.parts.map((id) => partNames.get(id) ?? '지운 부위').join(' · ') ||
                  '부위 없음'}{' '}
                · {TYPE_NAME[hoveredRow.type]}
              </span>
              <span className="records-chart-tip-text">{hoveredRow.text}</span>
            </div>
          ) : null}
        </div>
        <ol className="records-chart-index" aria-label="번호 색인">
          {model.index.map((entry) => (
            <li
              key={entry.record}
              className={indexShown.has(entry.record) ? undefined : 'records-chart-print-only'}
            >
              <button type="button" onClick={() => onOpen(entry.record)}>
                <span className="records-chart-index-number">{entry.number}</span>
                <span className="records-chart-index-date">{entry.date.slice(5)}</span>
                <span>{entry.parts.join('·') || '—'}</span>
                <span>{TYPE_NAME[entry.type]}</span>
                <span className="records-chart-index-text">{entry.text}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      <Timeline
        domain={layout.domain}
        width={width}
        offset={NAME_COLUMN}
        times={model.times}
        cursor={cursor}
        onCursor={setCursor}
        playing={playing}
        onPlaying={setPlaying}
      />
    </div>
  );
}

function Legend() {
  return (
    <ul className="records-chart-legend">
      {CHART_TYPES.map((type) => (
        <li key={type}>
          <svg width="14" height="12" style={{ width: 14, height: 12 }} aria-hidden="true">
            <RecordGlyph type={type} x={7} y={6} />
          </svg>
          {TYPE_NAME[type]}
        </li>
      ))}
      <li>채움 = 남김 · 빈 모양 = 후보</li>
      <li>굵은 테두리 = 이야기의 시작</li>
      <li>점선 → 실선 = 열어 보기 전 → 뒤</li>
    </ul>
  );
}
