// One step-rail row of the declarative jig panel (SPEC-07.10, Design §14): the stored step, the
// latest run, the pending changes and the work a part is doing for the step (SPEC-12.3의 3).
import type { RailState, RailStep } from '../kit/status.tsx';
import { pickableInputs } from './bindings.ts';
import type { InstanceView, StepReport } from './instance.ts';

const BY: Record<string, string> = {
  code: '계산',
  library: '라이브러리',
  ai: 'AI',
  human: '사람',
  host: 'CAD 프로그램',
};
const ERRORS: Record<string, string> = {
  BUDGET: '계산 시간 상한을 넘었습니다.',
  SCHEMA: '결과가 도구 설명의 형식과 다릅니다.',
  AI_UNAVAILABLE: 'AI 단계는 아직 실행되지 않습니다.',
};
/** One rail row from the stored step, the latest run and the pending changes. */
export function railStep(
  step: InstanceView['steps'][number],
  report: StepReport | undefined,
  stale: boolean,
  roleKeys: ReadonlySet<string> = new Set(),
  working = false,
): RailStep {
  // A part is fetching for this step (SPEC-12.3의 3): it runs, not '막힘' from the run before.
  if (working)
    return {
      id: step.id,
      title: step.title,
      by: BY[step.kind] ?? step.kind,
      state: 'running',
      label: `${step.title} 중…`,
    };
  const fromReport: Record<string, RailState> = {
    done: 'done',
    failed: 'failed',
    'gate-failed': 'failed',
    waiting: 'waiting',
    confirmed: 'confirmed',
    reconfirm: 'reconfirm',
    blocked: 'blocked',
  };
  const fromStore: Record<string, RailState> = {
    pending: 'pending',
    running: 'running',
    done: 'done',
    failed: 'failed',
    stale: 'stale',
    waiting: 'waiting',
    confirmed: 'confirmed',
    reconfirm: 'reconfirm',
  };
  const state: RailState = stale
    ? 'stale'
    : ((report && fromReport[report.status]) ?? fromStore[step.status] ?? 'pending');
  const gates = report?.gates ?? step.gates ?? [];
  const blocking = gates.filter((g) => !g.ok && g.level === 'block').map((g) => g.message);
  const reason =
    state !== 'failed'
      ? state === 'blocked'
        ? '앞 단계를 먼저 끝내야 합니다.'
        : undefined
      : report?.error
        ? (ERRORS[report.error.code] ?? report.error.message.replace(/^[A-Z][A-Z0-9_]*:\s*/, ''))
        : blocking.join(' · ') || undefined;
  return {
    id: step.id,
    title: step.title,
    by: BY[step.kind] ?? step.kind,
    state,
    ms: report?.ms ?? step.ms,
    unchanged: state === 'done' && !!report?.cached,
    problems: gates.filter((g) => !g.ok).length || undefined,
    reason,
    confirm: step.kind === 'human' && (state === 'waiting' || state === 'reconfirm') && !!report,
    inputs: state === 'failed' ? pickableInputs(gates, roleKeys) : undefined,
  };
}
