// Jig icons on screen (PLAN-26 T-100, Design SCR-15·18): the lucide drawings of the fixed list in
// src/contracts/jig-icons.ts, drawn like the rail (24 x 24, stroke 2, currentColor), and a small
// memory of which instance or draft has which icon, so a conversation chip can show the icon of
// the jig its conversation belongs to. The jig screens fill the memory as they read instances and
// drafts. No DOM access at import: node tests import the chip code that reads this module.
import {
  BrickWall,
  Box,
  Building2,
  Calculator,
  Columns3,
  Compass,
  Database,
  DraftingCompass,
  Droplets,
  FileText,
  Flame,
  Gauge,
  GitCompare,
  Grid3x3,
  Layers,
  Link,
  ListChecks,
  MapPinned,
  Route,
  Ruler,
  Scale,
  Scan,
  Sigma,
  Spline,
  SquareDashed,
  Sun,
  Table,
  TrafficCone,
  Trees,
  Triangle,
  Waypoints,
  Wrench,
} from 'lucide';
import type { IconNode } from 'lucide';
import { createElement } from 'react';
import {
  DEFAULT_JIG_ICON,
  JIG_ICONS,
  LEGACY_JIG_ICONS,
  isJigIcon,
  type JigIcon,
} from '../contracts/jig-icons.ts';

/** Each listed name's drawing; inspector.ts merges these into its icon record. */
export const JIG_ICON_NODES: Record<JigIcon, IconNode> = {
  jig: Wrench,
  columns: Columns3,
  grid: Grid3x3,
  ruler: Ruler,
  'drafting-compass': DraftingCompass,
  layers: Layers,
  building: Building2,
  'brick-wall': BrickWall,
  'square-dashed': SquareDashed,
  scan: Scan,
  waypoints: Waypoints,
  spline: Spline,
  route: Route,
  'map-pin': MapPinned,
  compass: Compass,
  sun: Sun,
  droplets: Droplets,
  flame: Flame,
  trees: Trees,
  cone: TrafficCone,
  cube: Box,
  triangle: Triangle,
  calculator: Calculator,
  sigma: Sigma,
  scale: Scale,
  gauge: Gauge,
  table: Table,
  'list-checks': ListChecks,
  file: FileText,
  database: Database,
  link: Link,
  compare: GitCompare,
};
/** What each icon stands for, in the picker's labels (실무어). */
export const JIG_ICON_LABELS: Record<JigIcon, string> = {
  jig: '도구',
  columns: '골조',
  grid: '격자',
  ruler: '치수',
  'drafting-compass': '설계',
  layers: '층',
  building: '건물',
  'brick-wall': '벽',
  'square-dashed': '영역',
  scan: '검사',
  waypoints: '연결',
  spline: '곡선',
  route: '동선',
  'map-pin': '대지',
  compass: '방위',
  sun: '일조',
  droplets: '배수',
  flame: '방화',
  trees: '조경',
  cone: '공사',
  cube: '매스',
  triangle: '트러스',
  calculator: '계산',
  sigma: '물량',
  scale: '법규',
  gauge: '성능',
  table: '일람표',
  'list-checks': '점검',
  file: '보고서',
  database: '자료',
  link: '연계',
  compare: '대조',
};
export { JIG_ICONS, type JigIcon };

const attribute = (value: string | number | undefined) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
/** The icon a name stands for: a listed name, else the default. */
export const jigIcon = (name: unknown): JigIcon => (isJigIcon(name) ? name : DEFAULT_JIG_ICON);
/** An inline jig icon; an unknown or missing name draws the default. */
export function jigIconSvg(name?: unknown) {
  const node = JIG_ICON_NODES[jigIcon(name)];
  const inner = node
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .map(([key, value]) => `${key}="${attribute(value)}"`)
          .join(' ')}/>`,
    )
    .join('');
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}
/** The fixed icon of a built-in screen jig (its catalog id). */
export const legacyJigIcon = (jigId: string): JigIcon =>
  LEGACY_JIG_ICONS[jigId] ?? DEFAULT_JIG_ICON;

// --- Which instance or draft shows which icon -------------------------------------------------
const known = new Map<string, JigIcon>();
const listeners = new Set<() => void>();
let version = 0;
/** Remember the icon of a jig instance (`instanceId`) or a draft (`draft:<id>`). */
export function noteJigIcon(key: string, icon: unknown) {
  const value = jigIcon(icon);
  if (known.get(key) === value) return;
  known.set(key, value);
  version++;
  for (const listener of listeners) listener();
}
/** The remembered icon of an instance or draft key. */
export const jigIconOf = (key: string | null | undefined): JigIcon | undefined =>
  key ? known.get(key) : undefined;
/** For useSyncExternalStore: a chip redraws when an icon becomes known. */
export function subscribeJigIcons(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
export const jigIconsVersion = () => version;

/** A jig's icon as a React element (cards, dashboard tiles, chips); hidden from screen readers. */
export const JigIconMark = ({ icon }: { icon?: unknown }) =>
  createElement('span', {
    className: 'jig-icon',
    'aria-hidden': true,
    dangerouslySetInnerHTML: { __html: jigIconSvg(icon) },
  });
