import { z } from 'zod';
import { DomainError } from './store.ts';
function fail(): never {
  throw new DomainError('INVALID_GEOMETRY');
}
const scalar = z.number().finite().min(-100000).max(100000);
const point = z.tuple([scalar, scalar, scalar]);
const identity = {
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  name: z
    .string()
    .min(1)
    .max(200)
    .refine((name) => Boolean(name.trim())),
};
const points = z.array(point).min(2).max(1000);
const box = z
  .object({
    ...identity,
    kind: z.literal('box'),
    origin: point,
    size: z.tuple([scalar.positive(), scalar.positive(), scalar.positive()]),
  })
  .passthrough();
const polyline = z.object({ ...identity, kind: z.literal('polyline'), points }).passthrough();
const extrude = z
  .object({ ...identity, kind: z.literal('extrude'), points, height: scalar.positive() })
  .passthrough();
const native = z
  .object({
    ...identity,
    kind: z.literal('native'),
    origin: point,
    nativeId: z.string(),
    nativeSourceId: z.string().optional(),
  })
  .passthrough();
export const legacyObjectSchema = z.discriminatedUnion('kind', [box, polyline, extrude, native]);
export type GeometryObject = z.infer<typeof legacyObjectSchema>;
type Point = z.infer<typeof point>;
const operation = z.discriminatedUnion('kind', [
  box,
  polyline,
  extrude,
  z.object({ kind: z.literal('move'), id: identity.id, delta: point }),
  z.object({ kind: z.literal('height'), id: identity.id, height: scalar.positive() }),
  z.object({ kind: z.literal('vertices'), id: identity.id, points }),
  z.object({ kind: z.literal('copy'), ...identity, sourceId: identity.id, delta: point }),
  z.object({ kind: z.literal('remove'), id: identity.id }),
]);
const proposalSchema = z.object({
  message: z.string().max(20000),
  operations: z.array(operation).max(100),
});
function validateExtrusion(object: GeometryObject) {
  if (
    object.kind === 'extrude' &&
    (object.points.length < 4 ||
      JSON.stringify(object.points[0]) !== JSON.stringify(object.points.at(-1)) ||
      object.points.some((p) => Math.abs(p[2] - object.points[0][2]) > 1e-6))
  )
    fail();
}
function translate(object: GeometryObject, delta: Point) {
  const move = (value: Point): Point => {
    const next: Point = [value[0] + delta[0], value[1] + delta[1], value[2] + delta[2]];
    if (!point.safeParse(next).success) fail();
    return next;
  };
  if (object.kind === 'box' || object.kind === 'native') object.origin = move(object.origin);
  else object.points = object.points.map(move);
}

export const geometryContract = `Return ONLY a JSON object {"message": "Korean explanation", "operations": [...]}. Do not output code.
Available operations, all coordinates/dimensions in meters:
{"kind":"box","id":"unique-id","name":"name","origin":[x,y,z],"size":[width,depth,height]}
{"kind":"polyline","id":"unique-id","name":"name","points":[[x,y,z],...]} (repeat first point to close)
{"kind":"extrude","id":"unique-id","name":"name","points":[[x,y,z],...],"height":number} (closed planar XY boundary)
{"kind":"move","id":"existing-id","delta":[x,y,z]}
{"kind":"height","id":"existing-box-or-extrusion-id","height":number}
{"kind":"vertices","id":"existing-polyline-or-extrusion-id","points":[[x,y,z],...]} (replaces boundary points; extrusion must remain closed planar XY)
{"kind":"copy","id":"new-id","sourceId":"existing-id","name":"copy name","delta":[x,y,z]} (box/polyline/extrusion or independent native geometry; repeat explicit copies up to the operation limit)
{"kind":"remove","id":"existing-id"}
Existing kind=native objects came from a user-selected 3dm. Their origin is the bounding box minimum. They support move/remove and copying independent geometry; native copies remain native, with no parametric height/vertices editing. Copying grouped, locked, referenced or history-linked native objects is unsupported; never reconstruct them as boxes or claim to know their topology. Their original geometry and attributes must be retained.
Read-only requests: operations=[] and grounded answer. Missing required dimensions: operations=[] and ask a specific question. Never invent requested dimensions. Sketch points use plane XY/XZ/YZ, origin 0 and meters. Object pins identify targets. Existing geometry is supplied as context. Preserve unmentioned geometry. Only describe proposed changes; execution is verified separately by VIDE.`;

export function interpret(text: string, existing: unknown[] = [], permission = 'review') {
  let raw: unknown;
  try {
    raw = JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/, '')
        .replace(/\s*```$/, ''),
    );
  } catch {
    fail();
  }
  const parsed = proposalSchema.safeParse(raw);
  if (!parsed.success) fail();
  const proposal = parsed.data;
  if (permission === 'review' && proposal.operations.length)
    throw new DomainError('WRITE_NOT_ALLOWED');
  if (!z.array(legacyObjectSchema).safeParse(existing).success) fail();
  // Keep original property order and unknown host metadata for preserved-object comparisons.
  const objects = structuredClone(existing) as GeometryObject[];
  for (const op of proposal.operations) {
    const index = objects.findIndex((object) => object.id === op.id),
      object = objects[index];
    switch (op.kind) {
      case 'box':
      case 'polyline':
      case 'extrude': {
        if (object) fail();
        const created: GeometryObject =
          op.kind === 'box'
            ? { kind: op.kind, id: op.id, name: op.name, origin: op.origin, size: op.size }
            : op.kind === 'extrude'
              ? { kind: op.kind, id: op.id, name: op.name, points: op.points, height: op.height }
              : { kind: op.kind, id: op.id, name: op.name, points: op.points };
        validateExtrusion(created);
        objects.push(created);
        break;
      }
      case 'move':
        if (!object) fail();
        translate(object, op.delta);
        break;
      case 'height':
        if (!object || (object.kind !== 'box' && object.kind !== 'extrude')) fail();
        if (object.kind === 'box') object.size[2] = op.height;
        else object.height = op.height;
        break;
      case 'vertices':
        if (!object || (object.kind !== 'polyline' && object.kind !== 'extrude')) fail();
        object.points = op.points;
        validateExtrusion(object);
        break;
      case 'copy': {
        const source = objects.find((object) => object.id === op.sourceId);
        if (object || !source) fail();
        const copy = structuredClone(source);
        copy.id = op.id;
        copy.name = op.name;
        if (copy.kind === 'native') {
          copy.nativeSourceId = existing.some(
            (item) => item && typeof item === 'object' && 'id' in item && item.id === source.id,
          )
            ? source.id
            : copy.nativeSourceId;
          if (!copy.nativeSourceId) fail();
        }
        translate(copy, op.delta);
        objects.push(copy);
        break;
      }
      case 'remove':
        if (!object) fail();
        objects.splice(index, 1);
        break;
    }
  }
  if (objects.length > 500) fail();
  return { message: proposal.message, objects, changed: proposal.operations.length > 0 };
}

/** Enforce explicit preserved/reference geometry before crossing the host boundary. */
export function protectGeometry(before: { id: string }[], after: { id: string }[], ids: string[]) {
  for (const id of new Set(ids)) {
    const original = before.find((object) => object.id === id),
      next = after.find((object) => object.id === id);
    if (!original || !next || JSON.stringify(original) !== JSON.stringify(next))
      throw new DomainError('PROTECTED_OBJECT_CHANGED');
  }
}
