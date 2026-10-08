// 패널링 값의 출처 at make time (SPEC-16.4 3, PLAN-49 T-255): which settings of the three stages are
// still the recommended value nobody gave or took ('가정'), and whether a stage may be made in Rhino
// (contract `makeAllowed`). A setting belongs to the stage its manifest group names ('1단계
// 미리보기' · '2단계 부재' · '3단계 최적화·타입화'); a setting read only with another value (합치기 기준 ·
// 투영 평면, SPEC-16.4 1) counts only while that value is chosen. The before-bake gate
// `paneling-confirmed` and the make attributes (`vide-assumed`) read it from here.

import { makeAllowed, type PanelingStage, type SettingSource } from '../../contracts/paneling.ts';
import type { ParamValue } from './params.ts';

export const PANELING_STAGES: readonly PanelingStage[] = ['preview', 'members', 'optimize'];
/** Settings read only together with another value. */
const WHEN: Record<string, { key: string; value: string }> = {
  mergeBelow: { key: 'boundaryRule', value: 'merge' },
  projection: { key: 'measure', value: 'projected' },
};

/** The stage of a setting by its manifest group, or undefined. */
export function stageOfGroup(group: string | undefined): PanelingStage | undefined {
  const text = group ?? '';
  if (/^\s*1\b|미리보기/.test(text)) return 'preview';
  if (/^\s*2\b|부재/.test(text)) return 'members';
  if (/^\s*3\b|최적화|타입/.test(text)) return 'optimize';
  return undefined;
}

/** The engine's `by` as the contract's 출처 (a default nobody touched is `assumed`). */
export function sourceOfParam(by: ParamValue['by'] | undefined): SettingSource {
  switch (by) {
    case 'default':
    case undefined:
      return 'assumed';
    case 'decision':
      return 'question';
    case 'fact':
      return 'project-fact';
    case 'ai':
      return 'ai-accepted';
    default:
      return 'person';
  }
}

export interface StageSources {
  settings: Record<PanelingStage, Record<string, { source: SettingSource }>>;
  /** Setting keys still assumed, by stage (in use only). */
  assumed: Record<PanelingStage, string[]>;
}
/** The sources of the settings in use, by stage. */
export function stageSources(
  decls: readonly { key: string; group?: string }[],
  params: Readonly<Record<string, Pick<ParamValue, 'value' | 'by'>>>,
): StageSources {
  const out: StageSources = {
    settings: { preview: {}, members: {}, optimize: {} },
    assumed: { preview: [], members: [], optimize: [] },
  };
  for (const decl of decls) {
    const stage = stageOfGroup(decl.group);
    if (!stage) continue;
    const when = WHEN[decl.key];
    if (when && params[when.key] && params[when.key].value !== when.value) continue;
    const source = sourceOfParam(params[decl.key]?.by);
    out.settings[stage][decl.key] = { source };
    if (source === 'assumed') out.assumed[stage].push(decl.key);
  }
  return out;
}

/** Stages up to and including this one. */
export const stagesUpTo = (stage: PanelingStage) =>
  PANELING_STAGES.slice(0, PANELING_STAGES.indexOf(stage) + 1);

/** May this stage be made now, and the assumed settings that keep it closed. */
export function panelingMakeAllowed(
  stage: PanelingStage,
  sources: StageSources,
): { allowed: boolean; assumed: string[] } {
  const allowed = makeAllowed(stage, {
    preview: sources.settings.preview,
    ...(stage === 'preview' ? {} : { members: sources.settings.members }),
    ...(stage === 'optimize' ? { optimize: sources.settings.optimize } : {}),
  });
  const assumed = stage === 'preview' ? [] : stagesUpTo(stage).flatMap((s) => sources.assumed[s]);
  return { allowed, assumed };
}

/** The make stage of a bake by the step its items come from (`preview`, `members`, `optimize`). */
export function stageOfStep(stepId: string): PanelingStage {
  return (PANELING_STAGES as readonly string[]).includes(stepId)
    ? (stepId as PanelingStage)
    : 'members';
}
