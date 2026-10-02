// Layer-limited reads of a linked Rhino document (ARCH-03 §8, SPEC-07.5 5): only the layers named,
// hidden objects when asked, straight from the host. Nothing is stored — no request, no Live Sync
// basis, no viewport change — so a read never becomes the document's "last Sync". T-046 keeps the
// result in `jig_reads`; until then the caller receives it directly. server.ts hands requests here.

import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import { isFileLink, type DocumentLinks } from '../core/document-links.ts';
import type { Workspace } from '../core/workspace.ts';
import { readScopeSchema } from '../contracts/native-model.ts';
import type { SdkExecution } from './sdk-execution.ts';

export interface SyncReadContext {
  links: DocumentLinks;
  workspace: Workspace;
  sdk?: Pick<SdkExecution, 'readLayers' | 'importFile'>;
  body: (request: IncomingMessage) => Promise<Record<string, unknown>>;
  send: (status: number, data: unknown) => void;
}

const readInput = readScopeSchema
  .extend({ purpose: z.enum(['assembly', 'pre-bake']).optional() })
  .strict();
const fileImport = z.object({
  filename: z.string(),
  fileHash: z.string().regex(/^[a-f0-9]{64}$/),
  verified: z.literal(true),
});

/** Answer `POST /api/v1/projects/:id/links/:linkId/reads`; false when the request is not one. */
export async function syncReadRoutes(
  url: URL,
  request: IncomingMessage,
  { links, workspace, sdk, body, send }: SyncReadContext,
): Promise<boolean> {
  const route = /^\/api\/v1\/projects\/([^/]+)\/links\/([^/]+)\/reads$/.exec(url.pathname);
  if (!route || request.method !== 'POST') return false;
  const [, projectId, linkId] = route;
  const link = links.get(projectId, linkId);
  // ZWCAD reads are filtered on the server from the stored display Sync (ARCH-03 §8): not here.
  if (link.host !== 'rhino' || !sdk) throw new DomainError('INVALID_INPUT');
  const { purpose, ...scope } = readInput.parse(await body(request));
  const readId = randomUUID();
  if (isFileLink(link)) {
    // A file opened in VIDE: the work copy of its latest import is read again with the scope.
    const latest = workspace
      .list(projectId)
      .filter(
        (entry) =>
          entry.state === 'succeeded' &&
          entry.input.host !== 'zwcad' &&
          (entry.input.linkId === link.id ||
            (entry.input.source === 'file' &&
              `file:${String(entry.input.body)
                .replace(/ 불러오기$/, '')
                .toLowerCase()}` === link.instance)),
      )
      .at(-1);
    const copy = latest ? fileImport.safeParse(latest.result) : undefined;
    if (!copy?.success) throw new DomainError('STALE_REFERENCE');
    const read = await sdk.importFile(copy.data.filename, () => {}, [], scope);
    const { changes: _changes, ...model } = read;
    send(200, {
      readId,
      purpose: purpose ?? 'assembly',
      revisionKey: `${link.instance}|${link.documentId}|${copy.data.fileHash}`,
      objectCount: model.objects.length,
      ...model,
    });
    return true;
  }
  const read = await sdk.readLayers(
    { instance: link.instance, documentId: link.documentId },
    scope,
  );
  send(200, {
    readId,
    purpose: purpose ?? 'assembly',
    revisionKey: `${link.instance}|${link.documentId}|${read.sourceDocument.revision ?? ''}`,
    objectCount: read.objects.length,
    ...read,
  });
  return true;
}
