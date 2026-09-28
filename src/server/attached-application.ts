import { z } from 'zod';
import type { Applications } from './application.ts';
import type { Workspace } from '../core/workspace.ts';
import type { StoredWork } from '../contracts/stored-work.ts';
import type { SdkExecution } from './sdk-execution.ts';

const sourceSchema = z.object({
  connection: z.literal('attached-editor'),
  instance: z.string(),
  documentId: z.number(),
  documentHash: z.string(),
});
const code = (error: unknown) =>
  z.object({ code: z.string() }).safeParse(error).data?.code || 'APPLICATION_FAILED';

/** Only the request's frozen authorization can initiate a native write. */
export async function applyAttachedCandidate(
  workspace: Workspace,
  applications: Pick<Applications, 'prepare' | 'confirm'>,
  sdk: Pick<SdkExecution, 'captureEditor'>,
  request: StoredWork,
  candidate: Record<string, unknown>,
  signal: AbortSignal,
) {
  const { projectId, id, input } = request;
  const finish = (state: StoredWork['state'], result: Record<string, unknown>) =>
    workspace.update(projectId, id, state, result);
  let result = { ...candidate };
  let writing = false;
  try {
    if (
      !input.applyToSource ||
      input.permission !== 'candidate' ||
      !input.baseRequestId ||
      input.linkedTargets ||
      (input.host || 'rhino') !== 'rhino'
    )
      throw { code: 'INVALID_INPUT' };
    const source = sourceSchema.parse(
      workspace.get(projectId, input.baseRequestId).result?.sourceDocument,
    );
    const returned = sourceSchema.parse(candidate.sourceDocument);
    if (
      source.instance !== returned.instance ||
      source.documentId !== returned.documentId ||
      source.documentHash !== returned.documentHash
    )
      throw { code: 'TARGET_MISMATCH' };
    if (signal.aborted) return finish('cancelled', { ...result, code: 'CANCELLED' });
    finish('running', result);
    const prepared = await applications.prepare(projectId, id, source);
    if (signal.aborted) return finish('cancelled', { ...result, code: 'CANCELLED' });
    result = { ...result, phase: 'host', applicationId: prepared.id };
    finish('running', result);
    writing = true;
    const outcome = await applications.confirm(projectId, prepared.id);
    if (!outcome) throw { code: 'HOST_RESULT_UNKNOWN' };
    result = { ...result, applicationState: outcome.state };
    if (outcome.state !== 'succeeded')
      return finish(outcome.state === 'failed' ? 'failed' : 'unknown', {
        ...result,
        code: outcome.state === 'failed' ? 'APPLICATION_FAILED' : 'HOST_RESULT_UNKNOWN',
      });
    // A read-back error must never retry a successful native write.
    try {
      const synced = await sdk.captureEditor(source, () => {});
      return finish('succeeded', {
        ...result,
        ...synced,
        phase: 'complete',
        hostExecuted: true,
        text: candidate.text,
        applicationState: 'succeeded',
        syncState: 'succeeded',
        appliedCandidate: { filename: candidate.filename, fileHash: candidate.fileHash },
      });
    } catch {
      return finish('succeeded', {
        ...result,
        phase: 'complete',
        syncState: 'failed',
        code: 'APPLIED_SYNC_FAILED',
      });
    }
  } catch (error) {
    return finish(writing ? 'unknown' : 'failed', {
      ...result,
      code: writing ? 'HOST_RESULT_UNKNOWN' : code(error),
    });
  }
}
