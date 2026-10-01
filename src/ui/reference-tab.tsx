// 참고 이미지 탭 (SPEC-09, PLAN-26 T-090): an image attachment opened from its composer chip
// ([영역 표시]) in the row of open items. Two states of one tab: the region editor ('참고 이미지 ·
// <파일>') — brush, lasso, rectangle and eraser drawing regions A, B, C… with a note each, wheel
// zoom, space/middle-button pan, Ctrl+Z / Ctrl+Shift+Z — and the 이해 확인 board ('이해 확인 ·
// <파일>'): [이해 확인] sends the regions with the reference to the chosen conversation's AI
// (reference-bridge.ts), the board draws its interpretation as bubbles over the reference (VIDE
// draws the words, never the image model), the image job's picture of our building beside it, the
// values table, the board's state, a one-line correction per bubble (that region only, next 판)
// and [맞음 → 모델링 반영] (the confirmed 판 as the next 자동 turn). The engine keeps the board
// (src/server/reference-boards.ts).
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
  UNKNOWN_TARGET,
  effectiveRegions,
  referenceBoardSchema,
  regionBox,
  targetQuestions,
  type InterpretedValue,
  type ReferenceBoard,
  type ReferenceRegion,
  type ReferenceShape,
  type ReferenceStage,
  type ReferenceVersion,
  type RegionInterpretation,
  type ValueSource,
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
import { leaderEnd, placeBubbles, type BubblePlace } from './reference-bubbles.ts';
import { onReferenceBridge, referenceBridge, type ReferenceAi } from './reference-bridge.ts';
import { TOKEN_FALLBACK } from './tokens.ts';
import {
  activeWorkspace,
  onWorkspaceChange,
  referenceTabId,
  renameContextTab,
  type ContextTab,
} from './workspaces.ts';
import { Card as QuestionCard } from './question-card.tsx';
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
const NO_IMAGES = '이 모델은 이미지를 읽지 않습니다';

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
  ai,
}: {
  name: string;
  history: MaskHistory;
  setHistory: (update: (history: MaskHistory) => MaskHistory) => void;
  image: { src: string; width: number; height: number };
  onCheck: () => void;
  checking: boolean;
  status: string;
  ai: ReferenceAi | undefined;
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
            title={ai && !ai.images ? NO_IMAGES : '지금 대화의 AI에 이미지와 영역을 보냅니다'}
            disabled={checking || !ai || !ai.images}
            onClick={onCheck}
          >
            {checking ? '보내는 중' : '이해 확인'}
          </button>
          <p>
            {!ai
              ? '작성기에서 AI 모델을 고르세요.'
              : !ai.images
                ? NO_IMAGES + '. 이미지를 읽는 모델을 고르세요.'
                : `지금 대화 · ${ai.name}에 이미지와 영역 ${effectiveRegions(regions).length}개를 보냅니다. 답이 오면 말풍선으로 보입니다.`}
          </p>
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

/** The words of a board problem or an image job's failure (SPEC-09.4·09.7 5). */
const IMAGE_TEXT: Record<string, string> = {
  CODEX_UNAVAILABLE: 'Codex CLI가 없어 만들지 못했습니다',
  CODEX_LOGIN_REQUIRED: 'Codex에 ChatGPT로 로그인되어 있지 않습니다',
  CODEX_USAGE_LIMIT: 'ChatGPT 요금제 사용 한도에 걸렸습니다',
  IMAGE_REFUSED: '이미지 생성이 거절됐습니다',
  IMAGE_NOT_CREATED: '결과 이미지 파일이 없습니다',
  IMAGE_INTERRUPTED: 'VIDE가 다시 시작돼 생성이 끊겼습니다',
  IMAGE_FAILED: '이미지를 만들지 못했습니다',
};
const BOARD_ERRORS: Record<string, string> = {
  REFERENCE_BUSY: '이 보드의 해석이 아직 진행 중입니다',
  REFERENCE_NOT_READY: '먼저 [이해 확인]으로 해석을 받으세요',
  REFERENCE_FROZEN: '확정한 판은 고칠 수 없습니다. [새 판으로 고치기]를 누르세요',
  REFERENCE_TARGET_UNKNOWN: '적용 대상을 먼저 정하세요',
  REFERENCE_IMAGES_OFF: '이 프로젝트에서 이미지 생성이 꺼져 있습니다',
  REFERENCE_NO_VIEW: '3D 뷰 캡처가 없어 만들 수 없습니다',
  STALE_REFERENCE: '보드가 그 사이 바뀌었습니다. 다시 확인하세요',
};
const boardError = (error: unknown) => {
  const code = (error as { code?: string })?.code ?? (error as Error)?.message;
  return (code && (BOARD_ERRORS[code] || errors[code])) || '보내지 못했습니다';
};
/** The bubble's sentence without the letter and the element its head already shows. */
const bubbleLine = (region: Pick<RegionInterpretation, 'letter' | 'element' | 'line'>) => {
  let line = region.line.trim();
  if (line.startsWith(region.letter))
    line = line.slice(region.letter.length).replace(/^\s*[:·.]\s*/, '');
  if (line.startsWith(region.element))
    line = line.slice(region.element.length).replace(/^\s*[·,:]\s*/, '');
  return line || region.line;
};
const SOURCE: Record<ValueSource, string> = { user: '사용자', estimated: '추정', unknown: '모름' };
const seconds = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}초`;
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const valueText = (value: InterpretedValue) =>
  `${value.name} ${value.value}${value.unit ? ' ' + value.unit : ''}`;
const NOTICE_KEY = 'vide:reference-image-notice';
const noticeSeen = () => {
  try {
    return localStorage.getItem(NOTICE_KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * A JPEG data URL small enough for a stored request (the whole request stays under 200 KB, so an
 * image gets about 140 KB); smaller and softer until it fits.
 */
export async function jpegDataUrl(
  source: CanvasImageSource & { width: number; height: number },
  maxChars = 150_000,
) {
  for (const [side, quality] of [
    [1280, 0.78],
    [1024, 0.72],
    [880, 0.66],
    [720, 0.6],
    [560, 0.55],
  ] as const) {
    const k = Math.min(1, side / Math.max(source.width, source.height, 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.width * k));
    canvas.height = Math.max(1, Math.round(source.height * k));
    const context = canvas.getContext('2d');
    if (!context) break;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', quality);
    if (url.length <= maxChars) return url;
  }
  return undefined;
}
const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((done, fail) => {
    const picture = new Image();
    picture.onload = () => done(picture);
    picture.onerror = () => fail(Error('IMAGE'));
    picture.src = src;
  });

/** The bubbles over the reference (VIDE draws them: never the image model), with leader lines. */
function Bubbles({
  version,
  regions,
  width,
  height,
  editable,
  busyLetter,
  onCorrect,
}: {
  version: ReferenceVersion;
  regions: readonly ReferenceRegion[];
  /** The figure on screen, in pixels. */
  width: number;
  height: number;
  editable: boolean;
  busyLetter?: string;
  onCorrect: (letter: string, note: string) => Promise<void>;
}) {
  const nodes = useRef(new Map<string, HTMLElement>());
  const [places, setPlaces] = useState<BubblePlace[]>([]);
  const [open, setOpen] = useState<string | undefined>();
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const shown = effectiveRegions(regions);
  const anchors = version.regions.map((region) => {
    const drawn = shown.find((entry) => entry.letter === region.letter);
    const box = drawn && !drawn.whole ? regionBox(drawn) : [0.4, 0.4, 0.6, 0.6];
    const x = region.anchor?.x ?? (box[0] + box[2]) / 2;
    const y = region.anchor?.y ?? (box[1] + box[3]) / 2;
    return { letter: region.letter, x: x * width, y: y * height };
  });
  const key = `${version.number}:${Math.round(width)}:${Math.round(height)}:${open ?? ''}`;
  useLayoutEffect(() => {
    if (!width || !height) return;
    const next = placeBubbles(
      anchors.map((anchor) => {
        const node = nodes.current.get(anchor.letter);
        return {
          ...anchor,
          width: node?.offsetWidth ?? 180,
          height: node?.offsetHeight ?? 48,
        };
      }),
      { width, height },
    );
    setPlaces(next);
    // Measured once per 판, size and open bubble.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const send = async (letter: string) => {
    if (!note.trim()) return;
    setSending(true);
    try {
      await onCorrect(letter, note.trim());
      setOpen(undefined);
      setNote('');
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="reference-bubbles">
      <svg className="reference-leaders" width={width} height={height} aria-hidden="true">
        {places.map((place) => {
          const anchor = anchors.find((entry) => entry.letter === place.letter);
          if (!anchor) return null;
          const [x, y] = leaderEnd(place, anchor.x, anchor.y);
          return (
            <g key={place.letter}>
              <line x1={anchor.x} y1={anchor.y} x2={x} y2={y} />
              <circle cx={anchor.x} cy={anchor.y} r={3.5} />
            </g>
          );
        })}
      </svg>
      {version.regions.map((region) => {
        const place = places.find((entry) => entry.letter === region.letter);
        const changed = version.kind !== 'all' && version.changed.includes(region.letter);
        return (
          <div
            key={region.letter}
            ref={(node) => {
              if (node) nodes.current.set(region.letter, node);
              else nodes.current.delete(region.letter);
            }}
            className="reference-bubble"
            data-letter={region.letter}
            data-changed={changed ? '' : undefined}
            data-busy={busyLetter === region.letter ? '' : undefined}
            data-open={open === region.letter ? '' : undefined}
            style={
              place
                ? { left: place.left, top: place.top }
                : { left: 0, top: 0, visibility: 'hidden' }
            }
          >
            <button
              type="button"
              className="reference-bubble-body"
              disabled={!editable}
              aria-label={`영역 ${region.letter} 말풍선 · ${region.line}`}
              title={editable ? `눌러서 영역 ${region.letter}만 고치기` : undefined}
              onClick={() => {
                setOpen(open === region.letter ? undefined : region.letter);
                setNote('');
              }}
            >
              <b>
                <span className="reference-letter">{region.letter}</span>
                {region.element}
              </b>
              <span>{bubbleLine(region)}</span>
              {region.openQuestions.length ? (
                <span className="reference-q">? {region.openQuestions.join(' · ')}</span>
              ) : null}
              {busyLetter === region.letter ? <em>다시 읽는 중</em> : null}
            </button>
            {open === region.letter ? (
              <form
                className="reference-correct"
                onSubmit={(event) => {
                  event.preventDefault();
                  void send(region.letter);
                }}
              >
                <input
                  autoFocus
                  value={note}
                  maxLength={500}
                  placeholder="예: 간격은 450, 깊이는 맞음"
                  aria-label={`영역 ${region.letter} 고칠 내용`}
                  onChange={(event) => setNote(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setOpen(undefined);
                  }}
                />
                <button type="submit" className="primary-button" disabled={sending || !note.trim()}>
                  이 영역만 다시
                </button>
                <button type="button" onClick={() => setOpen(undefined)}>
                  취소
                </button>
              </form>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** The picture of our building with the element on it (SPEC-09.5 오른쪽, 09.7). */
function Generated({
  board,
  base,
  ratio,
  now,
  imagesOn,
  onCancel,
  onRetry,
  onToggle,
}: {
  board: ReferenceBoard;
  base: string;
  ratio: string;
  now: number;
  imagesOn: boolean;
  onCancel: () => void;
  onRetry: (number: number) => void;
  onToggle: (on: boolean) => void;
}) {
  const [notice, setNotice] = useState(!noticeSeen());
  const last = board.versions.at(-1);
  const previous = [...board.versions]
    .reverse()
    .find((version) => version !== last && version.image.state === 'ready');
  const image = last?.image;
  const src = (number: number) => `${base}/images/${number}`;
  let body: ReactNode;
  let caption =
    '입력: 지금 3D 뷰 캡처 + 영역을 그린 참고 이미지 + 해석. 실패해도 [맞음]은 누를 수 있습니다.';
  const retry = last ? (
    <button type="button" onClick={() => onRetry(last.number)}>
      다시 생성
    </button>
  ) : null;
  if (!last || !image)
    body = (
      <div className="reference-empty-card">
        <strong>{board.pending ? '해석을 기다리는 중' : '아직 없음'}</strong>
        <small>말풍선이 나온 뒤 우리 건물에 입혀 본 이미지를 만듭니다</small>
      </div>
    );
  else if (image.state === 'ready')
    body = (
      <a className="reference-gen" href={src(last.number)} target="_blank" rel="noreferrer">
        <img src={src(last.number)} alt={`우리 건물에 입혀 본 이미지 · 판 ${last.number}`} />
      </a>
    );
  else if (image.state === 'running' || image.state === 'waiting') {
    const elapsed = image.startedAt ? now - Date.parse(image.startedAt) : 0;
    body = (
      <div className="reference-gen">
        {previous ? (
          <>
            <img src={src(previous.number)} alt={`이전 해석 · 판 ${previous.number}`} />
            <span className="reference-band">이전 해석 · 판 {previous.number}</span>
          </>
        ) : null}
        <div className="reference-gen-card" role="status">
          <span className="reference-spinner" aria-hidden="true" />
          <strong>
            우리 건물에 입혀 본 이미지 · {image.state === 'running' ? '생성 중' : '생성 대기'}
          </strong>
          {image.state === 'running' ? (
            <small>Codex 이미지 생성 · {clock(elapsed)} · 1분 안에 끝나지 않으면 멈춥니다</small>
          ) : null}
          {image.state === 'running' ? (
            <button type="button" onClick={onCancel}>
              생성 취소
            </button>
          ) : null}
        </div>
      </div>
    );
  } else {
    const text =
      image.state === 'timeout'
        ? '시간 초과 · 이미지 없이 확인'
        : image.state === 'cancelled'
          ? '취소됨'
          : image.state === 'off'
            ? '이미지 생성 꺼짐'
            : image.state === 'no-model'
              ? '연결된 모델이 없어 만들지 않음'
              : image.state === 'remote'
                ? '원격 세션에서는 만들지 않음'
                : (IMAGE_TEXT[image.code ?? ''] ?? IMAGE_TEXT.IMAGE_FAILED);
    body = (
      <div className="reference-empty-card" data-state={image.state}>
        <strong>{text}</strong>
        <small>이미지가 없어도 말풍선 판으로 [맞음]을 누를 수 있습니다</small>
        {image.state === 'remote' ||
        image.state === 'no-model' ||
        (image.state === 'off' && !imagesOn)
          ? null
          : retry}
      </div>
    );
  }
  if (image?.state === 'ready' && image.elapsedMs !== undefined)
    caption = `판 ${last!.number} · 걸린 시간 ${seconds(image.elapsedMs)} · 산출물에 저장됨 · 누르면 크게 봅니다. 참고용 시각화이며 모델링 기준은 확정한 해석입니다.`;
  return (
    <section className="reference-pane" aria-label="우리 건물에 입혀 본 이미지">
      <div className="reference-pane-head">
        <strong>우리 건물에 입혀 본 이미지</strong> 참고용
        <label className="reference-toggle">
          <input
            type="checkbox"
            checked={imagesOn}
            onChange={(event) => onToggle(event.currentTarget.checked)}
          />
          이미지 생성
        </label>
      </div>
      <div
        className={`reference-figure${image?.state === 'ready' ? '' : ' reference-empty'}`}
        style={{ aspectRatio: ratio }}
        data-image={image?.state ?? 'none'}
      >
        {body}
      </div>
      <div className="reference-caption">{caption}</div>
      {notice && imagesOn ? (
        <p className="reference-notice">
          이미지 생성은 ChatGPT 요금제 사용량을 씁니다(Codex · 대화의 AI와 상관없이 OpenAI로 보냄).
          <button
            type="button"
            className="link-button"
            onClick={() => {
              try {
                localStorage.setItem(NOTICE_KEY, '1');
              } catch {
                /* Shown again next time. */
              }
              setNotice(false);
            }}
          >
            알겠음
          </button>
        </p>
      ) : null}
    </section>
  );
}

/** [맞음] asks first where a region applies when the 판 does not say (SPEC-09.8 2). */
function TargetCards({
  questions,
  onAnswer,
  onCancel,
}: {
  questions: ReturnType<typeof targetQuestions>;
  onAnswer: (targets: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [choices, setChoices] = useState<Record<string, { optionId?: string; text?: string }>>({});
  return (
    <div className="qcards reference-targets">
      {questions.map((question, index) => (
        <QuestionCard
          key={question.id}
          question={question}
          index={index}
          count={questions.length}
          choice={choices[question.id] ?? {}}
          choose={(choice) => setChoices((all) => ({ ...all, [question.id]: choice }))}
          disabled={false}
        />
      ))}
      <footer className="qcard-actions">
        <button type="button" className="qcard-secondary" onClick={onCancel}>
          취소
        </button>
        <button
          type="button"
          className="qcard-primary"
          onClick={() =>
            onAnswer(
              Object.fromEntries(
                questions.map((question) => {
                  const choice = choices[question.id] ?? {};
                  const option =
                    question.options.find((o) => o.id === choice.optionId) ??
                    question.options.find((o) => o.recommended)!;
                  return [question.letter, choice.text?.trim() || option.label];
                }),
              ),
            )
          }
        >
          이 답으로 진행
        </button>
      </footer>
    </div>
  );
}

const STATES = [
  '답하는 중',
  '말풍선 준비',
  '이미지 생성 중',
  '이미지 준비 / 실패',
  '확정',
] as const;
function boardState(board: ReferenceBoard): (typeof STATES)[number] | '해석 대기' {
  const last = board.versions.at(-1);
  if (board.pending && board.pending.action !== 'confirm') return '답하는 중';
  if (!last) return '해석 대기';
  if (last.confirmed) return '확정';
  if (last.image.state === 'running') return '이미지 생성 중';
  // No image job for this 판 (off, remote, no model to draw on): the bubbles are what it has.
  if (['waiting', 'off', 'remote', 'no-model'].includes(last.image.state)) return '말풍선 준비';
  return '이미지 준비 / 실패';
}

/**
 * Why the last reference turn left no 판 (SPEC-09.4): a whole check is asked again with [다시
 * 확인]; one region's correction is sent again for that region only; a stopped turn is just
 * stopped (the board is as it was).
 */
function Problem({
  problem,
  disabled,
  onRecheck,
  onRegion,
}: {
  problem: NonNullable<ReferenceBoard['problem']>;
  disabled: boolean;
  onRecheck: () => void;
  onRegion: (letter: string, note: string) => void;
}) {
  const region = problem.action === 'region' && problem.letter ? problem.letter : undefined;
  const stopped = problem.code === 'TURN_CANCELLED';
  const retry =
    region && problem.note ? (
      <button
        type="button"
        className="link-button"
        disabled={disabled}
        onClick={() => onRegion(region, problem.note!)}
      >
        {region}만 다시
      </button>
    ) : region ? null : (
      <button type="button" className="link-button" disabled={disabled} onClick={onRecheck}>
        다시 확인
      </button>
    );
  return (
    <p
      className="reference-problem"
      role={stopped ? 'status' : 'alert'}
      data-kind={stopped ? 'stopped' : 'failed'}
    >
      {stopped
        ? region
          ? `영역 ${region} 고치기를 중단했습니다 · 보드는 그대로입니다.`
          : '해석을 중단했습니다 · 보드는 그대로입니다.'
        : region
          ? `영역 ${region} 고치기에 실패했습니다 · 말 답변만 확인하세요. 다른 말풍선은 그대로입니다.`
          : '말풍선을 만들지 못했습니다 · 말 답변만 확인하세요.'}
      {retry}
    </p>
  );
}

/** The 이해 확인 board (SPEC-09.4·09.5·09.6·09.8). */
function Board({
  projectId,
  attachmentId,
  name,
  board,
  setBoard,
  image,
  masked,
  onBack,
  onRecheck,
}: {
  projectId: string;
  attachmentId: string;
  name: string;
  board: ReferenceBoard;
  setBoard: (board: ReferenceBoard) => void;
  image: { src: string; width: number; height: number };
  masked: string;
  onBack: () => void;
  onRecheck: () => void;
}) {
  const regions = board.regions;
  const shown = effectiveRegions(regions);
  const figure = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [now, setNow] = useState(Date.now());
  const [status, setStatus] = useState('');
  const [asking, setAsking] = useState(false);
  const [sending, setSending] = useState(false);
  const [imagesOn, setImagesOn] = useState(true);
  const base = 'api/v1' + boardPath(projectId, attachmentId);
  useLayoutEffect(() => {
    const node = figure.current;
    if (!node) return;
    const measure = () => {
      const box = node.getBoundingClientRect();
      setSize({ width: box.width, height: box.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [image.width]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let live = true;
    api(`/projects/${encodeURIComponent(projectId)}/reference-settings`)
      .then((value) => live && setImagesOn((value as { images?: boolean }).images !== false))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectId]);
  const scale = size.width / image.width || 1;
  const ratio = `${image.width} / ${image.height}`;
  const last = board.versions.at(-1);
  const state = boardState(board);
  const answering = !!board.pending && board.pending.action !== 'confirm';
  const editable = !!last && !last.confirmed && !answering;
  const confirmRequest = last?.confirmed?.requestId;

  const act = async (work: () => Promise<unknown>) => {
    setStatus('');
    try {
      await work();
    } catch (error) {
      setStatus(boardError(error));
    }
  };
  const correct = async (letter: string, note: string) => {
    const bridge = referenceBridge();
    if (!bridge) return;
    const capture = bridge.capture();
    await act(async () => {
      if (capture) await saveView(projectId, attachmentId, capture);
      const images = await turnImages(projectId, attachmentId);
      await bridge.send({
        reference: { attachmentId, action: 'region', letter, note, view: !!capture },
        images,
        files: [{ id: attachmentId, name }],
      });
      setBoard(await loadBoard(projectId, attachmentId));
    });
  };
  const confirm = async (targets?: Record<string, string>) => {
    const bridge = referenceBridge();
    if (!bridge || !last) return;
    if (!targets && targetQuestions(last).length) {
      setAsking(true);
      return;
    }
    setAsking(false);
    setSending(true);
    await act(async () => {
      // SPEC-09.8 3: the reference with its regions drawn and the last generated image, both
      // small enough that the stored request stays under 200 KB; the original goes as the file.
      const generated =
        last.image.state === 'ready'
          ? await loadImage(`${base}/images/${last.number}`)
              .then((picture) => jpegDataUrl(picture, CONFIRM_IMAGE_CHARS))
              .catch(() => undefined)
          : undefined;
      const images: { kind: 'reference'; name: string; dataUrl: string }[] = await turnImages(
        projectId,
        attachmentId,
        CONFIRM_IMAGE_CHARS,
      ).catch(() => []);
      if (generated)
        images.push({
          kind: 'reference',
          name: `생성 이미지 · 판 ${last.number}`,
          dataUrl: generated,
        });
      await bridge.send({
        reference: {
          attachmentId,
          action: 'confirm',
          version: last.number,
          ...(targets ? { targets } : {}),
        },
        images,
        files: [{ id: attachmentId, name }],
      });
    });
    // Sent or refused (another window confirmed it first): the board shows where it stands.
    await loadBoard(projectId, attachmentId)
      .then(setBoard)
      .catch(() => {});
    setSending(false);
  };
  const post = (path: string, data?: unknown) =>
    act(async () =>
      setBoard(
        referenceBoardSchema.parse(
          await api(boardPath(projectId, attachmentId) + path, 'POST', data),
        ),
      ),
    );
  const questions = last ? targetQuestions(last) : [];

  return (
    <div className="reference-board" data-state={state}>
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
          {last && size.width ? (
            <Bubbles
              version={last}
              regions={regions}
              width={size.width}
              height={size.height}
              editable={editable}
              busyLetter={answering ? board.pending?.letter : undefined}
              onCorrect={correct}
            />
          ) : null}
          {answering && !board.pending?.letter ? (
            <span className="reference-waiting" data-state="answering">
              읽는 중
            </span>
          ) : !last && !answering ? (
            <span className="reference-waiting" data-state={board.problem ? 'problem' : 'waiting'}>
              {board.problem
                ? board.problem.code === 'TURN_CANCELLED'
                  ? '중단됨'
                  : '말풍선을 만들지 못했습니다'
                : '해석 대기'}
            </span>
          ) : null}
        </div>
        {board.problem ? (
          <Problem
            problem={board.problem}
            disabled={answering}
            onRecheck={onRecheck}
            onRegion={(letter, note) => void correct(letter, note)}
          />
        ) : null}
        <div className="reference-caption">
          말풍선 글자는 VIDE가 겹쳐 그립니다(생성 이미지에 글자를 넣지 않음).{' '}
          {editable ? '말풍선을 누르면 그 영역만 다시 해석합니다.' : ''}
          {masked ? ` ${masked}` : ''}
        </div>
      </section>
      <Generated
        board={board}
        base={base}
        ratio={ratio}
        now={now}
        imagesOn={imagesOn}
        onCancel={() => void post('/image/cancel')}
        onRetry={(number) => void post('/image', { version: number })}
        onToggle={(on) =>
          void act(async () => {
            await api(`/projects/${encodeURIComponent(projectId)}/reference-settings`, 'PUT', {
              images: on,
            });
            setImagesOn(on);
            setBoard(await loadBoard(projectId, attachmentId));
          })
        }
      />
      <table className="reference-values">
        <caption>읽은 값{last ? ` · 판 ${last.number} (말풍선과 같은 해석)` : ''}</caption>
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
          {last ? (
            last.regions.map((region) => (
              <tr key={region.letter} data-letter={region.letter}>
                <td>
                  <span className="reference-letter">{region.letter}</span>
                </td>
                <td>{region.element}</td>
                <td>
                  {region.values.length
                    ? region.values.map((value, index) => (
                        <span key={index} className="reference-value">
                          {index ? ' · ' : ''}
                          {valueText(value)}
                          <span className="reference-src" data-src={value.source}>
                            {SOURCE[value.source]}
                          </span>
                        </span>
                      ))
                    : '—'}
                </td>
                <td>{regions.find((entry) => entry.letter === region.letter)?.note || '—'}</td>
                <td>{region.openQuestions.join(' · ') || '—'}</td>
                <td data-unknown={region.target === UNKNOWN_TARGET ? '' : undefined}>
                  {region.target === UNKNOWN_TARGET ? '모름 · [맞음] 때 묻습니다' : region.target}
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={6} className="reference-values-empty">
                {answering ? 'AI가 읽는 중입니다' : '아직 해석이 없습니다'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {last ? (
        <section className="reference-confirm" aria-label="이해 확인">
          <div className="reference-confirm-head">
            이해 확인 · 판 {last.number}
            {last.confirmed ? <span className="reference-chip">확정</span> : null}
          </div>
          <p>{last.summary}</p>
          <ol>
            {last.regions.map((region) => (
              <li key={region.letter}>
                <span className="reference-letter">{region.letter}</span>
                <span>
                  {region.line}
                  {region.target !== UNKNOWN_TARGET ? ` · 적용: ${region.target}` : ''}
                </span>
              </li>
            ))}
          </ol>
          {asking && !last.confirmed ? (
            <TargetCards
              questions={questions}
              onAnswer={(targets) => void confirm(targets)}
              onCancel={() => setAsking(false)}
            />
          ) : last.confirmed ? (
            <div className="reference-actions">
              <button type="button" onClick={() => void post('/continue')}>
                새 판으로 고치기
              </button>
              <small>
                판 {last.number}을 확정해 자동 모드로 보냈습니다
                {confirmRequest ? ` · 요청 ${confirmRequest.slice(0, 8)}` : ''}. 결과와 [되돌리기]는
                오른쪽 AI 열에 있습니다.
              </small>
            </div>
          ) : (
            <div className="reference-actions">
              <button
                type="button"
                className="primary-button"
                disabled={answering || sending}
                onClick={() => void confirm()}
              >
                맞음 → 모델링 반영
              </button>
              <button type="button" onClick={onBack} disabled={sending || answering}>
                다시
              </button>
              <small>
                [맞음]은 이 해석을 같은 대화의 다음 턴으로 자동 모드에 보냅니다 · 열린 문서에 바로
                적용 · 실행마다 되돌리기
              </small>
            </div>
          )}
        </section>
      ) : null}
      <div className="reference-states" aria-label="보드 상태">
        {STATES.map((label, index) => (
          <span key={label} data-on={state === label ? '' : undefined}>
            {index ? <i>→ </i> : null}
            {label}
          </span>
        ))}
        {status ? (
          <span className="reference-status" role="status">
            {status}
          </span>
        ) : null}
        <button
          type="button"
          className="reference-back"
          onClick={onBack}
          disabled={answering}
          title={answering ? '해석이 끝난 뒤 고칠 수 있습니다' : undefined}
        >
          영역 고치기
        </button>
      </div>
    </div>
  );
}

/** A data URL's bytes (the page's CSP does not let fetch read data: URLs). */
const dataUrlBlob = (dataUrl: string) => {
  const comma = dataUrl.indexOf(',');
  const type = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? 'application/octet-stream';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
};
async function saveView(projectId: string, attachmentId: string, dataUrl: string) {
  const response = await fetch('api/v1' + boardPath(projectId, attachmentId) + '/view', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: dataUrlBlob(dataUrl),
  });
  if (!response.ok) throw Error('VIEW_NOT_SAVED');
}
/**
 * The image a reference turn shows the model: the reference with the regions drawn on it (the
 * original goes as the attachment, read with attachment_read for detail).
 */
async function turnImages(projectId: string, attachmentId: string, maxChars?: number) {
  const masked = await loadImage('api/v1' + boardPath(projectId, attachmentId) + '/masked');
  const url = await jpegDataUrl(masked, maxChars);
  return url ? [{ kind: 'reference' as const, name: '영역을 그린 참고 이미지', dataUrl: url }] : [];
}
/** Each of the two images of a [맞음] turn (with the 12 KB text the request stays under 200 KB). */
const CONFIRM_IMAGE_CHARS = 85_000;

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
  const [board, setBoard] = useState<ReferenceBoard>();
  const [ai, setAi] = useState(() => referenceBridge()?.ai());
  const src = attachmentPreview(projectId, attachmentId);
  const loaded = useRef(false);
  const element = useRef<HTMLImageElement | null>(null);

  useEffect(
    () =>
      onReferenceBridge(() =>
        setAi((current) => {
          const next = referenceBridge()?.ai();
          return current?.model === next?.model && current?.images === next?.images
            ? current
            : next;
        }),
      ),
    [],
  );
  useEffect(() => {
    let live = true;
    loaded.current = false;
    loadBoard(projectId, attachmentId)
      .then((value) => {
        if (!live) return;
        setStage(value.stage);
        setBoard(value);
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

  // The board follows its turn and image job: often while something runs, now and then otherwise
  // (a correction said in the chat comes as a new 판).
  const busy = !!board?.pending || board?.versions.at(-1)?.image.state === 'running' || false;
  useEffect(() => {
    if (stage !== 'check') return;
    let live = true;
    const timer = setTimeout(
      () =>
        void loadBoard(projectId, attachmentId)
          .then((value) => live && setBoard(value))
          .catch(() => {}),
      busy ? 1000 : 3000,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [stage, busy, board, projectId, attachmentId]);

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
      setBoard(referenceBoardSchema.parse(value));
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
  /**
   * [이해 확인]: the flattened input image is saved, the 3D view captured for the image job, and
   * the turn goes to the chosen conversation with both images (SPEC-09.3 6, 09.4).
   */
  const check = async () => {
    const bridge = referenceBridge();
    if (!history || !image || !element.current || !bridge) return;
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
      const capture = bridge.capture();
      if (capture) await saveView(projectId, attachmentId, capture);
      const url = await jpegDataUrl(canvas);
      const images = url
        ? [{ kind: 'reference' as const, name: '영역을 그린 참고 이미지', dataUrl: url }]
        : [];
      changeStage('check');
      await bridge.send({
        reference: { attachmentId, action: 'interpret', view: !!capture },
        images,
        files: [{ id: attachmentId, name }],
      });
      setStatus('');
      setBoard(await loadBoard(projectId, attachmentId));
    } catch (error) {
      setStatus(boardError(error));
    } finally {
      setChecking(false);
    }
  };

  if (failed)
    return (
      <div className="reference-page">
        <p className="reference-failed" role="alert">
          {failed}
        </p>
      </div>
    );
  if (!history || !image || !board)
    return (
      <div className="reference-page">
        <p className="reference-loading">참고 이미지를 여는 중</p>
      </div>
    );
  const last = board.versions.at(-1);
  return (
    <div className="reference-page" data-stage={stage}>
      <div className="reference-head">
        <h2>{referenceLabel(stage, name)}</h2>
        {stage === 'check' && last ? (
          <span className="reference-chip">판 {last.number}</span>
        ) : null}
        <span className="reference-meta">
          {stage === 'check'
            ? `${boardState(board)}${ai ? ` · 지금 대화 · ${ai.name}` : ''}`
            : '첨부 원본은 바꾸지 않음 · 영역은 따로 저장'}
        </span>
        {stage === 'check' && status ? (
          <span className="reference-status" role="status">
            {status}
          </span>
        ) : null}
      </div>
      {stage === 'check' ? (
        <Board
          projectId={projectId}
          attachmentId={attachmentId}
          name={name}
          board={{ ...board, regions: history.present.regions }}
          setBoard={setBoard}
          image={image}
          masked={masked}
          onBack={() => changeStage('mask')}
          onRecheck={() => void check()}
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
          ai={ai}
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
