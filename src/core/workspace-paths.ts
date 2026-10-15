// Names of the files VIDE writes into a work folder (PLAN-52 T-313·T-315; ARCH-01 「작업 폴더」).
// One rule for the engine's copies (src/server/workspace-outputs.ts) and the `vide` CLI, so the
// same jig result never lands in two differently named folders.

const pad = (n: number) => String(n).padStart(2, '0');

/** Local `YYYY-MM-DD`. */
export const dayOf = (at: Date) =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

/** Local `YYYY-MM-DD-HHmm` (one 회차 per minute). */
export const minuteOf = (at: Date) => `${dayOf(at)}-${pad(at.getHours())}${pad(at.getMinutes())}`;

/** A file or folder name from a title: no path or reserved characters, at most 60 characters. */
export function safeName(value: string, fallback = '제목 없음'): string {
  const name = value
    .replace(/[<>:"/\|?*\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, '');
  return name && name !== '.' && name !== '..' ? name : fallback;
}

/** The folder of a jig id under the review role: its last part (`vide/massing` → `massing`). */
export const jigFolderName = (jigId: string) => safeName(jigId.split('/').pop() ?? jigId, 'jig');

/** A run folder's name: `<YYYY-MM-DD-HHmm>-<instance id 앞 8자리>`. */
export const runFolderName = (at: Date, instanceId: string) =>
  `${minuteOf(at)}-${instanceId.slice(0, 8)}`;
