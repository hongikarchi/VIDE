import { createHash } from 'node:crypto';
import { z } from 'zod';
import { workspaceRequestSchema } from '../contracts/workspace-result.ts';
import { sceneRepresentation } from './scene-representation.ts';
import { DomainError } from './store.ts';

const selectionSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    objectIds: z
      .array(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/))
      .min(1)
      .max(5000),
    includeNames: z.boolean().default(false),
    includeMeasurements: z.boolean().default(false),
  })
  .strict();
interface PublicObject {
  id: string;
  name?: string;
  geometry: { type: 'mesh' | 'line' | 'point'; positions: number[]; indices?: number[] };
  measurements?: { length?: number; area?: number; volume?: number };
}
export interface PublicScene {
  format: 'vide-public-scene-v1';
  unit: 'm';
  objects: PublicObject[];
}

/** Explicit public projection. Never spread internal host/request/review data into this result. */
export function createPublicationBundle(rawRequest: unknown, rawSelection: unknown) {
  const parsed = selectionSchema.safeParse(rawSelection);
  if (!parsed.success) throw new DomainError('INVALID_INPUT');
  const selection = parsed.data,
    request = workspaceRequestSchema.parse(rawRequest),
    result = request.result;
  if (
    request.state !== 'succeeded' ||
    !result ||
    result.verified !== true ||
    !result.objects ||
    !result.scene
  )
    throw new DomainError('RESULT_NOT_VERIFIED');
  if (new Set(selection.objectIds).size !== selection.objectIds.length)
    throw new DomainError('DUPLICATE_OBJECT');
  const objectsById = new Map(result.objects.map((object) => [object.id, object])),
    geometryById = new Map(result.scene.map((object) => [object.id, object]));
  if (objectsById.size !== result.objects.length || geometryById.size !== result.scene.length)
    throw new DomainError('AMBIGUOUS_OBJECT');
  const objects: PublicObject[] = selection.objectIds.map((id) => {
    const object = objectsById.get(id),
      source = geometryById.get(id);
    if (!object || !source) throw new DomainError('OBJECT_NOT_FOUND');
    const representation = sceneRepresentation(source);
    if (
      !representation ||
      representation.type === 'segments' ||
      representation.type === 'annotation' ||
      representation.positions.length % 3 ||
      !representation.positions.every(Number.isFinite)
    )
      throw new DomainError('UNSUPPORTED_GEOMETRY');
    if (
      representation.type === 'mesh' &&
      (representation.indices.length % 3 ||
        !representation.indices.every(
          (index) =>
            Number.isSafeInteger(index) &&
            index >= 0 &&
            index < representation.positions.length / 3,
        ))
    )
      throw new DomainError('INVALID_GEOMETRY');
    const publicObject: PublicObject = {
      id,
      geometry: { type: representation.type, positions: [...representation.positions] },
    };
    if (representation.type === 'mesh') publicObject.geometry.indices = [...representation.indices];
    if (selection.includeNames) publicObject.name = object.name;
    if (selection.includeMeasurements) {
      const measurements: NonNullable<PublicObject['measurements']> = {};
      for (const key of ['length', 'area', 'volume'] as const) {
        const value = source[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
          measurements[key] = value;
      }
      publicObject.measurements = measurements;
    }
    return publicObject;
  });
  const scene: PublicScene = { format: 'vide-public-scene-v1', unit: 'm', objects };
  const bytes = Buffer.from(JSON.stringify(scene), 'utf8');
  if (bytes.byteLength > 512 * 1024 * 1024) throw new DomainError('PUBLICATION_LIMIT');
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8 * 1024 * 1024)
    chunks.push(bytes.subarray(offset, offset + 8 * 1024 * 1024));
  const manifest = {
    title: selection.title,
    objectIds: selection.objectIds,
    assets: [
      {
        id: 'scene',
        parts: chunks.map((chunk) => ({
          size: chunk.byteLength,
          sha256: createHash('sha256').update(chunk).digest('hex'),
        })),
      },
    ],
  };
  return { manifest, chunks };
}
