import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { EditorSessions } from '../../hosts/rhino/editor-sessions.ts';
import type { HostTarget } from '../contracts/host-documents.ts';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { launchRhinoWorker, workerResultSchema } from '../../hosts/rhino/worker-client.ts';
import type { RequestInput } from '../contracts/workspace.ts';
import { nativeModelSchema } from '../contracts/native-model.ts';
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
    options: { signal: AbortSignal; onProgress: (event: { state?: string }) => void },
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
    const sourceDocument = {
      ...target,
      connection: 'owned-editor',
      documentHash: captured.documentHash,
      name: captured.name,
      units: captured.units,
      selectedIds: captured.selectedIds,
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

  async importFile(
    filename: string,
    update: (intent: Record<string, unknown>) => void,
    measurements: GeometryMeasurement[] = [],
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
  async run({ input, previous, items, signal, provider, update }: Task) {
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
      currentOperation: string | undefined;
    let diagnostic: { diagnosticId?: string; exceptionType?: string } = {};
    const intent = () => ({
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
      update({ phase: 'starting-host', hostExecuted: false });
      worker = await (options.launch || launchRhinoWorker)({
        ...options,
        directory,
        source: seededSource,
      });
      if (signal.aborted) throw failure('CANCELLED');
      const targetRef = 'rhino:' + worker.identity.sessionId;
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
          pending = worker!.execute(operationId, revision, code, protectedIds);
          try {
            const receipt = (await pending) as Awaited<ReturnType<Worker['execute']>>;
            if (receipt.ok) {
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
                snapshot: receipt.snapshot,
                changes: receipt.changes,
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
      const goal = `Target is Rhino 8, dedicated working copy ${targetRef}, meters. Permission: ${input.permission}.
Use query to observe current native IDs and bounds. For candidate permission, implement the user request with RhinoCommon SDK calls using execute. Send only a C# method body; the wrapper imports System, System.Linq, Rhino, Rhino.Geometry and supplies RhinoDoc doc. Do not declare a class or method. You may return a small JSON-serializable summary (numbers, strings, arrays, anonymous objects; at most 16 KiB) to observe calculated results. Do not return Rhino geometry/document instances. Example construction syntax: doc.Objects.AddBox(new Box(new BoundingBox(0,0,0,1,1,1))).
Use supplied dimensions, sketch plane/coordinates and pin roles. Never invent a missing critical dimension; explain what is missing. Other-host references are read-only. Before replacing an object, retain its ID and duplicate its attributes; use typed Replace overloads and re-fetch the object after mutations. Keep vide-id on existing objects; copies need a new vide-id or removal of the inherited tag. Do not modify preserved/reference objects. Do not access files, processes, networking, other documents or application-wide state. The controller saves and reopens each successful edit. Never save/open documents yourself. Compilation diagnostics allow correction; after an uncertain result never execute again. Query after successful edits, then summarize actual results in Korean. For review permission only query is available; do not claim edits.
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
            if (!last && !uncertain) update({ phase: 'model', hostExecuted: false });
          },
        },
      );
      if (uncertain) throw failure('HOST_RESULT_UNKNOWN');
      if (signal.aborted) throw failure(last ? 'HOST_RESULT_UNKNOWN' : 'CANCELLED');
      if (!last) return { ...response, hostExecuted: false, executionMode: 'sdk' };
      const model = await worker.exportModel();
      return {
        ...response,
        ...model,
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
        hostExecuted: true,
        host: 'rhino',
        executionMode: 'sdk',
        workerDirectory: directory,
        baseRequestId: intent.baseRequestId,
        sourceDocument: intent.sourceDocument,
        text: '저장된 Rhino 후보를 재확인했습니다. AI 응답은 복구되지 않았습니다.',
      };
    } finally {
      if (worker) await worker.stop();
    }
  }
}
