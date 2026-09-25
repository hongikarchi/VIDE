import { failedRequestDraft, type DraftState } from './model.ts';
import type { UiRequest } from './workspace-data.ts';

/** Rebase only verified children; a missing result is never replaced with its old basis. */
export function linkedRequestDraft(state: DraftState, parent: UiRequest) {
  const targets = parent.input.linkedTargets;
  const origin =
    parent.input.supersedesRequestId && !parent.result?.targetResults
      ? state.messages.find((message) => message.id === parent.input.supersedesRequestId)?.request
      : parent;
  if (
    !origin ||
    !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(origin.state) ||
    JSON.stringify(origin.input.linkedTargets) !== JSON.stringify(targets) ||
    origin.input.coordinateBasis !== parent.input.coordinateBasis ||
    origin.input.permission !== parent.input.permission
  )
    throw Error('이전 연계 요청의 대상과 권한을 확인할 수 없습니다.');
  if (
    !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(parent.state) ||
    targets?.length !== 2 ||
    parent.input.coordinateBasis !== 'shared-metre-axes' ||
    new Set(targets.map((target) => target.baseRequestId)).size !== 2 ||
    origin.result?.targetResults?.length !== 2
  )
    throw Error('종료된 연계 요청의 두 대상을 확인할 수 없습니다.');
  const children = origin.result.targetResults.map(
    (row) => state.messages.find((message) => message.id === row.requestId)?.request,
  );
  const replacements = targets.map((target) => {
    const matches = children.filter(
      (child) =>
        child?.input.parentRequestId === origin.id &&
        child.input.baseRequestId === target.baseRequestId &&
        child.input.host === target.host,
    );
    const child = matches[0];
    if (
      matches.length !== 1 ||
      child?.state !== 'succeeded' ||
      !child.result?.hostExecuted ||
      !child.result.objects ||
      (child.result.host || 'rhino') !== target.host
    )
      throw Error(
        '두 대상의 저장된 후보를 먼저 확인하세요. 불명확하거나 없는 결과는 재실행하지 않습니다.',
      );
    const before = state.messages.find((message) => message.id === target.baseRequestId)?.request;
    if (
      before?.state !== 'succeeded' ||
      !before.result?.hostExecuted ||
      (before.result.host || 'rhino') !== target.host
    )
      throw Error('연계 요청의 원 기준을 확인할 수 없습니다.');
    return { target, child, before };
  });
  const draft = failedRequestDraft(state, {
    ...parent,
    state: 'interrupted',
    input: { ...parent.input, linkedTargets: undefined },
  });
  draft.pins = draft.pins.map((pin) => {
    const mapping = replacements.find((item) => item.target.baseRequestId === pin.basis);
    if (!mapping) return pin;
    const before = mapping.before.result!.objects?.find((object) => object.id === pin.id);
    const after = mapping.child.result!.objects!.find((object) => object.id === pin.id);
    if (!before?.nativeId || before.nativeId !== after?.nativeId)
      throw Error('후속 후보의 핀 대응을 확인할 수 없습니다. 객체를 다시 확인하세요.');
    return { ...pin, basis: mapping.child.id };
  });
  return {
    ...draft,
    baseRequestId: null,
    linkedTargets: replacements.map(({ child, target }) => ({
      baseRequestId: child.id,
      host: target.host,
    })),
    coordinateBasis: parent.input.coordinateBasis,
    body: `두 대상의 현재 후보를 먼저 확인하고, 이미 완료된 작업을 반복하지 말고 아래 목표의 남은 부분을 수행하세요. 완료 여부를 판단할 수 없으면 확인할 사항을 알려주세요.\n\n[원 목표와 조건]\n${draft.body}`,
  };
}
