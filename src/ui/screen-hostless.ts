import { FILE_WORDS } from './request-route.ts';

/**
 * Requests sent from the screens about the project's records (노트·일지, 대시보드, 자료) do not use
 * the host (T-190, SPEC-04.12 2): a note summary there must not connect to Rhino first. The model,
 * 이력 and JIG screens keep the host as before.
 */
const HOSTLESS_SCREENS = new Set(['notes', 'dashboard', 'data']);
/** A host document attached as a file or a path chip: the request is about that file. */
const HOST_FILE = /\.(3dm|dwg|dxf|gh|ghx)$/i;

interface HostlessDraft {
  body: string;
  pins: readonly unknown[];
  sketches: readonly unknown[];
  files: readonly { name: string }[];
  paths?: readonly { path: string }[];
  linkedTargets?: unknown;
  baseRequestId?: string | null;
}
/**
 * Whether a new request sent from `screen` goes without the host (`hostUse: 'none'`): sent from a
 * records screen, with no pins, sketches, linked targets, Sync basis or attached host file, and
 * words that do not name the file or program (`FILE_WORDS`: "원본", "도면에서", "라이노에서"…).
 * Change words alone ("추가", "수정") stay hostless here: on these screens they are about notes
 * and 할 일, and the AI still reads the host through a model-screen request when asked there.
 */
export function hostlessFromScreen(screen: string, draft: HostlessDraft): boolean {
  if (!HOSTLESS_SCREENS.has(screen)) return false;
  if (draft.pins.length || draft.sketches.length || draft.linkedTargets) return false;
  if (draft.baseRequestId) return false;
  if (draft.files.some((file) => HOST_FILE.test(file.name))) return false;
  if ((draft.paths ?? []).some((entry) => HOST_FILE.test(entry.path))) return false;
  return !FILE_WORDS.test(draft.body);
}
