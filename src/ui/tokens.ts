// Colours from tokens.css for places that need a concrete #rrggbb (the 3D view, canvas drawing).
// The stylesheet's value wins; these light values are used before it loads (and in tests).

/** Light values of the judgement, overlay and point-colour tokens (tokens.css :root). */
export const TOKEN_FALLBACK = {
  ok: '#2f7d4f',
  warn: '#a8660b',
  ng: '#b42323',
  na: '#a0a0a0',
  info: '#2f5aa8',
  accent: '#d0664a',
  'ov-grid': '#737373',
  'ov-new': '#121212',
  'ov-existing': '#a0a0a0',
  'ov-clash': '#b42323',
  'ov-cat-1': '#4e79a7',
  'ov-cat-2': '#f28e2b',
  'ov-cat-3': '#59a14f',
  'ov-cat-4': '#b07aa1',
  'ov-cat-5': '#76b7b2',
  'ov-cat-6': '#edc948',
  'ov-cat-7': '#9c755f',
  'ov-cat-8': '#ff9da7',
  'ov-cat-9': '#86bcb6',
  'ov-cat-10': '#8cd17d',
  'ov-cat-11': '#a0cbe8',
  'ov-cat-12': '#d4a6c8',
} as const;
export type ColorToken = keyof typeof TOKEN_FALLBACK;

/** The token's current value (theme-aware) as #rrggbb. */
export function tokenColor(name: ColorToken): string {
  const css =
    typeof document === 'undefined'
      ? ''
      : getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  return /^#[0-9a-f]{6}$/i.test(css) ? css : TOKEN_FALLBACK[name];
}
