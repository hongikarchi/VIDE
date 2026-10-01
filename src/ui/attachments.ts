import { z } from 'zod';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_REQUEST_ATTACHMENTS,
  MAX_REQUEST_ATTACHMENT_BYTES,
  storedAttachmentSchema,
  storedAttachments,
  type StoredAttachment,
} from '../contracts/workspace.ts';

/**
 * Composer attachments (SPEC-01.12): any file, picked, pasted or dropped, is kept by the engine and
 * the request carries only its record. A large image also gets a smaller view copy for the model.
 */
const MB = 1024 * 1024;
/** Images above this size get a view copy (the model is shown at most 1 MB, ARCH-01 §3). */
const VIEW_COPY_ABOVE = 1_000_000;
const VIEW_LONG_SIDE = 1600;

/** Why this batch cannot join the draft (the whole batch is refused), or undefined. */
export function batchRefusal(files: readonly File[], draftFiles: readonly unknown[]) {
  const kept = storedAttachments(draftFiles);
  if (files.some((file) => file.size > MAX_ATTACHMENT_BYTES))
    return `파일당 ${MAX_ATTACHMENT_BYTES / MB}MB까지 첨부할 수 있습니다.`;
  if (kept.length + files.length > MAX_REQUEST_ATTACHMENTS)
    return `한 요청에 파일은 ${MAX_REQUEST_ATTACHMENTS}개까지 첨부할 수 있습니다.`;
  const total =
    kept.reduce((sum, file) => sum + file.size, 0) +
    files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_REQUEST_ATTACHMENT_BYTES)
    return `한 요청의 첨부는 합계 ${MAX_REQUEST_ATTACHMENT_BYTES / MB}MB까지입니다.`;
  return undefined;
}

async function post(path: string, body: Blob) {
  let response: Response;
  try {
    response = await fetch('api/v1' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });
  } catch {
    throw Object.assign(Error('NETWORK_UNAVAILABLE'), { code: 'NETWORK_UNAVAILABLE' });
  }
  const value: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = z.object({ code: z.string() }).safeParse(value).data?.code ?? 'REQUEST_FAILED';
    throw Object.assign(Error(code), { code });
  }
  return value;
}

/** A JPEG of the image with its long side at most 1600 px (undefined when the browser cannot). */
async function viewCopy(file: File): Promise<Blob | undefined> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, VIEW_LONG_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    for (const quality of [0.85, 0.7, 0.5]) {
      const blob = await new Promise<Blob | null>((done) =>
        canvas.toBlob(done, 'image/jpeg', quality),
      );
      if (blob && blob.size <= VIEW_COPY_ABOVE) return blob;
    }
  } catch {
    /* Not an image the browser decodes: the AI is told the image is too large. */
  }
  return undefined;
}

/** Keeps each file in the project and returns the records for the draft, in order. */
export async function uploadAttachments(
  projectId: string,
  files: readonly File[],
): Promise<StoredAttachment[]> {
  const kept: StoredAttachment[] = [];
  for (const file of files) {
    const name = file.name || (file.type.startsWith('image/') ? 'image.png' : 'file');
    const record = storedAttachmentSchema.parse(
      await post(
        `/projects/${encodeURIComponent(projectId)}/attachments?name=${encodeURIComponent(name)}&type=${encodeURIComponent(file.type)}`,
        file,
      ),
    );
    if (record.kind === 'image' && record.size > VIEW_COPY_ABOVE) {
      const view = await viewCopy(file);
      if (view)
        await post(
          `/projects/${encodeURIComponent(projectId)}/attachments/${record.id}/view`,
          view,
        ).catch(() => undefined);
    }
    kept.push(record);
  }
  return kept;
}

/** The chip preview of a kept image (served by the engine; CSP allows only 'self' images). */
export const attachmentPreview = (projectId: string, id: string) =>
  `api/v1/projects/${encodeURIComponent(projectId)}/attachments/${id}`;
