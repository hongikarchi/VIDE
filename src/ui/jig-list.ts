// What the JIG list (SCR-18, PLAN-26 T-099) shows, as pure functions the screen and the tests share:
// one card per jig id at the version pinned to this project, and the drafts still being written.
// No DOM and no requests here; src/ui/jigs.tsx reads the registry, the pins and the drafts.

import { isNewerVersion } from '../contracts/jig-version.ts';

export interface ListedPackage {
  id: string;
  version: string;
  kind: 'tool' | 'library';
  stage: 'official' | 'project' | 'dev';
}
export interface PinnedRow {
  jigId: string;
  version: string;
}

/**
 * The tool jigs to show, one per id in registry order. A jig pinned to this project shows at its
 * pinned version (a re-pinned fork replaces the older version; SPEC-07.3); an installed jig not
 * pinned here does not show (the project's list only); a checkout source or an official tool not
 * pinned here shows as it is. When the pinned version is missing from the registry the newest
 * installed one of that id stands in, so the jig does not vanish from the list.
 */
export function listedTools<T extends ListedPackage>(
  packages: readonly T[],
  pins: readonly PinnedRow[],
): T[] {
  const pinned = new Map(pins.map((row) => [row.jigId, row.version]));
  const byId = new Map<string, T[]>();
  for (const entry of packages) {
    if (entry.kind !== 'tool') continue;
    const group = byId.get(entry.id);
    if (group) group.push(entry);
    else byId.set(entry.id, [entry]);
  }
  const out: T[] = [];
  for (const [id, group] of byId) {
    const version = pinned.get(id);
    const chosen =
      version !== undefined
        ? (group.find((entry) => entry.version === version && entry.stage === 'project') ??
          group.find((entry) => entry.version === version) ??
          group.filter((entry) => entry.stage === 'project').at(-1))
        : group.find((entry) => entry.stage !== 'project');
    if (chosen) out.push(chosen);
  }
  return out;
}

export interface ListedDraft {
  id: string;
  state?: string;
}
/** The drafts shown as cards: the open ones (a pinned or discarded draft is done). */
export const openDrafts = <T extends ListedDraft>(drafts: readonly T[]): T[] =>
  drafts.filter((draft) => !draft.state || draft.state === 'open');

/**
 * Whether an instance row offers [올리기] (SPEC-07.4, T-101): only when the card's version — the one
 * pinned here — is newer than the instance's. An older pinned version is no 올리기.
 */
export const behindCard = (instanceVersion: string, cardVersion: string): boolean =>
  isNewerVersion(cardVersion, instanceVersion);
