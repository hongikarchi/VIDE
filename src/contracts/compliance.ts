// 법규 체크의 내부 계약 (SPEC-15.10, ARCH-03 §8.6, PLAN-48 T-237~T-239). Three builders work against
// these shapes in parallel:
//
//   reader (T-237)  — the Rhino model as read + the confirmed classification → `ClassifiedModel`
//   engine (T-238)  — `ClassifiedModel` + `ComplianceLimits` + settings     → `ComplianceResult`
//   screen (T-239)  — `ComplianceResult` → result table, viewport highlight, report and CSV
//
// The project's classification store (`ComplianceRole`) and the AI proposal (`RoleProposal`) are
// here too. No legal number lives in this file or in code that uses it: every limit is a 규제 조건
// item carried in `ComplianceLimits.regulations` with its 근거 and 확정 상태 (SPEC-12.7).
// Coordinates are local metres of the massing frame (`ComplianceLimits.frame`).

import { z } from 'zod';

const finite = z.number().finite();
const vec3 = z.tuple([finite, finite, finite]);
const vec2 = z.tuple([finite, finite]);
const ring = z.array(vec2).min(3).max(20000);
const hash = z.string().regex(/^[a-f0-9]{8,64}$/);
const iso = z.string().min(10).max(40);

/** A closed planar region in plan (outer counter-clockwise, holes clockwise). */
export const planRegionSchema = z
  .object({ outer: ring, holes: z.array(ring).max(200).default([]) })
  .strict();
export type PlanRegion = z.infer<typeof planRegionSchema>;

/** A triangle mesh: `v` = xyz triples, `f` = vertex index triples. */
export const meshSchema = z
  .object({
    v: z.array(finite).max(3_000_000),
    f: z.array(z.number().int().nonnegative()).max(3_000_000),
  })
  .strict()
  .refine((m) => m.v.length % 3 === 0 && m.f.length % 3 === 0, 'mesh arrays come in triples')
  .refine((m) => m.f.every((i) => i < m.v.length / 3), 'mesh index out of range');
export type Mesh = z.infer<typeof meshSchema>;

// ── 분류 (SPEC-15.3·15.4) ────────────────────────────────────────────────────────────────────

/** 검사 역할 (SPEC-15.3). The `vide-check-role` attribute takes exactly these values. */
export const COMPLIANCE_ROLES = [
  'mass',
  'floor',
  'building-area',
  'rooftop',
  'parking',
  'landscape',
  'landscape-roof',
  'open-space',
  'ignore',
] as const;
export const complianceRoleSchema = z.enum(COMPLIANCE_ROLES);
export type ComplianceRoleName = z.infer<typeof complianceRoleSchema>;

/** Korean labels the screen and the report use. */
export const COMPLIANCE_ROLE_LABELS: Record<ComplianceRoleName, string> = {
  mass: '건물 매스',
  floor: '층 윤곽',
  'building-area': '건축면적 윤곽',
  rooftop: '옥탑 등',
  parking: '주차 구획',
  landscape: '조경(지상)',
  'landscape-roof': '조경(옥상·지상 아님)',
  'open-space': '공개공지',
  ignore: '검사에서 뺌',
};

/** How an object got its role, strongest first (SPEC-15.4 1). */
export const roleSourceSchema = z.enum([
  'attribute',
  'person-object',
  'person-layer',
  'ai-accepted',
  'jig-tag',
  'layer-rule',
]);
export type RoleSource = z.infer<typeof roleSourceSchema>;

/** `vide-floor` label: `1F`…`199F`, `B1`…`B20`. */
export const floorLabelSchema = z.string().regex(/^(?:[1-9]\d{0,2}F|B[1-9]\d?)$/);

/** One stored classification of the project (SPEC-15.4 4, table `compliance_roles`). */
export const complianceRoleRecordSchema = z
  .object({
    /** The Link document (ADR-030) the record is for. */
    documentKey: z.string().min(1).max(200),
    scope: z.enum(['layer', 'object']),
    /** Full layer path (`a::b`) or the object's native id. */
    key: z.string().min(1).max(800),
    role: complianceRoleSchema,
    floor: floorLabelSchema.nullable().default(null),
    use: z.string().min(1).max(60).nullable().default(null),
    by: z.enum(['person', 'ai-accepted']),
    at: iso,
    /** For object records: the display `geometryHash` when confirmed (a changed object asks again). */
    geometryHash: hash.nullable().default(null),
  })
  .strict();
export type ComplianceRoleRecord = z.infer<typeof complianceRoleRecordSchema>;

/** One AI classification proposal; never used until a person accepts it (SPEC-15.4 3). */
export const roleProposalSchema = z
  .object({
    id: z.string().min(1).max(80),
    scope: z.enum(['layer', 'group']),
    /** Layer path, or for a group the layer plus the shape class the objects share. */
    layer: z.string().max(800),
    objectIds: z.array(z.string().uuid()).max(20000),
    role: complianceRoleSchema,
    floor: floorLabelSchema.nullable().default(null),
    use: z.string().min(1).max(60).nullable().default(null),
    reason: z.string().min(1).max(300),
    state: z.enum(['proposed', 'accepted', 'rejected']),
  })
  .strict();
export type RoleProposal = z.infer<typeof roleProposalSchema>;

// ── 읽은 모델 (reader → engine, SPEC-15.3·15.5) ─────────────────────────────────────────────

const objectShapeSchema = z.discriminatedUnion('kind', [
  /** A closed solid as the display mesh gave it; `closed` = welded and passed the solid check. */
  z
    .object({
      kind: z.literal('solid'),
      mesh: meshSchema,
      closed: z.boolean(),
      volume: finite.nullable(),
    })
    .strict(),
  /** A closed planar curve (or hatch/surface boundary) lying flat at height `z`. */
  z.object({ kind: z.literal('region'), region: planRegionSchema, z: finite }).strict(),
  /** A block instance or point (parking stalls drawn as blocks). */
  z.object({ kind: z.literal('point'), at: vec3 }).strict(),
]);

export const classifiedObjectSchema = z
  .object({
    /** Native id (Rhino object GUID) — also the viewport highlight key. */
    objectId: z.string().uuid(),
    layer: z.string().max(800),
    role: complianceRoleSchema,
    roleSource: roleSourceSchema,
    floor: floorLabelSchema.nullable(),
    use: z.string().min(1).max(60).nullable(),
    /** `vide-count` (parking): stalls this object stands for, default 1. */
    count: z.number().int().min(1).max(1000).default(1),
    hidden: z.boolean(),
    geometryHash: hash.nullable(),
    shape: objectShapeSchema,
  })
  .strict();
export type ClassifiedObject = z.infer<typeof classifiedObjectSchema>;

export const UNCLASSIFIED_REASONS = [
  '역할 없음',
  '역할과 모양이 맞지 않음',
  '닫히지 않음',
  '평면이 아님',
  '숨김',
  '다른 jig의 결과',
] as const;

export const classifiedModelSchema = z
  .object({
    schema: z.literal('vide.compliance.model@1'),
    source: z
      .object({
        linkId: z.string().min(1).max(200),
        documentKey: z.string().min(1).max(200),
        readId: z.string().min(1).max(200),
        /** `<instance>|<documentId>|<revision>` (ARCH-03 §8). */
        revisionKey: z.string().min(1).max(400),
        readAt: iso,
        /** Document unit → metre factor applied to every coordinate. */
        toMeters: z.number().positive(),
      })
      .strict(),
    objects: z.array(classifiedObjectSchema).max(200000),
    unclassified: z
      .array(
        z
          .object({
            objectId: z.string().uuid(),
            layer: z.string().max(800),
            nativeType: z.string().max(80),
            reason: z.enum(UNCLASSIFIED_REASONS),
          })
          .strict(),
      )
      .max(200000),
    /** Version of the project's classification store the reader used (staleness). */
    rolesVersion: z.number().int().nonnegative(),
  })
  .strict();
export type ClassifiedModel = z.infer<typeof classifiedModelSchema>;

// ── 규제 조건과 한계 (buildable-mass#limits → engine, SPEC-15.5) ───────────────────────────────

/** A 규제 조건 item as `vide/massing-kit` `RegulationItem` carries it (SPEC-12.7 2). */
export const regulationItemSchema = z
  .object({
    id: z.string().regex(/^[a-z][A-Za-z0-9]{1,40}$/),
    group: z.string().min(1).max(20),
    title: z.string().min(1).max(120),
    value: z.union([finite, z.string().max(200), z.array(z.string().max(100)).max(100)]).nullable(),
    unit: z.string().max(20),
    applies: z.enum(['적용', '미적용', '판단 필요']).nullable(),
    status: z.enum(['확정', '가정', '판단 필요', '사람 입력 필요']),
    origin: z.enum([
      '원본에서 읽음',
      '도구로 계산함',
      '사용자가 확정함',
      'AI가 추정함',
      '서비스 확정',
      '서비스 해석',
      '없음',
    ]),
    basis: z
      .object({
        clause: z.string().max(400).optional(),
        link: z.string().max(800).optional(),
        note: z.string().max(400).optional(),
      })
      .strict()
      .nullable(),
    source: z.string().max(200),
    target: z.string().max(80).optional(),
  })
  .strict();
export type RegulationItemData = z.infer<typeof regulationItemSchema>;

/** The 2D rules whose forbidden band applies at every height above ground (SPEC-15.7 2). */
export const ZONE_RULES = [
  'roadSetback',
  'chamfer',
  'limitLine',
  'openSpaceRoad',
  'openSpaceAdjacent',
  'civilSetback',
  'otherSetback',
] as const;
export const zoneRuleSchema = z.enum(ZONE_RULES);
export type ZoneRule = z.infer<typeof zoneRuleSchema>;

const variantSchema = z.enum(['base', 'without']);

export const complianceLimitsSchema = z
  .object({
    schema: z.literal('vide.compliance.limits@1'),
    /** The massing frame: local = document metres − `origin`. */
    frame: z
      .object({
        linkId: z.string().max(200).nullable(),
        documentKey: z.string().max(200).nullable(),
        origin: vec3,
      })
      .strict(),
    site: z
      .object({
        ring,
        area_m2: z.number().positive(),
        /** Where `area_m2` came from (설정값 · 사이트 모델링 공부/계산 · 그린 경계). */
        areaSource: z.string().min(1).max(120),
        /** The other area when 공부 and 계산 differ (SPEC-15.6 1), else null. */
        otherArea_m2: z.number().positive().nullable(),
        northDeg: finite,
        northSource: z.string().max(120),
      })
      .strict(),
    regulations: z.array(regulationItemSchema).max(400),
    /** 미반영 조건 of the massing jig: items the envelope ran without. */
    unapplied: z
      .array(
        z
          .object({
            id: z.string().max(60),
            title: z.string().max(200),
            reason: z.string().max(300),
          })
          .strict(),
      )
      .max(400),
    /** Forbidden plan bands per rule; empty when the rule has no value or does not apply. */
    zones: z
      .array(
        z
          .object({
            rule: zoneRuleSchema,
            items: z.array(z.string().max(60)).min(1).max(20),
            regions: z.array(planRegionSchema).max(2000),
            /** Boundary segments the band is measured from (`도로 2`, `인접 3`). */
            segments: z.array(z.string().max(60)).max(400),
          })
          .strict(),
      )
      .max(40),
    variants: z
      .array(
        z
          .object({
            id: variantSchema,
            /** Height cap above ground (m) and the items it came from; null = no cap entered. */
            heightCap: z
              .object({ value: z.number().positive(), items: z.array(z.string().max(60)).min(1) })
              .strict()
              .nullable(),
            /** The forbidden volume of the 정북 일조 사선 (null = rule off or no value). */
            sunCut: meshSchema.nullable(),
            /** The checked 최대 외피. */
            envelope: meshSchema,
            envelopeVolume: z.number().nonnegative(),
            unconfirmed: z.array(z.string().max(200)).max(400),
          })
          .strict(),
      )
      .min(1)
      .max(2),
    /** Default use and floor heights of the massing plan (parking needs a use). */
    plan: z
      .object({
        mainUse: z.string().max(60).nullable(),
        floorHeightGround: z.number().positive(),
        floorHeightTypical: z.number().positive(),
      })
      .strict(),
  })
  .strict();
export type ComplianceLimits = z.infer<typeof complianceLimitsSchema>;

/** 기준 지반 (SPEC-15.6 3): the person's value, else the site model's candidate range. */
export const groundDatumSchema = z
  .object({
    value: finite.nullable(),
    basis: z.string().max(300).nullable(),
    candidate: z
      .object({ min: finite, max: finite, mean: finite, source: z.string().max(200) })
      .strict()
      .nullable(),
  })
  .strict();
export type GroundDatum = z.infer<typeof groundDatumSchema>;

// ── 결과 (engine → screen, SPEC-15.9) ──────────────────────────────────────────────────

export const COMPLIANCE_STATES = [
  '적합',
  '위반',
  '판단 필요',
  '사람 입력 필요',
  '검사 불가',
] as const;
export const complianceStateSchema = z.enum(COMPLIANCE_STATES);
export type ComplianceState = z.infer<typeof complianceStateSchema>;

/** The closed check list (SPEC-15.2). Height rows are one per 규제 조건 item. */
export const COMPLIANCE_CHECKS = [
  'coverage',
  'far',
  'height:heightMax',
  'height:streetHeight',
  'height:altitudeHeight',
  'floors',
  'zone:roadSetback',
  'zone:chamfer',
  'zone:limitLine',
  'zone:openSpaceRoad',
  'zone:openSpaceAdjacent',
  'zone:civilSetback',
  'zone:otherSetback',
  'sun',
  'envelope',
  'outside-site',
  'parking',
  'landscape',
  'open-space',
] as const;
export const complianceCheckIdSchema = z.enum(COMPLIANCE_CHECKS);
export type ComplianceCheckId = z.infer<typeof complianceCheckIdSchema>;

/** Where one number came from (SPEC-15.9 3). */
export const numberSourceSchema = z
  .object({
    label: z.string().min(1).max(120),
    value: finite.nullable(),
    unit: z.string().max(20),
    kind: z.enum(['모델', '규제 조건', '대지', '사람 입력', '계산']),
    /** `model:<role>` · `regulation:<itemId>` · `site:area` · `setting:<key>` · `override:<id>`. */
    ref: z.string().min(1).max(200),
    note: z.string().max(300).optional(),
  })
  .strict();
export type NumberSource = z.infer<typeof numberSourceSchema>;

/** A part of the building inside a forbidden volume (SPEC-15.7 4). */
export const exceedanceSchema = z
  .object({
    id: z.string().min(1).max(80),
    rule: z.string().min(1).max(60),
    variant: variantSchema,
    volume: z.number().nonnegative(),
    min: vec3,
    max: vec3,
    segments: z.array(z.string().max(60)).max(40),
    objectIds: z.array(z.string().uuid()).max(2000),
    mesh: meshSchema,
  })
  .strict();
export type Exceedance = z.infer<typeof exceedanceSchema>;

export const complianceItemSchema = z
  .object({
    id: complianceCheckIdSchema,
    group: z.enum(['규모', '형상 제한', '주차·조경·공개공지']),
    title: z.string().min(1).max(120),
    state: complianceStateSchema,
    /** Why the state (always set unless 적합 with nothing to add). */
    reason: z.string().max(400),
    planned: z
      .object({ value: finite, unit: z.string().max(20), text: z.string().max(120) })
      .strict()
      .nullable(),
    limit: z
      .object({
        value: finite,
        unit: z.string().max(20),
        text: z.string().max(120),
        itemId: z.string().max(60),
        status: z.enum(['확정', '가정', '판단 필요', '사람 입력 필요']),
        origin: z.string().max(40),
      })
      .strict()
      .nullable(),
    /** limit − planned in the limit's unit (negative = over); null when either is missing. */
    margin: finite.nullable(),
    /** 근거 조항 of the limit, as the 규제 조건 item carries it. */
    basis: z
      .array(
        z
          .object({
            clause: z.string().max(400),
            link: z.string().max(800).nullable(),
            answer: z.string().max(20).nullable(),
          })
          .strict(),
      )
      .max(20),
    numbers: z.array(numberSourceSchema).max(40),
    /** Per-variant / per-candidate outcomes when the state depends on them (SPEC-15.9 2). */
    cases: z
      .array(
        z
          .object({
            label: z.string().max(120),
            state: z.enum(['적합', '위반']),
            planned: finite.nullable(),
            limit: finite.nullable(),
          })
          .strict(),
      )
      .max(8),
    objectIds: z.array(z.string().uuid()).max(20000),
    exceedances: z.array(exceedanceSchema).max(500),
    /** 가정 · 판단 필요 inputs the state rests on (counted in the 미확정 count). */
    unconfirmed: z.array(z.string().max(200)).max(40),
  })
  .strict();
export type ComplianceItem = z.infer<typeof complianceItemSchema>;

const inputRef = z
  .object({ instanceId: z.string().max(200), hash: z.string().max(200), at: iso })
  .strict()
  .nullable();

export const complianceResultSchema = z
  .object({
    schema: z.literal('vide.compliance.result@1'),
    checkedAt: iso,
    /** What this result read; any change makes it '다시 체크 필요' (SPEC-15.13). */
    inputs: z
      .object({
        model: z
          .object({
            readId: z.string().max(200),
            revisionKey: z.string().max(400),
            objects: z.number().int().nonnegative(),
            unclassified: z.number().int().nonnegative(),
            rolesVersion: z.number().int().nonnegative(),
          })
          .strict()
          .nullable(),
        limits: inputRef,
        siteModel: inputRef,
        settingsHash: z.string().max(100),
      })
      .strict(),
    items: z.array(complianceItemSchema).max(COMPLIANCE_CHECKS.length),
    /** 규제 조건 items '미적용' — listed, not checked. */
    notApplicable: z
      .array(
        z
          .object({
            id: z.string().max(60),
            title: z.string().max(120),
            basis: z.string().max(400),
          })
          .strict(),
      )
      .max(60),
    counts: z.record(complianceStateSchema, z.number().int().nonnegative()),
    unconfirmedCount: z.number().int().nonnegative(),
    notice: z.literal('탐색용 법규 체크 — 인허가 검토·법규 검토를 대체하지 않음'),
  })
  .strict();
export type ComplianceResult = z.infer<typeof complianceResultSchema>;
