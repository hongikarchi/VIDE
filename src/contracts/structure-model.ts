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
            nature: z.enum(['D', 'L', 'Lr', 'S', 'W', 'E']),
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
        lateralRestraint: z
          .object({
            nodes: z.array(id).optional(),
            aboveZ_m: finite.optional(),
            dofs: z.array(z.enum(['dx', 'dy'])).min(1),
          })
          .strict()
          .optional(),
      })
      .strict(),
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
