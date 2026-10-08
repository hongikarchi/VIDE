// 화면에서 모델로 (SPEC-13.8 법규 답 대상 칩, SPEC-15.11 법규 체크 결과 행; ARCH-03 §8.6): a screen
// part raises this window event with the host objects it names (per linked file, Link ID ADR-030,
// and host object id); the viewport selects those of them the screen shows, as it shows Rhino's own
// pick (SPEC-01.11 4), and frames them. The selection is VIDE's only and is not sent to the host.

export const SELECT_NATIVE_EVENT = 'vide:select-native';

export interface SelectNativeDetail {
  /** What the objects are (대지 · 도로 · 건폐율 행 …), for the message when nothing is on screen. */
  label: string;
  objects: { linkId: string; nativeIds: string[] }[];
}

/** Raise `vide:select-native` for these objects. */
export function selectNative(detail: SelectNativeDetail) {
  window.dispatchEvent(new CustomEvent<SelectNativeDetail>(SELECT_NATIVE_EVENT, { detail }));
}

/** The shown ids of the named objects: the linked file's layer on screen, its Sync basis. */
export function shownTargetIds(
  detail: SelectNativeDetail,
  layers: readonly { key: string; requestId: string }[],
  displayIdOf: (basis: string, id: string) => string | undefined,
): { ids: string[]; fileShown: boolean } {
  const ids: string[] = [];
  let fileShown = false;
  for (const target of detail.objects) {
    const layer = layers.find((l) => l.key === target.linkId);
    if (!layer) continue;
    fileShown = true;
    for (const id of target.nativeIds) {
      const shown = displayIdOf(layer.requestId, id);
      if (shown) ids.push(shown);
    }
  }
  return { ids: [...new Set(ids)], fileShown };
}
