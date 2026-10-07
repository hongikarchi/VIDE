import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { JigPanel, type PanelHost } from './panel.tsx';

// A jig instance's context tab drawn from its declared screen (PLAN-22 T-048, SPEC-07.10). The
// screens of the official tool jigs (`src/jigs/official/jigs/*`, T-207) and of the jig packages in
// this checkout (`extensions/jigs/*`: `jig.json` + `panel.json`) are bundled with the page; a jig
// without one here (an imported package, until the engine serves panels) keeps the plain view.

const manifests = import.meta.glob<{ id?: unknown; version?: unknown; panel?: unknown }>(
  ['../../jigs/official/jigs/*/jig.json', '../../../extensions/jigs/*/jig.json'],
  { eager: true, import: 'default' },
);
const panels = import.meta.glob<unknown>(
  ['../../jigs/official/jigs/*/panel.json', '../../../extensions/jigs/*/panel.json'],
  { eager: true, import: 'default' },
);

/** The declared `panel.json` of a jig package in this checkout; undefined when there is none. */
export function panelOf(jigId: string, version?: string): unknown {
  const matches = Object.entries(manifests).filter(([, m]) => m.id === jigId);
  const [path] = matches.find(([, m]) => m.version === version) ?? matches[0] ?? [];
  if (!path) return undefined;
  const manifest = manifests[path];
  const file = typeof manifest.panel === 'string' ? manifest.panel : 'panel.json';
  return panels[path.replace(/jig\.json$/, file)];
}

/** The instance side of the JIG tab's host (jigs.tsx `JigHost`), as far as this screen needs it. */
export interface DeclaredHost extends PanelHost {
  instanceId: string;
  state: () => { instance?: { jig: { id: string; version: string } }; error?: string };
  subscribe: (listener: () => void) => () => void;
  refresh: () => Promise<unknown>;
}

export function DeclaredJig({ host, plain }: { host: DeclaredHost; plain: ReactNode }) {
  const state = useSyncExternalStore(host.subscribe, host.state);
  useEffect(() => {
    if (!host.state().instance) void host.refresh();
  }, [host]);
  const jig = state.instance?.jig;
  if (!jig)
    return (
      <p className="jig-intro" role="status">
        {state.error ?? '작업본을 읽는 중…'}
      </p>
    );
  const panel = panelOf(jig.id, jig.version);
  if (panel === undefined) return <>{plain}</>;
  return <JigPanel host={host} panel={panel} instanceId={host.instanceId} />;
}
