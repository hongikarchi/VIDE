// 참고 이미지 탭 (SPEC-09.2·09.3·09.5, PLAN-26 T-090 phase (a)): an image attachment opened from
// its composer chip ([영역 표시]) in the row of open items. Two states of one tab: the region
// editor ('참고 이미지 · <파일>') — brush, lasso, rectangle and eraser drawing regions A, B, C… with
// a note each, wheel zoom, space/middle-button pan, Ctrl+Z / Ctrl+Shift+Z — and the 이해 확인 board
// ('이해 확인 · <파일>'), which in this phase is only its frame: the reference with the regions
// ('해석 대기'), an empty place for the generated image ('아직 없음') and an empty values table.
// No AI is called yet. The regions are kept by the engine per project and attachment
// (src/server/reference-boards.ts); [이해 확인] also saves the flattened input image beside them.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  effectiveRegions,
  referenceBoardSchema,
  type ReferenceRegion,
  type ReferenceShape,
  type ReferenceStage,
} from '../contracts/reference-board.ts';
import { attachmentPreview } from './attachments.ts';
import { api, errors } from './gateway.ts';
import {
  addRegion,
  addShape,
  badgeAnchor,
  commit,
  createHistory,
  deleteRegion,
  drawFlattened,
  maskState,
  negligible,
  rectShape,
  redo,
  selectRegion,
  setNote,
  shapePath,
  thin,
  toImage,
  undo,
  type MaskHistory,
} from './reference-mask.ts';
import { TOKEN_FALLBACK } from './tokens.ts';
import {
  activeWorkspace,
  onWorkspaceChange,
  referenceTabId,
  renameContextTab,
  type ContextTab,
} from './workspaces.ts';
import './reference-tab.css';

type Tool = 'brush' | 'lasso' | 'rect' | 'erase';
const TOOLS: { id: Tool; label: string; title: string }[] = [
  { id: 'brush', label: '붓', title: '붓 · 지금 영역에 칠합니다' },
  { id: 'lasso', label: '올가미', title: '올가미 · 손으로 둘러 그리면 닫힙니다' },
  { id: 'rect', label: '사각형', title: '사각형 · 끌어서 그립니다' },
  { id: 'erase', label: '지우개', title: '지우개 · 지금 영역에서만 지웁니다' },
];
/** Brush width as thousandths of the image's long side. */
const WIDTH_MIN = 3;
const WIDTH_MAX = 150;
/** The flattened input image's long side at most (SPEC-09.7 2: a small image is enough). */
const FLAT_LONG_SIDE = 1600;
const CHECK_TITLE = '해석은 다음 단계에서 연결됩니다';

/** The file name shown after '참고 이미지 · ' or '이해 확인 · ' in the tab label. */
export const referenceName = (tab: Pick<ContextTab, 'label'>) =>
  tab.label.replace(/^(참고 이미지|이해 확인) · /, '');
export const referenceLabel = (stage: ReferenceStage, name: string) =>
  `${stage === 'check' ? '이해 확인' : '참고 이미지'} · ${name}`;
const referenceTitle = (stage: ReferenceStage, name: string) =>
  `${referenceLabel(stage, name)} · ${stage === 'check' ? '보드' : '영역 표시'}`;

const boardPath = (projectId: string, attachmentId: string) =>
  `/projects/${encodeURIComponent(projectId)}/reference-boards/${attachmentId}`;
async function loadBoard(projectId: string, attachmentId: string) {
  return referenceBoardSchema.parse(await api(boardPath(projectId, attachmentId)));
}
async function saveMasked(projectId: string, attachmentId: string, png: Blob) {
  const response = await fetch('api/v1' + boardPath(projectId, attachmentId) + '/masked', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: png,
  });
  if (!response.ok) throw Error('MASKED_NOT_SAVED');
  return referenceBoardSchema.parse(await response.json());
}
const message = (error: unknown) => {
  const code = (error as { code?: string })?.code;
  return (code && errors[code]) || '저장하지 못했습니다';
};
const shapeCount = (region: ReferenceRegion) => {
  const counts = new Map<string, number>();
  const names: Record<ReferenceShape['kind'], string> = {
    brush: '붓',
    lasso: '올가미',
    rect: '사각형',
    erase: '지우개',
  };
  for (const shape of region.shapes)
    counts.set(names[shape.kind], (counts.get(names[shape.kind]) ?? 0) + 1);
  return counts.size
    ? [...counts].map(([name, count]) => `${name} ${count}`).join(' · ')
    : '아직 그리지 않음';
};

/** The regions over the image: one mask per region (eraser strokes in order) and its letter. */
function RegionOverlay({
  regions,
  width,
  height,
  scale,
  active,
  idPrefix,
  draft,
}: {
  regions: readonly ReferenceRegion[];
  width: number;
  height: number;
  /** Screen pixels per image pixel (letters keep their size on screen). */
  scale: number;
  active?: string;
  idPrefix: string;
  draft?: ReactNode;
}) {
  const radius = 11 / Math.max(scale, 0.01);
  const shown = effectiveRegions(regions);
  return (
    <svg
      className="reference-overlay"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-hidden="true"
    >
      <defs>
        {regions.map((region) => (
          <mask
            key={region.letter}
            id={`${idPrefix}-${region.letter}`}
            maskUnits="userSpaceOnUse"
            x={0}
            y={0}
            width={width}
            height={height}
          >
            {region.shapes.map((shape, k) => {
              const { d, stroke } = shapePath(shape, width, height);
              const color = shape.kind === 'erase' ? 'black' : 'white';
              return stroke === undefined ? (
                <path key={k} d={d} fill={color} />
              ) : (
                <path
                  key={k}
                  d={d}
                  fill="none"
                  stroke={color}
                  strokeWidth={stroke}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              );
            })}
          </mask>
        ))}
      </defs>
      {regions.map((region) => (
        <rect
          key={region.letter}
          className="reference-region-fill"
          data-region={region.letter}
          data-active={region.letter === active ? '' : undefined}
          width={width}
          height={height}
          mask={`url(#${idPrefix}-${region.letter})`}
        />
      ))}
      {draft}
      {shown.map((region) => {
        const [x, y] = badgeAnchor(region);
        const wide = (region.letter.length - 1) * radius * 0.55;
        const cx = Math.min(width - radius - wide, Math.max(radius + wide, x * width));
        const cy = Math.min(height - radius, Math.max(radius, y * height));
        return (
          <g
            key={region.letter}
            className="reference-badge"
            data-active={region.letter === active ? '' : undefined}
          >
            <rect
              x={cx - radius - wide}
              y={cy - radius}
              width={(radius + wide) * 2}
              height={radius * 2}
              rx={radius}
            />
            <text x={cx} y={cy} fontSize={radius * 1.1} dy="0.36em" textAnchor="middle">
              {region.letter}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

interface View {
  scale: number;
  x: number;
  y: number;
}
type Gesture =
  | { kind: 'pan'; from: [number, number]; start: View }
  | { kind: 'draw'; tool: Tool; points: number[]; origin: [number, number] }
  | undefined;

function Editor({
  name,
  history,
  setHistory,
  image,
  onCheck,
  checking,
  status,
}: {
  name: string;
  history: MaskHistory;
  setHistory: (update: (history: MaskHistory) => MaskHistory) => void;
  image: { src: string; width: number; height: number };
  onCheck: () => void;
  checking: boolean;
  status: string;
}) {
  const state = history.present;
  const [tool, setTool] = useState<Tool>('brush');
  const [width, setWidth] = useState(24);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [fitted, setFitted] = useState(true);
  const [space, setSpace] = useState(false);
  const [draft, setDraft] = useState<{ tool: Tool; points: number[] } | undefined>();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const stage = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const gesture = useRef<Gesture>(undefined);

  // Fit the image in the stage (and again when the stage changes size, until the user zooms).
  const fit = useCallback(() => {
    const box = stage.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return;
    const scale = Math.min(
      (box.width - 32) / image.width,
      (box.height - 32) / image.height,
      // A small image is not blown up past twice its size.
      2,
    );
    setView({
      scale,
      x: (box.width - image.width * scale) / 2,
      y: (box.height - image.height * scale) / 2,
    });
    setFitted(true);
  }, [image.width, image.height]);
  useLayoutEffect(() => {
    if (fitted) fit();
    const node = stage.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (fitted) fit();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [fit, fitted]);

  // Wheel zoom about the pointer (a native listener: the page must not scroll).
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = node.getBoundingClientRect();
      const px = event.clientX - box.left;
      const py = event.clientY - box.top;
      setView((current) => {
        const scale = Math.min(
          16,
          Math.max(0.02, current.scale * Math.exp(-event.deltaY * 0.0015)),
        );
        const k = scale / current.scale;
        return { scale, x: px - (px - current.x) * k, y: py - (py - current.y) * k };
      });
      setFitted(false);
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, []);

  // Keys: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, space to pan (not while typing a note).
  useEffect(() => {
    const typing = (target: EventTarget | null) =>
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;
    const down = (event: KeyboardEvent) => {
      if (document.body.dataset.workspace !== 'reference' || typing(event.target)) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && (key === 'z' || key === 'y')) {
        event.preventDefault();
        setHistory((current) => (key === 'y' || event.shiftKey ? redo(current) : undo(current)));
      } else if (event.key === ' ' && !event.repeat) {
        event.preventDefault();
        setSpace(true);
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === ' ') setSpace(false);
    };
    const leave = () => setSpace(false);
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    addEventListener('blur', leave);
    return () => {
      removeEventListener('keydown', down);
      removeEventListener('keyup', up);
      removeEventListener('blur', leave);
    };
  }, [setHistory]);

  const point = (event: { clientX: number; clientY: number }) =>
    toImage(event.clientX, event.clientY, picture.current!.getBoundingClientRect());
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!picture.current) return;
    if (event.button === 1 || (event.button === 0 && space)) {
      event.preventDefault();
      gesture.current = { kind: 'pan', from: [event.clientX, event.clientY], start: view };
    } else if (event.button === 0) {
      const at = point(event);
      gesture.current = { kind: 'draw', tool, points: [...at], origin: at };
      setDraft({ tool, points: [...at] });
    } else return;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current) return;
    if (current.kind === 'pan') {
      setView({
        ...current.start,
        x: current.start.x + event.clientX - current.from[0],
        y: current.start.y + event.clientY - current.from[1],
      });
      setFitted(false);
      return;
    }
    const at = point(event);
    if (current.tool === 'rect') current.points = [...current.origin, ...at];
    else current.points.push(...at);
    setDraft({ tool: current.tool, points: [...current.points] });
  };
  const up = () => {
    const current = gesture.current;
    gesture.current = undefined;
    setDraft(undefined);
    if (!current || current.kind !== 'draw') return;
    const long = Math.max(image.width, image.height);
    // Points closer than about one screen pixel add nothing.
    const step = 1.5 / Math.max(1, view.scale * long);
    const stroke = width / 1000;
    let shape: ReferenceShape;
    if (current.tool === 'rect') {
      const [x0, y0, x1, y1] =
        current.points.length >= 4 ? current.points : [...current.origin, ...current.origin];
      shape = rectShape([x0, y0], [x1, y1]);
    } else if (current.tool === 'lasso')
      shape = { kind: 'lasso', points: thin(current.points, step) };
    else shape = { kind: current.tool, width: stroke, points: thin(current.points, step) };
    if (negligible(shape)) return;
    setHistory((history) => commit(history, addShape(history.present, shape)));
  };

  const draftNode = draft && draftPath(draft, image.width, image.height, width / 1000);
  const regions = state.regions;
  const activeRegion = regions.find((region) => region.letter === state.active);
  const commitNote = (letter: string) => {
    const text = notes[letter];
    if (text === undefined) return;
    setNotes(({ [letter]: _, ...rest }) => rest);
    setHistory((history) => commit(history, setNote(history.present, letter, text)));
  };
  const hint = space
    ? '끌어서 이동'
    : tool === 'lasso'
      ? '둘러 그리고 놓으면 닫힘'
      : tool === 'erase'
        ? activeRegion
          ? `영역 ${activeRegion.letter}에서만 지움`
          : '지울 영역이 없습니다'
        : activeRegion
          ? `영역 ${activeRegion.letter}에 그리는 중`
          : '그리면 영역 A가 시작됩니다';

  return (
    <div className="reference-editor">
      <div className="reference-canvas">
        <div className="reference-tools" role="toolbar" aria-label="영역 표시 도구">
          <span className="reference-seg" role="group" aria-label="도구">
            {TOOLS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={tool === entry.id}
                title={entry.title}
                onClick={() => setTool(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </span>
          <span className="reference-sep" />
          <label>
            굵기
            <input
              type="range"
              min={WIDTH_MIN}
              max={WIDTH_MAX}
              value={width}
              aria-label="붓 굵기"
              disabled={tool === 'lasso' || tool === 'rect'}
              onChange={(event) => setWidth(event.currentTarget.valueAsNumber)}
            />
          </label>
          <span className="reference-sep" />
          <button
            type="button"
            aria-label="되돌리기"
            title="되돌리기 · Ctrl+Z"
            disabled={!history.past.length}
            onClick={() => setHistory(undo)}
          >
            ↶
          </button>
          <button
            type="button"
            aria-label="다시 하기"
            title="다시 하기 · Ctrl+Shift+Z"
            disabled={!history.future.length}
            onClick={() => setHistory(redo)}
          >
            ↷
          </button>
          <span className="reference-sep" />
          <button type="button" title="화면에 맞춤" onClick={fit}>
            맞춤
          </button>
          <span className="reference-zoom" aria-label="배율">
            {Math.round(view.scale * 100)}%
          </span>
          <span className="reference-hint">{hint} · 휠 확대 · 스페이스 끌기 이동</span>
        </div>
        <div
          ref={stage}
          className="reference-stage"
          data-tool={space ? 'pan' : tool}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onAuxClick={(event) => event.preventDefault()}
        >
          <div
            className="reference-layer"
            style={{
              width: image.width,
              height: image.height,
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
          >
            <img ref={picture} src={image.src} alt={`참고 이미지 ${name}`} draggable={false} />
            <RegionOverlay
              regions={regions}
              width={image.width}
              height={image.height}
              scale={view.scale}
              active={state.active}
              idPrefix="reference-edit"
              draft={draftNode}
            />
          </div>
        </div>
      </div>
      <aside className="reference-regions" aria-label="영역">
        <h3>영역 {regions.length}</h3>
        <ul>
          {regions.map((region) => (
            <li
              key={region.letter}
              className="reference-region"
              data-active={region.letter === state.active ? '' : undefined}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest('input, button')) return;
                setHistory((history) => ({
                  ...history,
                  present: selectRegion(history.present, region.letter),
                }));
              }}
            >
              <span className="reference-letter">{region.letter}</span>
              <strong>영역 {region.letter}</strong>
              <button
                type="button"
                className="reference-remove"
                aria-label={`영역 ${region.letter} 지우기`}
                title="영역 지우기 · 글자는 다시 쓰지 않습니다"
                onClick={() =>
                  setHistory((history) =>
                    commit(history, deleteRegion(history.present, region.letter)),
                  )
                }
              >
                ×
              </button>
              <input
                value={notes[region.letter] ?? region.note}
                placeholder="메모 한 줄 (선택)"
                aria-label={`영역 ${region.letter} 메모`}
                maxLength={500}
                onFocus={() =>
                  setHistory((history) => ({
                    ...history,
                    present: selectRegion(history.present, region.letter),
                  }))
                }
                onChange={(event) => {
                  const text = event.currentTarget.value;
                  setNotes((current) => ({ ...current, [region.letter]: text }));
                }}
                onBlur={() => commitNote(region.letter)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
              <small>{shapeCount(region)}</small>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="link-button reference-add"
          onClick={() => setHistory((history) => commit(history, addRegion(history.present)))}
        >
          + 새 영역
        </button>
        <div className="reference-foot">
          <p>
            영역이 없으면 이미지 전체를 영역 A로 봅니다. 영역과 메모는 첨부 원본과 따로 이
            프로젝트에 저장됩니다.
          </p>
          <button
            type="button"
            className="primary-button reference-cta"
            title={CHECK_TITLE}
            disabled={checking}
            onClick={onCheck}
          >
            {checking ? '입력 이미지 만드는 중' : '이해 확인'}
          </button>
          <p>{CHECK_TITLE}. 지금은 AI에 보내지 않고 확인 보드의 틀과 입력 이미지만 만듭니다.</p>
          <p className="reference-status" role="status">
            {status}
          </p>
        </div>
      </aside>
    </div>
  );
}

function draftPath(
  draft: { tool: Tool; points: number[] },
  width: number,
  height: number,
  stroke: number,
) {
  if (draft.tool === 'rect') {
    if (draft.points.length < 4) return null;
    const { d } = shapePath(
      rectShape([draft.points[0], draft.points[1]], [draft.points[2], draft.points[3]]),
      width,
      height,
    );
    return <path className="reference-draft" data-tool="rect" d={d} />;
  }
  if (draft.tool === 'lasso') {
    const { d } = shapePath({ kind: 'brush', width: 0.001, points: draft.points }, width, height);
    return <path className="reference-draft" data-tool="lasso" d={d} />;
  }
  const { d, stroke: px } = shapePath(
    { kind: 'brush', width: stroke, points: draft.points },
    width,
    height,
  );
  return <path className="reference-draft" data-tool={draft.tool} d={d} strokeWidth={px} />;
}

/** The 이해 확인 board, phase (a): its frame only (SPEC-09.5 before 답하는 중). */
function Board({
  name,
  regions,
  image,
  masked,
  onBack,
}: {
  name: string;
  regions: readonly ReferenceRegion[];
  image: { src: string; width: number; height: number };
  masked: string;
  onBack: () => void;
}) {
  const shown = effectiveRegions(regions);
  const figure = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const node = figure.current;
    if (!node) return;
    const measure = () => setScale(node.getBoundingClientRect().width / image.width || 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [image.width]);
  const ratio = `${image.width} / ${image.height}`;
  return (
    <div className="reference-board">
      <section className="reference-pane" aria-label="참고 이미지와 AI가 읽은 것">
        <div className="reference-pane-head">
          <strong>참고 이미지</strong> {name} · 영역 {shown.length}
          {shown[0]?.whole ? ' (전체)' : ''} · AI가 읽은 것
        </div>
        <div ref={figure} className="reference-figure" style={{ aspectRatio: ratio }}>
          <div
            className="reference-figure-layer"
            style={{ width: image.width, height: image.height, transform: `scale(${scale})` }}
          >
            <img src={image.src} alt={`참고 이미지 ${name}`} draggable={false} />
            <RegionOverlay
              regions={regions}
              width={image.width}
              height={image.height}
              scale={scale}
              idPrefix="reference-board"
            />
          </div>
          <span className="reference-waiting" data-state="waiting">
            해석 대기
          </span>
        </div>
        <div className="reference-caption">
          말풍선은 AI 해석이 오면 VIDE가 영역 위에 겹쳐 그립니다(생성 이미지에 글자를 넣지 않음).
          {masked ? ` ${masked}` : ''}
        </div>
      </section>
      <section className="reference-pane" aria-label="우리 건물에 입혀 본 이미지">
        <div className="reference-pane-head">
          <strong>우리 건물에 입혀 본 이미지</strong> 참고용
        </div>
        <div className="reference-figure reference-empty" style={{ aspectRatio: ratio }}>
          <div className="reference-empty-card">
            <strong>아직 없음</strong>
            <small>이미지 생성은 다음 단계에서 연결됩니다</small>
          </div>
        </div>
        <div className="reference-caption">
          입력: 3D 뷰 캡처 + 영역을 그린 참고 이미지 + 해석. 실패해도 [맞음]은 누를 수 있습니다.
        </div>
      </section>
      <table className="reference-values">
        <caption>읽은 값</caption>
        <thead>
          <tr>
            <th>영역</th>
            <th>요소</th>
            <th>읽은 값</th>
            <th>메모</th>
            <th>확인할 것</th>
            <th>적용 대상</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={6} className="reference-values-empty">
              아직 해석이 없습니다
            </td>
          </tr>
        </tbody>
      </table>
      <div className="reference-states" aria-label="보드 상태">
        <span data-on="">해석 대기</span>
        <i>→</i>
        <span>답하는 중</span>
        <i>→</i>
        <span>말풍선 준비</span>
        <i>→</i>
        <span>이미지 생성 중</span>
        <i>→</i>
        <span>이미지 준비 / 실패</span>
        <i>→</i>
        <span>확정</span>
        <button type="button" className="reference-back" onClick={onBack}>
          영역 고치기
        </button>
      </div>
    </div>
  );
}

function ReferenceTab({
  projectId,
  attachmentId,
  name,
}: {
  projectId: string;
  attachmentId: string;
  name: string;
}) {
  const [failed, setFailed] = useState('');
  const [history, setHistoryState] = useState<MaskHistory | undefined>();
  const [stage, setStage] = useState<ReferenceStage>('mask');
  const [image, setImage] = useState<{ src: string; width: number; height: number }>();
  const [status, setStatus] = useState('');
  const [checking, setChecking] = useState(false);
  const [masked, setMasked] = useState('');
  const src = attachmentPreview(projectId, attachmentId);
  const loaded = useRef(false);
  const element = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    let live = true;
    loaded.current = false;
    loadBoard(projectId, attachmentId)
      .then((value) => {
        if (!live) return;
        setStage(value.stage);
        savedRegions.current = value.regions;
        setHistoryState(createHistory(maskState(value)));
        if (value.masked)
          setMasked(`입력 이미지 저장됨 · ${Math.round(value.masked.size / 1024)} KB`);
        renameContextTab(
          attachmentId,
          referenceLabel(value.stage, name),
          referenceTitle(value.stage, name),
          'reference',
        );
        loaded.current = true;
      })
      .catch((error) => live && setFailed(message(error)));
    const picture = new Image();
    picture.onload = () =>
      live && setImage({ src, width: picture.naturalWidth, height: picture.naturalHeight });
    picture.onerror = () => live && setFailed('이미지를 읽지 못했습니다');
    picture.src = src;
    element.current = picture;
    return () => {
      live = false;
    };
  }, [projectId, attachmentId, name, src]);

  // Every change is saved shortly after (the last state wins); leaving the tab saves at once.
  const latest = useRef({ history, stage, image });
  latest.current = { history, stage, image };
  const savedRegions = useRef<readonly ReferenceRegion[] | undefined>(undefined);
  const pending = useRef<number | undefined>(undefined);
  const persist = useCallback(async () => {
    pending.current = undefined;
    const { history: now, stage: shownStage, image: picture } = latest.current;
    if (!loaded.current || !now) return;
    setStatus('저장 중');
    try {
      const value = await api(boardPath(projectId, attachmentId), 'PUT', {
        regions: now.present.regions,
        nextIndex: now.present.nextIndex,
        stage: shownStage,
        ...(picture ? { width: picture.width, height: picture.height } : {}),
      });
      referenceBoardSchema.parse(value);
      setStatus('저장됨');
    } catch (error) {
      setStatus(message(error));
    }
  }, [projectId, attachmentId]);
  const schedule = useCallback(() => {
    if (pending.current !== undefined) clearTimeout(pending.current);
    pending.current = window.setTimeout(() => void persist(), 350);
  }, [persist]);
  const flush = useCallback(async () => {
    if (pending.current === undefined) return;
    clearTimeout(pending.current);
    await persist();
  }, [persist]);
  useEffect(
    () => () => {
      void flush();
    },
    [flush],
  );
  useEffect(() => {
    if (!history || history.present.regions === savedRegions.current) return;
    savedRegions.current = history.present.regions;
    schedule();
  }, [history, schedule]);

  const setHistory = useCallback(
    (update: (history: MaskHistory) => MaskHistory) =>
      setHistoryState((current) => (current ? update(current) : current)),
    [],
  );

  const changeStage = (next: ReferenceStage) => {
    setStage(next);
    latest.current = { ...latest.current, stage: next };
    renameContextTab(
      attachmentId,
      referenceLabel(next, name),
      referenceTitle(next, name),
      'reference',
    );
    schedule();
  };
  const check = async () => {
    if (!history || !image || !element.current) return;
    setChecking(true);
    try {
      await flush();
      const long = Math.max(image.width, image.height);
      const k = Math.min(1, FLAT_LONG_SIDE / long);
      const canvas = document.createElement('canvas');
      drawFlattened(
        canvas,
        element.current,
        history.present.regions,
        Math.max(1, Math.round(image.width * k)),
        Math.max(1, Math.round(image.height * k)),
        // The AI's input image keeps the light accent in both themes.
        { accent: TOKEN_FALLBACK.accent, ink: 'white' },
      );
      const png = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'));
      if (!png) throw Error('PNG');
      await saveMasked(projectId, attachmentId, png);
      setMasked(
        `입력 이미지 저장됨 · ${canvas.width}×${canvas.height} · ${Math.round(png.size / 1024)} KB`,
      );
    } catch {
      setMasked('입력 이미지를 저장하지 못했습니다');
    } finally {
      setChecking(false);
    }
    changeStage('check');
  };

  if (failed)
    return (
      <div className="reference-page">
        <p className="reference-failed" role="alert">
          {failed}
        </p>
      </div>
    );
  if (!history || !image)
    return (
      <div className="reference-page">
        <p className="reference-loading">참고 이미지를 여는 중</p>
      </div>
    );
  return (
    <div className="reference-page" data-stage={stage}>
      <div className="reference-head">
        <h2>{referenceLabel(stage, name)}</h2>
        <span className="reference-meta">
          {stage === 'check'
            ? '해석 대기 · AI 해석은 다음 단계에서 연결됩니다'
            : '첨부 원본은 바꾸지 않음 · 영역은 따로 저장'}
        </span>
      </div>
      {stage === 'check' ? (
        <Board
          name={name}
          regions={history.present.regions}
          image={image}
          masked={masked}
          onBack={() => changeStage('mask')}
        />
      ) : (
        <Editor
          name={name}
          history={history}
          setHistory={setHistory}
          image={image}
          onCheck={() => void check()}
          checking={checking}
          status={status}
        />
      )}
    </div>
  );
}

let root: Root | undefined;
let host: HTMLElement | undefined;
let shown: string | undefined;
/** Show the reference tab's screen in the centre column (called when its tab shows). */
export function showReference(projectId: string, tab: ContextTab) {
  const workspace = document.querySelector<HTMLElement>('.workspace');
  if (!workspace) return;
  if (!root || !host?.isConnected) {
    host = document.createElement('section');
    host.className = 'reference-workspace';
    host.setAttribute('aria-label', '참고 이미지');
    workspace.append(host);
    root = createRoot(host);
  }
  const key = `${projectId}:${tab.instanceId}`;
  if (shown === key) return;
  shown = key;
  root.render(
    <ReferenceTab
      key={key}
      projectId={projectId}
      attachmentId={tab.instanceId}
      name={referenceName(tab)}
    />,
  );
}
// Another tab showing (or this one closing) lets the screen go; its board stays on the engine.
onWorkspaceChange(() => {
  if (!shown) return;
  const attachmentId = shown.slice(shown.indexOf(':') + 1);
  if (activeWorkspace() === referenceTabId(attachmentId)) return;
  shown = undefined;
  root?.render(<></>);
});
