// The icon set of the work screen (moved from inspector.ts, PLAN-26 T-113): iconSvg() for code that
// draws an icon and paintIcons() for the static `data-icon` buttons of the shell.
import {
  ArrowUp,
  Box,
  Cuboid,
  Database,
  Expand,
  FileOutput,
  Eye,
  EyeOff,
  FileText,
  Focus,
  FolderOpen,
  Footprints,
  Grid2x2Plus,
  Hammer,
  History,
  House,
  Layers,
  LayoutDashboard,
  ListPlus,
  MessageSquare,
  Moon,
  MousePointer2,
  NotebookPen,
  Paperclip,
  Pencil,
  Pin,
  Pyramid,
  RefreshCw,
  Search,
  Slice,
  Sun,
  Trash2,
  Wrench,
  X,
} from 'lucide';
import type { IconNode } from 'lucide';
import { JIG_ICON_NODES } from './jig-icons.ts';
// Icon shapes are lucide's (ISC licence, https://lucide.dev), as in 참고 앱 A: 24 x 24, stroke 2.
// The names stay VIDE's own so data-icon attributes and iconSvg() callers do not change.
// The jig icons (PLAN-26 T-100) come first; VIDE's own names below keep their drawings.
const icons: Record<string, IconNode> = {
  ...JIG_ICON_NODES,
  extension: Grid2x2Plus,
  jig: Wrench,
  // View: perspective (converging) and parallel projection, fit selection, fit all.
  perspective: Pyramid,
  orthographic: Cuboid,
  'fit-selection': Focus,
  'fit-all': Expand,
  walk: Footprints,
  section: Slice,
  home: House,
  layers: Layers,
  history: History,
  file: FileText,
  cursor: MousePointer2,
  pin: Pin,
  pencil: Pencil,
  cube: Box,
  paperclip: Paperclip,
  send: ArrowUp,
  'list-plus': ListPlus,
  trash: Trash2,
  dashboard: LayoutDashboard,
  database: Database,
  notebook: NotebookPen,
  message: MessageSquare,
  moon: Moon,
  sun: Sun,
  eye: Eye,
  'eye-off': EyeOff,
  refresh: RefreshCw,
  x: X,
  'folder-open': FolderOpen,
  search: Search,
  // The rail's 만들기 and 산출물 destinations.
  make: Hammer,
  output: FileOutput,
};
const attribute = (value: string | number | undefined) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
const markup = (node: IconNode | undefined) =>
  (node ?? [])
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .map(([key, value]) => `${key}="${attribute(value)}"`)
          .join(' ')}/>`,
    )
    .join('');
/** An inline icon (same set as the data-icon buttons). */
export function iconSvg(name: string) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${markup(icons[name])}</svg>`;
}
/**
 * Fills every `[data-icon]` node that has no children yet with its icon. A node that already has
 * children (an icon drawn by a component) is left as it is.
 */
export function paintIcons(root: ParentNode = document) {
  for (const node of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    if (node.firstChild) continue;
    node.innerHTML = iconSvg(node.dataset.icon ?? '');
  }
}
