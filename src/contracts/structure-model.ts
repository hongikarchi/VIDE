import { z } from 'zod';

// Structure analysis model and result contract (ARCH-02 §2–4). Units live in field names.

const id = z.string().min(1).max(120);
const finite = z.number().finite();
const positive = finite.positive();
const xyz = z.tuple([finite, finite, finite]);
const dofs = ['dx', 'dy', 'dz', 'rx', 'ry', 'rz'] as const;
const dofFlags = z
  .object(Object.fromEntries(dofs.map((d) => [d, z.boolean().optional()])))
  .strict();

export const provenanceSchema = z
  .object({
    by: z.enum(['auto', 'ai', 'user']),
    assumed: z.boolean(),
    note: z.string().max(500).optional(),
  })
  .strict();

const materialSchema = z
  .object({
    id,
    grade: z.string().max(40),
    E_MPa: positive,
    G_MPa: positive,
    density_kNpm3: finite.nonnegative(),
    Fy_MPa: positive,
    Fu_MPa: positive,
    fyByThickness: z.array(z.object({ tMax_mm: positive, Fy_MPa: positive }).strict()).optional(),
    provenance: provenanceSchema.optional(),
  })
  .strict();

const sectionShape = z.enum(['H', 'BH', 'BOX', 'PIPE', 'ROD', 'L', 'C']);
const sectionSchema = z
  .object({
    id,
    name: z.string().max(80),
    shape: sectionShape,
    // H/BH: h, b, tw, tf, (r). BOX: h, b, t. PIPE: d, t. ROD: d. L/C need props.
    dims_mm: z.record(z.string(), positive),
    source: z.enum(['KS D 3502', 'user', 'ai']),
    props: z
      .object({
        A_mm2: positive,
        I2_mm4: positive,
        I3_mm4: positive,
        J_mm4: positive,
        Z2_mm3: positive.optional(),
        Z3_mm3: positive.optional(),
        S2_mm3: positive.optional(),
        S3_mm3: positive.optional(),
        Cw_mm6: finite.nonnegative().optional(),
      })
      .strict()
      .optional(),
    provenance: provenanceSchema.optional(),
  })
  .strict()
  .refine((s) => s.props || ['H', 'BH', 'BOX', 'PIPE', 'ROD'].includes(s.shape), {
    message: 'L and C sections need explicit props',
  });

const nodeSchema = z
  .object({ id, xyz_m: xyz, support: dofFlags.optional(), provenance: provenanceSchema.optional() })
  .strict();

const designSchema = z
  .object({
    Lb_m: positive.optional(),
    K2: positive.optional(),
    K3: positive.optional(),
    Cb: positive.optional(),
  })
  .strict();

const memberSchema = z
  .object({
    id,
    i: id,
    j: id,
    section: id,
    material: id,
    role: z.enum(['column', 'girder', 'beam', 'brace', 'other']),
    kind: z.enum(['frame', 'truss', 'tensionOnly']),
    betaDeg: finite.default(0),
    releases: z.object({ i: dofFlags.optional(), j: dofFlags.optional() }).strict().optional(),
    source: z.object({ documentId: z.string(), objectId: z.string() }).strict().optional(),
    design: designSchema.optional(),
    provenance: provenanceSchema.optional(),
  })
  .strict();

const memberRole = z.enum(['column', 'girder', 'beam', 'brace', 'other']);
const designMemberSchema = z
  .object({
    id,
    role: memberRole,
    /** Jig-side label, e.g. the plan role (edge, arm, trimmer). */
    tag: z.string().max(40).optional(),
    /** Analysis members in order from the first support end. */
    segments: z.array(id).min(1),
    length_m: positive,
    kind: z.enum(['span', 'cantilever']),
    /** Supported end nodes: two for a span, one (the root) for a cantilever. */
    supports: z.array(id).min(1).max(2),
    /** Reference unbraced length and effective-length factor of the whole member. */
    Lb_m: positive.optional(),
    K: positive.optional(),
    Cb: positive.optional(),
    provenance: provenanceSchema.optional(),
  })
  .strict();

const direction = z.enum(['-Z', '+Z', '-X', '+X', '-Y', '+Y', 'local-1', 'local-2', 'local-3']);
const loadSchema = z.discriminatedUnion('type', [
  z
    .object({
      id,
      pattern: id,
      type: z.literal('memberUniform'),
      targets: z.array(id).min(1),
      direction,
      value_kNpm: finite,
      provenance: provenanceSchema.optional(),
    })
    .strict(),
  z
    .object({
      id,
      pattern: id,
      type: z.literal('memberPoint'),
      targets: z.array(id).min(1),
      direction,
      value_kN: finite,
      position: finite.min(0).max(1),
      provenance: provenanceSchema.optional(),
    })
    .strict(),
  z
    .object({
      id,
      pattern: id,
      type: z.literal('nodePoint'),
      targets: z.array(id).min(1),
      direction: direction.exclude(['local-1', 'local-2', 'local-3']),
      value_kN: finite,
      provenance: provenanceSchema.optional(),
    })
    .strict(),
]);

const areaLoadSchema = z
  .object({
    id,
    pattern: id,
    polygon_m: z.array(xyz).min(3),
    value_kPa: finite,
    spanDirection: z.enum(['X', 'Y']).optional(),
    provenance: provenanceSchema.optional(),
  })
  .strict();

export const structureModelSchema = z
  .object({
    schema: z.literal('vide.structure.model/1'),
    meta: z
      .object({
        name: z.string().max(200),
        sources: z
          .array(
            z
              .object({
                kind: z.enum(['rhino', 'cad', 'layout']),
                documentId: z.string(),
                syncId: z.string().optional(),
              })
              .strict(),
          )
          .default([]),
        mergeTolerance_m: positive.default(0.005),
        createdAt: z.string().optional(),
      })
      .strict(),
    materials: z.array(materialSchema).min(1),
    sections: z.array(sectionSchema).min(1),
    nodes: z.array(nodeSchema).min(2),
    members: z.array(memberSchema).min(1),
    loadPatterns: z
      .array(
        z
          .object({
            id,
            // N = 명목 수평하중(층 중력 × 비율, ARCH-02 §3). 코어는 성격을 해석에 쓰지 않는다.
            nature: z.enum(['D', 'L', 'Lr', 'S', 'W', 'E', 'N']),
            selfWeight: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1),
    loads: z.array(loadSchema).default([]),
    areaLoads: z.array(areaLoadSchema).default([]),
    combinations: z
      .array(
        z
          .object({
            id,
            terms: z.array(z.object({ pattern: id, factor: finite }).strict()).min(1),
            limitState: z.enum(['strength', 'service']),
          })
          .strict(),
      )
      .min(1),
    analysis: z
      .object({
        kind: z.literal('linearStatic'),
        // Lateral restraint holds the listed nodes only (SPEC-06.5): no "every node above z".
        lateralRestraint: z
          .object({
            nodes: z.array(id).min(1),
            dofs: z.array(z.enum(['dx', 'dy'])).min(1),
          })
          .strict()
          .optional(),
      })
      .strict(),
    // Design members (SPEC-06.1·.6): the physical member each analysis segment belongs to and the
    // design lengths the library filled in. Read by the TypeScript library, not by the core (1st pass).
    designMembers: z.array(designMemberSchema).default([]),
    checkSettings: z
      .object({
        code: z.literal('KDS 14 31 10').default('KDS 14 31 10'),
        deflectionLimits: z
          .record(z.string(), positive)
          .default({ beam: 360, girder: 360, other: 240 }),
        colorBands: z.tuple([positive, positive]).default([0.7, 1.0]),
      })
      .strict()
      .default({
        code: 'KDS 14 31 10',
        deflectionLimits: { beam: 360, girder: 360, other: 240 },
        colorBands: [0.7, 1.0],
      }),
  })
  .strict()
  .superRefine((m, ctx) => {
    const unique = (name: string, ids: string[]) => {
      const seen = new Set<string>();
      for (const value of ids) {
        if (seen.has(value))
          ctx.addIssue({ code: 'custom', message: `duplicate ${name} id ${value}` });
        seen.add(value);
      }
      return seen;
    };
    const nodes = unique(
      'node',
      m.nodes.map((n) => n.id),
    );
    const sections = unique(
      'section',
      m.sections.map((s) => s.id),
    );
    const materials = unique(
      'material',
      m.materials.map((x) => x.id),
    );
    const members = unique(
      'member',
      m.members.map((x) => x.id),
    );
    const patterns = unique(
      'pattern',
      m.loadPatterns.map((p) => p.id),
    );
    unique(
      'combination',
      m.combinations.map((c) => c.id),
    );
    for (const member of m.members) {
      for (const end of [member.i, member.j])
        if (!nodes.has(end))
          ctx.addIssue({ code: 'custom', message: `member ${member.id} node ${end} missing` });
      if (member.i === member.j)
        ctx.addIssue({ code: 'custom', message: `member ${member.id} has one node` });
      if (!sections.has(member.section))
        ctx.addIssue({
          code: 'custom',
          message: `member ${member.id} section ${member.section} missing`,
        });
      if (!materials.has(member.material))
        ctx.addIssue({
          code: 'custom',
          message: `member ${member.id} material ${member.material} missing`,
        });
    }
    for (const load of m.loads) {
      if (!patterns.has(load.pattern))
        ctx.addIssue({ code: 'custom', message: `load ${load.id} pattern missing` });
      const pool = load.type === 'nodePoint' ? nodes : members;
      for (const target of load.targets)
        if (!pool.has(target))
          ctx.addIssue({ code: 'custom', message: `load ${load.id} target ${target} missing` });
    }
    for (const combo of m.combinations)
      for (const term of combo.terms)
        if (!patterns.has(term.pattern))
          ctx.addIssue({
            code: 'custom',
            message: `combination ${combo.id} pattern ${term.pattern} missing`,
          });
    for (const node of m.analysis.lateralRestraint?.nodes ?? [])
      if (!nodes.has(node))
        ctx.addIssue({ code: 'custom', message: `lateral restraint node ${node} missing` });
    const owned = new Set<string>();
    unique(
      'design member',
      m.designMembers.map((d) => d.id),
    );
    for (const design of m.designMembers) {
      for (const segment of design.segments) {
        if (!members.has(segment))
          ctx.addIssue({
            code: 'custom',
            message: `design member ${design.id} segment ${segment} missing`,
          });
        if (owned.has(segment))
          ctx.addIssue({
            code: 'custom',
            message: `segment ${segment} belongs to two design members`,
          });
        owned.add(segment);
      }
      for (const support of design.supports)
        if (!nodes.has(support))
          ctx.addIssue({
            code: 'custom',
            message: `design member ${design.id} support ${support} missing`,
          });
    }
  });

export type StructureModel = z.infer<typeof structureModelSchema>;
export type StructureModelInput = z.input<typeof structureModelSchema>;

const six = z.tuple([finite, finite, finite, finite, finite, finite]);
const forces = z
  .object({ N: finite, V2: finite, V3: finite, T: finite, M2: finite, M3: finite })
  .strict();
export const checkStatus = z.enum(['pass', 'fail', 'incomplete', 'error']);

export const structureResultSchema = z
  .object({
    schema: z.literal('vide.structure.result/1'),
    modelHash: z.string(),
    coreVersion: z.string(),
    elapsed_ms: finite,
    status: z.enum(['ok', 'error']),
    error: z.string().optional(),
    diagnostics: z
      .object({
        mechanisms: z.array(z.object({ node: z.string(), dof: z.enum(dofs) })),
        autoRestrained: z.array(z.object({ node: z.string(), dof: z.enum(dofs) })),
        equilibrium: z.array(z.object({ combo: z.string(), error_rel: finite })),
        warnings: z.array(z.string()),
      })
      .strict(),
    combos: z.array(z.string()),
    nodes: z.record(
      z.string(),
      z
        .object({ disp: z.record(z.string(), six), reaction: z.record(z.string(), six).optional() })
        .strict(),
    ),
    members: z.record(
      z.string(),
      z
        .object({
          length_m: finite,
          stations: z.array(finite),
          forces: z.record(z.string(), z.array(forces)),
          deflection_mm: z.record(z.string(), finite).optional(),
        })
        .strict(),
    ),
    checks: z.array(
      z
        .object({
          member: z.string(),
          status: checkStatus,
          ratio: finite.nullable(),
          governing: z.object({ combo: z.string(), clause: z.string() }).nullable(),
          parts: z.array(
            z.object({
              clause: z.string(),
              ratio: finite,
              combo: z.string(),
              values: z.record(z.string(), finite),
            }),
          ),
          cause: z.enum(['member', 'input-suspect']).optional(),
          notes: z.array(z.string()),
        })
        .strict(),
    ),
    summary: z
      .object({
        steel_kN: finite,
        maxRatio: finite.nullable(),
        failCount: z.number().int(),
        incompleteCount: z.number().int(),
      })
      .strict(),
    notChecked: z.array(z.string()),
  })
  .strict();

export type StructureResult = z.infer<typeof structureResultSchema>;

// Summary result (`vide.structure.summary/1`, ARCH-02 §4.1): what the structure-analysis library
// returns per analysis and what a preview shows. Small on purpose (≤ 50 KB for 1,500 segments):
// rows are tuples, clauses and combinations are referenced by index.

/** Verdict codes: index into `statusCodes` — 0 ok, 1 warn (≥ first colour band), 2 ng, 3 na (미완), 4 err. */
export const summaryStatusCodes = ['ok', 'warn', 'ng', 'na', 'err'] as const;
const statusCode = z.number().int().min(0).max(4);
const ratio = finite.nullable();
const clauseIndex = z.number().int().nonnegative().nullable();
/** [status, ratio] of one analysis segment, in `designMembers[].segments` order. */
const segmentRow = z.tuple([statusCode, ratio]);
/**
 * [id, status, ratio, clause, referenceDeflection_mm, limit_mm, segments]. `segments` is empty
 * when the member is one segment (its row is the segment's verdict).
 */
const memberRow = z.tuple([
  z.string(),
  statusCode,
  ratio,
  clauseIndex,
  finite.nullable(),
  finite.nullable(),
  z.array(segmentRow),
]);
/** [column, z_m, combo, Rx_kN, Ry_kN]: the restraint reaction of one column node, worst combination. */
const restraintRow = z.tuple([z.string(), finite, z.number().int().nonnegative(), finite, finite]);

export const structureSummarySchema = z
  .object({
    schema: z.literal('vide.structure.summary/1'),
    mode: z.enum(['confirmed', 'preview']),
    /** Shown with every number: '확정 결과' or '미확정 미리보기'. */
    label: z.string(),
    /** invalid = check errors, nothing analysed; unstable = mechanism. */
    status: z.enum(['ok', 'unstable', 'error', 'invalid']),
    error: z.string().optional(),
    modelHash: z.string(),
    coreVersion: z.string(),
    ms: finite,
    /** The combinations exactly as analysed (gate `combo-echo`). */
    combos: z.array(
      z
        .object({
          id: z.string(),
          limitState: z.enum(['strength', 'service']),
          terms: z.record(z.string(), finite),
        })
        .strict(),
    ),
    statusCodes: z.tuple([
      z.literal('ok'),
      z.literal('warn'),
      z.literal('ng'),
      z.literal('na'),
      z.literal('err'),
    ]),
    colorBands: z.tuple([positive, positive]),
    clauses: z.array(z.string()),
    members: z.array(memberRow),
    reactions: z
      .object({
        sumZ_kN: z.record(z.string(), finite),
        lateral_kN: z.record(z.string(), z.tuple([finite, finite])),
        perColumn: z.array(restraintRow),
        maxLateral_kN: finite,
      })
      .strict(),
    maxRatio: ratio,
    steel_t: finite,
    counts: z
      .object({
        ok: z.number().int(),
        warn: z.number().int(),
        ng: z.number().int(),
        na: z.number().int(),
        err: z.number().int(),
      })
      .strict(),
    margin: z.object({ name: z.string(), value: finite.nullable() }).strict(),
    issues: z.array(
      z
        .object({
          level: z.enum(['error', 'warning', 'info']),
          code: z.string(),
          message: z.string(),
          nodes: z.array(z.string()).optional(),
          members: z.array(z.string()).optional(),
        })
        .strict(),
    ),
    assumptions: z.array(z.string()),
    unchecked: z.array(z.string()),
    disclaimer: z.string(),
  })
  .strict();

export type StructureSummary = z.infer<typeof structureSummarySchema>;
