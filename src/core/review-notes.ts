import { z } from 'zod';
import type { Store } from './store.ts';
import type { Reviews } from './reviews.ts';
import { reviewNoteSchema } from '../contracts/reviews.ts';
import { DomainError } from './store.ts';
export class ReviewNotes {
  store: Store;
  reviews: Reviews;
  constructor(store: Store, reviews: Reviews) {
    this.store = store;
    this.reviews = reviews;
  }
  list(projectId: string, reviewId: string) {
    this.reviews.get(projectId, reviewId);
    return this.store.db
      .prepare('SELECT * FROM review_notes WHERE projectId=? AND reviewId=? ORDER BY rowid')
      .all(projectId, reviewId)
      .map((row) => reviewNoteSchema.parse(row));
  }
  create(projectId: string, reviewId: string, value: unknown) {
    const parsed = z
      .object({ id: z.string(), body: z.string(), objectId: z.string().nullable() })
      .safeParse(value);
    if (!parsed.success) throw new DomainError('INVALID_INPUT');
    const input = parsed.data;
    const review = this.reviews.get(projectId, reviewId);
    if (
      !input ||
      typeof input.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(input.id) ||
      typeof input.body !== 'string' ||
      !input.body.trim() ||
      input.body.length > 4000 ||
      !(
        input.objectId === null ||
        review.payload.model.some((object) => object.id === input.objectId)
      )
    )
      throw new DomainError('INVALID_INPUT');
    const existing = this.store.db.prepare('SELECT * FROM review_notes WHERE id=?').get(input.id);
    if (existing) {
      if (
        existing.projectId !== projectId ||
        existing.reviewId !== reviewId ||
        existing.body !== input.body ||
        existing.objectId !== input.objectId
      )
        throw new DomainError('REVISION_CONFLICT');
      return reviewNoteSchema.parse(existing);
    }
    if (this.list(projectId, reviewId).length >= 1000) throw new DomainError('INPUT_TOO_LARGE');
    this.store.db
      .prepare('INSERT INTO review_notes VALUES(?,?,?,?,?,?,?)')
      .run(
        input.id,
        projectId,
        reviewId,
        review.requestId,
        input.objectId,
        input.body,
        new Date().toISOString(),
      );
    return reviewNoteSchema.parse(
      this.store.db.prepare('SELECT * FROM review_notes WHERE id=?').get(input.id),
    );
  }
}
