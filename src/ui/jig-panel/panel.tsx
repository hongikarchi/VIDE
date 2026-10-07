import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { OverlayItem } from '../viewport.ts';
import type { LegendSpec, PartOf, PartUse } from '../kit/registry.ts';
import { ConflictBanner, RoleCards, type RoleCardData } from '../kit/cards.tsx';
import {
  FactBadge,
  SettingGroup,
  SettingRow,
  SliderBoard,
  type SettingControl,
} from '../kit/settings.tsx';
import {
  KpiStrip,
  StepRail,
  VerdictLegend,
  type RailState,
  type RailStep,
} from '../kit/status.tsx';
import { DataTable, ResultTabs } from '../kit/tables.tsx';
import { OverlayControls, PlanMap } from '../kit/views.tsx';
import {
  BAND_ORDER,
  BAND_SYMBOL,
  BAND_TEXT,
  bandCounts,
  bandsOf,
  cellText,
  columnsOf,
  fieldOf,
  formatNumber,
  layerItems,
  resolve,
  rowsOf,
  stepOf,
  type Band,
  type PanelData,
} from './bindings.ts';
import { BakePart } from './bake-parts.tsx';
import { SitePicker } from './site-parts.tsx';
import { JigSource } from './source-parts.tsx';
import { useInstance, type InstanceView, type StepReport } from './instance.ts';
import { InstanceReportPart, renderReportPart } from './report-parts.tsx';
import { scopeOf, validatePanel, type PanelAction } from './spec.ts';

// The declarative jig screen (SPEC-07.10, ARCH-03 §5.1, Design SCR-13): a checked `panel.json`
// drawn with the official parts and bound to one instance. Results go to the viewport as overlay
// layers (never into the document); a table row frames its item in 3D and a picked overlay item
// selects its row; moving a setting recomputes through the jig runner. Server confirmation
// levels of actions stay off the screen. In a jig's context tab the KPI strip and view switch go
// above the 3D view, the slider board over it and the result drawer below it (the host's slots);
// without slots everything stays in the panel.

/** What the panel needs from the app (a subset of the JIG panel's context). */
export interface PanelHost {
  projectId: string;
  overlay: (key: string, items: OverlayItem[] | null) => void;
  focus: (target: { overlay: string; itemId?: string }) => void;
  clearTint?: () => void;
  onOverlayPick?: (listener: (hit: { key: string; itemId: string }) => void) => () => void;
  overlayStyle?: (key: string, style: { visible?: boolean; opacity?: number }) => void;
  /** The project's Syncs; jig input reads come from them. */
  sources?: readonly { id: string; host: string }[];
  /** Layer paths in the linked documents' Syncs. */
  layers?: readonly string[];
  /**
   * Frame one object of the linked document (the bake card's preserved objects); resolves to why
   * it could not be shown (e.g. no Sync holds it yet), or undefined once shown.
   */
  focusObject?: (nativeId: string) => void | Promise<string | undefined>;
  /** Open one of this instance's reports in 산출물 → 보고서; omitted where there is no such tab. */
  openReport?: (reportId: string) => void;
  /** Regions beside the panel (Design SCR-13): above the 3D view, over it, below it. */
  slots?: { top?: HTMLElement; board?: HTMLElement; drawer?: HTMLElement };
}

const glob = (pattern: string) =>
  new RegExp(
    '^' +
      pattern
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
    'i',
  );

const BY: Record<string, string> = {
  code: '계산',
  library: '라이브러리',
  ai: 'AI',
  human: '사람',
  host: '호스트',
};
const ERRORS: Record<string, string> = {
  BUDGET: '계산 시간 상한을 넘었습니다.',
  SCHEMA: '결과가 도구 설명의 형식과 다릅니다.',
  AI_UNAVAILABLE: 'AI 단계는 아직 실행되지 않습니다.',
};
const CONTROL: Partial<Record<PartUse['part'], SettingControl>> = {
  slider: 'slider',
  stepper: 'stepper',
  toggle: 'toggle',
  choice: 'choice',
};

const PREVIEW = '미확정 미리보기';
/** Whether a step's kept output is only a preview (never shown as a final result, SPEC-06.3). */
export function isPreviewOutput(output: unknown): boolean {
  if (!output || typeof output !== 'object') return false;
  const value = output as { mode?: unknown; previewOnly?: unknown; summary?: unknown };
  if (value.mode === 'preview' || value.previewOnly === true) return true;
  const summary = value.summary as { mode?: unknown; confirmed?: unknown } | null | undefined;
  return (
    !!summary &&
    typeof summary === 'object' &&
    (summary.mode === 'preview' || summary.confirmed === false)
  );
}
/**
 * A KPI cell's note with the '미확정 미리보기' label exactly when its value comes from a preview:
 * added when the jig did not write it, dropped when the value is a confirmed result.
 */
export function kpiNote(note: string | undefined, preview: boolean): string | undefined {
  const rest = (note ?? '')
    .split(' · ')
    .map((part) => part.trim())
    .filter((part) => part && part !== PREVIEW);
  const parts = preview ? [PREVIEW, ...rest] : rest;
  return parts.length ? parts.join(' · ') : undefined;
}

/** One rail row from the stored step, the latest run and the pending changes. */
function railStep(
  step: InstanceView['steps'][number],
  report: StepReport | undefined,
  stale: boolean,
): RailStep {
  const fromReport: Record<string, RailState> = {
    done: 'done',
    failed: 'failed',
    'gate-failed': 'failed',
    waiting: 'waiting',
    confirmed: 'confirmed',
    reconfirm: 'reconfirm',
    blocked: 'blocked',
  };
  const fromStore: Record<string, RailState> = {
    pending: 'pending',
    running: 'running',
    done: 'done',
    failed: 'failed',
    stale: 'stale',
    waiting: 'waiting',
    confirmed: 'confirmed',
    reconfirm: 'reconfirm',
  };
  const state: RailState = stale
    ? 'stale'
    : ((report && fromReport[report.status]) ?? fromStore[step.status] ?? 'pending');
  const gates = report?.gates ?? step.gates ?? [];
  const blocking = gates.filter((g) => !g.ok && g.level === 'block').map((g) => g.message);
  const reason =
    state !== 'failed'
      ? state === 'blocked'
        ? '앞 단계를 먼저 끝내야 합니다.'
        : undefined
      : report?.error
        ? (ERRORS[report.error.code] ?? report.error.message.replace(/^[A-Z][A-Z0-9_]*:\s*/, ''))
        : blocking.join(' · ') || undefined;
  return {
    id: step.id,
    title: step.title,
    by: BY[step.kind] ?? step.kind,
    state,
    ms: report?.ms ?? step.ms,
    unchanged: state === 'done' && !!report?.cached,
    problems: gates.filter((g) => !g.ok).length || undefined,
    reason,
    confirm: step.kind === 'human' && (state === 'waiting' || state === 'reconfirm') && !!report,
  };
}

function Drawer({
  tabs,
  selection,
}: {
  tabs: { id: string; title: string; count?: number; select?: string; content: ReactNode }[];
  selection?: { key: string };
}) {
  const [active, setActive] = useState(tabs[0]?.id ?? '');
  // A new selection (3D, plan or a table) opens the tab that lists it; the tabs themselves are
  // rebuilt on every render, so only the selection triggers this.
  useEffect(() => {
    const tab = selection && tabs.find((t) => t.select === selection.key);
    if (tab) setActive(tab.id);
  }, [selection]);
  return <ResultTabs tabs={tabs} active={active} onActive={setActive} />;
}

export function JigPanel({
  host,
  panel,
  instanceId,
}: {
  host: PanelHost;
  /** The jig's `panel.json` as read; it is checked here against what the jig declares. */
  panel: unknown;
  instanceId: string;
}) {
  const jig = useInstance(host.projectId, instanceId);
  const { view } = jig;
  // Checked once per instance: what the jig declares does not change with its values.
  const checked = useMemo(
    () => (view ? validatePanel(panel, scopeOf(view)) : undefined),
    [panel, view?.id],
  );
  const spec = checked?.spec;
  const [selection, setSelection] = useState<{ key: string; id: string }>();
  const [colored, setColored] = useState(true);
  const [only, setOnly] = useState<Record<string, Band | undefined>>({});
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [opacity, setOpacity] = useState<Record<string, number>>({});
  const [viewTab, setViewTab] = useState(0);
  const [asking, setAsking] = useState<PanelAction>();
  /** Why an object asked for from the bake card was not shown. */
  const [focusNote, setFocusNote] = useState('');
  const data: PanelData = useMemo(
    () => ({ outputs: jig.outputs, params: view?.params ?? [] }),
    [jig.outputs, view?.params],
  );

  // 3D overlay layers: drawn while the panel is open, taken off when it goes.
  const overlayLayers = useMemo(
    () =>
      spec?.center.views.flatMap((part) => (part.part === 'viewport-overlay' ? part.layers : [])) ??
      [],
    [spec],
  );
  const drawn = useMemo(
    () =>
      new Map(
        overlayLayers.map((layer) => [
          layer.key,
          layerItems(layer, data, { verdict: colored, only: only[layer.key] }),
        ]),
      ),
    [overlayLayers, data, colored, only],
  );
  useEffect(() => {
    for (const [key, items] of drawn) host.overlay(key, hidden.has(key) ? null : items);
  }, [drawn, hidden, host]);
  const keys = useRef<string[]>([]);
  keys.current = overlayLayers.map((layer) => layer.key);
  useEffect(
    () => () => {
      for (const key of keys.current) host.overlay(key, null);
    },
    [host],
  );
  useEffect(
    () => host.onOverlayPick?.((hit) => setSelection({ key: hit.key, id: hit.itemId })),
    [host],
  );
  const select = (key: string, id: string) => {
    setSelection({ key, id });
    if (drawn.has(key) && !hidden.has(key)) host.focus({ overlay: key, itemId: id });
  };
  const focusObject = host.focusObject
    ? (nativeId: string) => {
        setFocusNote('');
        void Promise.resolve(host.focusObject?.(nativeId)).then(
          (reason) => reason && setFocusNote(reason),
          () => setFocusNote('객체를 보여 주지 못했습니다.'),
        );
      }
    : undefined;

  if (!view)
    return (
      <div className="kit-panel">
        <p className="kit-muted" role="status">
          {jig.notice ?? '여는 중…'}
        </p>
      </div>
    );
  if (!spec)
    return (
      <div className="kit-panel">
        <p className="kit-notice" data-level="error" role="alert">
          이 jig의 화면 구성에 목록에 없는 부품이나 값이 있어 열지 않았습니다.
        </p>
        <ul className="kit-issues">
          {(checked?.issues ?? []).map((issue, i) => (
            <li key={i}>
              {issue.message} <small>{issue.path}</small>
            </li>
          ))}
        </ul>
      </div>
    );

  const settings = view.params;
  const values = {
    ...Object.fromEntries(settings.map((s) => [s.key, s.value])),
    ...jig.pending,
  };
  const settingsOf = (refs?: readonly string[], group?: string) =>
    refs
      ? refs.flatMap((ref) => settings.find((s) => s.key === ref.slice(1)) ?? [])
      : group
        ? settings.filter((s) => s.group === group)
        : settings;
  const busy = jig.busy;
  const change = jig.change;
  const isStale = (binding?: string) => {
    const step = stepOf(binding);
    return !!step && jig.stale.has(step);
  };

  const legendOf = (legend: Omit<LegendSpec, 'part'>) => {
    const rows = rowsOf(resolve(legend.from, data));
    const bands = bandsOf(legend.bands, data);
    const counts = bandCounts(rows, legend.field, bands);
    const n = (value: number) => formatNumber(value);
    const range: Record<Band, string> = bands
      ? {
          ok: `< ${n(bands[0])}`,
          warn: `${n(bands[0])}~${n(bands[1])}`,
          ng: `≥ ${n(bands[1])}`,
          na: '',
        }
      : { ok: '', warn: '', ng: '', na: '' };
    const layer = legend.overlay;
    return (
      <VerdictLegend
        title={legend.title ?? '판정'}
        total={rows.length}
        bands={BAND_ORDER.filter((band) => band !== 'na' || counts.na).map((band) => ({
          band,
          symbol: BAND_SYMBOL[band],
          text: BAND_TEXT[band],
          range: range[band],
          count: counts[band],
        }))}
        only={layer ? only[layer] : undefined}
        colored={colored}
        onOnly={(band) => {
          if (layer) setOnly((current) => ({ ...current, [layer]: band }));
        }}
        onColored={(on) => {
          setColored(on);
          if (!on) host.clearTint?.();
        }}
      />
    );
  };
  const rowId = (keyField: string) => (row: Record<string, unknown>, index: number) => {
    const value = fieldOf(row, keyField);
    return typeof value === 'string' || typeof value === 'number' ? String(value) : String(index);
  };
  const tableOf = (part: PartOf<'table' | 'issue-table' | 'schedule'>, label: string) => {
    const rows = rowsOf(resolve(part.from, data));
    const key = part.overlay ?? `table:${part.from}`;
    return (
      <DataTable
        variant={part.part}
        label={label}
        rows={rows}
        columns={columnsOf(rows, part.columns)}
        rowId={rowId(part.key ?? 'key')}
        selected={selection?.key === key ? selection.id : undefined}
        onRow={(id) => select(key, id)}
        csvName={part.csv}
      />
    );
  };
  const roleCards = (part: PartOf<'role-card'>) => {
    const input = view.inputs.find((i) => `inputs.${i.key}` === part.input);
    if (!input) return null;
    if (input.kind !== 'assembly')
      return (
        <div className="kit-card">
          <strong>{input.title}</strong>
          <span className="kit-muted">구역 {(view.body.zones?.[input.key] ?? []).length}개</span>
        </div>
      );
    const roles: RoleCardData[] = (input.roles ?? [])
      .filter((r) => !part.roles || part.roles.includes(r.role) || part.roles.includes(r.title))
      .map((r) => {
        const key = `${input.key}.${r.role}`;
        const assembled = view.body.assembly[key];
        const found = jig.proposals[key];
        return {
          key,
          title: r.title,
          required: r.required,
          state: assembled?.confirmed ? 'confirmed' : assembled ? 'proposed' : 'missing',
          source: assembled?.sources.map((s) => s.layers.join(', ')).join(' · '),
          candidates: found?.map((c, i) => ({
            id: String(i),
            label: c.layer,
            detail: `${c.objectCount}개 · ${c.reason}`,
          })),
        };
      });
    return (
      <RoleCards
        title={input.title}
        roles={roles}
        busy={busy}
        onFind={(key) => {
          // The Sync layers whose names fit the role's hints (the engine proposes among them).
          const role = input.roles?.find((r) => `${input.key}.${r.role}` === key) as
            | { hints?: { layers?: string[]; words?: string[] } }
            | undefined;
          const patterns = (role?.hints?.layers ?? []).map(glob);
          const words = (role?.hints?.words ?? []).map((w) => w.toLowerCase());
          const layers = (host.layers ?? []).filter((path) => {
            const name = path.split('::').at(-1) ?? path;
            return (
              patterns.some((p) => p.test(path) || p.test(name)) ||
              words.some((w) => path.toLowerCase().includes(w))
            );
          });
          void jig.findRole(
            key,
            (host.sources ?? []).map((s) => s.id),
            layers,
          );
        }}
        onConfirm={(key, candidate) =>
          void jig.confirmRole(
            key,
            candidate === undefined ? undefined : jig.proposals[key]?.[Number(candidate)],
          )
        }
      />
    );
  };

  const render = (part: PartUse, key: string): ReactNode => {
    switch (part.part) {
      case 'step-rail':
        return (
          <section key={key} className="kit-section">
            <h4>{part.title ?? '단계'}</h4>
            <StepRail
              steps={view.steps.map((step) =>
                railStep(step, jig.reports[step.id], jig.stale.has(step.id)),
              )}
              busy={busy}
              onConfirm={(id) => void jig.confirmStep(id)}
            />
          </section>
        );
      case 'param-group':
        return (
          <SettingGroup
            key={key}
            title={part.title}
            settings={settingsOf(part.params, part.group)}
            values={values}
            disabled={busy}
            onChange={change}
          />
        );
      case 'slider':
      case 'stepper':
      case 'toggle':
      case 'choice': {
        const setting = settingsOf([part.param])[0];
        return setting ? (
          <SettingRow
            key={key}
            setting={setting}
            value={values[setting.key]}
            control={CONTROL[part.part]}
            disabled={busy}
            onChange={(value, phase) => change(setting.key, value, phase)}
          />
        ) : null;
      }
      case 'slider-board':
        return (
          <SliderBoard
            key={key}
            title={part.title}
            settings={part.params ? settingsOf(part.params) : settings.filter((s) => s.board)}
            values={values}
            disabled={busy}
            onChange={change}
          />
        );
      case 'fact-badge': {
        const setting = settingsOf([part.param])[0];
        return setting ? <FactBadge key={key} setting={setting} /> : null;
      }
      case 'role-card':
        return <div key={key}>{roleCards(part)}</div>;
      case 'kpi-strip':
        return (
          <KpiStrip
            key={key}
            items={part.items.map((item) => {
              const value = resolve(item.from, data);
              const limit =
                typeof item.warnAbove === 'string' ? resolve(item.warnAbove, data) : item.warnAbove;
              const shown = value !== undefined && value !== null;
              const step = stepOf(item.from);
              return {
                label: item.label,
                value: shown ? cellText(value, item.decimals) : undefined,
                unit: item.unit,
                note: kpiNote(item.note, shown && !!step && isPreviewOutput(jig.outputs[step])),
                over: typeof value === 'number' && typeof limit === 'number' && value > limit,
                empty: item.empty,
                stale: isStale(item.from),
              };
            })}
          />
        );
      case 'verdict-legend':
        return (
          <section key={key} className="kit-section">
            {legendOf(part)}
          </section>
        );
      case 'viewport-overlay':
        return (
          <div key={key} className="kit-side">
            <OverlayControls
              layers={part.layers.map((layer) => ({
                key: layer.key,
                title: layer.title ?? layer.key,
                count: drawn.get(layer.key)?.length ?? 0,
                visible: !hidden.has(layer.key),
                opacity: opacity[layer.key],
              }))}
              onVisible={(layer, on) =>
                setHidden((current) => {
                  const next = new Set(current);
                  if (on) next.delete(layer);
                  else next.add(layer);
                  return next;
                })
              }
              onOpacity={
                host.overlayStyle
                  ? (layer, value) => {
                      setOpacity((current) => ({ ...current, [layer]: value }));
                      host.overlayStyle?.(layer, { opacity: value });
                    }
                  : undefined
              }
            />
            {part.legend ? legendOf(part.legend) : null}
          </div>
        );
      case 'plan-map': {
        const turn = part.rotate ? resolve(part.rotate, data) : undefined;
        return (
          <PlanMap
            key={key}
            title={part.title}
            layers={part.layers.map((layer) => ({
              key: layer.key,
              items: hidden.has(layer.key)
                ? []
                : layerItems(layer, data, { verdict: colored, only: only[layer.key] }),
            }))}
            rotate={typeof turn === 'number' ? turn : 0}
            selected={selection}
            onPick={select}
          />
        );
      }
      case 'issue-table':
      case 'table':
      case 'schedule':
        return (
          <section key={key} className="kit-section">
            {part.title ? <h4>{part.title}</h4> : null}
            {tableOf(part, part.title ?? '결과')}
          </section>
        );
      case 'result-tabs':
        return (
          <Drawer
            key={key}
            selection={selection}
            tabs={part.tabs.map((tab, i) => {
              const isTable =
                tab.part === 'table' || tab.part === 'issue-table' || tab.part === 'schedule';
              return {
                id: String(i),
                title: tab.title,
                count: isTable ? rowsOf(resolve(tab.from, data)).length : undefined,
                select: isTable ? (tab.overlay ?? `table:${tab.from}`) : undefined,
                content: isTable ? tableOf(tab, tab.title) : render(tab, `${key}.${i}`),
              };
            })}
          />
        );
      case 'bake-card':
        // [선만 먼저 만들기]·[부재 만들기], what the candidate changes, the records and the
        // baseline read (bake-parts.tsx); read again after each run.
        return (
          <div key={key}>
            <BakePart
              projectId={host.projectId}
              instanceId={instanceId}
              title={part.title}
              bake={part.bake}
              revision={jig.lastRun?.getTime()}
              onRecompute={() => void jig.recompute()}
              onFocus={focusObject}
            />
            {focusNote ? (
              <p className="kit-muted" role="status">
                {focusNote}
              </p>
            ) : null}
          </div>
        );
      case 'site-picker':
        return (
          <SitePicker
            key={key}
            projectId={host.projectId}
            instanceId={instanceId}
            inputKey={part.input.slice('inputs.'.length)}
            title={part.title}
            jig={jig}
          />
        );
      case 'jig-source':
        return (
          <JigSource
            key={key}
            projectId={host.projectId}
            instanceId={instanceId}
            inputKey={part.input.slice('inputs.'.length)}
            title={part.title}
            jig={jig}
          />
        );
      case 'compare-bars':
      case 'ledger':
        return renderReportPart(part, key, data);
      case 'report':
        return (
          <InstanceReportPart
            key={key}
            projectId={host.projectId}
            instanceId={instanceId}
            reportId={part.report}
            revision={jig.lastRun?.getTime()}
          />
        );
      case 'conflict-banner':
        return (
          <ConflictBanner
            key={key}
            items={rowsOf(resolve(part.from, data)).flatMap((row) =>
              typeof row.label === 'string' && typeof row.count === 'number'
                ? [{ label: row.label, count: row.count }]
                : [],
            )}
          />
        );
      default:
        return null;
    }
  };

  const views = spec.center.views;
  const shownView = views[Math.min(viewTab, views.length - 1)];
  const titleOf = (part: PartUse) =>
    ('title' in part && typeof part.title === 'string' && part.title) ||
    (part.part === 'plan-map' ? '평면' : part.part === 'viewport-overlay' ? '3D' : '보기');
  const stepTitle = (id?: string) => view.steps.find((s) => s.id === id)?.title ?? '';
  const slots = host.slots ?? {};
  const kpis = spec.center.kpis ? render(spec.center.kpis, 'kpis') : null;
  const switcher =
    views.length > 1 ? (
      <div className="kit-view-tabs" role="tablist" aria-label="보기">
        {views.map((part, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={part === shownView}
            onClick={() => setViewTab(i)}
          >
            {titleOf(part)}
          </button>
        ))}
      </div>
    ) : null;
  // The centre head (Design SCR-13): KPI strip, view switch and the shown view's content.
  const center = (
    <>
      {kpis}
      {switcher}
      {shownView ? <div className="kit-view">{render(shownView, 'view')}</div> : null}
    </>
  );
  const board = spec.center.board ? render(spec.center.board, 'board') : null;
  const drawer = spec.drawer ? render(spec.drawer, 'drawer') : null;
  // Parts that live beside the panel in a context tab keep the kit's look there.
  const beside = (node: ReactNode, slot: HTMLElement | undefined, name: string) =>
    node && slot
      ? createPortal(
          <div className="kit-panel kit-slot" data-slot={name}>
            {node}
          </div>,
          slot,
        )
      : null;
  return (
    <div
      className="kit-panel"
      data-jig-panel={view.jig.id}
      data-slotted={slots.top ? '' : undefined}
    >
      <header className="kit-head">
        {slots.top ? null : <h3>{view.jig.name}</h3>}
        <small>
          v{view.jig.version} · {view.title} · 출력 레이어 {view.body.layerRoot} ·{' '}
          {jig.computing
            ? '계산 중…'
            : jig.lastRun
              ? `마지막 계산 ${jig.lastRun.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
              : '계산 전'}
        </small>
      </header>
      {jig.notice ? (
        <p className="kit-notice" role="alert">
          {jig.notice}
        </p>
      ) : null}
      <div className="kit-columns">
        <div className="kit-side">{spec.left.map((part, i) => render(part, `left.${i}`))}</div>
        {slots.top && slots.board ? null : (
          <div className="kit-main">
            {slots.top ? null : center}
            {slots.board ? null : board}
          </div>
        )}
      </div>
      {slots.drawer ? null : drawer}
      {beside(center, slots.top, 'top')}
      {beside(board, slots.board, 'board')}
      {beside(drawer, slots.drawer, 'drawer')}
      {spec.actions.length ? (
        <div className="kit-actions">
          {spec.actions.map((action) =>
            action.report ? (
              // A report opens in 산출물 → 보고서 (reading it changes nothing, so no confirmation).
              host.openReport ? (
                <button
                  key={action.id}
                  type="button"
                  data-report={action.report}
                  onClick={() => host.openReport?.(action.report!)}
                >
                  {action.label}
                </button>
              ) : (
                <span key={action.id} className="kit-actions">
                  <button type="button" disabled>
                    {action.label}
                  </button>
                  <span className="kit-reason">
                    이 화면에서는 산출물 탭의 보고서를 열 수 없습니다
                  </span>
                </span>
              )
            ) : (
              <button
                key={action.id}
                type="button"
                disabled={busy}
                onClick={() =>
                  action.tier === 'T2' ? setAsking(action) : void jig.runStep(action.step!)
                }
              >
                {action.label}
              </button>
            ),
          )}
        </div>
      ) : null}
      {asking ? (
        <div className="kit-confirm" role="group" aria-label={`${asking.label} 확인`}>
          <strong>{asking.label}</strong>
          <span>
            ‘{stepTitle(asking.step)}’ 단계까지 계산합니다. 출력 레이어 {view.body.layerRoot}.
          </span>
          <div className="kit-actions">
            <button
              type="button"
              data-primary
              onClick={() => {
                const step = asking.step!;
                setAsking(undefined);
                void jig.runStep(step);
              }}
            >
              실행
            </button>
            <button type="button" onClick={() => setAsking(undefined)}>
              취소
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
