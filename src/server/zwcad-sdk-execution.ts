import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { launchZwcadWorker, zwcadReceiptSchema } from '../../hosts/zwcad/worker-client.ts';
import { workspaceResultSchema } from '../contracts/workspace-result.ts';
import type { SdkExecution } from './sdk-execution.ts';
import type { AgentTools } from './agent-tools.ts';
type Task = Parameters<SdkExecution['run']>[0];
type Worker = Awaited<ReturnType<typeof launchZwcadWorker>>;
type Receipt = Extract<Awaited<ReturnType<Worker['execute']>>, { ok: true }>;
const sourceSchema = z.object({
  filename: z.string(),
  fileHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const pinSchema = z.object({
  id: z.string(),
  basis: z.string(),
  role: z.enum(['target', 'preserve', 'reference']),
});
const modelSchema = workspaceResultSchema.extend({
  objects: workspaceResultSchema.shape.objects.unwrap(),
  scene: workspaceResultSchema.shape.scene.unwrap(),
});
const protectionSchema = z.array(
  z.object({ id: z.string(), object: z.unknown(), scene: z.unknown() }),
);
function verifyProtected(
  model: z.infer<typeof modelSchema>,
  protection: z.infer<typeof protectionSchema>,
) {
  for (const expected of protection) {
    if (
      !expected.object ||
      JSON.stringify(expected.object) !==
        JSON.stringify(model.objects.find((object) => object.id === expected.id)) ||
      JSON.stringify(expected.scene) !==
        JSON.stringify(model.scene.find((scene) => scene.id === expected.id))
    )
      throw failure('PRESERVED_OBJECT_CHANGED');
  }
}
const failure = (code: string) => Object.assign(new Error(code), { code });
interface Options {
  directory: string;
  tools: AgentTools;
  origin: () => string;
  launch?: typeof launchZwcadWorker;
  executable?: string;
  plugin?: string;
}
export class ZwcadSdkExecution {
  private options: Options;
  constructor(options: Options) {
    this.options = options;
  }
  async run({ input, previous, items, signal, provider, update }: Task) {
    const options = this.options;
    await mkdir(options.directory, { recursive: true });
    const directory = join(options.directory, randomUUID());
    const source = previous ? sourceSchema.parse(previous.result) : undefined;
    const protectedIds = input.pins
      .map((pin) => pinSchema.parse(pin))
      .filter((pin) => pin.basis === previous?.id && pin.role !== 'target')
      .map((pin) => pin.id);
    const baseline = previous ? modelSchema.parse(previous.result) : undefined;
    const protection = protectedIds.map((id) => ({
      id,
      object: baseline?.objects.find((object) => object.id === id),
      scene: baseline?.scene.find((scene) => scene.id === id),
    }));
    let worker: Worker | undefined,
      scope: ReturnType<AgentTools['issue']> | undefined,
      last: Receipt | undefined;
    let revision = 0,
      uncertain = false,
      pending: Promise<unknown> | undefined,
      attempts = 0,
      currentOperation: string | undefined;
    let diagnostic: { diagnosticId?: string; exceptionType?: string } = {};
    const intent = () => ({
      ...diagnostic,
      protection,
      phase: 'host',
      hostExecuted: false,
      host: 'zwcad',
      executionMode: 'sdk',
      workerDirectory: directory,
      baseRequestId: previous?.id,
      operationId: currentOperation,
      sourceDocument: previous?.result.sourceDocument,
    });
    try {
      if (signal.aborted) throw failure('CANCELLED');
      update({ phase: 'starting-host', hostExecuted: false });
      worker = await (options.launch || launchZwcadWorker)({
        ...options,
        directory,
        source,
      });
      if (signal.aborted) throw failure('CANCELLED');
      const targetRef = 'zwcad:' + worker.identity.sessionId;
      const handlers: {
        query: () => Promise<unknown>;
        execute?: (args: { code: string }) => Promise<unknown>;
      } = { query: () => worker!.query() };
      if (input.permission === 'candidate')
        handlers.execute = async ({ code }) => {
          if (signal.aborted) throw failure('CANCELLED');
          if (uncertain) throw failure('HOST_RESULT_UNKNOWN');
          if (++attempts > 12) throw failure('HOST_REJECTED');
          const operationId = randomUUID();
          currentOperation = operationId;
          // Persist intent before the controller sends a write. A crash cannot become a safe retry.
          update({ ...intent(), operationId, revision });
          uncertain = true;
          pending = worker!.execute(operationId, revision, code);
          try {
            const receipt = (await pending) as Awaited<ReturnType<Worker['execute']>>;
            if (receipt.ok) {
              const model = modelSchema.parse(receipt.model);
              verifyProtected(model, protection);
              last = receipt;
              revision = receipt.revision;
              uncertain = false;
              update({
                ...intent(),
                operationId,
                revision,
                filename: receipt.filename,
                fileHash: receipt.fileHash,
              });
              return {
                ok: true,
                revision,
                readbackVerified: true,
                model: receipt.model,
                ...(Buffer.byteLength(JSON.stringify(receipt.value ?? null)) <= 16384
                  ? { value: receipt.value }
                  : { valueOmitted: true }),
              };
            }
            if (
              receipt.code === 'COMPILE_ERROR' ||
              receipt.code === 'CODE_POLICY_REJECTED' ||
              receipt.code === 'STALE_REFERENCE'
            ) {
              uncertain = false;
              currentOperation = last?.operationId;
              if (last) update({ ...intent(), revision });
              return receipt;
            }
            diagnostic = {
              diagnosticId: receipt.diagnosticId,
              exceptionType: receipt.exceptionType,
            };
            update(intent());
            throw failure('HOST_RESULT_UNKNOWN');
          } finally {
            pending = undefined;
          }
        };
      scope = options.tools.issue({
        targetRef,
        handlers,
        isCurrent: () => !signal.aborted && !uncertain,
        maxCalls: 30,
        ttlMs: 240000,
      });
      const goal = `Target is ZWCAD 2023, dedicated work copy ${targetRef}. Native SDK coordinates are millimetres; attached UI geometry and sketches are metres, so convert explicitly. Permission: ${input.permission}.
Use query to inspect objects and native handles. For candidate permission use execute with a C# method body. The wrapper imports System, System.Linq, ZwSoft.ZwCAD.DatabaseServices, ZwSoft.ZwCAD.Geometry and supplies Database db and Transaction tr. Use tr.GetObject and the model-space BlockTableRecord; append new entities and register with tr.AddNewlyCreatedDBObject. The controller owns transaction commit, saving and readback. Do not open/save files, commit transactions, invoke shell/network/reflection, or access active documents. Return only small JSON-serializable values, never SDK objects.
The currently verified viewer supports independent planar XY straight LWPolylines. Unsupported geometry is rejected, not silently omitted. Use given dimensions and sketch coordinates; ask for missing critical values. Preserve existing handles, layers, colors and protected/reference objects; edit existing entities instead of replacing them unnecessarily. Other-host references are read-only. Query after success. Compilation/policy errors allow correction; an uncertain write forbids another execute. Respond in Korean with actual results.
User request: ${input.body || '첨부한 설계 문맥을 검토해 주세요.'}`;
      const response = await provider({
        url: options.origin() + '/mcp',
        token: scope.token,
        tools: Object.keys(handlers),
      }).run(
        { goal, revision: 1, items, includedIds: items.map((item) => item.id) },
        {
          signal,
          onProgress: () => {
            if (!last && !uncertain) update({ phase: 'model', hostExecuted: false });
          },
        },
      );
      if (uncertain) throw failure('HOST_RESULT_UNKNOWN');
      if (signal.aborted) throw failure(last ? 'HOST_RESULT_UNKNOWN' : 'CANCELLED');
      if (!last) return { ...response, hostExecuted: false, executionMode: 'sdk' };
      const model = modelSchema.parse(await worker.exportModel());
      return {
        ...response,
        ...model,
        filename: last.filename,
        fileHash: last.fileHash,
        verified: true,
        hostExecuted: true,
        host: 'zwcad',
        executionMode: 'sdk',
        workerDirectory: directory,
        baseRequestId: previous?.id,
        sourceDocument: previous?.result.sourceDocument,
      };
    } catch (error) {
      if (uncertain || last)
        throw Object.assign(failure('HOST_RESULT_UNKNOWN'), { intent: intent(), cause: error });
      throw error;
    } finally {
      scope?.revoke();
      if (pending) await pending.catch(() => {});
      if (worker) await worker.stop();
    }
  }
  async recover(intent: Record<string, unknown>) {
    const directory = z.string().parse(intent.workerDirectory),
      operationId = z.string().uuid().parse(intent.operationId);
    const path = relative(resolve(this.options.directory), resolve(directory));
    if (!path || path.startsWith('..') || isAbsolute(path)) throw failure('HOST_RESULT_UNKNOWN');
    const receipt = zwcadReceiptSchema.parse(
      JSON.parse(await readFile(join(directory, operationId + '.receipt.json'), 'utf8')).result,
    );
    if (
      !receipt.ok ||
      receipt.operationId !== operationId ||
      resolve(receipt.filename) !== resolve(directory, operationId + '.dwg')
    )
      throw failure('HOST_RESULT_UNKNOWN');
    const worker = await (this.options.launch || launchZwcadWorker)({
      ...this.options,
      directory: join(this.options.directory, randomUUID()),
      source: sourceSchema.parse(receipt),
    });
    try {
      const model = modelSchema.parse(await worker.exportModel());
      verifyProtected(model, protectionSchema.parse(intent.protection || []));
      return {
        ...model,
        filename: receipt.filename,
        fileHash: receipt.fileHash,
        verified: true,
        hostExecuted: true,
        host: 'zwcad',
        executionMode: 'sdk',
        workerDirectory: directory,
        baseRequestId: intent.baseRequestId,
        text: '저장된 ZWCAD 후보를 재확인했습니다. AI 응답은 복구되지 않았습니다.',
      };
    } finally {
      await worker.stop();
    }
  }
}
