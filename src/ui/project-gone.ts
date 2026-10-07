// A project that disappeared while open (T-191): the site's clean-up or another window removed it.
// On 2026-10-06 a window kept polling such a project for 40 minutes (~1,500 NOT_FOUND). The gateway
// reports every project-scoped NOT_FOUND here; the first one for the open project re-reads the
// project list, and when the project is not in it the window leaves it (`leave`) and the gateway
// answers every later call for it at once, without asking the engine (`isProjectGone`).

export const PROJECT_GONE_TEXT = '프로젝트가 삭제되어 목록으로 돌아갑니다';
/** Codes that can mean the project itself is gone (a missing request answers NOT_FOUND too). */
const MISSING = new Set(['NOT_FOUND', 'PROJECT_NOT_FOUND']);
const gone = new Set<string>();
const events = new EventTarget();

/** The project id of an engine path (`/projects/<id>/…`), or undefined for other paths. */
export function projectOfPath(path: string): string | undefined {
  const id = /^\/projects\/([^/?#]+)/.exec(path)?.[1];
  if (!id) return undefined;
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

/** True for a call to a project already known to be gone: the gateway answers it itself. */
export function isProjectGone(path: string) {
  const id = projectOfPath(path);
  return !!id && gone.has(id);
}

/** The gateway's report of a failed call: a project-scoped NOT_FOUND may mean the project is gone. */
export function noteProjectError(path: string, code: string) {
  if (!MISSING.has(code)) return;
  const id = projectOfPath(path);
  if (id) events.dispatchEvent(new CustomEvent('missing', { detail: id }));
}

export interface ProjectGoneOptions {
  /** The open project's id. */
  current: () => string | undefined;
  /** The engine's project list (GET /projects). */
  listProjects: () => Promise<{ id: string }[]>;
  /** The project is gone: tell the user and go to the project list. */
  leave: (id: string) => void;
  /** After a check that found the project, later NOT_FOUNDs wait this long (default 30 s). */
  recheckMs?: number;
  now?: () => number;
}

/** Watches for the open project disappearing; returns a function that stops watching. */
export function watchProjectGone(options: ProjectGoneOptions) {
  const now = options.now ?? Date.now;
  const recheckMs = options.recheckMs ?? 30_000;
  let checking = false;
  let checkedAt = -Infinity;
  const onMissing = async (event: Event) => {
    const id = (event as CustomEvent<string>).detail;
    if (id !== options.current() || gone.has(id) || checking) return;
    if (now() - checkedAt < recheckMs) return;
    checking = true;
    try {
      const projects = await options.listProjects();
      if (projects.some((project) => project.id === id)) return;
      gone.add(id);
      options.leave(id);
    } catch {
      /* The list could not be read: a later NOT_FOUND asks again. */
    } finally {
      checkedAt = now();
      checking = false;
    }
  };
  events.addEventListener('missing', onMissing);
  return () => events.removeEventListener('missing', onMissing);
}
