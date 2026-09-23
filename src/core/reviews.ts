import { z } from 'zod';
import type { Store } from './store.ts';
import { reviewRowSchema } from '../contracts/reviews.ts';
import { quantityTableSchema } from '../contracts/quantities.ts';
import { workspaceResultSchema, applicationResultSchema } from '../contracts/workspace-result.ts';
export const candidateSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  result: workspaceResultSchema.extend({
    objects: workspaceResultSchema.shape.objects.unwrap(),
    scene: workspaceResultSchema.shape.scene.unwrap(),
  }),
});
const snapshotSchema = reviewRowSchema.extend({
  projectId: z.string(),
  payload: z
    .object({
      model: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          kind: z.string(),
          comparable: z.boolean(),
          geometryHash: z.string(),
        }),
      ),
      table: quantityTableSchema,
      sourceDocument: z
        .object({ instance: z.string(), documentId: z.number() })
        .passthrough()
        .optional(),
    })
    .passthrough(),
});
const captureSchema = candidateSchema.extend({
  projectId: z.string(),
  input: z.object({
    body: z.string(),
    pins: z.array(z.unknown()),
    sketches: z.array(z.unknown()),
    files: z.array(z.object({ name: z.string(), type: z.string().optional() })),
  }),
  applications: z.array(applicationResultSchema).optional(),
});
export type ReviewSnapshot = z.infer<typeof snapshotSchema>;
import { sceneRepresentation } from './scene-representation.ts';
import { randomUUID, createHash } from 'node:crypto';
import { DomainError } from './store.ts';
import { quantities } from './quantities.ts';
export function validatePreview(image: unknown): asserts image is string {
  if (
    typeof image !== 'string' ||
    image.length > 1000000 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image) ||
    Buffer.from(image.split(',')[1], 'base64').subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
  )
    throw new DomainError('INVALID_INPUT');
}
export class Reviews {
  store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  list(projectId: string) {
    this.store.project(projectId);
    return this.store.db
      .prepare(
        'SELECT id,requestId,title,createdAt FROM review_snapshots WHERE projectId=? ORDER BY rowid DESC',
      )
      .all(projectId)
      .map((row) => reviewRowSchema.parse(row));
  }
  get(projectId: string, id: string) {
    this.store.project(projectId);
    const row = this.store.db
      .prepare('SELECT * FROM review_snapshots WHERE projectId=? AND id=?')
      .get(projectId, id);
    if (!row) throw new DomainError('NOT_FOUND');
    return snapshotSchema.parse({ ...row, payload: JSON.parse(z.string().parse(row.payload)) });
  }
  create(projectId: string, rawInput: unknown, rawRequest: unknown) {
    const parsed = z
      .object({ title: z.string(), image: z.unknown(), query: z.unknown().optional() })
      .safeParse(rawInput);
    if (!parsed.success) throw new DomainError('INVALID_INPUT');
    const input = parsed.data,
      request = captureSchema.parse(rawRequest);
    const project = this.store.project(projectId);
    if (
      !input ||
      typeof input.title !== 'string' ||
      !input.title.trim() ||
      input.title.length > 100 ||
      request.projectId !== projectId
    )
      throw new DomainError('INVALID_INPUT');
    validatePreview(input.image);
    if (this.list(projectId).length >= 200) throw new DomainError('REVIEW_LIMIT');
    const table = quantities(request, input.query),
      id = randomUUID(),
      createdAt = new Date().toISOString(),
      title = input.title.trim();
    const result = request.result;
    const model = result.objects.map(({ nativeId, ...object }) => {
      const { nativeId: ignored, ...geometry } =
        result.scene.find((item) => item.id === object.id) || {};
      return {
        id: object.id,
        name: object.name,
        kind: object.kind,
        comparable: !!sceneRepresentation(geometry),
        geometryHash: createHash('sha256')
          .update(JSON.stringify({ object, geometry }))
          .digest('hex'),
      };
    });
    const frozen = {
      id: request.id,
      createdAt: request.createdAt,
      input: {
        body: request.input.body,
        pins: request.input.pins,
        sketches: request.input.sketches,
        files: request.input.files.map((file) => ({ name: file.name, type: file.type })),
      },
      result: {
        hostExecuted: true,
        displayUnsupported: result.scene
          .filter((object) => !sceneRepresentation(object))
          .map((object) => object.nativeType || '미상'),
        verified: result.verified,
        host: result.host,
        text: result.text,
        objects: result.objects.map(({ id, name, kind }) => ({ id, name, kind })),
        scene: result.scene.map(({ id, nativeId, nativeType, area, volume }) => ({
          id,
          nativeId,
          nativeType,
          area,
          volume,
        })),
      },
      applications: (request.applications || []).map((application) => ({
        id: application.id,
        state: application.state,
        result: {
          applied: application.result?.applied,
          saved: application.result?.saved,
          code: application.result?.code,
        },
      })),
    };
    const payload = JSON.stringify({
      project: { name: project.name },
      request: frozen,
      image: input.image,
      table,
      model,
      sourceDocument: result.sourceDocument,
      title,
      createdAt,
    });
    if (Buffer.byteLength(payload) > 2000000) throw new DomainError('INPUT_TOO_LARGE');
    this.store.db
      .prepare('INSERT INTO review_snapshots VALUES(?,?,?,?,?,?)')
      .run(id, projectId, request.id, title, createdAt, payload);
    return { id, requestId: request.id, title, createdAt };
  }
}
