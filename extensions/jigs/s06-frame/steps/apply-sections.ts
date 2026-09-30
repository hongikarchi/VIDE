// S-06 frame jig ⑨ 선정 단면 적용 (PLAN-23 T-056, SPEC-06.12): after a person confirms the human
// step 'applySections', this code step turns the sizing result into section overrides of the
// instance — one per member of each group whose section was chosen ('선정') and differs from the
// member's current section. The engine writes them through the step output's `apply` field
// (ARCH-03 §6.3 적용 요청); overrides have stable ids (`s06-section:<member>`), so applying again
// replaces the earlier ones. The model then carries the sections, its hash changes, the confirmed
// analysis no longer belongs to it and [해석 확정] waits again; members bake only after that.
// '후보 없음' and '미검토' groups keep their section. Pure: (inputs) → JSON.

import type { ModelOutput } from './model.ts';
import type { SizingOutput } from './sizing.ts';

export interface ApplySectionsInputs {
  steps: { sizing: SizingOutput; model: ModelOutput };
}
export interface SectionOverride {
  id: string;
  target: { kind: 'member'; identity: { key: string } };
  op: 'set';
  fields: { section: string; group: string };
  origin: 'table';
  by: 'user';
  note: string;
}
export interface AppliedGroup {
  groupId: string;
  roleLabel: string;
  band: string;
  sectionName: string | null;
  members: number;
  /** Members whose section this application changes. */
  changed: number;
  /** Why a group is left as it is ('후보 없음', '미검토', 단면 불명). */
  kept?: string;
}
export interface ApplySectionsOutput {
  schema: 'vide.s06.applySections/1';
  modelHash: string;
  /** The analysis the sizing started from; a preview basis still needs [해석 확정] afterwards. */
  basis: SizingOutput['basis'];
  groups: AppliedGroup[];
  /** Engine request (ARCH-03 §6.3): overrides to upsert into the instance by id. */
  apply: { overrides: SectionOverride[] };
  summary: { groups: number; applied: number; kept: number; members: number; changed: number };
  notes: string[];
}

export const SECTION_OVERRIDE_PREFIX = 's06-section:';
const NOTE = '선정 단면 적용';

/** Action step 'sectionsApplied' (after the human step 'applySections'). */
export function applySections(inputs: ApplySectionsInputs): ApplySectionsOutput {
  const { sizing, model } = inputs.steps;
  const sectionOf = new Map(model.model.members.map((m) => [m.id, m.section]));
  const overrides: SectionOverride[] = [];
  const groups: AppliedGroup[] = [];
  for (const g of sizing.groups) {
    const row: AppliedGroup = {
      groupId: g.id,
      roleLabel: g.roleLabel,
      band: g.band,
      sectionName: g.sectionName,
      members: g.memberIds.length,
      changed: 0,
    };
    groups.push(row);
    if (g.status !== 'ok') {
      row.kept = g.judgement;
      continue;
    }
    if (!g.sectionId || !g.sectionName) {
      row.kept = '단면 불명';
      continue;
    }
    for (const member of g.memberIds) {
      const segments = model.map.physical[member] ?? [];
      if (segments.length && segments.every((s) => sectionOf.get(s) === g.sectionId)) continue;
      row.changed++;
      overrides.push({
        id: `${SECTION_OVERRIDE_PREFIX}${member}`,
        target: { kind: 'member', identity: { key: member } },
        op: 'set',
        fields: { section: g.sectionName, group: g.id },
        origin: 'table',
        by: 'user',
        note: NOTE,
      });
    }
  }
  const kept = groups.filter((g) => g.kept).length;
  const changed = overrides.length;
  const notes = [
    changed
      ? `선정 단면 ${changed}개 부재를 작업본에 적용합니다. 해석을 다시 확정해야 부재를 만들 수 있습니다.`
      : '모델이 이미 선정 단면을 쓰고 있습니다. 바꿀 부재가 없습니다.',
  ];
  if (kept) notes.push(`'후보 없음'·'미검토' 묶음 ${kept}개는 지금 단면을 유지합니다.`);
  return {
    schema: 'vide.s06.applySections/1',
    modelHash: model.modelHash,
    basis: sizing.basis,
    groups,
    apply: { overrides },
    summary: {
      groups: groups.length,
      applied: groups.length - kept,
      kept,
      members: groups.reduce((s, g) => s + g.members, 0),
      changed,
    },
    notes,
  };
}
