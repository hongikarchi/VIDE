// Checking a jig's `panel.json` (SPEC-07.10, ARCH-03 §5.1) against the official part list of
// `src/ui/kit/registry.ts`. A panel is refused as a whole when it uses a part outside the list or
// outside its place, an unknown property, a colour value (`#…`, `rgb(…`, `hsl(…`) or a colour name
// that is not a token, a `custom-view`, or a binding to a step, setting or input the jig does not
// declare. Pure: the screen checks before drawing, and the engine can check at registration.

import type { ZodType } from 'zod';
import {
  NOT_READY,
  PART_NAMES,
  PART_PROPS,
  PLACES,
  SETTING,
  TONES,
  type LayerSpec,
  type PartName,
  type PartUse,
  type Place,
} from '../kit/registry.ts';

export interface PanelAction {
  id: string;
  label: string;
  step?: string;
  report?: string;
  /** Server confirmation level (SPEC-02.19); never shown on screen. */
  tier: 'T1' | 'T2';
}
export interface PanelSpec {
  layout: 'jig-run';
  left: PartUse[];
  center: { views: PartUse[]; board?: PartUse; kpis?: PartUse };
  drawer?: PartUse;
  actions: PanelAction[];
}
export interface PanelIssue {
  code:
    | 'PANEL_SCHEMA'
    | 'PANEL_PART_UNKNOWN'
    | 'PANEL_PART_NOT_READY'
    | 'PANEL_PART_PLACE'
    | 'PANEL_PROPERTY'
    | 'PANEL_COLOR'
    | 'PANEL_TOKEN'
    | 'PANEL_BINDING';
  path: string;
  message: string;
}
/** What the jig declares, for checking bindings (from `jig.json` or an instance view). */
export interface PanelScope {
  steps: readonly string[];
  params: readonly string[];
  inputs: readonly string[];
}

const COLOR = /^\s*(?:#|rgba?\(|hsla?\()/i;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Every string of a value with its path (for colour and token checks). */
function* strings(value: unknown, path: string): Generator<[string, string, string]> {
  if (typeof value === 'string') yield [path, value, path.split('.').at(-1) ?? ''];
  else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* strings(value[i], `${path}[${i}]`);
  } else if (isRecord(value))
    for (const [key, item] of Object.entries(value)) yield* strings(item, `${path}.${key}`);
}

/** Check a panel; `spec` is set only when there are no issues. */
export function validatePanel(
  raw: unknown,
  scope?: PanelScope,
): { spec?: PanelSpec; issues: PanelIssue[] } {
  const issues: PanelIssue[] = [];
  const issue = (code: PanelIssue['code'], path: string, message: string) =>
    issues.push({ code, path, message });
  if (!isRecord(raw))
    return { issues: [{ code: 'PANEL_SCHEMA', path: '', message: '객체가 아닙니다' }] };

  // Colours: values only, and only token names where a colour is asked for.
  for (const [path, value, key] of strings(raw, 'panel')) {
    if (COLOR.test(value)) issue('PANEL_COLOR', path, `색은 토큰 이름만 씁니다: ${value}`);
    else if (key === 'tone' && !(TONES as readonly string[]).includes(value))
      issue('PANEL_TOKEN', path, `목록에 없는 색 토큰: ${value}`);
  }

  const known = new Set<string>(PART_NAMES);
  const layerKeys = new Set<string>();
  const part = (value: unknown, place: Place, path: string): PartUse | undefined => {
    if (!isRecord(value) || typeof value.part !== 'string') {
      issue('PANEL_SCHEMA', path, '부품은 { "part": 이름, … } 입니다');
      return undefined;
    }
    const name = value.part;
    if (name === 'custom-view') {
      issue('PANEL_PART_UNKNOWN', path, '사용자 정의 화면은 이 버전에서 쓸 수 없습니다');
      return undefined;
    }
    if (!known.has(name)) {
      issue('PANEL_PART_UNKNOWN', path, `부품 목록에 없는 부품: ${name}`);
      return undefined;
    }
    if (NOT_READY.has(name as PartName)) {
      issue('PANEL_PART_NOT_READY', path, `아직 쓸 수 없는 부품: ${name}`);
      return undefined;
    }
    if (!(PLACES[place] as readonly string[]).includes(name)) {
      issue('PANEL_PART_PLACE', path, `${name}은(는) 이 자리에 둘 수 없습니다`);
      return undefined;
    }
    const { part: _part, ...props } = value;
    if (name === 'result-tabs') {
      const tabs = Array.isArray(props.tabs) ? props.tabs : undefined;
      const extra = Object.keys(props).filter((key) => key !== 'tabs');
      if (!tabs || !tabs.length || tabs.length > 12 || extra.length) {
        issue('PANEL_PROPERTY', path, '결과 서랍은 tabs(1~12개)만 받습니다');
        return undefined;
      }
      const checked = tabs.map((tab, i) => {
        const at = `${path}.tabs[${i}]`;
        if (!isRecord(tab) || typeof tab.title !== 'string' || !tab.title.trim()) {
          issue('PANEL_PROPERTY', at, '탭에는 title이 필요합니다');
          return undefined;
        }
        const { title, ...rest } = tab;
        const inner = part(rest, 'tab', at);
        return inner && { ...inner, title };
      });
      if (checked.some((tab) => !tab)) return undefined;
      return { part: 'result-tabs', tabs: checked as (PartUse & { title: string })[] };
    }
    const parsed = (PART_PROPS[name as PartName] as ZodType).safeParse(props);
    if (!parsed.success) {
      for (const problem of parsed.error.issues)
        // Colours were reported above as colour or token issues.
        if (problem.path.at(-1) !== 'tone')
          issue(
            'PANEL_PROPERTY',
            [path, ...problem.path.map(String)].join('.'),
            problem.code === 'unrecognized_keys'
              ? `목록에 없는 속성: ${problem.keys.join(', ')}`
              : problem.message,
          );
      return undefined;
    }
    const data = parsed.data as Record<string, unknown>;
    for (const layer of (data.layers as LayerSpec[] | undefined) ?? []) layerKeys.add(layer.key);
    return { part: name, ...data } as PartUse;
  };
  const list = (value: unknown, place: Place, path: string) => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      issue('PANEL_SCHEMA', path, '부품 목록이어야 합니다');
      return [];
    }
    return value.flatMap((item, i) => part(item, place, `${path}[${i}]`) ?? []);
  };

  const extra = Object.keys(raw).filter(
    (key) => !['layout', 'left', 'center', 'drawer', 'actions'].includes(key),
  );
  if (extra.length) issue('PANEL_PROPERTY', 'panel', `목록에 없는 속성: ${extra.join(', ')}`);
  if (raw.layout !== 'jig-run') issue('PANEL_SCHEMA', 'panel.layout', "layout은 'jig-run'입니다");
  const center = isRecord(raw.center) ? raw.center : undefined;
  if (!center) issue('PANEL_SCHEMA', 'panel.center', 'center가 필요합니다');
  else {
    const extraCenter = Object.keys(center).filter((k) => !['views', 'board', 'kpis'].includes(k));
    if (extraCenter.length)
      issue('PANEL_PROPERTY', 'panel.center', `목록에 없는 속성: ${extraCenter.join(', ')}`);
  }
  const left = list(raw.left, 'left', 'panel.left');
  const views = list(center?.views ?? [], 'views', 'panel.center.views');
  const board =
    center?.board === undefined ? undefined : part(center.board, 'board', 'panel.center.board');
  const kpis =
    center?.kpis === undefined ? undefined : part(center.kpis, 'kpis', 'panel.center.kpis');
  const drawer = raw.drawer === undefined ? undefined : part(raw.drawer, 'drawer', 'panel.drawer');

  const actions: PanelAction[] = [];
  if (raw.actions !== undefined && !Array.isArray(raw.actions))
    issue('PANEL_SCHEMA', 'panel.actions', '행동 목록이어야 합니다');
  for (const [i, action] of (Array.isArray(raw.actions) ? raw.actions : []).entries()) {
    const path = `panel.actions[${i}]`;
    const keys = isRecord(action) ? Object.keys(action) : [];
    const ok =
      isRecord(action) &&
      typeof action.id === 'string' &&
      /^[a-z][a-z0-9-]*$/.test(action.id) &&
      typeof action.label === 'string' &&
      action.label.trim().length > 0 &&
      action.label.length <= 40 &&
      (action.tier === 'T1' || action.tier === 'T2') &&
      (typeof action.step === 'string') !== (typeof action.report === 'string') &&
      keys.every((key) => ['id', 'label', 'step', 'report', 'tier'].includes(key));
    if (!ok) issue('PANEL_PROPERTY', path, '행동은 { id, label, step 또는 report, tier }입니다');
    else actions.push(action as unknown as PanelAction);
  }

  // Bindings: what the jig declares; overlay references: layers this panel draws.
  const check = (path: string, value: string) => {
    if (!scope) return;
    const [head, name] = value.startsWith('$') ? ['$', value.slice(1)] : value.split('.');
    const missing =
      head === 'step'
        ? !scope.steps.includes(name)
        : head === '$'
          ? !scope.params.includes(name)
          : head === 'inputs'
            ? !scope.inputs.includes(name)
            : false;
    if (missing) issue('PANEL_BINDING', path, `이 jig에 없는 연결: ${value}`);
  };
  const bindingKeys = ['from', 'param', 'input', 'rotate', 'warnAbove', 'bands'];
  for (const [path, value, key] of strings(raw, 'panel')) {
    const leaf = key.replace(/\[\d+\]$/, '');
    if (bindingKeys.includes(leaf) || (leaf === 'params' && SETTING.test(value)))
      check(path, value);
    if (leaf === 'overlay' && !layerKeys.has(value))
      issue('PANEL_BINDING', path, `이 화면에 없는 3D 층: ${value}`);
  }
  for (const [i, action] of actions.entries())
    if (action.step && scope && !scope.steps.includes(action.step))
      issue('PANEL_BINDING', `panel.actions[${i}].step`, `이 jig에 없는 단계: ${action.step}`);

  if (issues.length) return { issues };
  return {
    spec: {
      layout: 'jig-run',
      left,
      center: { views, ...(board ? { board } : {}), ...(kpis ? { kpis } : {}) },
      ...(drawer ? { drawer } : {}),
      actions,
    },
    issues,
  };
}

/** The declared names of a `jig.json` (or an instance view) for `validatePanel`. */
export function scopeOf(manifest: {
  steps: readonly { id: string }[];
  params: readonly { key: string }[];
  inputs: readonly { key: string }[];
}): PanelScope {
  return {
    steps: manifest.steps.map((s) => s.id),
    params: manifest.params.map((p) => p.key),
    inputs: manifest.inputs.map((i) => i.key),
  };
}
