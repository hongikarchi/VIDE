import { randomUUID, createHash } from 'node:crypto';
import { executionLimits } from '../contracts/execution-limits.ts';
import { queryPage, type QueryPageOptions } from './query-page.ts';
import { writeChanges, writeSnapshot } from './write-context.ts';
import { activityLog } from './activity.ts';
import { mkdir, readFile, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { EditorSessions } from '../../hosts/rhino/editor-sessions.ts';
import type { HostTarget } from '../contracts/host-documents.ts';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { launchRhinoWorker, workerResultSchema } from '../../hosts/rhino/worker-client.ts';
import type { RequestInput } from '../contracts/workspace.ts';
import {
  nativeModelSchema,
  displayObjectSchema,
  displaySceneSchema,
  displayDefinitionSchema,
  type ReadScope,
} from '../contracts/native-model.ts';
import { applyDisplayDelta } from '../core/display-delta.ts';
import { withSurvey } from '../../hosts/rhino/scene-pages.ts';
import { AgentTools } from './agent-tools.ts';
import type { GeometryMeasurement } from '../core/measurement-cache.ts';

type Worker = Awaited<ReturnType<typeof launchRhinoWorker>>;
type Receipt = Extract<Awaited<ReturnType<Worker['execute']>>, { ok: true }>;
interface ContextItem {
  id: string;
  type: string;
  data: unknown;
}
interface Provider {
  run(
    context: { goal: string; revision: number; items: ContextItem[]; includedIds: string[] },
    options: {
      signal: AbortSignal;
      onProgress: (event: { state?: string; text?: string; kind?: 'thinking' | 'message' }) => void;
    },
  ): Promise<{ text: string; [key: string]: unknown }>;
}
export interface AgentConnection {
  url: string;
  token: string;
  tools: string[];
  targetRef?: string;
}
interface Options {
  directory: string;
  executable: string;
  plugin: string;
  bootstrap: string;
  tools: AgentTools;
  origin: () => string;
  launch?: typeof launchRhinoWorker;
}
export interface Task {
  input: RequestInput;
  previous?: { id: string; result: Record<string, unknown> };
  items: ContextItem[];
  signal: AbortSignal;
  provider: (connection: AgentConnection) => Provider;
  update: (phase: Record<string, unknown>) => void;
}
/** A bake: fixed bodies in order, no provider (`runFixed`). */
export interface FixedTask {
  input: RequestInput;
  previous?: { id: string; result: Record<string, unknown> };
  codes: string[];
  signal: AbortSignal;
  update: (phase: Record<string, unknown>) => void;
  expectedDocumentHash?: string;
}
const sourceSchema = z.object({
  filename: z.string(),
  fileHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const pinSchema = z.object({
  id: z.string(),
  basis: z.string(),
  role: z.enum(['target', 'preserve', 'reference']),
});
const failure = (code: string) => Object.assign(new Error(code), { code });

/** The controller owns the process, output path, revision and receipt; the agent owns SDK code. */
export class SdkExecution {
  private options: Options;
  readonly editors: EditorSessions;
  constructor(options: Options) {
    this.options = options;
    this.editors = new EditorSessions(options);
  }
  async status() {
    try {
      await Promise.all(
        [this.options.executable, this.options.plugin, this.options.bootstrap].map((path) =>
          access(path),
        ),
      );
      return { available: true, mode: 'sdk', ready: true };
    } catch {
      return { available: false, mode: 'sdk', reason: 'SDK_HOST_NOT_INSTALLED' };
    }
  }
  async open(result: Record<string, unknown>) {
    const source = sourceSchema.parse(result),
      path = relative(resolve(this.options.directory), resolve(source.filename));
    if (!path || path.startsWith('..') || isAbsolute(path)) throw failure('INVALID_ARTIFACT');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(source.filename)) hash.update(chunk);
    if (hash.digest('hex') !== source.fileHash) throw failure('SOURCE_CHANGED');
    return this.editors.open(source);
  }
  async captureEditor(
    target: HostTarget,
    update: (intent: Record<string, unknown>) => void,
    measurements: GeometryMeasurement[] = [],
  ) {
    const captured = await this.editors.capture(target);
    // Attached documents identify a basis by connection revision; the content hash guards application.
    const sourceDocument = {
      ...target,
      connection: await this.editors.connectionKind(target.instance),
      documentHash: captured.revisionHash ?? captured.documentHash,
      ...(captured.revisionHash ? { contentHash: captured.documentHash } : {}),
      name: captured.name,
      units: captured.units,
      selectedIds: captured.selectedIds,
      capture: captured.filename,
      capturedAt: new Date().toISOString(),
    };
    try {
      const result = await this.importFile(
        captured.filename,
        (intent) => update({ ...intent, sourceDocument }),
        measurements,
      );
      return { ...result, sourceDocument };
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'intent' in error &&
        error.intent &&
        typeof error.intent === 'object'
      )
        Object.assign(error, { intent: { ...error.intent, sourceDocument } });
      throw error;
    }
  }

  async syncEditor(
    target: HostTarget,
    update: (intent: Record<string, unknown>) => void,
    measurements: GeometryMeasurement[] = [],
  ) {
    if ((await this.editors.connectionKind(target.instance)) !== 'attached-editor')
      return this.captureEditor(target, update, measurements);
    const { source, ...model } = await this.editors.display(target);
    return {
      ...model,
      displayOnly: true,
      verified: false,
      executionMode: 'sdk',
      sourceDocument: {
        ...target,
        connection: 'attached-editor',
        documentHash: source.documentHash,
        ...(source.revision === undefined ? {} : { revision: source.revision }),
        name: source.name,
        units: source.units,
        selectedIds: source.selectedIds,
        capturedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * A layer-limited read of an attached document (ARCH-03 §8): only the named layers, hidden objects
   * too when asked. Same display page method, but the caller keeps it out of the Sync history.
   */
  async readLayers(target: HostTarget, scope: ReadScope) {
    const { source, ...model } = await this.editors.display(target, scope);
    return {
      ...model,
      sourceDocument: {
        ...target,
        connection: 'attached-editor' as const,
        documentHash: source.documentHash,
        ...(source.revision === undefined ? {} : { revision: source.revision }),
        name: source.name,
        units: source.units,
        capturedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Live Sync: objects changed since `since` on the same attached connection, merged into `basis`.
   * RESYNC_REQUIRED means the caller must fall back to a full Sync.
   */
  async liveSync(
    target: HostTarget,
    basis: { objects: unknown[]; scene: unknown[]; sourceDocument: Record<string, unknown> },
    since: number,
  ) {
    // The stored basis was validated when it was read from Rhino; only changed items are checked here.
    if (
      !Array.isArray(basis.objects) ||
      !Array.isArray(basis.scene) ||
      basis.sourceDocument.instance !== target.instance
    )
      throw failure('RESYNC_REQUIRED');
    const delta = await this.editors.changes(target, since);
    const merged = applyDisplayDelta(
      basis as {
        objects: z.infer<typeof displayObjectSchema>[];
        scene: z.infer<typeof displaySceneSchema>[];
        definitions?: Record<string, z.infer<typeof displayDefinitionSchema>>;
      },
      delta,
    );
    const source = delta.source;
    return {
      delta: {
        objects: delta.objects,
        scene: delta.scene,
        removed: delta.removed,
        definitions: delta.definitions,
      },
      result: {
        // The plugin surveys the document with every change page; an older plugin sends none.
        ...withSurvey(merged, { coverage: delta.coverage, layers: delta.layers }),
        sourceDocument: {
          ...basis.sourceDocument,
          ...target,
          connection: 'attached-editor',
          documentHash: source.documentHash,
          revision: delta.revision,
          name: source.name,
          units: source.units,
          selectedIds: source.selectedIds,
          capturedAt: new Date().toISOString(),
        },
      },
    };
  }

  /** Opens a file in a work copy; `scope` limits the exported model to layers or adds hidden objects. */
  async importFile(
    filename: string,
    update: (intent: Record<string, unknown>) => void,
    measurements: GeometryMeasurement[] = [],
    scope: ReadScope = {},
  ) {
    const options = this.options;
    await mkdir(options.directory, { recursive: true });
    const directory = join(options.directory, randomUUID()),
      operationId = randomUUID();
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    const source = { filename, fileHash: hash.digest('hex'), geometryMeasurements: measurements };
    const intent = {
      phase: 'host',
      hostExecuted: false,
      host: 'rhino',
      executionMode: 'sdk',
      workerDirectory: directory,
      operationId,
    };
    let worker: Worker | undefined,
      writing = false;
    try {
      worker = await (options.launch || launchRhinoWorker)({
        ...options,
        directory,
        source,
        normalizeUnits: true,
        exportScope: scope,
      });
      update(intent);
      writing = true;
      const receipt = await worker.execute(
        operationId,
        0,
        '// Save the validated, normalized imported working copy.',
      );
      if (!receipt.ok) throw failure('HOST_RESULT_UNKNOWN');
      const model = await worker.exportModel();
      return {
        ...model,
        filename: receipt.filename,
        fileHash: receipt.fileHash,
        verified: true,
        changes: receipt.changes,
        executionMode: 'sdk',
        workerDirectory: directory,
      };
    } catch (error) {
      if (writing) throw Object.assign(failure('HOST_RESULT_UNKNOWN'), { intent, cause: error });
      throw error;
    } finally {
      if (worker) await worker.stop();
    }
  }
  /**
   * Rhino에 만들기 (ARCH-03 §9.3, PLAN-22 T-055): fixed C# bodies VIDE rendered itself, run in
   * order in one work copy with no AI provider, then saved and re-read like any candidate. A
   * rejected or failing body fails the request (`BAKE_TEMPLATE_REJECTED` / `BAKE_FAILED`); the
   * original is untouched either way. `expectedDocumentHash` is the forced read's revision token:
   * a work copy of another revision is refused (`STALE_INPUT`) before anything runs.
   */
  async runFixed({ input, previous, codes, signal, update, expectedDocumentHash }: FixedTask) {
    if (!codes.length) throw failure('INVALID_INPUT');
    if (previous?.result.displayOnly === true) {
      const basis = z
        .object({ instance: z.string(), documentId: z.number(), documentHash: z.string() })
        .parse(previous.result.sourceDocument);
      // The document must still be the one the forced read saw. Compared before the capture: a
      // capture itself moves the revision token (Rhino counts saves as a property change), and
      // the application later verifies the captured content object by object anyway.
      if (
        expectedDocumentHash !== undefined &&
        (await this.editors.inspect(basis)).documentHash !== expectedDocumentHash
      )
        throw failure('STALE_INPUT');
      const prepared = await this.captureEditor(basis, update);
      previous = { id: previous.id, result: prepared };
    }
    const options = this.options;
    await mkdir(options.directory, { recursive: true });
    const directory = join(options.directory, randomUUID());
    const source = previous ? sourceSchema.parse(previous.result) : undefined;
    if (!source) throw failure('STALE_REFERENCE');
    let worker: Worker | undefined, last: Receipt | undefined, currentOperation: string | undefined;
    let revision = 0;
    const activity = activityLog();
    const values: unknown[] = [];
    const intent = () => ({
      progress: { queries: 0, attempts: values.length, completed: revision },
      activity: activity.entries,
      phase: 'host',
      hostExecuted: false,
      host: 'rhino',
      executionMode: 'sdk',
      workerDirectory: directory,
      baseRequestId: previous?.id,
      operationId: currentOperation,
      sourceDocument: previous?.result.sourceDocument,
    });
    try {
      if (signal.aborted) throw failure('CANCELLED');
      activity.add('host', 'Rhino 작업 사본 준비');
      update({ phase: 'starting-host', hostExecuted: false, activity: activity.entries });
      worker = await (options.launch || launchRhinoWorker)({ ...options, directory, source });
      for (const [index, code] of codes.entries()) {
        if (signal.aborted) throw failure('CANCELLED');
        const operationId = randomUUID();
        currentOperation = operationId;
        activity.add('execute', `고정 틀 실행 ${index + 1}/${codes.length}`);
        update({ ...intent(), operationId, revision });
        const receipt = await worker.execute(operationId, revision, code);
        if (!receipt.ok) {
          const rejected =
            receipt.code === 'COMPILE_ERROR' || receipt.code === 'CODE_POLICY_REJECTED';
          activity.add(
            'error',
            rejected
              ? '고정 틀이 워커에서 거절됨'
              : `고정 틀 실행 실패 · ${receipt.exceptionType ?? receipt.code}`,
            receipt.diagnostics?.join(' / '),
          );
          update(intent());
          throw Object.assign(failure(rejected ? 'BAKE_TEMPLATE_REJECTED' : 'BAKE_FAILED'), {
            diagnostics: receipt.diagnostics,
            diagnosticId: receipt.diagnosticId,
            exceptionType: receipt.exceptionType,
          });
        }
        last = receipt;
        revision = receipt.revision;
        values.push(receipt.value ?? null);
        const counts = writeChanges(receipt.changes)?.counts;
        activity.add(
          'result',
          counts
            ? `실행 성공 · 추가 ${counts.added} · 수정 ${counts.modified} · 삭제 ${counts.removed} · 저장·재열기 검증`
            : '실행 성공 · 저장·재열기 검증',
        );
        update({
          ...intent(),
          operationId,
          revision,
          filename: receipt.filename,
          fileHash: receipt.fileHash,
        });
      }
      const model = await worker.exportModel();
      return {
        ...model,
        values,
        progress: { queries: 0, attempts: values.length, completed: revision },
        activity: activity.entries,
        changes: last!.changes,
        filename: last!.filename,
        fileHash: last!.fileHash,
        verified: true,
        hostExecuted: true,
        host: 'rhino',
        executionMode: 'sdk',
        workerDirectory: directory,
        baseRequestId: previous?.id,
        sourceDocument: previous?.result.sourceDocument,
      };
    } finally {
      if (worker) await worker.stop();
    }
  }
  async run({ input, previous, items, signal, provider, update }: Task) {
    if (previous?.result.displayOnly === true) {
      const basis = z
        .object({ instance: z.string(), documentId: z.number(), documentHash: z.string() })
        .parse(previous.result.sourceDocument);
      // Edit the document as it is now. The Sync basis names the Rhino session and document; its
      // revision also moves on material/property events and whenever the user keeps working in
      // Rhino, so it cannot gate a request. Application checks this capture's content hash.
      const prepared = await this.captureEditor(basis, update);
      previous = { id: previous.id, result: prepared };
    }
    const options = this.options;
    await mkdir(options.directory, { recursive: true });
    const directory = join(options.directory, randomUUID());
    const source = previous ? sourceSchema.parse(previous.result) : undefined;
    const priorModel =
      previous?.result.executionMode === 'sdk' && previous.result.measurementVersion === 1
        ? nativeModelSchema.safeParse(previous.result)
        : undefined;
    const seededSource =
      source && priorModel?.success
        ? {
            ...source,
            measurements: priorModel.data.scene.map(({ id, area, volume, length }) => ({
              id,
              area,
              volume,
              length,
            })),
          }
        : source;
    const protectedIds = input.pins
      .map((pin) => pinSchema.parse(pin))
      .filter((pin) => pin.basis === previous?.id && pin.role !== 'target')
      .map((pin) => pin.id);
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
    const activity = activityLog();
    const progress = () => ({ queries, attempts, completed: revision });
    const intent = () => ({
      progress: progress(),
      activity: activity.entries,
      ...diagnostic,
      phase: 'host',
      hostExecuted: false,
      host: 'rhino',
      executionMode: 'sdk',
      workerDirectory: directory,
      baseRequestId: previous?.id,
      operationId: currentOperation,
      sourceDocument: previous?.result.sourceDocument,
    });
    try {
      if (signal.aborted) throw failure('CANCELLED');
      activity.add('host', 'Rhino 작업 사본 준비');
      update({ phase: 'starting-host', hostExecuted: false, activity: activity.entries });
      worker = await (options.launch || launchRhinoWorker)({
        ...options,
        directory,
        source: seededSource,
      });
      if (signal.aborted) throw failure('CANCELLED');
      const targetRef = 'rhino:' + worker.identity.sessionId;
      const handlers: {
        query: (args?: QueryPageOptions) => Promise<unknown>;
        execute?: (args: { code: string }) => Promise<unknown>;
      } = {
        query: async (args) => {
          const result = await worker!.query();
          queries++;
          activity.add('query', `모델 조회 ${queries}회차`);
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
          activity.add('execute', `RhinoCommon 코드 실행 ${attempts}회차`, code);
          const operationId = randomUUID();
          currentOperation = operationId;
          // Persist intent before the controller sends a write. A crash cannot become a safe retry.
          update({ ...intent(), operationId, revision });
          uncertain = true;
          pending = worker!.execute(operationId, revision, code, protectedIds);
          try {
            const receipt = (await pending) as Awaited<ReturnType<Worker['execute']>>;
            if (receipt.ok) {
              last = receipt;
              revision = receipt.revision;
              uncertain = false;
              const counts = writeChanges(receipt.changes)?.counts;
              activity.add(
                'result',
                counts
                  ? `실행 성공 · 추가 ${counts.added} · 수정 ${counts.modified} · 삭제 ${counts.removed} · 저장·재열기 검증`
                  : '실행 성공 · 저장·재열기 검증',
              );
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
                snapshot: writeSnapshot(receipt.snapshot, revision),
                changes: writeChanges(receipt.changes),
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
              activity.add(
                'error',
                receipt.code === 'COMPILE_ERROR'
                  ? '코드 컴파일 오류 · AI가 수정해 다시 시도'
                  : receipt.code === 'CODE_POLICY_REJECTED'
                    ? '허용되지 않은 코드 · AI가 수정해 다시 시도'
                    : '기준이 바뀐 객체 참조 · 다시 조회 필요',
                'diagnostics' in receipt && Array.isArray(receipt.diagnostics)
                  ? receipt.diagnostics.join(' / ')
                  : undefined,
              );
              currentOperation = last?.operationId;
              update({ ...intent(), revision, phase: last ? 'host' : 'model' });
              return receipt;
            }
            diagnostic = {
              diagnosticId: receipt.diagnosticId,
              exceptionType: receipt.exceptionType,
            };
            activity.add(
              'error',
              `호스트 실행 결과 미확인 · ${receipt.exceptionType ?? receipt.code}`,
            );
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
      const goal = `Target is Rhino 8, dedicated working copy ${targetRef}, meters. Permission: ${input.permission}.
Use query to observe current native IDs, layers and bounds (curves also give start/end points, length and whether they are straight). For candidate permission, implement the user request with RhinoCommon SDK calls using execute. Send only a C# method body; the wrapper imports System, System.Linq, Rhino, Rhino.Geometry and supplies RhinoDoc doc. Do not declare a class or method. You may return a small JSON-serializable summary (numbers, strings, arrays, anonymous objects; at most 16 KiB) to observe calculated results. Do not return Rhino geometry/document instances. Example construction syntax: doc.Objects.AddBox(new Box(new BoundingBox(0,0,0,1,1,1))).
Use supplied dimensions, sketches and pin roles. Sketch items: points are U/V metres on plane (XY/XZ/YZ through the origin); brush sketches carry strokes[].points as world XYZ polylines in metres drawn freehand by the user (placement surface=on model faces, view=a view plane, plane=axis plane at planeOffset), so treat them as approximate intent and snap to nearby geometry; color/width only distinguish strokes. What a sketch means (outline, path, direction, area) comes from the message text; an older sketch may also carry a role. When a dimension is missing but a standard or conventional value exists (e.g. a KS/JIS steel section table, typical thicknesses, the pinned objects' own dimensions), use the closest one, do the work and state the assumption in the reply; ask only when no reasonable value exists. Other-host references are read-only. Before replacing an object, retain its ID and duplicate its attributes; apply changed attributes with ModifyAttributes before typed Replace, then re-fetch the object and verify the requested attribute values after mutations. Keep vide-id on existing objects; copies need a new vide-id or removal of the inherited tag. Do not modify preserved/reference objects. Do not access files, processes, networking, other documents or application-wide state. The controller saves and reopens each successful edit. Never save/open documents yourself. Compilation diagnostics allow correction; after an uncertain result never execute again. Query after successful edits, then summarize actual results in Korean. For review permission only query is available; do not claim edits.
Limits: ${executionLimits(input).maxToolCalls} tool calls, ${executionLimits(input).maxHostCommands} host commands, ${executionLimits(input).timeoutSeconds} seconds for the AI response. Stop at the limit and report remaining work.
User request: ${input.body || '첨부한 설계 문맥을 검토해 주세요.'}`;
      activity.add('model', 'AI에 요청 전달 · 응답 대기');
      update({ ...intent(), phase: 'model' });
      const response = await provider({
        url: options.origin() + '/mcp',
        targetRef,
        token: scope.token,
        tools: Object.keys(handlers),
      }).run(
        { goal, revision: 1, items, includedIds: items.map((item) => item.id) },
        {
          signal,
          onProgress: (event) => {
            if (event.text) activity.add(event.kind ?? 'message', event.text);
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
        const model = await worker.exportModel();
        return {
          ...response,
          ...model,
          filename: source.filename,
          fileHash: source.fileHash,
          progress: progress(),
          activity: activity.entries,
          changes: { added: [], removed: [], modified: [] },
          unchanged: true,
          verified: true,
          hostExecuted: true,
          host: 'rhino',
          executionMode: 'sdk',
          baseRequestId: previous.id,
          sourceDocument: previous.result.sourceDocument,
        };
      }
      if (!last)
        return {
          ...response,
          progress: progress(),
          activity: activity.entries,
          hostExecuted: false,
          executionMode: 'sdk',
        };
      const model = await worker.exportModel();
      return {
        ...response,
        ...model,
        progress: progress(),
        activity: activity.entries,
        changes: last.changes,
        filename: last.filename,
        fileHash: last.fileHash,
        verified: true,
        hostExecuted: true,
        host: 'rhino',
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
    const operationId = z.string().uuid().parse(intent.operationId),
      directory = z.string().parse(intent.workerDirectory);
    const path = relative(resolve(this.options.directory), resolve(directory));
    if (!path || path.startsWith('..') || isAbsolute(path)) throw failure('HOST_RESULT_UNKNOWN');
    const record = z
      .object({ result: workerResultSchema })
      .parse(JSON.parse(await readFile(join(directory, operationId + '.json'), 'utf8')));
    const receipt = record.result;
    if (
      !receipt.ok ||
      receipt.operationId !== operationId ||
      resolve(receipt.filename) !== resolve(directory, operationId + '.3dm')
    )
      throw failure('HOST_RESULT_UNKNOWN');
    let worker: Worker | undefined;
    try {
      worker = await (this.options.launch || launchRhinoWorker)({
        ...this.options,
        directory: join(this.options.directory, randomUUID()),
        source: { filename: receipt.filename, fileHash: receipt.fileHash },
      });
      const model = await worker.exportModel();
      return {
        ...model,
        changes: receipt.changes,
        filename: receipt.filename,
        fileHash: receipt.fileHash,
        verified: true,
        recovered: true,
        hostExecuted: true,
        host: 'rhino',
        executionMode: 'sdk',
        workerDirectory: directory,
        baseRequestId: intent.baseRequestId,
        sourceDocument: intent.sourceDocument,
        progress: intent.progress,
        text: '저장된 Rhino 후보를 재확인했습니다. AI 응답은 복구되지 않았습니다.',
      };
    } finally {
      if (worker) await worker.stop();
    }
  }
}
