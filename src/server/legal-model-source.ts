import type { JigRuntime } from '../jigs/runtime/runtime.ts';
import type { LegalModelSource } from '../services/legal-model.ts';

/** The official site modeling jig (PLAN-45 T-207) whose 대지 요약 fills the legal profile. */
export const SITE_MODEL_JIG = 'vide/site-model';

/**
 * The project's site model for the legal service (SPEC-13.8, PLAN-46 T-220): the newest
 * `vide/site-model` instance that has a computed 대지 요약, with the objects its bakes made. The
 * version names the instance and the run of its summary so a recomputed model shows as changed.
 */
export function siteModelSource(runtime: () => JigRuntime): LegalModelSource {
  return {
    async read(projectId) {
      const jigs = runtime();
      const instances = jigs
        .list(projectId)
        .filter((instance) => instance.jigId === SITE_MODEL_JIG)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      for (const instance of instances) {
        let summary: unknown;
        try {
          summary = jigs.output(projectId, instance.id, 'summary');
        } catch {
          continue; // not computed yet
        }
        const view = await jigs.view(projectId, instance.id);
        const run = view.steps.find((step) => step.id === 'summary')?.inputHash ?? '';
        return {
          instanceId: instance.id,
          version: `대지 모델 ${instance.title} · ${run.slice(0, 8)}`,
          summary,
          made: jigs.madeObjects(projectId, instance.id),
        };
      }
      return undefined;
    },
  };
}
