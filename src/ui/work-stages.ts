// Progress stages of one request (SPEC-02.11 "진행 단계의 표시"). A stage's state comes only from
// recorded events — capture, queries, code runs, verified writes, the request ending — never from
// time or guesses. Stages without events are "skipped" once the request has ended.

export type StageState = 'pending' | 'active' | 'done' | 'skipped' | 'failed';
export interface Stage {
  key: string;
  label: string;
  state: StageState;
  /** Real counts for the stage (e.g. "조회 3회"), empty when nothing happened. */
  detail: string;
}
interface Entry {
  kind: string;
  text: string;
}
export interface StageInput {
  state: string;
  provider?: string;
  source?: string;
  host?: string;
  jig?: string;
  phase?: string;
  activity: Entry[];
  progress?: { queries: number; attempts: number; completed: number };
  maxHostCommands?: number;
  hostExecuted?: boolean;
}
const ACTIVE = ['queued', 'running'];
const FAILED = ['failed', 'cancelled', 'interrupted', 'unknown'];

export function workStages(input: StageInput): Stage[] {
  const running = ACTIVE.includes(input.state);
  const failed = FAILED.includes(input.state);
  const finish = (): Stage => ({
    key: 'result',
    label: '결과',
    state: input.state === 'succeeded' ? 'done' : failed ? 'failed' : 'pending',
    detail:
      input.state === 'succeeded'
        ? ''
        : input.state === 'cancelled'
          ? '중단됨'
          : input.state === 'unknown'
            ? '호스트 결과 확인 필요'
            : input.state === 'interrupted'
              ? '연결 종료로 중단'
              : failed
                ? '실패'
                : '',
  });
  // Documents brought in (Sync, file import): capture then result.
  if (input.source === 'document' || input.source === 'file')
    return [
      {
        key: 'capture',
        label: '문서 취득',
        state: running ? 'active' : input.state === 'succeeded' ? 'done' : 'failed',
        detail: '',
      },
      finish(),
    ];
  if (input.provider === 'extension')
    return [
      {
        key: 'run',
        label: '확장 실행',
        state: running ? 'active' : failed ? 'failed' : 'done',
        detail: '',
      },
      finish(),
    ];
  // Questions and jig reviews: the request goes to the AI, the answer comes back.
  if (!input.host || input.jig === 'sync-review') {
    const answered = input.state === 'succeeded';
    return [
      {
        key: 'model',
        label: '요청 전달·답변 작성',
        state: running ? 'active' : answered ? 'done' : 'failed',
        detail: '',
      },
      { ...finish(), label: '답변' },
    ];
  }
  // Host work: prepare → understand → query → run → verify → result.
  const labels = ['기준 준비', '요청 이해', '모델 조회', '생성·수정 실행', '저장·재열기 검증'];
  const keys = ['prepare', 'understand', 'query', 'execute', 'verify'];
  const counts = [0, 0, 0, 0, 0];
  let errors = 0,
    last = -1;
  const stageOf: Record<string, number> = { host: 0, query: 2, execute: 3, result: 4, error: 3 };
  for (const entry of input.activity) {
    // AI notes count for "understand" only before any tool was used.
    const index = stageOf[entry.kind] ?? (last <= 1 ? 1 : -1);
    if (index < 0) continue;
    if (entry.kind === 'error') errors++;
    else counts[index]++;
    last = index;
  }
  // Counts and phases reported without activity entries (CAD paths, older engines).
  if (input.progress) {
    counts[2] = Math.max(counts[2], input.progress.queries);
    counts[3] = Math.max(counts[3], input.progress.attempts);
    counts[4] = Math.max(counts[4], input.progress.completed);
  }
  if (input.phase === 'starting-host') counts[0] = Math.max(counts[0], 1);
  if (input.phase === 'model' && last < 1) counts[1] = Math.max(counts[1], 1);
  const reached = counts.reduce((max, count, index) => (count > 0 ? index : max), last);
  const evidence = (index: number) => counts[index] > 0 || (index === 1 && reached > 1);
  const current = running ? (last >= 0 ? last : reached) : -1;
  const detail = [
    '',
    '',
    counts[2] ? `조회 ${counts[2]}회` : '',
    counts[3] || errors
      ? `실행 ${counts[3]}${input.maxHostCommands ? '/' + input.maxHostCommands : ''}회` +
        (errors ? ` · 오류 ${errors}회 (AI가 고쳐 다시 시도)` : '')
      : '',
    counts[4] ? `검증 성공 ${counts[4]}회` : '',
  ];
  const stages = keys.map((key, index): Stage => {
    let state: StageState;
    if (running)
      state =
        input.state === 'queued' && reached < 0
          ? 'pending'
          : index === Math.max(current, 0)
            ? 'active'
            : index <= reached
              ? evidence(index)
                ? 'done'
                : 'skipped'
              : 'pending';
    else if (input.state === 'succeeded')
      state = evidence(index) || index === 1 ? 'done' : 'skipped';
    else
      state =
        index === Math.max(last, reached, 0)
          ? 'failed'
          : index < reached && evidence(index)
            ? 'done'
            : 'skipped';
    return { key, label: labels[index], state, detail: detail[index] };
  });
  return [...stages, finish()];
}
