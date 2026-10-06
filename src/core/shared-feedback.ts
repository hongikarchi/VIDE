import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError, type Store } from './store.ts';
import type { Workspace } from './workspace.ts';
import { StoredList } from './model-store.ts';
import { feedbackFileSchema, receivedFeedbackSchema } from '../contracts/shared-feedback.ts';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => JSON.stringify(key) + ':' + canonical(value))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
/**
 * `hash` of a request result read lazily (`Workspace.lazy`, T-129): the same canonical text fed to
 * the hash piece by piece, a stored list as an array one item at a time, so the model is never
 * assembled or held as one string. Equal to `hash` of the whole result.
 */
function resultHash(value: unknown): string {
  const digest = createHash('sha256');
  let buffer = '';
  const out = (text: string) => {
    buffer += text;
    if (buffer.length >= 1 << 16) {
      digest.update(buffer);
      buffer = '';
    }
  };
  const feed = (value: unknown): void => {
    if (Array.isArray(value) || value instanceof StoredList) {
      out('[');
      let first = true;
      for (const item of value as Iterable<unknown>) {
        if (!first) out(',');
        first = false;
        feed(item);
      }
      out(']');
    } else if (value && typeof value === 'object') {
      out('{');
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([key, item], index) => {
          out((index ? ',' : '') + JSON.stringify(key) + ':');
          feed(item);
        });
      out('}');
    } else out(JSON.stringify(value) ?? 'null');
  };
  feed(value);
  digest.update(buffer);
  return digest.digest('hex');
}
const exportRow = z.object({
  id: z.string(),
  projectId: z.string(),
  requestId: z.string(),
  manifestHash: z.string(),
  sourceHash: z.string(),
});
const storedRow = z.object({
  id: z.string(),
  projectId: z.string(),
  requestId: z.string(),
  receivedAt: z.string(),
  original: z.string(),
});
const decode = (value: unknown) => {
  const row = storedRow.parse(value);
  return receivedFeedbackSchema.parse({
    ...row,
    source: 'file',
    original: JSON.parse(row.original),
  });
};
export class SharedFeedback {
  readonly store: Store;
  readonly workspace: Workspace;
  constructor(store: Store, workspace: Workspace) {
    this.store = store;
    this.workspace = workspace;
  }
  record(projectId: string, requestId: string, manifest: unknown) {
    const request = this.workspace.lazy(projectId, requestId),
      id = randomUUID();
    this.store
      .db(projectId)
      .prepare('INSERT INTO publication_exports VALUES(?,?,?,?,?)')
      .run(id, projectId, requestId, hash(manifest), resultHash(request.result));
    return id;
  }
  receive(projectId: string, raw: unknown) {
    this.store.project(projectId);
    const parsed = feedbackFileSchema.safeParse(raw);
    if (!parsed.success) throw new DomainError('INVALID_INPUT');
    const original = parsed.data;
    const row = this.store
      .db(projectId)
      .prepare('SELECT * FROM publication_exports WHERE id=? AND projectId=?')
      .get(original.exportId, projectId);
    if (!row) throw new DomainError('PUBLICATION_BASIS_NOT_FOUND');
    const basis = exportRow.parse(row);
    if (
      hash(original.manifest) !== basis.manifestHash ||
      resultHash(this.workspace.lazy(projectId, basis.requestId).result) !== basis.sourceHash
    )
      throw new DomainError('STALE_REFERENCE');
    if (
      original.comment.input.objectId !== null &&
      !original.manifest.objectIds.includes(original.comment.input.objectId)
    )
      throw new DomainError('TARGET_MISMATCH');
    const identity = hash([
      original.origin,
      original.projectId,
      original.publicationId,
      original.comment.id,
    ]);
    // The identity is unique across every project (one DB per project: each is asked).
    const existing = this.store
      .findDb('SELECT 1 FROM shared_feedback WHERE identity=?', identity)
      ?.prepare('SELECT * FROM shared_feedback WHERE identity=?')
      .get(identity);
    if (existing) {
      const prior = decode(existing);
      if (prior.projectId !== projectId || hash(prior.original) !== hash(original))
        throw new DomainError('REVISION_CONFLICT');
      return prior;
    }
    const id = randomUUID(),
      receivedAt = new Date().toISOString();
    this.store
      .db(projectId)
      .prepare('INSERT INTO shared_feedback VALUES(?,?,?,?,?,?)')
      .run(id, projectId, basis.requestId, identity, JSON.stringify(original), receivedAt);
    return decode(
      this.store.db(projectId).prepare('SELECT * FROM shared_feedback WHERE id=?').get(id),
    );
  }
  list(projectId: string) {
    this.store.project(projectId);
    return this.store
      .db(projectId)
      .prepare('SELECT * FROM shared_feedback WHERE projectId=? ORDER BY rowid DESC')
      .all(projectId)
      .map(decode);
  }
}
