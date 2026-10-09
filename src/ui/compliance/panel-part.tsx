import type { PartOf } from '../kit/registry.ts';
import { ComplianceRoles } from '../kit/compliance-roles.tsx';
import type { PanelData } from '../jig-panel/bindings.ts';
import type { InstanceState } from '../jig-panel/instance.ts';
import type { PanelHost } from '../jig-panel/panel.tsx';
import { useCompliance } from './context.ts';
import { ComplianceResultPart, ComplianceRun, ComplianceSummary } from './parts.tsx';

/** One 법규 체크 part of a declared panel, bound to its `ComplianceResult` step output. */
export function CompliancePart({
  part,
  host,
  instanceId,
  jig,
  data,
}: {
  part: PartOf<'compliance-roles' | 'compliance-run' | 'compliance-summary' | 'compliance-result'>;
  host: PanelHost;
  instanceId: string;
  jig: InstanceState;
  data: PanelData;
}) {
  const view = useCompliance({
    projectId: host.projectId,
    instanceId,
    jig,
    data,
    from: part.from,
    remote: host.remote,
  });
  switch (part.part) {
    case 'compliance-roles':
      return (
        <ComplianceRoles
          projectId={host.projectId}
          instanceId={instanceId}
          title={part.title}
          view={view}
        />
      );
    case 'compliance-run':
      return <ComplianceRun view={view} jig={jig} />;
    case 'compliance-summary':
      return <ComplianceSummary view={view} jig={jig} />;
    case 'compliance-result':
      return <ComplianceResultPart view={view} host={host} jig={jig} />;
  }
}
