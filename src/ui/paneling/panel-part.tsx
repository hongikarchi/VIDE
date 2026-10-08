import type { PartOf } from '../kit/registry.ts';
import type { PanelData } from '../jig-panel/bindings.ts';
import type { InstanceState } from '../jig-panel/instance.ts';
import type { PanelHost } from '../jig-panel/panel.tsx';
import { usePaneling } from './context.ts';
import {
  PanelingMake,
  PanelingResult,
  PanelingSettings,
  PanelingStages,
  PanelingSummary,
  PanelingSurface,
} from './parts.tsx';

/** One 패널링 part of a declared panel (Design SCR-33), all reading the same instance store. */
export function PanelingPart({
  part,
  host,
  instanceId,
  jig,
  data,
}: {
  part: PartOf<
    | 'paneling-stages'
    | 'paneling-surface'
    | 'paneling-settings'
    | 'paneling-make'
    | 'paneling-summary'
    | 'paneling-result'
  >;
  host: PanelHost;
  instanceId: string;
  jig: InstanceState;
  data: PanelData;
}) {
  const view = usePaneling({
    projectId: host.projectId,
    instanceId,
    jig,
    data,
    remote: host.remote,
  });
  switch (part.part) {
    case 'paneling-stages':
      return <PanelingStages view={view} title={part.title} />;
    case 'paneling-surface':
      return <PanelingSurface view={view} title={part.title} />;
    case 'paneling-settings':
      return <PanelingSettings view={view} jig={jig} title={part.title} />;
    case 'paneling-make':
      return (
        <PanelingMake
          view={view}
          jig={jig}
          host={host}
          instanceId={instanceId}
          title={part.title}
        />
      );
    case 'paneling-summary':
      return <PanelingSummary view={view} jig={jig} />;
    case 'paneling-result':
      return <PanelingResult view={view} host={host} />;
  }
}
