// What every check reads (PLAN-48 T-238): the model's usable objects by role and their prepared
// solids, the objects that keep rows from 적합 (SPEC-15.9 7), the 기준 지반 cases, the site area
// cases (SPEC-15.6 1), the floor tables per ground case, and the shared exceedance numbering.

import type {
  ClassifiedModel,
  ClassifiedObject,
  ComplianceLimits,
  ComplianceOverride,
  ComplianceRoleName,
  ComplianceSettings,
  GroundDatum,
  Mesh,
  NumberSource,
  RegulationItemData,
} from '../../../contracts/compliance.ts';
import type { RegulationItem } from '../massing-kit/rules.ts';
import { prepareMesh, type PreparedSolid } from './geometry.ts';
import { floorTable, groundCases, type FloorTable, type GroundCase } from './ground.ts';
import { filteredItems } from './limits-read.ts';
import type { Blockers } from './verdict.ts';

export interface SiteAreaCase {
  key: 'site:area' | 'site:otherArea';
  label: string;
  value: number;
}

export interface Ctx {
  model: ClassifiedModel;
  limits: ComplianceLimits | null;
  /** Why there are no limits (SPEC-15.5 3). */
  limitsMissing: string;
  regs: RegulationItemData[];
  /** The 규제 조건 as massing-kit functions receive them (SPEC-15.5 6 applied). */
  items: RegulationItem[];
  settings: ComplianceSettings;
  overrides: ComplianceOverride[];
  unitsKnown: boolean;
  /** Why shape rows cannot place the model on the site (SPEC-15.5 5), else null. */
  docProblem: string | null;
  grounds: GroundCase[];
  groundNumbers: NumberSource[];
  siteAreas: SiteAreaCase[];
  /** Usable objects of a role (hidden ones only with 숨긴 객체 포함). */
  objs: (role: ComplianceRoleName) => ClassifiedObject[];
  /** True when any object of the model carries the role (used or not). */
  hasRole: (role: ComplianceRoleName) => boolean;
  solids: Map<string, PreparedSolid>;
  /** A massing mesh (envelope, 일조 금지 부피) prepared once. */
  prepared: (m: Mesh) => PreparedSolid;
  blockers: Blockers;
  floorTables: () => { tables: FloorTable[]; needsGround: boolean };
  nextNo: () => number;
}

const UNUSABLE = new Set(['역할과 모양이 맞지 않음', '닫히지 않음', '평면이 아님']);
const MAY_BE_BUILDING = new Set(['closed-solid', 'region', 'point']);

export function buildContext(
  model: ClassifiedModel,
  limits: ComplianceLimits | null,
  ground: GroundDatum,
  settings: ComplianceSettings,
  overrides: ComplianceOverride[],
  limitsMissing: string,
): Ctx {
  const used = model.objects.filter(
    (o) => (settings.includeHidden || !o.hidden) && o.role !== 'ignore',
  );
  const byRole = new Map<ComplianceRoleName, ClassifiedObject[]>();
  for (const o of used) (byRole.get(o.role) ?? byRole.set(o.role, []).get(o.role)!).push(o);
  for (const list of byRole.values()) list.sort((a, b) => a.objectId.localeCompare(b.objectId));

  const solids = new Map<string, PreparedSolid>();
  for (const o of used)
    if (o.shape.kind === 'solid') solids.set(o.objectId, prepareMesh(o.shape.mesh));

  const unusable = new Map<ComplianceRoleName, string[]>();
  const hidden = new Map<ComplianceRoleName, string[]>();
  const push = (m: Map<ComplianceRoleName, string[]>, role: ComplianceRoleName, id: string) =>
    (m.get(role) ?? m.set(role, []).get(role)!).push(id);
  for (const u of model.unclassified)
    if (u.role && u.role !== 'ignore' && UNUSABLE.has(u.reason)) push(unusable, u.role, u.objectId);
  for (const o of model.objects) {
    if (o.role === 'ignore') continue;
    if (o.hidden && !settings.includeHidden) push(hidden, o.role, o.objectId);
    else if (o.shape.kind === 'solid' && !o.shape.closed) push(unusable, o.role, o.objectId);
  }
  const roleless = model.unclassified
    .filter((u) => u.reason === '역할 없음' && MAY_BE_BUILDING.has(u.shape))
    .map((u) => u.objectId);

  const g = groundCases(ground, settings, limits);
  const siteAreas: SiteAreaCase[] = [];
  if (limits) {
    siteAreas.push({
      key: 'site:area',
      label: `대지면적(${limits.site.areaSource})`,
      value: limits.site.area_m2,
    });
    const other = limits.site.otherArea_m2;
    if (other !== null && other !== limits.site.area_m2)
      siteAreas.push({ key: 'site:otherArea', label: '다른 대지면적(공부·계산)', value: other });
  }

  let docProblem: string | null = null;
  if (limits) {
    if (limits.frame.documentKey === null) docProblem = '대지가 어느 문서에서 왔는지 모름';
    else if (limits.frame.documentKey !== model.source.documentKey)
      docProblem = '대지와 모델이 다른 문서';
  }

  let tables: { tables: FloorTable[]; needsGround: boolean } | null = null;
  let no = 0;
  const preparedMeshes = new Map<Mesh, PreparedSolid>();
  return {
    model,
    limits,
    limitsMissing,
    regs: limits?.regulations ?? [],
    items: filteredItems(limits?.regulations ?? []),
    settings,
    overrides,
    unitsKnown: model.source.toMeters !== null,
    docProblem,
    grounds: g.cases,
    groundNumbers: g.numbers,
    siteAreas,
    objs: (role) => byRole.get(role) ?? [],
    hasRole: (role) =>
      model.objects.some((o) => o.role === role) || model.unclassified.some((u) => u.role === role),
    solids,
    prepared: (m) => preparedMeshes.get(m) ?? preparedMeshes.set(m, prepareMesh(m)).get(m)!,
    blockers: { unusable, hidden, roleless },
    floorTables: () => {
      if (tables) return tables;
      const floors = byRole.get('floor') ?? [];
      const mainUse = limits?.plan.mainUse ?? null;
      const named = floors.every((o) => o.floor);
      if (named || !floors.length)
        tables = {
          tables: [floorTable(floors, solids, null, overrides, mainUse)],
          needsGround: false,
        };
      else if (!g.cases.length) tables = { tables: [], needsGround: true };
      else
        tables = {
          tables: g.cases.map((c) => floorTable(floors, solids, c, overrides, mainUse)),
          needsGround: false,
        };
      return tables;
    },
    nextNo: () => ++no,
  };
}
