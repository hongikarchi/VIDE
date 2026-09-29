// Where a request goes (SPEC-02.17), judged by Jev when a key is set (user, 2026-09-29: "jev가
// 판정하면 안되나? 규칙으로 하니까 칩을 눌러야 하는 횟수가 너무 많아"). One call answers three
// questions: VIDE view only or work on the file, which view action, and which of the listed object
// groups. No key, a failure, a timeout or an unsure answer: undefined, and the UI uses its rules.
import { readJevKey } from './model-router.ts';

export const VIEW_ACTIONS = {
  hide: 'Hide these objects or turn their layer off in the view (숨겨, 안 보이게, 꺼, 가려).',
  isolate: 'Show only these objects and hide everything else (만 보여, 만 남기고, 만 켜, 격리).',
  unhide: 'Show all hidden objects again (다시 보여, 모두 보여, 숨김 해제).',
  select: 'Select or pick these objects (선택해, 골라, 찍어).',
  fit: 'Zoom or move the view to these objects (확대, 줌, 가까이, 맞춰 보여).',
} as const;
/** Naming the file or program means work on the file, whatever else the words say. */
const FILE_WORDS =
  /(원본|파일에서|파일에|도면에서|cad\s*에서|캐드에서|zwcad|rhino\s*에서|라이노에서)/i;
export type ViewAction = keyof typeof VIEW_ACTIONS;
export interface RouteSubject {
  id: string;
  /** What the group is, e.g. "문자 (text annotations), 120 objects" or "layer A-ANNO, 30 objects". */
  label: string;
}
export interface RouteQuery {
  body: string;
  subjects: RouteSubject[];
}
export interface RouteDecision {
  target: 'view' | 'document';
  action?: ViewAction;
  /** The chosen subject id, or undefined when none fits. */
  subject?: string;
  confidence: number;
  ms: number;
}
export interface RouterOptions {
  dataDirectory?: string;
  key?: () => string;
  fetchImpl?: typeof fetch;
  url?: string;
  model?: string;
  timeoutMs?: number;
}
const MIN_CONFIDENCE = 0.6;
const MAX_SUBJECTS = 40;

export async function decideRoute(
  query: RouteQuery,
  options: RouterOptions = {},
): Promise<RouteDecision | undefined> {
  const started = performance.now();
  const key = options.key?.() ?? (options.dataDirectory ? readJevKey(options.dataDirectory) : '');
  if (!key || !query.body.trim()) return undefined;
  if (FILE_WORDS.test(query.body))
    return { target: 'document', confidence: 1, ms: Math.round(performance.now() - started) };
  const subjects = query.subjects.slice(0, MAX_SUBJECTS);
  const questions: Record<string, unknown> = {
    target: {
      type: 'choice',
      instructions: 'Where should this request be carried out?',
      criteria: {
        view: 'Only change what the VIDE viewer shows: hide, turn off, show only, show again, select or zoom to objects or layers. The Rhino model or CAD drawing is not changed and no AI work is needed.',
        document:
          'Work on the Rhino model or CAD drawing itself (create, change, delete, move, recolour or rename in the file; also anything said to happen in CAD, in Rhino, in the drawing or in the original), or a question, count, check or analysis for the AI assistant.',
      },
    },
    action: {
      type: 'choice',
      instructions: 'If the request only changes the VIDE view, which change is it?',
      criteria: VIEW_ACTIONS,
    },
  };
  if (subjects.length)
    questions.subject = {
      type: 'choice',
      instructions:
        'Which objects does the request name (the ones to hide, show, keep, select or zoom to)? Korean words: 문자·텍스트·글자 = text, 치수 = dimensions, 해치 = hatches, 블록 = blocks, 면 = surfaces, 선 = lines, 점 = points, 보 = beams, 기둥 = columns, 벽 = walls, 슬래브 = slabs, 창호 = windows and doors. A layer whose code or name matches the word counts (S-BEAM for 보, A-WALL for 벽).',
      criteria: {
        ...Object.fromEntries(subjects.map((subject, i) => [`s${i}`, subject.label])),
        none: 'None of these, or all objects',
      },
    };
  try {
    const response = await (options.fetchImpl ?? fetch)(
      options.url ?? 'https://api.typesafe.ai/v1/systemone',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model ?? 'jev-1.13.0',
          state: `A user of VIDE, an AI workspace that shows Rhino models and CAD drawings, typed a request.\nRequest: ${query.body.slice(0, 2000)}`,
          questions,
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
      },
    );
    if (!response.ok) return undefined;
    type Answer = { choice?: string; confidence?: number } | undefined;
    const answers = ((await response.json()) as { answers?: Record<string, Answer> }).answers;
    const target = answers?.target?.choice;
    const confidence = Number(answers?.target?.confidence ?? 0);
    if ((target !== 'view' && target !== 'document') || confidence < MIN_CONFIDENCE)
      return undefined;
    const ms = Math.round(performance.now() - started);
    if (target === 'document') return { target, confidence, ms };
    const action = answers?.action?.choice;
    if (!action || !(action in VIEW_ACTIONS)) return undefined;
    const picked = answers?.subject?.choice;
    const index = picked?.startsWith('s') ? Number(picked.slice(1)) : NaN;
    return {
      target,
      action: action as ViewAction,
      ...(Number.isInteger(index) && subjects[index] ? { subject: subjects[index].id } : {}),
      confidence,
      ms,
    };
  } catch {
    return undefined;
  }
}
