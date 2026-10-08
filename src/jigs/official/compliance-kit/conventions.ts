// 법규 체크의 모델 읽기 규칙 (SPEC-15.3, ARCH-03 §8.6, PLAN-48 T-237): which 검사 역할 an object of
// the linked Rhino document has. The order is fixed (the first that decides wins):
//
//   1. object attribute `vide-check-role` (with `vide-floor` · `vide-use` · `vide-count`)
//   2. a classification record — object first (a person's or an accepted AI proposal's), then a
//      layer record a person set (SPEC-15.4 4)
//   3. jig tags: the chosen alternative's floor masses of `vide/buildable-mass` read as `floor`;
//      every other jig object is context or an estimate and is left out
//   4. layer names: a path step equal to a name of the table below; the deeper step wins and two
//      roles at the same depth decide nothing (the AI proposal takes it). An AI-accepted layer
//      record (older projects) stands here, below a deeper layer name
//
// Pure TypeScript without node: imports. No legal value lives here — only names.

import {
  COMPLIANCE_ROLES,
  floorLabelSchema,
  type ComplianceRoleName,
  type ComplianceRoleRecord,
  type RoleSource,
} from '../../../contracts/compliance.ts';

export { COMPLIANCE_ROLES };

/** Object attribute names the reader takes (ARCH-03 §8.6; VIDE never writes them). */
export const CHECK_ATTRS = {
  role: 'vide-check-role',
  floor: 'vide-floor',
  use: 'vide-use',
  count: 'vide-count',
} as const;

/** Attribute names the 만들기 templates stamp on what a jig made (ARCH-03 §9.1). */
export const JIG_TAGS = { jig: 'vide-jig', key: 'vide-key', option: 'vide-option' } as const;

/** The jig whose chosen alternative's floor masses read as `floor` (SPEC-15.3 3). */
export const MASSING_JIG = 'vide/buildable-mass';

/** 레이어 단계 이름 (SPEC-15.3 3의 4). Compared trimmed and case-folded. */
export const LAYER_NAMES: Readonly<Record<ComplianceRoleName, readonly string[]>> = {
  mass: ['건물', '매스', '건물매스', 'MASS', 'BUILDING'],
  floor: ['층윤곽', '층', '바닥', 'FLOOR', 'SLAB'],
  'building-area': ['건축면적', 'BUILDING-AREA'],
  rooftop: ['옥탑', 'ROOFTOP'],
  parking: ['주차', '주차구획', 'PARKING'],
  landscape: ['조경', 'LANDSCAPE'],
  'landscape-roof': ['옥상조경', 'ROOF-LANDSCAPE'],
  'open-space': ['공개공지', 'OPEN-SPACE'],
  ignore: ['검사제외', '참고', 'REF'],
};

const fold = (text: string) => text.normalize('NFC').trim().toLowerCase();

/**
 * The role a layer path's names give: the deepest step that matches a name wins; two different
 * roles at that depth give none (`conflict`). `table` is for tests.
 */
export function layerRule(
  path: string,
  table: Readonly<Record<string, readonly string[]>> = LAYER_NAMES,
): { role: ComplianceRoleName | null; depth: number; conflict: boolean } {
  const steps = path.split('::').map(fold);
  for (let depth = steps.length - 1; depth >= 0; depth--) {
    const roles = new Set<ComplianceRoleName>();
    for (const [role, names] of Object.entries(table))
      if (names.some((name) => fold(name) === steps[depth])) roles.add(role as ComplianceRoleName);
    if (roles.size === 1) return { role: [...roles][0], depth, conflict: false };
    if (roles.size > 1) return { role: null, depth, conflict: true };
  }
  return { role: null, depth: -1, conflict: false };
}

export const isComplianceRole = (value: unknown): value is ComplianceRoleName =>
  typeof value === 'string' && (COMPLIANCE_ROLES as readonly string[]).includes(value);

/** `vide-floor` (or a record's floor) when it is a valid label, else null. */
export const floorLabel = (value: unknown): string | null =>
  typeof value === 'string' && floorLabelSchema.safeParse(value.trim()).success
    ? value.trim()
    : null;

/** `vide-use`: trimmed, at most 60 characters (the contract's limit), else null. */
export const useLabel = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, 60);
  return text || null;
};

/** `vide-count`: an integer 1…1000, else 1. */
export const countOf = (value: unknown): number => {
  const n = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 1;
};

/** What the role rules see of one object. */
export interface RoleRow {
  objectId: string;
  layer: string;
  attributes: Readonly<Record<string, string>>;
}

/** The decided role, or why there is none (`unclassified` reason). */
export type RoleDecision =
  | {
      role: ComplianceRoleName;
      source: RoleSource;
      floor: string | null;
      use: string | null;
      count: number;
      /** The object record that decided or named the floor (geometry change check). */
      record: ComplianceRoleRecord | null;
      note?: string;
    }
  | { role: null; reason: '역할 없음' | '다른 jig의 결과' | '고르지 않은 대안' };

/**
 * The classification records of one document, indexed: object records by object id, layer records
 * by full path. A layer record also covers the layers below it (the nearest one wins).
 */
export interface RecordIndex {
  objects: Map<string, ComplianceRoleRecord>;
  layers: Map<string, ComplianceRoleRecord>;
}
export function indexRecords(records: readonly ComplianceRoleRecord[]): RecordIndex {
  const objects = new Map<string, ComplianceRoleRecord>();
  const layers = new Map<string, ComplianceRoleRecord>();
  for (const record of records)
    (record.scope === 'object' ? objects : layers).set(
      record.scope === 'object' ? record.key.toLowerCase() : record.key,
      record,
    );
  return { objects, layers };
}
function layerRecord(index: RecordIndex, layer: string) {
  const steps = layer.split('::');
  for (let n = steps.length; n > 0; n--) {
    const record = index.layers.get(steps.slice(0, n).join('::'));
    if (record) return record;
  }
  return undefined;
}

/**
 * The massing alternatives the model holds and which one reads as `floor`: the chosen one when the
 * massing work copy has one; else the only one when the model has exactly one; else none.
 */
export function alternativeReading(
  rows: readonly RoleRow[],
  chosenOption: string | null,
): { read: string | null; options: string[]; note: string | null } {
  const options = [
    ...new Set(
      rows
        .filter(
          (row) =>
            row.attributes[JIG_TAGS.jig] === MASSING_JIG &&
            (row.attributes[JIG_TAGS.key] ?? '').startsWith('alt:'),
        )
        .map((row) => row.attributes[JIG_TAGS.option] ?? ''),
    ),
  ].sort();
  if (chosenOption !== null) return { read: chosenOption, options, note: null };
  if (options.length === 1)
    return { read: options[0], options, note: '고른 대안 없음 · 모델의 대안 하나로 읽음' };
  return { read: null, options, note: options.length ? '고른 대안 없음 · 대안이 여럿' : null };
}

/** The role of one object by the fixed order (SPEC-15.3 3). `readOption` from `alternativeReading`. */
export function roleOf(row: RoleRow, index: RecordIndex, readOption: string | null): RoleDecision {
  const attrs = row.attributes;
  const objectRecord = index.objects.get(row.objectId.toLowerCase());
  const floorAttr = floorLabel(attrs[CHECK_ATTRS.floor]);
  const useAttr = useLabel(attrs[CHECK_ATTRS.use]);
  const count = countOf(attrs[CHECK_ATTRS.count]);
  const decided = (
    role: ComplianceRoleName,
    source: RoleSource,
    record: ComplianceRoleRecord | null,
    note?: string,
  ): RoleDecision => ({
    role,
    source,
    floor: floorAttr ?? (record ? floorLabel(record.floor) : null),
    use: useAttr ?? (record ? useLabel(record.use) : null),
    count,
    record: objectRecord ?? null,
    ...(note ? { note } : {}),
  });
  // 1. The object's own attribute.
  const own = attrs[CHECK_ATTRS.role]?.trim();
  if (isComplianceRole(own)) return decided(own, 'attribute', objectRecord ?? null);
  // 2. A person's record: object, then the nearest layer.
  if (objectRecord)
    return decided(
      objectRecord.role,
      objectRecord.by === 'person' ? 'person-object' : 'ai-accepted',
      objectRecord,
    );
  const onLayer = layerRecord(index, row.layer);
  if (onLayer?.by === 'person') return decided(onLayer.role, 'person-layer', onLayer);
  // 3. Jig tags: only the read alternative's floor masses; everything else a jig made is left out.
  const jig = attrs[JIG_TAGS.jig];
  if (jig) {
    const key = attrs[JIG_TAGS.key] ?? '';
    if (jig === MASSING_JIG && key.startsWith('alt:')) {
      if (readOption !== null && (attrs[JIG_TAGS.option] ?? '') === readOption)
        return decided('floor', 'jig-tag', null);
      return { role: null, reason: '고르지 않은 대안' };
    }
    return { role: null, reason: '다른 jig의 결과' };
  }
  // 4. Layer names. A layer record only a person confirmed decides above; one taken from an AI
  // proposal (older projects — accepting a proposal now writes object records) never overrides a
  // jig tag, nor a layer name deeper in the path than the record's layer (SPEC-15.4 3).
  const rule = layerRule(row.layer);
  if (onLayer) {
    const recordDepth = onLayer.key.split('::').length - 1;
    if (!rule.role || rule.depth <= recordDepth)
      return decided(onLayer.role, 'ai-accepted', onLayer);
  }
  if (rule.role) return decided(rule.role, 'layer-rule', null);
  return { role: null, reason: '역할 없음' };
}
