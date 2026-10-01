// Light / dark theme of the work screen (user request 2026-10-01). tokens.css holds both token
// sets; the dark set applies under :root[data-theme='dark']. The rail's toggle chooses one and
// this browser remembers it. A host panel (Rhino / ZWCAD) follows the host's theme instead and
// never stores it. The 3D view's 'auto' background follows the theme (THEME_CHANGED).
export type Theme = 'light' | 'dark';
export const THEME_CHANGED = 'vide:theme-changed';
const KEY = 'vide:theme';

export const currentTheme = (): Theme =>
  document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';

/** The theme this browser chose last (light when none or the storage refuses). */
export function storedTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** Apply a theme; `remember` keeps it for the next load (not for a host panel). */
export function setTheme(theme: Theme, remember = true) {
  document.documentElement.dataset.theme = theme;
  if (remember)
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* A viewer convenience only; the theme still changes for this page. */
    }
  dispatchEvent(new Event(THEME_CHANGED));
}
