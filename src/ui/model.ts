import type { Review, ReviewNote } from '../contracts/reviews.ts';
import { executionLimitsSchema, type ExecutionLimits } from '../contracts/execution-limits.ts';
import type { UiMessage } from './workspace-data.ts';
export interface DraftPin {
  id: string;
  basis: string;
  role: 'target' | 'preserve' | 'reference';
  name?: string;
  /** Inline token ("고정N") in the message that names this pin group. */
  label?: string;
}
export interface DraftFile {
  name: string;
  text: string;
  [key: string]: unknown;
}
export type Point2 = [number, number];
export type Point3 = [number, number, number];
export type SketchPlacement = 'surface' | 'view' | 'plane';
export interface DraftStroke {
  points: Point3[];
  color: string;
  width: number;
}
export interface DraftSketch {
  points?: Point2[];
  strokes?: DraftStroke[];
  placement?: SketchPlacement;
  planeOffset?: number;
  id?: string;
  name?: string;
  plane?: string;
  [key: string]: unknown;
}
interface DraftObject {
  id: string;
  name: string;
  revision?: string;
  [key: string]: unknown;
}
export interface DraftState {
  executionLimits?: ExecutionLimits;
  linkedTargets?: { baseRequestId: string; host: 'rhino' | 'zwcad' }[];
  coordinateBasis?: 'shared-metre-axes';
  selected: string | null;
  host: 'rhino' | 'zwcad';
  body: string;
  instructions: string[];
  pins: DraftPin[];
  sketches: DraftSketch[];
  files: DraftFile[];
  model: string;
  effort: string;
  permission: 'review' | 'candidate';
  applyToSource?: boolean;
  messages: UiMessage[];
  baseRequestId?: string | null;
  drawingPlane?: 'XY' | 'XZ' | 'YZ';
}
interface RestoreInput {
  executionLimits?: ExecutionLimits;
  linkedTargets?: DraftState['linkedTargets'];
  body: string;
  pins: DraftPin[];
  sketches: DraftSketch[];
  files: DraftFile[];
  host?: DraftState['host'];
  model?: string;
  effort?: string;
  permission: DraftState['permission'];
  baseRequestId?: string | null;
  source?: string;
  provider?: string;
}
interface RestoreRequest {
  state: string;
  input?: RestoreInput;
}
interface ModelOption {
  id: string;
  name: string;
  provider: 'claude-cli' | 'codex-cli';
  efforts: string[];
}
interface SelectionRequest {
  id: string;
  result?: {
    sourceDocument?: { instance: string; documentId: number; documentHash?: string };
    objects?: { id: string; name: string }[];
  } | null;
}
interface HostSelection {
  instance: string;
  documentId: number;
  documentHash: string;
  selectedIds: string[];
}
export const objects: DraftObject[] = [];
export const models: ModelOption[] = [
  {
    id: 'claude-cli',
    name: 'Claude · 계정 기본 모델',
    provider: 'claude-cli',
    efforts: ['default'],
  },
  {
    id: 'codex-cli',
    name: 'ChatGPT · 계정 기본 모델',
    provider: 'codex-cli',
    efforts: ['default'],
  },
];
export const initial = (): DraftState => ({
  selected: null,
  host: 'rhino',
  body: '',
  instructions: [],
  pins: [],
  sketches: [],
  files: [],
  model: models[0].id,
  effort: 'default',
  permission: 'review',
  messages: [],
});
export const storageKey = 'vide:review:composer:v3';
export function draftHasInput(state: DraftState) {
  return Boolean(
    state.linkedTargets?.length ||
    state.body.trim() ||
    (state.instructions || []).some((text) => text.trim()) ||
    state.pins.length ||
    state.sketches.length ||
    state.files.length,
  );
}
export function failedRequestDraft(state: DraftState, request: RestoreRequest) {
  if (request.input?.linkedTargets)
    throw Error(
      '연계 요청은 대상별 확인 결과에서 새 요청을 만드세요. 성공한 작업을 함께 재실행하지 않습니다.',
    );
  if (
    !['failed', 'cancelled', 'interrupted'].includes(request?.state) ||
    !request.input ||
    ['file', 'document'].includes(request.input.source ?? '') ||
    request.input.provider === 'extension'
  )
    throw Error('복원할 수 있는 AI 요청이 아닙니다.');
  const input = request.input;
  if (
    input.baseRequestId &&
    !state.messages.some(
      (message) => message.id === input.baseRequestId && message.request?.result?.hostExecuted,
    )
  )
    throw Error('원 요청의 기준 후보를 확인할 수 없습니다.');
  if (
    typeof input.body !== 'string' ||
    !(['pins', 'sketches', 'files'] as const).every((key) => Array.isArray(input[key]))
  )
    throw Error('저장된 입력을 확인할 수 없습니다.');
  return structuredClone({
    body: input.body,
    executionLimits: input.executionLimits,
    linkedTargets: undefined,
    coordinateBasis: undefined,
    instructions: [],
    pins: input.pins,
    sketches: input.sketches,
    files: input.files,
    host: input.host || 'rhino',
    baseRequestId: input.baseRequestId,
    model: input.model || input.provider || state.model,
    effort: input.effort || 'default',
    permission: input.permission,
    applyToSource: false,
    selected: null,
  });
}
export function recoveredRequestDraft(state: DraftState, request: UiMessage['request']) {
  if (
    request.state !== 'succeeded' ||
    !request.result?.recovered ||
    !request.result.hostExecuted ||
    request.result.executionMode !== 'sdk' ||
    !request.result.objects
  )
    throw Error('저장 검증된 복구 후보가 아닙니다.');
  const draft = failedRequestDraft(state, { ...request, state: 'interrupted' });
  const basis = state.messages.find((message) => message.id === request.input.baseRequestId)
    ?.request?.result?.objects;
  draft.pins = draft.pins.map((pin) => {
    if (pin.basis !== request.input.baseRequestId) return pin;
    const before = basis?.find((object) => object.id === pin.id);
    const after = request.result!.objects!.find((object) => object.id === pin.id);
    if (!before || !after || !before.nativeId || before.nativeId !== after.nativeId)
      throw Error('복구 후보의 핀 대응을 확인할 수 없습니다. 객체를 다시 확인하세요.');
    return { ...pin, basis: request.id };
  });
  draft.baseRequestId = request.id;
  draft.body = `복구된 현재 후보를 먼저 확인하고, 이미 완료된 작업을 반복하지 말고 아래 목표의 남은 부분을 수행하세요. 완료 여부를 판단할 수 없으면 확인할 사항을 알려주세요.\n\n[원 목표와 조건]\n${draft.body}`;
  return draft;
}
export function chooseModel(s: DraftState, id: string) {
  const model = models.find((m) => m.id === id);
  if (!model) throw Error('모델을 선택하세요.');
  s.model = id;
  if (!model.efforts.includes(s.effort))
    s.effort = model.efforts.includes('default') ? 'default' : model.efforts[0];
}
export function pinSelection(
  s: DraftState,
  ids: readonly string[] = s.selected ? [s.selected] : [],
) {
  for (const id of ids) {
    const o = objects.find((o) => o.id === id);
    if (o && o.revision && !s.pins.some((p) => p.id === o.id && p.basis === o.revision))
      s.pins.push({ id: o.id, name: o.name, role: 'target', basis: o.revision });
  }
}
export function validate(s: DraftState) {
  if (s.executionLimits && !executionLimitsSchema.safeParse(s.executionLimits).success)
    return '작업 상한을 확인하세요.';
  if (
    s.linkedTargets &&
    (s.linkedTargets.length !== 2 ||
      new Set(s.linkedTargets.map((target) => target.baseRequestId)).size !== 2 ||
      s.coordinateBasis !== 'shared-metre-axes')
  )
    return '연계 대상 두 개와 좌표 기준을 확인하세요.';
  if (
    s.instructions !== undefined &&
    (!Array.isArray(s.instructions) || s.instructions.some((t) => typeof t !== 'string'))
  )
    return '요청 목록을 확인하세요.';
  if (requestBody(s).length > 20000) return '요청 묶음은 20,000자까지 입력할 수 있습니다.';
  if (!requestBody(s).trim() && !s.pins.length && !s.sketches.length && !s.files.length)
    return '메시지나 참조를 추가하세요.';
  const m = models.find((m) => m.id === s.model);
  if (!m || !m.efforts.includes(s.effort)) return '모델과 effort를 확인하세요.';
  if (
    s.applyToSource &&
    (s.permission !== 'candidate' || s.host !== 'rhino' || !s.baseRequestId || s.linkedTargets)
  )
    return 'Sync한 Rhino 문서 하나를 기준으로 선택하세요.';
  if (!['review', 'candidate'].includes(s.permission)) return '권한을 확인하세요.';
  return '';
}
export function packet(s: DraftState) {
  const error = validate(s);
  if (error) throw Error(error);
  return structuredClone({
    host: s.host || 'rhino',
    ...(s.executionLimits ? { executionLimits: s.executionLimits } : {}),
    ...(s.linkedTargets
      ? { linkedTargets: s.linkedTargets, coordinateBasis: s.coordinateBasis }
      : {}),
    baseRequestId: s.baseRequestId ?? null,
    body: requestBody(s),
    pins: s.pins,
    sketches: s.sketches,
    files: s.files,
    provider: models.find((m) => m.id === s.model)!.provider,
    model: s.model,
    effort: s.effort,
    permission: s.permission,
    ...(s.applyToSource ? { applyToSource: true } : {}),
  });
}
export function attachSketch(s: DraftState, points: Point2[], plane: string, role: string) {
  if (points.length < 2) throw Error('두 점 이상 그리세요.');
  if (
    !['XY', 'XZ', 'YZ'].includes(plane) ||
    !['reference', 'boundary', 'path', 'direction'].includes(role)
  )
    throw Error('평면과 역할을 확인하세요.');
  if (role === 'direction' && points.length !== 2) throw Error('방향은 두 점으로 지정하세요.');
  if (points.some((p) => p.length !== 2 || p.some((n) => !Number.isFinite(n))))
    throw Error('좌표를 확인하세요.');
  s.sketches.push({
    id: crypto.randomUUID(),
    name: `스케치 ${s.sketches.length + 1}`,
    plane,
    origin: [0, 0, 0],
    axisU: plane === 'YZ' ? [0, 1, 0] : [1, 0, 0],
    axisV: plane === 'XY' ? [0, 1, 0] : [0, 0, 1],
    unit: 'm',
    role,
    points: structuredClone(points),
  });
}

/** Attach free brush strokes (world XYZ metres) as one sketch; numeric points join as a stroke. */
export function attachBrushSketch(
  s: DraftState,
  strokes: DraftStroke[],
  options: {
    placement: SketchPlacement;
    role: string;
    plane: string;
    planeOffset: number;
    points?: Point2[];
  },
) {
  const { placement, role, plane, planeOffset } = options;
  if (
    !['reference', 'boundary', 'path', 'direction'].includes(role) ||
    !['XY', 'XZ', 'YZ'].includes(plane) ||
    !Number.isFinite(planeOffset)
  )
    throw Error('평면과 역할을 확인하세요.');
  const all = strokes.map((stroke) => structuredClone(stroke));
  if (options.points && options.points.length >= 2)
    all.push({
      points: options.points.map(([u, v]) => planePoint(plane, [u, v], planeOffset)),
      color: all.at(-1)?.color ?? '#c5684b',
      width: 3,
    });
  const valid = all.filter((stroke) => stroke.points.length >= 2);
  if (!valid.length) throw Error('선을 그리세요.');
  if (valid.length > 200) throw Error('스케치 하나에 200획까지 첨부할 수 있습니다.');
  if (valid.reduce((sum, stroke) => sum + stroke.points.length, 0) > 20000)
    throw Error('스케치 점이 너무 많습니다. 나누어 첨부하세요.');
  s.sketches.push({
    id: crypto.randomUUID(),
    name: `스케치 ${s.sketches.length + 1}`,
    unit: 'm',
    role,
    placement,
    ...(placement === 'plane' ? { plane, planeOffset } : {}),
    strokes: valid,
  });
}
/** U/V on XY/XZ/YZ at an offset along the plane normal, in world metres. */
export function planePoint(plane: string, [u, v]: Point2, offset = 0): Point3 {
  return plane === 'XY' ? [u, v, offset] : plane === 'XZ' ? [u, offset, v] : [offset, u, v];
}

export function requestBody(s: Pick<DraftState, 'body' | 'instructions'>) {
  const instructions = [...(s.instructions || []), s.body].filter((text) => text.trim());
  return instructions.length > 1
    ? instructions.map((text, i) => `${i + 1}. ${text}`).join('\n\n')
    : instructions[0] || '';
}

export function attachHostSelection(
  state: DraftState,
  request: SelectionRequest | undefined,
  selection: HostSelection,
) {
  const source = request?.result?.sourceDocument;
  const available = request?.result?.objects;
  if (
    !request ||
    !available ||
    !source ||
    source.instance !== selection.instance ||
    source.documentId !== selection.documentId
  )
    throw Error('선택한 Rhino 문서의 작업 사본을 먼저 가져오세요.');
  if (source.documentHash !== selection.documentHash)
    throw Error('원본이 취득 후 변경됐습니다. 작업 사본을 다시 가져온 뒤 선택을 첨부하세요.');
  const selected = selection.selectedIds.map((id) => available.find((object) => object.id === id));
  if (selected.some((object) => !object))
    throw Error(
      '현재 후보에 없는 선택 객체가 있습니다. 원본 작업 사본에서 선택을 다시 확인하세요.',
    );
  const valid = selected.filter((object): object is { id: string; name: string } =>
    Boolean(object),
  );
  const additions = valid.filter(
    (object) => !state.pins.some((pin) => pin.id === object.id && pin.basis === request.id),
  );
  if (state.pins.length + additions.length > 100)
    throw Error('요청에 첨부할 수 있는 객체는 100개까지입니다.');
  state.pins.push(
    ...additions.map((object) => ({
      id: object.id,
      name: object.name,
      role: 'target' as const,
      basis: request.id,
    })),
  );
  if (valid.length) state.selected = valid[0].id;
  return additions.length;
}

export function attachReviewNote(state: DraftState, note: ReviewNote, review: Review) {
  if (state.baseRequestId !== review.requestId)
    throw Error('다른 후보를 보고 있습니다. 기준 후보를 먼저 열어 대상을 확인하세요.');
  if (
    requestBody({ ...state, instructions: [...(state.instructions || []), note.body] }).length >
    20000
  )
    throw Error('요청 묶음은 20,000자까지 입력할 수 있습니다.');
  const name = 'Review-' + note.id + '.md';
  if (state.files.some((file) => file.name === name))
    throw Error('이미 요청 초안에 첨부한 의견입니다.');
  if (state.files.length >= 100) throw Error('첨부 자료는 100개까지입니다.');
  const object = review.payload.model.find((object) => object.id === note.objectId);
  if (note.objectId && !object) throw Error('검토본의 대상 객체를 확인할 수 없습니다.');
  const existing = object && state.pins.find((pin) => pin.id === object.id);
  if (existing && (existing.basis !== review.requestId || existing.role !== 'target'))
    throw Error('첨부된 객체의 기준과 역할을 먼저 확인하세요.');
  if (object && !existing && state.pins.length >= 100) throw Error('요청 객체는 100개까지입니다.');
  const text = JSON.stringify(
    {
      reviewId: review.id,
      reviewTitle: review.title,
      requestId: review.requestId,
      noteId: note.id,
      createdAt: note.createdAt,
      objectId: note.objectId,
      body: note.body,
    },
    null,
    2,
  );
  state.files.push({
    name,
    displayName: '검토 의견 · ' + review.title,
    type: 'text/markdown',
    text,
    size: new TextEncoder().encode(text).length,
    contentStatus: 'included',
  });
  if (object && !existing)
    state.pins.push({ id: object.id, name: object.name, role: 'target', basis: review.requestId });
  state.instructions.push(note.body);
}
