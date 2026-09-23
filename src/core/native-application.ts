import { z } from 'zod';
const model = z.object({
  objects: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      name: z.string(),
      origin: z.tuple([z.number(), z.number(), z.number()]),
    }),
  ),
});
import { DomainError } from './store.ts';
export function nativeMoves(candidateValue: unknown, sourceValue: unknown) {
  const candidateParsed = model.safeParse(candidateValue),
    sourceParsed = model
      .extend({ sourceDocument: z.object({}).passthrough() })
      .safeParse(sourceValue);
  if (!candidateParsed.success || !sourceParsed.success)
    throw new DomainError('UNSUPPORTED_APPLICATION');
  const candidate = candidateParsed.data,
    source = sourceParsed.data;
  function reject(): never {
    throw new DomainError('UNSUPPORTED_APPLICATION');
  }
  if (!source?.sourceDocument || candidate.objects.length !== source.objects.length) reject();
  const movements = [];
  for (const object of candidate.objects) {
    const original = source.objects.find((item) => item.id === object.id);
    if (
      !original ||
      object.kind !== 'native' ||
      original.kind !== 'native' ||
      object.name !== original.name ||
      !Array.isArray(object.origin) ||
      object.origin.length !== 3 ||
      !Array.isArray(original.origin)
    )
      reject();
    const delta = object.origin.map((value, i) => value - original.origin[i]);
    if (delta.some((value) => !Number.isFinite(value) || Math.abs(value) > 200000)) reject();
    if (delta.some((value) => value !== 0)) movements.push({ id: original.id, delta });
  }
  if (new Set(candidate.objects.map((object) => object.id)).size !== source.objects.length)
    reject();
  if (!movements.length) throw new DomainError('NO_CHANGES');
  return movements;
}
