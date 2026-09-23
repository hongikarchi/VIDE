import { z } from 'zod';
export const reviewRowSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  title: z.string(),
  createdAt: z.string(),
});
export type ReviewRow = z.infer<typeof reviewRowSchema>;
export const reviewSchema = reviewRowSchema
  .extend({
    projectId: z.string(),
    payload: z
      .object({ model: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()) })
      .passthrough(),
  })
  .passthrough();
export type Review = z.infer<typeof reviewSchema>;
export const reviewNoteSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  reviewId: z.string(),
  requestId: z.string(),
  objectId: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
});
export type ReviewNote = z.infer<typeof reviewNoteSchema>;
