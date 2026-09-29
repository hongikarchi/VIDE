// Words of the S-06 diagnosis (SPEC-06.11·.14 판정 이름) shared by the step, its CSV and the jig
// screen. No imports, so the screen can take the words without the geometry code.

/** Judgement of one check. `over` is a span above the limit; `incomplete` could not be judged. */
export type Verdict = 'pass' | 'forbidden' | 'consult' | 'warning' | 'over' | 'incomplete';

export const VERDICT_LABEL: Record<Verdict, string> = {
  pass: '통과',
  forbidden: '불가',
  consult: '협의',
  warning: '경고',
  over: '초과',
  incomplete: '미완',
};

/** Design §02: the verdict is never colour alone — a symbol goes with the word. */
export const VERDICT_SYMBOL: Record<Verdict, string> = {
  pass: '✓',
  forbidden: '✕',
  consult: '!',
  warning: '!',
  over: '✕',
  incomplete: '?',
};

/** Worst first when rows are merged or sorted: 불가 > 초과 > 협의 > 경고 > 미완 > 통과. */
export const VERDICT_RANK: Record<Verdict, number> = {
  pass: 0,
  incomplete: 1,
  warning: 2,
  consult: 3,
  over: 4,
  forbidden: 5,
};

/** Input roles of the M0 diagnosis (a subset of the S-06 assembly roles, SPEC-06.10). */
export type RoleKey = 'columns' | 'girders' | 'newFootings' | 'existingFootings' | 'basinGirders';
export const ROLE_KEYS: readonly RoleKey[] = [
  'columns',
  'girders',
  'newFootings',
  'existingFootings',
  'basinGirders',
];
export const ROLE_LABEL: Record<RoleKey, string> = {
  columns: '신설 기둥',
  girders: '거더',
  newFootings: '신설 기초(파일캡·오픈컷)',
  existingFootings: '기존 기초',
  basinGirders: '유수지 보',
};

/** The checks of the diagnosis; each can be '미완' on its own. */
export type Judgement = 'cap' | 'openCut' | 'basin' | 'span' | 'curve';
export const JUDGEMENT_LABEL: Record<Judgement, string> = {
  cap: '파일캡↔기존 기초',
  openCut: '오픈컷↔기존 기초',
  basin: '기둥↔유수지 보',
  span: '경간',
  curve: '곡선 평면 길이',
};
