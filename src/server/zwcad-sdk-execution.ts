import { inspectorOptions } from '../../hosts/zwcad/inspector.ts';
import { ZwcadEditors } from '../../hosts/zwcad/editor-sessions.ts';
import { randomUUID } from 'node:crypto';
import { executionLimits } from '../contracts/execution-limits.ts';
import { queryPage, type QueryPageOptions } from './query-page.ts';
import { writeSnapshot } from './write-context.ts';
import { access, mkdir, readFile } from 'node:fs/promises';
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
  readonly editors: ZwcadEditors;
  constructor(options: Options) {
    this.options = options;
    this.editors = new ZwcadEditors(options.directory);
  }
  async status() {
    const config = inspectorOptions();
    try {
      await Promise.all(
        [this.options.executable || config.executable, this.options.plugin || config.plugin].map(
          (path) => access(path),
        ),
      );
      return { available: true };
    } catch {
      return { available: false };
    }
  }
  async open(result: Record<string, unknown>) {
    return this.editors.open(sourceSchema.parse(result));
  }
  /**
   * The drawing open in the user's ZWCAD (connection plugin): the AI queries its entities and runs
   * method bodies on it directly. Plan mode only reads (every transaction is aborted); the other
   * modes commit one transaction per execute, which ZWCAD's UNDO reverts in one step.
   */
  private async runAttached({ input, previous, items, signal, provider, update }: Task) {
    const basis = z
      .object({ instance: z.string(), documentId: z.number() })
      .parse(previous!.result.sourceDocument);
    const attached = this.editors.attached;
    const write = input.permission !== 'review';
    const targetRef = 'zwcad-open:' + basis.instance;
    const activity: { at: string; kind: string; text: string; detail?: string }[] = [];
    const changes = {
      added: new Set<string>(),
      modified: new Set<string>(),
      erased: new Set<string>(),
    };
    let attempts = 0,
      queries = 0,
      writes = 0;
    const progress = () => ({ queries, attempts, completed: writes });
    const report = (kind: string, text: string, detail?: string) => {
      activity.push({ at: new Date().toISOString(), kind, text, ...(detail ? { detail } : {}) });
      update({
        phase: 'host',
        host: 'zwcad',
        hostExecuted: writes > 0,
        progress: progress(),
        activity: [...activity],
      });
    };
    const handlers: {
      query: (args?: QueryPageOptions) => Promise<unknown>;
      execute: (args: { code: string }) => Promise<unknown>;
    } = {
      query: async (args = {}) => {
        queries++;
        report('query', `도면 조회 ${queries}회차`);
        return attached.query(basis, {
          offset: args.offset ?? 0,
          limit: args.limit ?? 100,
          handles: args.objectIds?.map((id) => id.replace(/^cad-/, '')),
        });
      },
      execute: async ({ code }) => {
        if (signal.aborted) throw failure('CANCELLED');
        if (attempts >= executionLimits(input).maxHostCommands) throw failure('HOST_COMMAND_LIMIT');
        attempts++;
        report('execute', `${write ? 'ZWCAD 도면 수정' : 'ZWCAD 도면 읽기'} ${attempts}회차`, code);
        const result = await attached.run(basis, code, write);
        const outcome = z
          .object({
            ok: z.boolean(),
            code: z.string().optional(),
            diagnostics: z.array(z.string()).optional(),
            changes: z
              .object({
                added: z.array(z.string()),
                modified: z.array(z.string()),
                erased: z.array(z.string()),
              })
              .optional(),
          })
          .passthrough()
          .parse(result);
        if (!outcome.ok) {
          report(
            'error',
            '실행 거절 · AI가 수정해 다시 시도',
            (outcome.diagnostics ?? []).join('\n'),
          );
          return result;
        }
        if (write && outcome.changes) {
          writes++;
          for (const id of outcome.changes.added) changes.added.add(id);
          for (const id of outcome.changes.modified)
            if (!changes.added.has(id)) changes.modified.add(id);
          for (const id of outcome.changes.erased) {
            changes.added.delete(id);
            changes.modified.delete(id);
            changes.erased.add(id);
          }
          report(
            'result',
            `도면에 반영 · 추가 ${outcome.changes.added.length} · 수정 ${outcome.changes.modified.length} · 삭제 ${outcome.changes.erased.length}`,
          );
        }
        return result;
      },
    };
    const scope = this.options.tools.issue({
      targetRef,
      handlers,
      isCurrent: () => !signal.aborted,
      maxCalls: executionLimits(input).maxToolCalls,
      ttlMs: Math.min(600000, (executionLimits(input).timeoutSeconds + 60) * 1000),
    });
    const goal = `Target is the drawing open in the user's ZWCAD 2023 (${targetRef}). It is NOT a copy: ${write ? 'every successful execute is committed to that drawing immediately as one UNDO step' : 'this is Plan mode, so execute runs read-only (its transaction is always discarded)'}.
Native coordinates are drawing units (usually millimetres; query returns "units"). Other hosts' geometry and sketches are metres, so convert explicitly.
Use query (offset/limit pages, objectIds = entity handles) to inspect entities: handle, type, layer, colour, bounds and type-specific data (line ends, polyline vertices, text, block name/attributes, dimension values). Its "layers" lists every layer with its entity count.
execute takes a C# method body. The wrapper imports System, System.Linq, ZwSoft.ZwCAD.DatabaseServices, ZwSoft.ZwCAD.Geometry and supplies Database db and Transaction tr. Use tr.GetObject and the model-space BlockTableRecord; create layers in db.LayerTableId when needed; append new entities and register them with tr.AddNewlyCreatedDBObject. The controller commits or discards the transaction; never call Commit/Abort, open or save files, use shell/network/reflection or active documents. Return small JSON-serializable values (numbers, strings, arrays, anonymous objects), never SDK objects.
Keep existing handles, layers and colours unless the request changes them; edit entities in place rather than erasing and redrawing. Do not touch protected/reference objects. Work in few, complete executes; query after writing to confirm. When a dimension is missing but a standard or conventional value exists, use it and say so.
Limits: ${executionLimits(input).maxToolCalls} tool calls, ${executionLimits(input).maxHostCommands} executes, ${executionLimits(input).timeoutSeconds} seconds. Reply in Korean with what actually changed in the drawing (and that ZWCAD's UNDO reverts it).
User request: ${input.body || '첨부한 설계 문맥을 검토해 주세요.'}`;
    try {
      report('host', '열린 ZWCAD 도면에 연결');
      const response = await provider({
        url: this.options.origin() + '/mcp',
        targetRef,
        token: scope.token,
        tools: Object.keys(handlers),
      }).run(
        { goal, revision: 1, items, includedIds: items.map((item) => item.id) },
        {
          signal,
          onProgress: () => update({ phase: writes ? 'host' : 'model', progress: progress() }),
        },
      );
      const changed = {
        added: [...changes.added],
        modified: [...changes.modified],
        removed: [...changes.erased],
      };
      // Show the drawing as it is now (a fresh read-only Sync of the open drawing).
      const model = writes ? await attached.capture(basis).catch(() => undefined) : undefined;
      return {
        ...(model ?? {}),
        ...response,
        progress: progress(),
        activity,
        changes: changed,
        appliedDirectly: writes > 0,
        hostExecuted: writes > 0,
        host: 'zwcad',
        executionMode: 'sdk',
        baseRequestId: model ? undefined : previous?.id,
        sourceDocument: model?.sourceDocument ?? previous?.result.sourceDocument,
      };
    } finally {
      scope.revoke();
    }
  }
  async run(task: Task) {
    const { input, previous, items, signal, provider, update } = task;
    if (
      previous?.result?.displayOnly === true &&
      z
        .object({ connection: z.literal('attached-editor') })
        .safeParse(previous.result.sourceDocument).success
    )
      return this.runAttached(task);
    if (previous?.result?.displayOnly === true) throw failure('ZWCAD_ATTACHED_EDIT_UNAVAILABLE');
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
      queries = 0,
      currentOperation: string | undefined;
    let diagnostic: { diagnosticId?: string; exceptionType?: string } = {};
    const progress = () => ({ queries, attempts, completed: revision });
    const intent = () => ({
      progress: progress(),
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
        query: (args?: QueryPageOptions) => Promise<unknown>;
        execute?: (args: { code: string }) => Promise<unknown>;
      } = {
        query: async (args) => {
          const result = await worker!.query();
          queries++;
          update({ ...intent(), phase: last ? 'host' : 'query' });
          return queryPage(result, args, revision);
        },
      };
      if (input.permission === 'candidate')
        handlers.execute = async ({ code }) => {
          if (signal.aborted) throw failure('CANCELLED');
          if (uncertain) throw failure('HOST_RESULT_UNKNOWN');
          if (attempts >= executionLimits(input).maxHostCommands)
            throw failure('HOST_COMMAND_LIMIT');
          attempts++;
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
                readbackVerified: true,
                ...writeSnapshot({ model: receipt.model }, revision),
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
              update({ ...intent(), revision, phase: last ? 'host' : 'model' });
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
        maxCalls: executionLimits(input).maxToolCalls,
        ttlMs: Math.min(600000, (executionLimits(input).timeoutSeconds + 60) * 1000),
      });
      const goal = `Target is ZWCAD 2023, dedicated work copy ${targetRef}. Native SDK coordinates are millimetres; attached UI geometry and sketches are metres, so convert explicitly. Permission: ${input.permission}.
Use query to inspect objects and native handles. For candidate permission use execute with a C# method body. The wrapper imports System, System.Linq, ZwSoft.ZwCAD.DatabaseServices, ZwSoft.ZwCAD.Geometry and supplies Database db and Transaction tr. Use tr.GetObject and the model-space BlockTableRecord; append new entities and register with tr.AddNewlyCreatedDBObject. The controller owns transaction commit, saving and readback. Do not open/save files, commit transactions, invoke shell/network/reflection, or access active documents. Return only small JSON-serializable values, never SDK objects.
The currently verified viewer supports independent planar XY straight LWPolylines and LINE entities with both endpoints at the same Z. Preserve each native type and handle when editing; a LINE remains a LINE. Unsupported geometry is rejected, not silently omitted. Use given dimensions and sketch coordinates; ask for missing critical values. Preserve existing handles, layers, colors and protected/reference objects; edit existing entities instead of replacing them unnecessarily. Other-host references are read-only. Query after success. Compilation/policy errors allow correction; an uncertain write forbids another execute. Respond in Korean with actual results.
Limits: ${executionLimits(input).maxToolCalls} tool calls, ${executionLimits(input).maxHostCommands} host commands, ${executionLimits(input).timeoutSeconds} seconds for the AI response. Stop at the limit and report remaining work.
User request: ${input.body || '첨부한 설계 문맥을 검토해 주세요.'}`;
      const response = await provider({
        url: options.origin() + '/mcp',
        targetRef,
        token: scope.token,
        tools: Object.keys(handlers),
      }).run(
        { goal, revision: 1, items, includedIds: items.map((item) => item.id) },
        {
          signal,
          onProgress: () => {
            if (!uncertain) update({ ...intent(), phase: last ? 'host' : 'model' });
          },
        },
      );
      if (uncertain) throw failure('HOST_RESULT_UNKNOWN');
      if (signal.aborted) throw failure(last ? 'HOST_RESULT_UNKNOWN' : 'CANCELLED');
      if (
        !last &&
        source &&
        previous?.result.verified === true &&
        previous.result.hostExecuted === true &&
        previous.result.executionMode === 'sdk' &&
        typeof input.parentRequestId === 'string' &&
        input.permission === 'candidate' &&
        queries > 0 &&
        attempts === 0
      ) {
        const model = modelSchema.parse(await worker.exportModel());
        return {
          ...response,
          ...model,
          filename: source.filename,
          fileHash: source.fileHash,
          progress: progress(),
          changes: { added: [], removed: [], modified: [] },
          unchanged: true,
          verified: true,
          hostExecuted: true,
          host: 'zwcad',
          executionMode: 'sdk',
          baseRequestId: previous.id,
          sourceDocument: previous.result.sourceDocument,
        };
      }
      if (!last)
        return { ...response, progress: progress(), hostExecuted: false, executionMode: 'sdk' };
      const model = modelSchema.parse(await worker.exportModel());
      return {
        ...response,
        ...model,
        progress: progress(),
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
        recovered: true,
        hostExecuted: true,
        host: 'zwcad',
        executionMode: 'sdk',
        workerDirectory: directory,
        baseRequestId: intent.baseRequestId,
        sourceDocument: intent.sourceDocument,
        progress: intent.progress,
        text: '저장된 ZWCAD 후보를 재확인했습니다. AI 응답은 복구되지 않았습니다.',
      };
    } finally {
      await worker.stop();
    }
  }
}
