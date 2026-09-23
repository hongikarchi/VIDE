import { z } from 'zod';
import { sharedCommentInputSchema } from './shared-spatial.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const feedbackFileSchema = z
  .object({
    format: z.literal('vide-feedback-v1'),
    origin: z.url(),
    projectId: id,
    publicationId: id,
    exportId: id,
    manifest: z
      .object({
        title: z.string(),
        objectIds: z.array(id),
        assets: z.array(
          z
            .object({
              id,
              parts: z.array(
                z.object({ sha256: z.string(), size: z.number().int().positive() }).strict(),
              ),
            })
            .strict(),
        ),
      })
      .strict(),
    comment: z
      .object({
        id,
        authorId: id,
        receivedAt: z.number().int().positive(),
        input: z
          .object({
            body: sharedCommentInputSchema.shape.body,
            objectId: sharedCommentInputSchema.shape.objectId,
            pin: sharedCommentInputSchema.shape.pin,
            sketches: sharedCommentInputSchema.shape.sketches,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export const receivedFeedbackSchema = z.object({
  id,
  projectId: id,
  requestId: id,
  receivedAt: z.string(),
  source: z.literal('file'),
  original: feedbackFileSchema,
});
export type ReceivedFeedback = z.infer<typeof receivedFeedbackSchema>;
