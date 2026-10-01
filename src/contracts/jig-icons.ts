// The icons a jig may name in `jig.json` `icon` (SPEC-07.2, ARCH-03 §3, PLAN-26 T-100; user
// decision 2026-10-01): a fixed list drawn like the rail's icons, shared by the manifest check
// (src/jigs/runtime/manifest.ts) and the screen (src/ui/jig-icons.ts, which maps each name to its
// lucide drawing). An icon is how a jig looks in the lists, never a sign of trust or of what it may
// do. A jig without one, or with a name the screen does not know, shows `jig`.

export const JIG_ICONS = [
  'jig',
  'columns',
  'grid',
  'ruler',
  'drafting-compass',
  'layers',
  'building',
  'brick-wall',
  'square-dashed',
  'scan',
  'waypoints',
  'spline',
  'route',
  'map-pin',
  'compass',
  'sun',
  'droplets',
  'flame',
  'trees',
  'cone',
  'cube',
  'triangle',
  'calculator',
  'sigma',
  'scale',
  'gauge',
  'table',
  'list-checks',
  'file',
  'database',
  'link',
  'compare',
] as const;
export type JigIcon = (typeof JIG_ICONS)[number];
export const DEFAULT_JIG_ICON: JigIcon = 'jig';
export const isJigIcon = (name: unknown): name is JigIcon =>
  typeof name === 'string' && (JIG_ICONS as readonly string[]).includes(name);

/**
 * The built-in screen jigs (Sync, 구조 분석, 프로젝트 자료) have no `jig.json`; their icons are
 * fixed here. Other catalog entries without a package show the default.
 */
export const LEGACY_JIG_ICONS: Record<string, JigIcon> = {
  sync: 'compare',
  structure: 'columns',
  knowledge: 'database',
};
