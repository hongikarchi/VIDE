// 도면 반영 jig (SPEC-14.1·14.6·14.7·14.10·14.11, Design SCR-31, PLAN-47 T-234): the built-in
// screen jig over the engine's backflow routes. [모델 변경 반영] picks a linked ZWCAD drawing and
// the Rhino document, takes the position relation from the Sync jig, edits the drawing's layer
// table (T-227), lists the rows (T-232) and applies the chosen ones (T-233): open drawings at once
// (one undo), closed ones as new files after the save card. [도곽 미리보기] is the SCR-30 group as it
// is (one screen, not two). The engine computes and writes; this screen only shows and asks.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './gateway.ts';
import { remoteSession } from './remote-panel.ts';
import { DrawingSheets } from './drawing-sheets.tsx';
import { DIRECT_MAX_DELETES } from '../contracts/host-documents.ts';
import type { JigContext } from './jigs.tsx';
import './drawing-backflow.css';

type Point = [number, number, number];
type Geometry =
  | { kind: 'line'; points: [Point, Point] }
  | { kind: 'polyline'; points: Point[]; bulges?: number[]; closed: boolean }
  | { kind: 'arc'; center: Point; radius: number; start: number; end: number }
  | { kind: 'circle'; center: Point; radius: number }
  | { kind: 'insert'; block: string; position: Point; rotation: number; scale: Point };
type Kind = 'add' | 'modify' | 'delete' | 'conflict' | 'broken' | 'unsupported';
interface Row {
  id: string;
  kind: Kind;
  reason: string | null;
  sourceId: string | null;
  sourceLayer: string | null;
  path: string;
  handle: string | null;
  layer: string | null;
  before: Geometry | null;
  after: Geometry | null;
  selectable: boolean;
  selected: boolean;
  absoluteXref: boolean;
  affectedRoots: string[];
}
interface Diff {
  id: string;
  root: string;
  settled: boolean;
  changed: string[];
  rows: Row[];
  summary: Record<Kind, number> & { unchanged: number; handEdited: number; inSync: number };
}
interface Check {
  ok: boolean;
  differences: number;
  version: { before: string; after: string; same: boolean };
  changed: { modified: number; added: number; deleted: number };
  entities: { handle: string; field: string; before: unknown; after: unknown }[];
  tables: { name: string; before: number; after: number; added: string[]; removed: string[] }[];
  layouts: { before: number; after: number; same: boolean };
  xrefs: { before: number; after: number; same: boolean; changed: string[] };
  unexpected: { counts: { added: number; removed: number; changed: number } };
}
interface Dimension {
  handle: string;
  type: string;
  layer: string;
  entity: string;
  reason: 'NOT_LINKED' | 'NOT_FOLLOWED' | 'ENTITY_DELETED';
}
interface FileResult {
  path: string;
  mode: 'open' | 'closed';
  written: string | null;
  version?: string | null;
  rows: string[];
  check: Check | null;
  dimensions: Dimension[];
  undoId?: string | null;
}
type Answer =
  | { state: 'applied'; id: string; files: FileResult[] }
  | { state: 'confirm'; id: string; files: FileResult[]; expiresAt: string }
  | {
      state: 'failed';
      code: string;
      path: string | null;
      failed: { id: string; code: string }[];
      rolledBack: string[];
      undoFailed: string[];
    }
  | { state: 'unclear'; path: string; applied: string[]; notApplied: string[] };
interface Link {
  id: string;
  host: 'rhino' | 'zwcad';
  name: string;
  path: string | null;
  connection: unknown;
  lastSync: { requestId: string; at: string } | null;
}
interface Summary {
  path: string;
  name: string;
  release: string | null;
  units: number | null;
  unitsAssumed: boolean;
  eligible: boolean;
  reason: string | null;
}
interface LayersState {
  state: 'idle' | 'reading' | 'done' | 'failed';
  error: string | null;
  drawings: Summary[];
}
interface MapEntry {
  source: string;
  layer: string | null;
  how: 'same' | 'user' | 'none';
}
interface SyncRelation {
  rotation: number;
  translation: [number, number];
  dz: number;
  pairs: number;
  residual: { max: number; rms: number };
  ambiguous: boolean;
}
interface SyncAnswer {
  alignment: SyncRelation;
  rows: {
    state: string;
    rhino?: { id: string; nativeId: string };
    cad?: { id: string; nativeId: string };
  }[];
}

const KINDS: Kind[] = ['add', 'modify', 'delete', 'conflict', 'broken', 'unsupported'];
const KIND_TEXT: Record<Kind, string> = {
  add: '추가',
  modify: '수정',
  delete: '삭제',
  conflict: '충돌',
  broken: '끊김',
  unsupported: '지원 안 함',
};
const REASON_TEXT: Record<string, string> = {
  LAYER_NEEDED: '레이어 지정 필요',
  BOTH_CHANGED: '모델과 도면이 둘 다 바뀜',
  NO_BASELINE: '반영 기준 없음 · 도면 값과 다름',
  SOURCE_DELETED_DRAWING_CHANGED: '모델에서 지웠고 도면에서 고침',
  ENTITY_DELETED: '도면에서 지워짐',
  SOURCE_ID_CHANGED: '원천 객체를 다시 만듦(ID 바뀜)',
  SOURCE_TYPE: '반영하지 않는 원천 종류',
  ENTITY_TYPE: '반영하지 않는 도면 개체(문자·치수·해치 등)',
  TYPE_CHANGED: '원천과 도면 개체의 종류가 다름',
  BLOCK_CONTENT: '블록 정의 안 개체',
  DYNAMIC_BLOCK: '동적 블록',
  XREF_INSERT: 'xref 삽입',
  XREF_INSERT_MOVE: 'xref 삽입 이동',
  XREF_MISSING: 'xref 누락',
  XREF_CYCLE: 'xref 순환',
  XREF_OUTSIDE: '폴더 밖 xref',
  XREF_TRANSFORM: 'xref 배치를 풀 수 없음',
  DRAWING_NOT_READ: '도면을 읽지 못함',
  UNITS_NOT_MM: '단위가 mm가 아님',
  LAYER_LOCKED: '잠긴 레이어',
  LAYER_MISSING: '도면에 없는 레이어',
  ENTITY_MISSING: '도면에 개체가 없음',
  INVALID_GEOMETRY: '쓸 수 없는 기하',
  NOT_PLANAR: '평면이 아닌 기하',
  WRITE_FAILED: '쓰지 못함',
};
const ERRORS: Record<string, string> = {
  NO_ZWCAD: '이 PC에 ZWCAD 2023이 없거나 시작하지 못했습니다.',
  NO_PROJECT_FOLDER: '프로젝트 폴더를 먼저 등록하세요.',
  PATH_NOT_IN_PROJECT: '프로젝트 폴더 밖의 도면입니다.',
  DRAWING_NOT_READ: '도면을 아직 읽지 않았습니다. [도면 읽기]를 누르세요.',
  FILE_MISSING: '도면 파일이 없습니다.',
  FILE_CHANGED: '계산 뒤 도면이 바뀌었습니다. 다시 계산하세요.',
  READ_FAILED: '도면을 읽지 못했습니다.',
  UNITS_NOT_MM: '도면 단위가 mm가 아니어서 반영 대상이 아닙니다.',
  SOURCE_NOT_SYNCED: '원천 Rhino 문서의 Sync가 없습니다.',
  SOURCE_CHANGED: '계산 뒤 모델이 바뀌었습니다. 다시 계산하세요.',
  DIFF_NOT_FOUND: '계산 결과가 오래되었습니다. 다시 계산하세요.',
  DIFF_NOT_SETTLED: '계산 중에 도면이 바뀌었습니다. 다시 계산하세요.',
  ROW_NOT_SELECTABLE: '고를 수 없는 행이 있습니다.',
  APPLY_NOT_FOUND: '저장 확인 시간이 지났습니다. 다시 계산하세요.',
  OUTPUT_EXISTS: '같은 이름의 파일이 이미 있습니다. 쓰지 않았습니다.',
  OUTPUT_UNCLEAR:
    '쓴 파일을 확인하지 못했습니다. 그 폴더의 파일 상태를 확인하세요. 다시 쓰지 않습니다.',
  OUTPUT_VERSION_MISMATCH: '쓴 파일의 DWG 버전이 원본과 달라 지웠습니다.',
  ZWCAD_PLUGIN_UPDATE_REQUIRED:
    '연결 플러그인을 새 판으로 바꾼 뒤 열린 도면에 반영할 수 있습니다. 도면을 닫으면 새 파일로 반영합니다.',
  ZWCAD_ATTACHED_EDIT_UNAVAILABLE: '열린 도면에 쓸 수 없습니다. ZWCAD 연결을 확인하세요.',
  HIDDEN_HOST_TIMEOUT: '숨은 ZWCAD가 제때 답하지 않아 껐습니다.',
  HIDDEN_HOST_STALLED: '숨은 ZWCAD가 멈춰 껐습니다.',
  HIDDEN_HOST_EXITED: '숨은 ZWCAD가 중간에 끝났습니다.',
  PROJECT_BUSY: '이 프로젝트의 다른 도면 작업이 끝난 뒤 다시 누르세요.',
  FORBIDDEN: '반영과 저장은 작업 PC 화면에서 합니다.',
  OP_REFUSED: '도면이 일부 행을 거절해 아무것도 바꾸지 않았습니다.',
  LAYER_NOT_IN_DRAWING: '그 도면에 없는 레이어입니다.',
  REVISION_CONFLICT: '다른 화면이 표를 먼저 고쳤습니다. 다시 여세요.',
  STALE_REFERENCE: 'Sync 기록을 찾지 못했습니다. 다시 Sync하세요.',
  TARGET_MISMATCH: 'Rhino와 ZWCAD Sync를 맞게 골랐는지 확인하세요.',
  NOTHING_TO_APPLY: '반영할 행이 없습니다.',
};
const QUIET = Object.keys(ERRORS);
const errorText = (error: unknown) => {
  const code = (error as { code?: string })?.code;
  return (code && ERRORS[code]) || (error instanceof Error && error.message) || '실패했습니다.';
};
const DIMENSION_TEXT: Record<Dimension['reason'], string> = {
  NOT_LINKED: '연동 안 됨',
  NOT_FOLLOWED: '따라가지 않음',
  ENTITY_DELETED: '개체 삭제',
};
const SHAPE: Record<Geometry['kind'], string> = {
  line: '선',
  polyline: '폴리선',
  arc: '호',
  circle: '원',
  insert: '블록 삽입',
};
const nameOf = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
/** DWG versions as their release years (src/core/drawing-output.ts DWG_VERSIONS). */
const RELEASES: Record<string, string> = {
  AC1015: '2000',
  AC1018: '2004',
  AC1021: '2007',
  AC1024: '2010',
  AC1027: '2013',
  AC1032: '2018',
};
const release = (version?: string | null) => (version ? (RELEASES[version] ?? version) : '?');
const sameKey = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const mm = (value: number) => `${Math.round(value * 10) / 10}`;
const deg = (radians: number) => Math.round(((radians * 180) / Math.PI) * 1000) / 1000;
const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** One line of what a row changes, in drawing units (mm). */
export function changeText(row: Pick<Row, 'kind' | 'before' | 'after'>): string {
  const { before, after } = row;
  if (row.kind === 'add' && after) {
    if (after.kind === 'arc' || after.kind === 'circle')
      return `새 ${SHAPE[after.kind]} R${mm(after.radius)}`;
    if (after.kind === 'line') return `새 선 ${mm(dist(after.points[0], after.points[1]))} mm`;
    return `새 ${SHAPE[after.kind]}`;
  }
  if (row.kind === 'delete' && before) return `${SHAPE[before.kind]} 지움`;
  if (!before || !after || before.kind !== after.kind)
    return before ? SHAPE[before.kind] : after ? SHAPE[after.kind] : '—';
  const parts: string[] = [];
  if (before.kind === 'line' || before.kind === 'polyline') {
    const b = before.points,
      a = (after as typeof before).points;
    if (a.length !== b.length) parts.push(`정점 ${b.length} → ${a.length}`);
    else {
      const moved = Math.max(0, ...b.map((p, i) => dist(p, a[i])));
      parts.push(`${before.kind === 'line' ? '끝점' : '정점'} 이동 최대 ${mm(moved)} mm`);
    }
  } else if (before.kind === 'arc' || before.kind === 'circle') {
    const a = after as typeof before;
    const moved = dist(before.center, a.center);
    if (moved > 1e-6) parts.push(`중심 이동 ${mm(moved)} mm`);
    if (Math.abs(before.radius - a.radius) > 1e-6)
      parts.push(`반지름 ${mm(before.radius)} → ${mm(a.radius)} mm`);
    if (
      before.kind === 'arc' &&
      a.kind === 'arc' &&
      (Math.abs(before.start - a.start) > 1e-9 || Math.abs(before.end - a.end) > 1e-9)
    )
      parts.push(
        `각도 ${deg(before.start)}°~${deg(before.end)}° → ${deg(a.start)}°~${deg(a.end)}°`,
      );
  } else if (before.kind === 'insert') {
    const a = after as typeof before;
    const moved = dist(before.position, a.position);
    if (moved > 1e-6) parts.push(`삽입 위치 이동 ${mm(moved)} mm`);
    if (Math.abs(before.rotation - a.rotation) > 1e-9)
      parts.push(`회전 ${deg(a.rotation - before.rotation)}°`);
  }
  return `${SHAPE[before.kind]} ${parts.join(' · ') || '값 변경'}`;
}

/** Points along a geometry for the before/after picture (arcs sampled). */
function trace(g: Geometry): Point[][] {
  const arc = (c: Point, r: number, s: number, e: number) => {
    let end = e;
    while (end <= s) end += Math.PI * 2;
    const n = Math.max(8, Math.ceil(((end - s) / (Math.PI * 2)) * 48));
    return Array.from({ length: n + 1 }, (_, i): Point => {
      const t = s + ((end - s) * i) / n;
      return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t), 0];
    });
  };
  if (g.kind === 'line') return [g.points];
  if (g.kind === 'circle') return [arc(g.center, g.radius, 0, Math.PI * 2)];
  if (g.kind === 'arc') return [arc(g.center, g.radius, g.start, g.end)];
  if (g.kind === 'insert') {
    const [x, y] = g.position;
    const k = 200;
    const r = g.rotation;
    return [
      [
        [x - k, y, 0],
        [x + k, y, 0],
      ],
      [
        [x, y - k, 0],
        [x, y + k, 0],
      ],
      [
        [x, y, 0],
        [x + 2 * k * Math.cos(r), y + 2 * k * Math.sin(r), 0],
      ],
    ];
  }
  const out: Point[] = [];
  const pts = g.closed ? [...g.points, g.points[0]] : g.points;
  for (let i = 0; i < pts.length - 1; i++) {
    const bulge = g.bulges?.[i] ?? 0;
    const p = pts[i],
      q = pts[i + 1];
    if (Math.abs(bulge) < 1e-9) {
      if (!out.length) out.push(p);
      out.push(q);
      continue;
    }
    // A bulge segment: the arc through p and q with included angle 4·atan(bulge).
    const angle = 4 * Math.atan(bulge);
    const chord = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const radius = chord / (2 * Math.sin(Math.abs(angle) / 2));
    const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const h = Math.sqrt(Math.max(0, radius * radius - (chord / 2) ** 2)) * Math.sign(bulge);
    const nx = -(q[1] - p[1]) / chord,
      ny = (q[0] - p[0]) / chord;
    const sign = Math.abs(angle) > Math.PI ? -1 : 1;
    const c: Point = [mid[0] + nx * h * sign, mid[1] + ny * h * sign, 0];
    const s = Math.atan2(p[1] - c[1], p[0] - c[0]);
    const n = 16;
    if (!out.length) out.push(p);
    for (let j = 1; j <= n; j++) {
      const t = s + (angle * j) / n;
      out.push([c[0] + radius * Math.cos(t), c[1] + radius * Math.sin(t), 0]);
    }
  }
  return [out];
}

/** 전·후 겹쳐 보기: before dashed and grey, after solid in the accent colour (drawing units). */
function Overlay({ row }: { row: Row }) {
  const before = row.before ? trace(row.before) : [];
  const after = row.after ? trace(row.after) : [];
  const all = [...before, ...after].flat();
  if (!all.length) return null;
  const xs = all.map((p) => p[0]),
    ys = all.map((p) => p[1]);
  const x0 = Math.min(...xs),
    x1 = Math.max(...xs),
    y0 = Math.min(...ys),
    y1 = Math.max(...ys);
  const span = Math.max(x1 - x0, y1 - y0, 1);
  const pad = span * 0.08;
  const W = 240,
    H = 160;
  const k = Math.min((W - 16) / (x1 - x0 + 2 * pad || 1), (H - 24) / (y1 - y0 + 2 * pad || 1));
  const map = (p: Point) =>
    `${(8 + (p[0] - x0 + pad) * k).toFixed(1)},${(H - 16 - (p[1] - y0 + pad) * k).toFixed(1)}`;
  const path = (lines: Point[][]) => lines.map((l) => 'M' + l.map(map).join('L')).join('');
  // A round scale bar about a quarter of the picture.
  const raw = (W / 4 / k) * 1;
  const step = 10 ** Math.floor(Math.log10(raw));
  const bar =
    [1, 2, 5, 10]
      .map((m) => m * step)
      .filter((v) => v <= raw)
      .at(-1) ?? step;
  return (
    <figure className="bf-overlay" aria-label="전·후 겹쳐 보기">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img">
        {before.length ? <path className="bf-before" d={path(before)} /> : null}
        {after.length ? <path className="bf-after" d={path(after)} /> : null}
        <path className="bf-scale" d={`M8,${H - 6}h${(bar * k).toFixed(1)}`} />
        <text x={12 + bar * k} y={H - 3}>
          {mm(bar)} mm
        </text>
      </svg>
      <figcaption>
        <span className="bf-key" data-key="before">
          반영 전
        </span>
        <span className="bf-key" data-key="after">
          반영 후
        </span>
        <code>
          {JSON.stringify({ before: row.before, after: row.after }, (_, v) =>
            typeof v === 'number' ? Math.round(v * 1000) / 1000 : v,
          )}
        </code>
      </figcaption>
    </figure>
  );
}

/** 형식 보존 확인 and 치수 확인 필요 of one file (SPEC-14.6, SPEC-14.8 4). */
const TABLE_TEXT: Record<string, string> = {
  layers: '레이어',
  linetypes: '선종류',
  textStyles: '문자 스타일',
  dimStyles: '치수 스타일',
  regApps: '응용 프로그램 이름',
  blocks: '블록 정의',
};
function FileReport({ file }: { file: FileResult }) {
  const check = file.check;
  const issues: string[] = [];
  if (check) {
    if (!check.version.same)
      issues.push(`DWG 버전 ${release(check.version.before)} → ${release(check.version.after)}`);
    // A count alone is no difference: the origin marks' application name is expected (SPEC-14.6).
    for (const t of check.tables)
      if (t.added.length || t.removed.length)
        issues.push(
          `${TABLE_TEXT[t.name] ?? t.name} ${t.before} → ${t.after}${t.added.length ? ` (+${t.added.join(', ')})` : ''}${t.removed.length ? ` (−${t.removed.join(', ')})` : ''}`,
        );
    if (!check.layouts.same)
      issues.push(`레이아웃 ${check.layouts.before} → ${check.layouts.after}`);
    if (!check.xrefs.same)
      issues.push(
        `xref ${check.xrefs.before} → ${check.xrefs.after} ${check.xrefs.changed.join(', ')}`,
      );
    const u = check.unexpected.counts;
    if (u.added || u.removed || u.changed)
      issues.push(`예상 밖 개체 추가 ${u.added} · 삭제 ${u.removed} · 변경 ${u.changed}`);
  }
  return (
    <section className="bf-file" aria-label={`${nameOf(file.path)} 결과`}>
      <header>
        <strong className="bf-mono">{nameOf(file.path)}</strong>
        {file.mode === 'open' ? (
          <span className="bf-faint">열린 도면 · 저장 안 됨 · 저장은 ZWCAD에서</span>
        ) : (
          <span className="bf-mono bf-faint" title={file.written ?? undefined}>
            → {file.written}
          </span>
        )}
      </header>
      {check ? (
        <div className="bf-check" aria-label="형식 보존 확인">
          <p>
            바뀐 개체 수정 {check.changed.modified} · 추가 {check.changed.added} · 삭제{' '}
            {check.changed.deleted} · DWG 버전 {release(check.version.before)} →{' '}
            {release(check.version.after)} {check.version.same ? '같음' : '다름'}
          </p>
          {check.ok && !check.entities.length && !issues.length ? (
            <p className="bf-ok">형식 보존 확인 — 차이 없음</p>
          ) : (
            <ul className="bf-issues">
              {issues.map((text) => (
                <li key={text}>{text}</li>
              ))}
              {check.entities.map((e) => (
                <li key={e.handle + e.field}>
                  <span className="bf-mono">{e.handle}</span> {e.field} {String(e.before)} →{' '}
                  {String(e.after)}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="bf-faint">저장할 때 바로 고칩니다.</p>
      )}
      {file.dimensions.length ? (
        <details className="bf-dims">
          <summary>치수 확인 필요 {file.dimensions.length}</summary>
          <ul>
            {file.dimensions.map((d) => (
              <li key={d.handle}>
                <span className="bf-mono">{d.handle}</span> {d.type} · {d.layer} ·{' '}
                {DIMENSION_TEXT[d.reason]} · 잰 개체 <span className="bf-mono">{d.entity}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function BackflowPanel({ context, openSync }: { context: JigContext; openSync: () => void }) {
  const projectId = context.projectId;
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const remote = remoteSession();
  const [links, setLinks] = useState<Link[]>([]);
  const [layers, setLayers] = useState<LayersState>();
  const [root, setRoot] = useState('');
  const [rhino, setRhino] = useState('');
  const [sync, setSync] = useState<SyncAnswer | null>(null);
  const [syncNote, setSyncNote] = useState('');
  const [baseline, setBaseline] = useState<{ pairs: number; updatedAt: string } | null>(null);
  const [table, setTable] = useState<{ layers: string[]; entries: MapEntry[]; revision: number }>();
  const [edits, setEdits] = useState<Record<string, string | null>>({});
  const [diff, setDiff] = useState<Diff | null>(null);
  const [filter, setFilter] = useState<Kind | 'all'>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [cover, setCover] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [askDeletes, setAskDeletes] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [undone, setUndone] = useState('');
  const reading = useRef(false);

  const drawings = links.filter((l) => l.host === 'zwcad' && l.path && /\.dwg$/i.test(l.path));
  const sources = links.filter((l) => l.host === 'rhino' && l.lastSync);
  const cadLink = drawings.find((l) => l.path === root);
  const rhinoLink = sources.find((l) => l.id === rhino);
  const summary = layers?.drawings.find((d) => sameKey(d.path, root));

  const loadLayers = useCallback(
    async () =>
      setLayers(
        (await api(`${base}/drawing/layers`, 'GET', undefined, { quiet: QUIET })) as LayersState,
      ),
    [base],
  );
  useEffect(() => {
    void (async () => {
      try {
        const list = (await api(`${base}/links`)) as Link[];
        setLinks(list);
        const first = list.find((l) => l.host === 'zwcad' && l.path && /\.dwg$/i.test(l.path));
        setRoot((r) => r || first?.path || '');
        setRhino((r) => r || list.filter((l) => l.host === 'rhino' && l.lastSync).at(-1)?.id || '');
        await loadLayers();
      } catch (error) {
        setNotice(errorText(error));
      }
    })();
  }, [base, loadLayers]);

  // The relation (Sync jig) and the baseline of the drawing chosen.
  useEffect(() => {
    setSync(null);
    setSyncNote('');
    setDiff(null);
    setAnswer(null);
    setBaseline(null);
    let live = true;
    const stop = () => {
      live = false;
    };
    if (!root) return stop;
    void api(`${base}/drawing/backflow?path=${encodeURIComponent(root)}`, 'GET', undefined, {
      quiet: QUIET,
    })
      .then((value) => live && setBaseline((value as { baseline: typeof baseline }).baseline))
      .catch(() => {});
    if (!cadLink?.lastSync) {
      setSyncNote('no-cad');
      return stop;
    }
    if (!rhinoLink?.lastSync) return stop;
    void api(
      `${base}/jigs/sync`,
      'POST',
      { rhino: rhinoLink.lastSync.requestId, cad: cadLink.lastSync.requestId },
      { quiet: QUIET },
    )
      .then((value) => live && setSync(value as SyncAnswer))
      .catch((error) => live && setSyncNote(errorText(error)));
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, root, rhino, cadLink?.lastSync?.requestId, rhinoLink?.lastSync?.requestId]);

  // The drawing's layer table (T-227) once it is read.
  const loadTable = useCallback(async () => {
    if (!root || !summary?.eligible) return setTable(undefined);
    try {
      const value = (await api(
        `${base}/drawing/layers?path=${encodeURIComponent(root)}`,
        'GET',
        undefined,
        { quiet: QUIET },
      )) as {
        read: { layers: { name: string; dependent?: boolean }[] };
        map: { entries: MapEntry[]; revision: number } | null;
      };
      setTable({
        layers: value.read.layers.filter((l) => !l.dependent).map((l) => l.name),
        entries: value.map?.entries ?? [],
        revision: value.map?.revision ?? 0,
      });
      setEdits({});
    } catch (error) {
      setNotice(errorText(error));
    }
  }, [base, root, summary?.eligible]);
  useEffect(() => {
    void loadTable();
  }, [loadTable]);

  const readDrawing = async () => {
    setBusy('read');
    setNotice('');
    try {
      await api(`${base}/drawing/layers/read`, 'POST', { paths: [root] }, { quiet: QUIET });
      reading.current = true;
      for (let i = 0; i < 600 && reading.current; i++) {
        const state = (await api(`${base}/drawing/layers`)) as LayersState;
        setLayers(state);
        if (state.state !== 'reading') break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      reading.current = false;
      setBusy('');
    }
  };
  useEffect(
    () => () => {
      reading.current = false;
    },
    [],
  );

  const pairs = useMemo(
    () =>
      (sync?.rows ?? [])
        .filter((r) => r.state === 'match' && r.rhino && r.cad)
        .slice(0, 20000)
        .map((r) => ({
          sourceId: r.rhino!.nativeId || r.rhino!.id,
          path: root,
          handle: String(r.cad!.nativeId || r.cad!.id).toUpperCase(),
        }))
        .filter((p) => /^[0-9a-f]{1,16}$/i.test(p.handle)),
    [sync, root],
  );
  const relation = sync && {
    rotation: sync.alignment.rotation,
    translation: sync.alignment.translation,
    dz: sync.alignment.dz,
  };

  const compute = async () => {
    if (!relation || !rhinoLink) return;
    setBusy('diff');
    setNotice('');
    setAnswer(null);
    setUndone('');
    setAskDeletes(false);
    try {
      const value = (await api(
        `${base}/drawing/backflow`,
        'POST',
        { root, link: rhinoLink.id, relation, ...(pairs.length ? { pairs } : {}) },
        { quiet: QUIET },
      )) as Diff;
      setDiff(value);
      setPicked(new Set(value.rows.filter((r) => r.selected && r.selectable).map((r) => r.id)));
      setCover(new Set());
      setFocus(null);
      // Rows waiting for a layer put their source layers in the table.
      const needed = value.rows.filter((r) => r.reason === 'LAYER_NEEDED' && r.sourceLayer);
      if (needed.length) await loadTable();
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy('');
    }
  };
  const recordPairs = async () => {
    if (!rhinoLink || !pairs.length) return;
    setBusy('pairs');
    try {
      await api(
        `${base}/drawing/backflow/pairs`,
        'POST',
        { root, link: rhinoLink.id, pairs },
        {
          quiet: QUIET,
        },
      );
      const value = (await api(`${base}/drawing/backflow?path=${encodeURIComponent(root)}`)) as {
        baseline: typeof baseline;
      };
      setBaseline(value.baseline);
      setNotice(`Sync 일치 ${pairs.length}행을 반영 기준으로 기록했습니다.`);
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy('');
    }
  };

  // The table's sources: its own plus the source layers of rows that wait for a layer.
  const tableSources = useMemo(() => {
    const out = new Map<string, MapEntry>();
    for (const e of table?.entries ?? []) out.set(e.source, e);
    for (const r of diff?.rows ?? [])
      if (r.reason === 'LAYER_NEEDED' && r.sourceLayer && !out.has(r.sourceLayer))
        out.set(r.sourceLayer, { source: r.sourceLayer, layer: null, how: 'none' });
    return [...out.values()];
  }, [table, diff]);
  const unmapped = tableSources.filter((e) =>
    Object.hasOwn(edits, e.source) ? edits[e.source] === null : e.layer === null,
  ).length;
  const saveTable = async () => {
    if (!table) return;
    setBusy('table');
    setNotice('');
    try {
      const chosen: Record<string, string | null> = {};
      for (const e of table.entries) if (e.how === 'user') chosen[e.source] = e.layer;
      Object.assign(chosen, edits);
      await api(
        `${base}/drawing/layers`,
        'PUT',
        {
          path: root,
          sources: tableSources.map((e) => e.source),
          chosen,
          revision: table.revision,
        },
        { quiet: QUIET },
      );
      await loadTable();
      setBusy('');
      if (diff) await compute();
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy('');
    }
  };

  const rows = diff?.rows ?? [];
  const shown = filter === 'all' ? rows : rows.filter((r) => r.kind === filter);
  const chosenRows = rows.filter((r) => picked.has(r.id) || cover.has(r.id));
  const deletes = chosenRows.filter((r) => r.kind === 'delete').length;
  const files = new Set(chosenRows.map((r) => r.path.toLowerCase()));
  const coverable = (r: Row) =>
    r.kind === 'conflict' &&
    (r.reason === 'BOTH_CHANGED' || r.reason === 'NO_BASELINE') &&
    !!r.after &&
    !!r.handle;
  const toggle = (id: string) =>
    setPicked((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const apply = async (confirmDeletes = false) => {
    if (!diff || !chosenRows.length) return;
    if (deletes > DIRECT_MAX_DELETES && !confirmDeletes) {
      setAskDeletes(true);
      return;
    }
    setBusy('apply');
    setNotice('');
    setAskDeletes(false);
    setUndone('');
    try {
      const value = (await api(
        `${base}/drawing/backflow/apply`,
        'POST',
        {
          diff: diff.id,
          rows: [...picked].filter((id) => rows.some((r) => r.id === id && r.selectable)),
          ...(cover.size ? { cover: [...cover] } : {}),
          ...(confirmDeletes ? { confirmDeletes: true } : {}),
        },
        { quiet: [...QUIET, 'DELETE_CONFIRMATION_REQUIRED'] },
      )) as Answer;
      setAnswer(value);
    } catch (error) {
      if ((error as { code?: string }).code === 'DELETE_CONFIRMATION_REQUIRED') setAskDeletes(true);
      else setNotice(errorText(error));
    } finally {
      setBusy('');
    }
  };
  const step = async (action: 'confirm' | 'cancel') => {
    if (answer?.state !== 'confirm') return;
    setBusy(action);
    setNotice('');
    try {
      const value = await api(
        `${base}/drawing/backflow/apply/${answer.id}/${action}`,
        'POST',
        {},
        { quiet: QUIET },
      );
      if (action === 'cancel') {
        setAnswer(null);
        setNotice('저장하지 않았습니다. 쓴 파일이 없습니다.');
      } else setAnswer(value as Answer);
    } catch (error) {
      setNotice(errorText(error));
      if (action === 'confirm') setAnswer(null);
    } finally {
      setBusy('');
    }
  };
  const undo = async () => {
    if (answer?.state !== 'applied') return;
    setBusy('undo');
    try {
      const value = (await api(
        `${base}/drawing/backflow/apply/${answer.id}/undo`,
        'POST',
        {},
        { quiet: QUIET },
      )) as { files: { path: string; undone: boolean; reason: string | null }[] };
      const open = value.files.filter((f) => f.reason !== 'closed');
      setUndone(
        open.every((f) => f.undone)
          ? '되돌렸습니다.'
          : '되돌리지 못했습니다. 그 뒤에 도면이 바뀌었으면 ZWCAD에서 Ctrl+Z로 되돌리세요.',
      );
    } catch (error) {
      setUndone(errorText(error));
    } finally {
      setBusy('');
    }
  };

  const a = sync?.alignment;
  const focused = rows.find((r) => r.id === focus) ?? null;
  return (
    <div className="bf-panel">
      <section className="bf-target" aria-label="대상">
        <p className="bf-faint">
          모델 변경을 기존 CAD 도면에 형식 그대로 반영합니다. 열린 도면은 바로 고치고(되돌리기 한
          번), 닫힌 도면은 같은 폴더에 새 파일로 씁니다.
        </p>
        <label className="bf-field">
          <span>대상 도면</span>
          <select
            aria-label="대상 도면"
            value={root}
            disabled={!!busy}
            onChange={(e) => setRoot(e.target.value)}
          >
            {drawings.length ? null : <option value="">ZWCAD 연결 도면이 없습니다</option>}
            {drawings.map((d) => (
              <option key={d.id} value={d.path!} title={d.path!}>
                {d.name}
                {d.connection ? ' · 열림' : ''}
              </option>
            ))}
          </select>
          {root ? (
            summary && summary.eligible && !summary.reason ? (
              <span className="bf-faint bf-nowrap">
                DWG {summary.release ?? '?'} · mm
                {summary.unitsAssumed ? '(단위 없음, mm로 봄)' : ''}
              </span>
            ) : remote ? null : (
              <button type="button" disabled={!!busy} onClick={() => void readDrawing()}>
                {busy === 'read' ? '읽는 중…' : '도면 읽기'}
              </button>
            )
          ) : null}
        </label>
        {summary?.reason && summary.reason !== 'FILE_CHANGED' ? (
          <p className="bf-warn" role="alert">
            {ERRORS[summary.reason] ?? summary.reason}
          </p>
        ) : summary?.reason === 'FILE_CHANGED' ? (
          <p className="bf-faint">읽은 뒤 도면이 바뀌었습니다. [도면 읽기]로 다시 읽으세요.</p>
        ) : null}
        <label className="bf-field">
          <span>원천 Rhino 문서</span>
          <select
            aria-label="원천 Rhino 문서"
            value={rhino}
            disabled={!!busy}
            onChange={(e) => setRhino(e.target.value)}
          >
            {sources.length ? null : <option value="">Sync한 Rhino 문서가 없습니다</option>}
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {syncNote === 'no-cad' ? (
          <p className="bf-warn">
            이 도면의 ZWCAD Sync가 없습니다. ZWCAD에서 도면을 연결해 Sync하세요.{' '}
            <button type="button" className="link-button" onClick={openSync}>
              Sync jig 열기
            </button>
          </p>
        ) : syncNote ? (
          <p className="bf-warn">{syncNote}</p>
        ) : a ? (
          <p className="bf-relation" aria-label="위치 관계">
            위치 관계 · 회전 {deg(a.rotation).toFixed(3)}° · 이동 ({mm(a.translation[0] * 1000)},{' '}
            {mm(a.translation[1] * 1000)}) mm · 짝 {a.pairs} · 오차 최대 {mm(a.residual.max * 1000)}{' '}
            mm
            {a.ambiguous ? (
              <span className="bf-warn"> · 후보가 여럿 — Sync jig에서 확정하세요</span>
            ) : null}
          </p>
        ) : root && rhino ? (
          <p className="bf-faint">위치 관계 계산 중…</p>
        ) : null}
        <div className="bf-line">
          <span className="bf-faint">
            {baseline
              ? `반영 기준 ${baseline.pairs}짝 · ${baseline.updatedAt.slice(0, 16).replace('T', ' ')}`
              : `반영 기준 없음 — Sync 일치 ${pairs.length}행을 짝으로 씁니다`}
          </span>
          {remote ? null : (
            <button
              type="button"
              className="link-button"
              disabled={!!busy || !pairs.length || !summary?.eligible}
              onClick={() => void recordPairs()}
            >
              짝 기록
            </button>
          )}
          <span className="bf-spacer" />
          {remote ? (
            <span className="bf-faint">반영과 저장은 작업 PC 화면에서 합니다.</span>
          ) : (
            <button
              type="button"
              className="bf-primary"
              disabled={!!busy || !relation || !rhinoLink || !summary?.eligible}
              onClick={() => void compute()}
            >
              {busy === 'diff' ? '계산 중…' : '차이 계산'}
            </button>
          )}
        </div>
      </section>

      {notice ? (
        <p className="bf-notice" role="status">
          {notice}
        </p>
      ) : null}

      {table && (tableSources.length || diff) ? (
        <details
          className="bf-layers"
          open={rows.some((r) => r.reason === 'LAYER_NEEDED') || undefined}
        >
          <summary>
            레이어 대응 {tableSources.length} · 지정 필요 {unmapped}
          </summary>
          {tableSources.length ? (
            <ul aria-label="레이어 대응">
              {tableSources.map((e) => {
                const value = Object.hasOwn(edits, e.source) ? edits[e.source] : e.layer;
                return (
                  <li key={e.source}>
                    <span className="bf-mono" title={e.source}>
                      {e.source}
                    </span>
                    <span aria-hidden="true">→</span>
                    <select
                      aria-label={`${e.source} 도면 레이어`}
                      value={value ?? ''}
                      disabled={!!busy}
                      onChange={(ev) =>
                        setEdits((now) => ({ ...now, [e.source]: ev.target.value || null }))
                      }
                    >
                      <option value="">레이어 지정 필요</option>
                      {table.layers.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                    {e.how === 'same' && !Object.hasOwn(edits, e.source) ? (
                      <span className="bf-faint">같은 이름</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="bf-faint">대응할 원천 레이어가 아직 없습니다.</p>
          )}
          <button
            type="button"
            disabled={!!busy || !tableSources.length}
            onClick={() => void saveTable()}
          >
            표 저장
          </button>
        </details>
      ) : null}

      {diff ? (
        <section className="bf-diff" aria-label="변경 행">
          <div className="bf-chips" role="group" aria-label="종류">
            <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
              전체 {rows.length}
            </button>
            {KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={filter === kind}
                data-empty={!diff.summary[kind] || undefined}
                onClick={() => setFilter(kind)}
              >
                {KIND_TEXT[kind]} {diff.summary[kind] ?? 0}
              </button>
            ))}
            <span className="bf-faint bf-tally">
              변경 없음 {diff.summary.unchanged} · 이미 같음 {diff.summary.inSync} · 도면에서만 고침{' '}
              {diff.summary.handEdited}
            </span>
          </div>
          {!diff.settled ? (
            <p className="bf-warn" role="alert">
              계산 중에 도면이 바뀌었습니다. 다시 계산하세요.{' '}
              <button type="button" className="link-button" onClick={() => void compute()}>
                다시 계산
              </button>
            </p>
          ) : null}
          {rows.length ? null : <p className="bf-empty">반영할 변경이 없습니다.</p>}
          <ul className="bf-rows" aria-label="행 목록">
            {shown.map((row) => {
              const covered = cover.has(row.id);
              const locked = !row.selectable && !covered;
              return (
                <li key={row.id} data-focus={row.id === focus || undefined}>
                  <div className="bf-row">
                    <input
                      type="checkbox"
                      aria-label={`${row.id} 선택`}
                      checked={picked.has(row.id) || covered}
                      disabled={locked || covered || !!busy || !!answer}
                      onChange={() => toggle(row.id)}
                    />
                    <button
                      type="button"
                      className="bf-row-main"
                      aria-label={`${row.id} ${KIND_TEXT[row.kind]}`}
                      aria-expanded={row.id === focus}
                      onClick={() => setFocus(row.id === focus ? null : row.id)}
                    >
                      <span className="bf-kind" data-kind={row.kind}>
                        {covered ? '충돌 → 모델로 덮음' : KIND_TEXT[row.kind]}
                      </span>
                      <span className="bf-mono bf-file-name" title={row.path}>
                        {nameOf(row.path)}
                        {!sameKey(row.path, diff.root) ? (
                          <span className="bf-tag">xref</span>
                        ) : null}
                      </span>
                      <span className="bf-change">{changeText(row)}</span>
                      {row.layer ? (
                        <span className="bf-mono bf-layer">{row.layer}</span>
                      ) : row.kind === 'add' ? (
                        <span className="bf-layer bf-warn-text">레이어 지정 필요</span>
                      ) : null}
                      {row.reason && row.reason !== 'LAYER_NEEDED' ? (
                        <span className="bf-reason">{REASON_TEXT[row.reason] ?? row.reason}</span>
                      ) : null}
                    </button>
                    {coverable(row) && !covered && !answer ? (
                      <button
                        type="button"
                        className="link-button"
                        disabled={!!busy}
                        onClick={() => setCover((now) => new Set(now).add(row.id))}
                      >
                        모델로 덮기
                      </button>
                    ) : null}
                  </div>
                  {row.absoluteXref ? (
                    <p className="bf-warn bf-sub">
                      절대 경로 xref — 같은 폴더의 새 파일을 그 루트가 보지 않음
                    </p>
                  ) : null}
                  {row.affectedRoots.length ? (
                    <p className="bf-faint bf-sub">
                      영향받는 루트: {row.affectedRoots.map(nameOf).join(', ')}
                    </p>
                  ) : null}
                  {row.id === focus && focused ? <Overlay row={focused} /> : null}
                </li>
              );
            })}
          </ul>

          {askDeletes ? (
            <div className="bf-ask" role="alertdialog" aria-label="삭제 확인">
              <p>
                삭제 {deletes}개는 한 번에 지우는 기준({DIRECT_MAX_DELETES}개)을 넘습니다.
              </p>
              <button type="button" className="bf-primary" onClick={() => void apply(true)}>
                삭제 포함해 반영
              </button>
              <button type="button" onClick={() => setAskDeletes(false)}>
                취소
              </button>
            </div>
          ) : null}

          {answer?.state === 'confirm' ? (
            <div className="bf-card" role="dialog" aria-label="저장 확인">
              <h4>새 파일로 저장할까요?</h4>
              <ul>
                {answer.files.map((f) =>
                  f.mode === 'closed' ? (
                    <li key={f.path}>
                      <span className="bf-mono">{f.written}</span>
                      <span>DWG {release(f.version)}</span>
                      <span>{f.rows.length}행</span>
                      <span data-ok={f.check?.ok ?? false}>
                        형식 보존 차이 {f.check?.differences ?? '?'}
                      </span>
                    </li>
                  ) : (
                    <li key={f.path}>
                      열린 도면 <span className="bf-mono">{nameOf(f.path)}</span> · {f.rows.length}
                      행(바로 고침)
                    </li>
                  ),
                )}
              </ul>
              <p className="bf-faint">
                원본은 그대로입니다. 확인 전에는 어떤 파일도 쓰지 않았습니다. 원본 교체는 직접
                합니다.
              </p>
              {remote ? (
                <p className="bf-faint">저장은 작업 PC 화면에서 확인합니다.</p>
              ) : (
                <div className="bf-line">
                  <button
                    type="button"
                    className="bf-primary"
                    disabled={!!busy}
                    onClick={() => void step('confirm')}
                  >
                    {busy === 'confirm' ? '저장 중…' : '저장'}
                  </button>
                  <button type="button" disabled={!!busy} onClick={() => void step('cancel')}>
                    취소
                  </button>
                </div>
              )}
            </div>
          ) : answer?.state === 'applied' ? (
            <div className="bf-result" aria-label="반영 결과">
              <h4>
                {answer.files.some((f) => f.mode === 'closed')
                  ? '새 파일을 썼습니다'
                  : '반영했습니다'}
              </h4>
              {answer.files.map((f) => (
                <FileReport key={f.path + (f.written ?? '')} file={f} />
              ))}
              <div className="bf-line">
                {answer.files.some((f) => f.mode === 'open' && f.undoId) ? (
                  <button type="button" disabled={!!busy || !!undone} onClick={() => void undo()}>
                    되돌리기
                  </button>
                ) : null}
                {answer.files.some((f) => f.mode === 'closed') ? (
                  <span className="bf-faint">새 파일은 그대로 남습니다.</span>
                ) : null}
                {undone ? <span role="status">{undone}</span> : null}
                <span className="bf-spacer" />
                <button type="button" className="link-button" onClick={() => void compute()}>
                  다시 계산
                </button>
              </div>
            </div>
          ) : answer?.state === 'failed' ? (
            <div className="bf-fail" role="alert">
              <p>반영하지 못했습니다 · {ERRORS[answer.code] ?? answer.code}</p>
              {answer.failed.length ? (
                <ul>
                  {answer.failed.map((f) => (
                    <li key={f.id}>
                      {f.id} · {REASON_TEXT[f.code] ?? f.code}
                    </li>
                  ))}
                </ul>
              ) : null}
              {answer.rolledBack.length ? (
                <p>되돌린 파일: {answer.rolledBack.map(nameOf).join(', ')}</p>
              ) : null}
              {answer.undoFailed.length ? (
                <p>
                  되돌리지 못한 파일: {answer.undoFailed.map(nameOf).join(', ')} — ZWCAD에서
                  Ctrl+Z로 되돌리세요.
                </p>
              ) : null}
              <button type="button" className="link-button" onClick={() => setAnswer(null)}>
                닫기
              </button>
            </div>
          ) : answer?.state === 'unclear' ? (
            <div className="bf-fail" role="alert">
              <p>
                결과를 확인하지 못했습니다. 다시 적용하지 않습니다. 도면을 다시 읽으니{' '}
                <span className="bf-mono">{nameOf(answer.path)}</span>에 반영됨{' '}
                {answer.applied.length} · 반영 안 됨 {answer.notApplied.length}.
              </p>
            </div>
          ) : (
            <div className="bf-line bf-foot">
              <span className="bf-faint">
                선택 {chosenRows.length}행 · 파일 {files.size}개
              </span>
              <span className="bf-spacer" />
              {remote ? (
                <span className="bf-faint">반영과 저장은 작업 PC 화면에서 합니다.</span>
              ) : (
                <button
                  type="button"
                  className="bf-primary"
                  disabled={!!busy || !chosenRows.length || !diff.settled}
                  onClick={() => void apply()}
                >
                  {busy === 'apply' ? '반영 중…' : '반영'}
                </button>
              )}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

/** The 도면 반영 jig: [모델 변경 반영] and the SCR-30 [도곽 미리보기] as its second tab. */
export function DrawingJig({ context, openSync }: { context: JigContext; openSync: () => void }) {
  const [view, setView] = useState<'backflow' | 'sheets'>('backflow');
  return (
    <div className="drawing-jig">
      <nav className="bf-tabs" role="tablist" aria-label="도면 반영 보기">
        {(
          [
            ['backflow', '모델 변경 반영'],
            ['sheets', '도곽 미리보기'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div hidden={view !== 'backflow'}>
        <BackflowPanel context={context} openSync={openSync} />
      </div>
      {view === 'sheets' ? (
        <div className="bf-sheets">
          <DrawingSheets
            projectId={context.projectId}
            empty={
              <p className="bf-empty">
                도면 관계가 읽은 도면이 없습니다. 대시보드 › 프로젝트 폴더에서 도면 관계를 읽으세요.
              </p>
            }
          />
        </div>
      ) : null}
    </div>
  );
}
