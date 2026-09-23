import { z } from 'zod';
const objectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    nativeId: z.string(),
    kind: z.literal('polyline'),
    points: z.array(z.tuple([z.number(), z.number(), z.number()])),
  })
  .passthrough();
const baselineSchema = z
  .object({
    dwgEditMode: z.literal('polyline-vertices-v1'),
    sourceUnits: z.literal(4),
    objects: z.array(objectSchema),
    scene: z.array(
      z
        .object({ id: z.string(), layer64: z.string().optional(), color: z.number().optional() })
        .passthrough(),
    ),
  })
  .passthrough();
function read<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail();
  return parsed.data;
}
function fail(): never {
  throw Object.assign(new Error('UNSUPPORTED_DWG_EDIT'), { code: 'UNSUPPORTED_DWG_EDIT' });
}
export function validateDwgEdit(objectsValue: unknown, baselineValue: unknown) {
  const objects = read(z.array(objectSchema), objectsValue),
    baseline = read(baselineSchema, baselineValue);
  if (
    baseline?.dwgEditMode !== 'polyline-vertices-v1' ||
    baseline.sourceUnits !== 4 ||
    !objects.length ||
    objects.length !== baseline.objects?.length ||
    new Set(objects.map((o) => o.id)).size !== objects.length
  )
    fail();
  for (const object of objects) {
    const old = baseline.objects.find((o) => o.id === object.id);
    if (
      !old ||
      object.name !== old.name ||
      object.nativeId !== old.nativeId ||
      !/^cad-[A-Fa-f0-9]+$/.test(object.id) ||
      object.id !== 'cad-' + object.nativeId ||
      object.kind !== 'polyline' ||
      !Array.isArray(object.points) ||
      object.points.length < 2 ||
      object.points.length > 1000
    )
      fail();
    if (
      object.points.some(
        (p) =>
          !Array.isArray(p) ||
          p.length !== 3 ||
          p.some((n) => !Number.isFinite(n) || Math.abs(n) > 100000) ||
          p[2] !== object.points[0][2],
      )
    )
      fail();
  }
}
export function verifyDwgEdit(objectsValue: unknown, baselineValue: unknown, resultValue: unknown) {
  const objects = read(z.array(objectSchema), objectsValue),
    baseline = read(baselineSchema, baselineValue),
    result = read(baselineSchema.extend({ verified: z.literal(true) }), resultValue);
  validateDwgEdit(objects, baseline);
  if (!result.verified || result.sourceUnits !== 4 || result.objects?.length !== objects.length)
    fail();
  for (const expected of objects) {
    const actual = result.objects.find((o) => o.id === expected.id),
      before = baseline.scene.find((o) => o.id === expected.id),
      after = result.scene.find((o) => o.id === expected.id);
    if (
      !actual ||
      !before ||
      !after ||
      actual.nativeId !== expected.nativeId ||
      actual.name !== expected.name ||
      before.layer64 !== after.layer64 ||
      before.color !== after.color ||
      actual.points.length !== expected.points.length ||
      actual.points.some((p, i) => p.some((n, j) => Math.abs(n - expected.points[i][j]) > 1e-8))
    )
      fail();
  }
}
