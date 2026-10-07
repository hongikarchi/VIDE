// 답에서 모델로 (SPEC-13.8, PLAN-46 T-220): a legal answer card's target chip raises this window
// event with the site-model objects it names (per linked file, Link ID ADR-030, and host object id);
// the viewport selects those of them the screen shows, as it shows Rhino's own pick (SPEC-01.11 4),
// and frames them. The selection is VIDE's only and is not sent to the host.

export const LEGAL_TARGET_EVENT = 'vide:legal-target';

export interface LegalTargetEventDetail {
  /** 대지 · 인접 대지 · 도로, for the message when nothing is on screen. */
  label: string;
  objects: { linkId: string; nativeIds: string[] }[];
}

/** The shown ids of the named objects: the linked file's layer on screen, its Sync basis. */
export function shownTargetIds(
  detail: LegalTargetEventDetail,
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
