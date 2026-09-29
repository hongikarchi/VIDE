import { randomUUID } from 'node:crypto';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { z } from 'zod';
import { mkdir, readFile, writeFile, rename, readdir, lstat } from 'node:fs/promises';
import { editorConnectionSchema, resumeEditor, type ChangeSet } from './editor-channel.ts';
import { launchRhinoWorker } from './worker-client.ts';
import type { HostTarget, HostDocuments } from '../../src/contracts/host-documents.ts';
import type { ReadScope } from '../../src/contracts/native-model.ts';

type Resumed = ReturnType<typeof resumeEditor>;
type Worker = Omit<Resumed, 'editorConnection'> & {
  editorConnection?: Resumed['editorConnection'];
};
interface Options {
  directory: string;
  executable: string;
  plugin: string;
  bootstrap: string;
  launch?: typeof launchRhinoWorker;
  resume?: typeof resumeEditor;
  connectionDirectory?: string;
}
const candidateSchema = z.object({
  filename: z.string(),
  fileHash: z.string(),
  sourceDocument: z.object({
    instance: z.string(),
    documentId: z.number(),
    documentHash: z.string(),
    /** Attached captures: full content hash (documentHash is the connection's revision token). */
    contentHash: z.string().optional(),
    /** The captured copy (its receipt has the per-object hashes at capture time). */
    capture: z.string(),
  }),
  changes: z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    modified: z.array(z.object({ id: z.string() })),
  }),
});
const changeSet = (candidate: z.infer<typeof candidateSchema>): ChangeSet => ({
  capture: candidate.sourceDocument.capture,
  changes: {
    added: candidate.changes.added,
    removed: candidate.changes.removed,
    modified: candidate.changes.modified.map((change) => change.id),
  },
});
type ApplicationTarget = HostTarget & { documentHash: string; candidateHash: string };
const failure = (code: string) => Object.assign(new Error(code), { code });

/** Visible user editing sessions stay alive when the controller closes. */
export class EditorSessions {
  private sessions = new Map<string, Worker>();
  private options: Options;
  private ready: Promise<void> | undefined;
  private writes = Promise.resolve();
  private attached = new Map<string, Worker>();
  constructor(options: Options) {
    this.options = options;
  }
  private get registry() {
    return this.options.directory + '.editors.json';
  }
  private restore() {
    return (this.ready ??= this.load());
  }
  private async load() {
    let data: unknown;
    try {
      data = JSON.parse(await readFile(this.registry, 'utf8'));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
      throw failure('EDITOR_REGISTRY_INVALID');
    }
    const parsed = z.array(editorConnectionSchema).max(100).safeParse(data);
    if (!parsed.success) throw failure('EDITOR_REGISTRY_INVALID');
    for (const connection of parsed.data) {
      const worker = (this.options.resume || resumeEditor)(connection, this.options.executable);
      this.sessions.set(worker.identity.pid + ':' + worker.identity.startTicks, worker);
    }
  }
  private async discover() {
    const directory =
      this.options.connectionDirectory ||
      join(dirname(this.options.directory), 'rhino-connections');
    let files: string[];
    try {
      if ((await lstat(directory)).isSymbolicLink()) throw failure('EDITOR_REGISTRY_INVALID');
      files = await readdir(directory);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        this.attached.clear();
        return;
      }
      throw error;
    }
    const next = new Map<string, Worker>();
    for (const file of files.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).slice(0, 100)) {
      try {
        const path = join(directory, file),
          info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) continue;
        const connection = editorConnectionSchema.parse(JSON.parse(await readFile(path, 'utf8')));
        if (file !== connection.identity.sessionId + '.json') continue;
        const worker = (this.options.resume || resumeEditor)(connection, this.options.executable);
        const instance =
          worker.identity.pid + ':' + worker.identity.startTicks + ':' + worker.identity.sessionId;
        next.set(instance, worker);
      } catch {
        /* Invalid or concurrently removed discovery files never become trusted channels. */
      }
    }
    this.attached = next;
  }
  async connectionKind(instance: string) {
    await this.discover();
    return this.attached.has(instance) ? 'attached-editor' : 'owned-editor';
  }
  private persist() {
    const save = async () => {
      const data = JSON.stringify(
        [...this.sessions.values()].map((worker) => worker.editorConnection).filter(Boolean),
      );
      await writeFile(this.registry + '.tmp', data, { mode: 0o600 });
      await rename(this.registry + '.tmp', this.registry);
    };
    const next = this.writes.then(save, save);
    this.writes = next.catch(() => {});
    return next;
  }
  async has(instance: string) {
    await this.restore();
    await this.discover();
    return this.sessions.has(instance) || this.attached.has(instance);
  }
  async open(source: { filename: string; fileHash: string }) {
    await this.restore();
    if (this.sessions.size >= 100) throw failure('EDITOR_SESSION_LIMIT');
    await mkdir(this.options.directory, { recursive: true });
    const worker = await (this.options.launch || launchRhinoWorker)({
      ...this.options,
      directory: join(this.options.directory, randomUUID()),
      mode: 'editor',
      visible: true,
      source,
    });
    const instance = worker.identity.pid + ':' + worker.identity.startTicks;
    worker.detach();
    this.sessions.set(instance, worker);
    await this.persist();
    return { opened: true, instance, documentId: worker.identity.documentId };
  }
  private async get(target: HostTarget) {
    await this.restore();
    await this.discover();
    const worker = this.sessions.get(target.instance) || this.attached.get(target.instance);
    if (!worker || worker.identity.documentId !== target.documentId)
      throw failure('STALE_CONNECTION');
    return worker;
  }
  async list(attachedOnly = false): Promise<HostDocuments | null> {
    await this.restore();
    const documents: HostDocuments['documents'] = [];
    let changed = false;
    await this.discover();
    for (const [instance, worker] of [...(attachedOnly ? [] : this.sessions), ...this.attached]) {
      try {
        const external = this.attached.has(instance);
        const snapshot = external ? await worker.attachedStatus() : await worker.inspectEditor();
        documents.push({
          instance,
          id: snapshot.documentId,
          name: snapshot.name,
          units: snapshot.units,
          objectCount: snapshot.objectCount,
          modified: snapshot.modified,
          host: 'rhino',
          connection: external ? 'attached-editor' : 'owned-editor',
          ...('generation' in snapshot
            ? {
                ...(snapshot.path ? { path: snapshot.path } : {}),
                generation: snapshot.generation,
                live: snapshot.live,
                hostBusy: snapshot.busy,
                selectionVersion: snapshot.selectionVersion,
                selectedIds: snapshot.selectedIds,
                pinnedIds: snapshot.pinnedIds,
              }
            : {}),
        });
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          ['HOST_LEASE_EXPIRED', 'TARGET_MISMATCH'].includes(String(error.code))
        ) {
          this.sessions.delete(instance);
          changed = true;
        }
      }
    }
    if (changed) await this.persist();
    return documents.length ? { instance: documents[0].instance!, documents } : null;
  }
  async setPins(target: HostTarget, ids: string[]) {
    await this.discover();
    const worker = this.attached.get(target.instance);
    if (!worker || worker.identity.documentId !== target.documentId)
      throw failure('STALE_CONNECTION');
    return worker.setPins(ids);
  }
  async inspect(target: HostTarget) {
    const snapshot = await (await this.get(target)).inspectEditor();
    return {
      ...target,
      documentHash: snapshot.documentHash,
      selectedIds: snapshot.selectedIds,
      observedAt: new Date().toISOString(),
    };
  }
  private candidate(value: unknown, target: HostTarget) {
    const candidate = candidateSchema.parse(value),
      path = relative(resolve(this.options.directory), resolve(candidate.filename));
    if (!path || path.startsWith('..') || isAbsolute(path)) throw failure('INVALID_ARTIFACT');
    if (
      candidate.sourceDocument.instance !== target.instance ||
      candidate.sourceDocument.documentId !== target.documentId
    )
      throw failure('TARGET_MISMATCH');
    return candidate;
  }
  async preview(target: HostTarget, value: unknown) {
    const candidate = this.candidate(value, target);
    // Native application always verifies the document content, never the display revision token.
    return (await this.get(target)).previewEditorApplication(
      candidate.filename,
      candidate.fileHash,
      candidate.sourceDocument.contentHash ?? candidate.sourceDocument.documentHash,
      changeSet(candidate),
    );
  }
  async apply(id: string, value: unknown, target: ApplicationTarget) {
    const candidate = this.candidate(value, target);
    return (await this.get(target)).applyEditorCandidate(
      id,
      candidate.filename,
      target.candidateHash,
      target.documentHash,
      changeSet(candidate),
    );
  }
  async reconcile(id: string, value: unknown, target: ApplicationTarget) {
    const candidate = this.candidate(value, target);
    return (await this.get(target)).recoverEditorApplication(
      id,
      candidate.filename,
      target.candidateHash,
      target.documentHash,
      changeSet(candidate),
    );
  }
  async capture(target: HostTarget) {
    return (await this.get(target)).captureEditor(randomUUID());
  }
  async display(target: HostTarget, scope: ReadScope = {}) {
    if ((await this.connectionKind(target.instance)) !== 'attached-editor')
      throw failure('TARGET_MISMATCH');
    return (await this.get(target)).displayEditor(scope);
  }
  async changes(target: HostTarget, since: number) {
    if ((await this.connectionKind(target.instance)) !== 'attached-editor')
      throw failure('RESYNC_REQUIRED');
    return (await this.get(target)).displayChanges(since);
  }
}
