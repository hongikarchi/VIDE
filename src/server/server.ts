import {
  hasJevKey,
  judgeRoute,
  linkLabels,
  officialJigs,
  routeSettingsFor,
} from '../ai/request-router.ts';
import { selectContext } from '../ai/context-selector.ts';
import { GEOMETRY_TYPE, encodeGeometry } from '../contracts/geometry-transfer.ts';
import { applyAttachedCandidate } from './attached-application.ts';
import { LiveSync } from './live-sync.ts';
import { DEFAULT_SHARING_ORIGIN, RemoteAccess } from './remote-access.ts';
import { OfflineView } from './offline-view.ts';
import { Connectors, type ConnectorOptions } from './connectors.ts';
import { appVersion, defaultRhinoPlugin, defaultZwcadConnection } from './sdk-options.ts';
import { gzip } from 'node:zlib';
import { AccountUsageService, PROVIDERS } from '../ai/account-usage.ts';
import { JIGS } from '../jigs/catalog.ts';
import { runSync } from '../jigs/sync.ts';
import { closeJigRuntime, jigRoutes, jigStatuses } from './jig-routes.ts';
import { routeJigsOf, skillCatalog } from './skill-catalog.ts';
import {
  analysisWorkerStats,
  closeAnalysisWorker,
} from '../jigs/official/structure-analysis/index.ts';
import { makeRoutes, makeStatuses } from './make-routes.ts';
import { syncReadRoutes } from './sync-reads.ts';
import { factRoutes, factStatuses } from './facts-routes.ts';
import { ConversationService, conversationRoutes, conversationStatuses } from './conversations.ts';
import {
  analyzeSummary,
  applyEdits,
  checkModel as checkStructureModel,
  documentKey as structureDocumentKey,
  draftEditsSchema,
  draftStructure,
  StructureStore,
} from '../jigs/structure/index.ts';
import { AUTO_MODELS, ModelRouter, isAutoModel } from '../ai/model-router.ts';
import { PinCarryError, carryPins } from './pin-carry.ts';
import { startHealthLog } from './health.ts';
import { Diagnostics, RepeatGate, routeOf } from './diagnostics.ts';
import { writeDiagnosticBundle } from './diagnostic-bundle.ts';
import { Telemetry, type TelemetryOptions } from './telemetry.ts';
import {
  BIG_JSON,
  breadcrumb,
  scrub,
  setBreadcrumbSink,
  setDiagnosticSink,
} from '../core/breadcrumbs.ts';
import { knowledgeFile } from '../jigs/knowledge.ts';
import {
  DocumentLinks,
  isFileLink,
  type OpenDocument as LinkedDocument,
} from '../core/document-links.ts';
import { followOpenDocuments } from './live-links.ts';
import { linkRequests, removeLink } from './link-removal.ts';
import { importedName } from '../contracts/link-requests.ts';
import { z } from 'zod';
import type { IncomingMessage } from 'node:http';
import type { StoredWork } from '../contracts/stored-work.ts';
import { hostTargetSchema } from '../contracts/host-documents.ts';
import { candidateSchema } from '../core/reviews.ts';
import { lazyCandidate } from '../core/scene-items.ts';
type ExecutionOptions = NonNullable<ConstructorParameters<typeof Execution>[1]>;
interface ServerOptions {
  filename: string;
  port?: number;
  providerFactory?: ExecutionOptions['providerFactory'];
  host?: RhinoWorkspace;
  cadHost?: ZwcadWorkspace;
  applicationOptions?: ConstructorParameters<typeof Applications>[2];
  onShutdown?: () => void;
  sdkOptions?: Omit<ConstructorParameters<typeof SdkExecution>[0], 'tools' | 'origin'>;
  /** Test seams for host plugin installation (registry, running processes, bundled plugin). */
  connectorOptions?: Partial<ConnectorOptions>;
  /** Test seams for the remote tunnel process and Worker calls. */
  remoteOptions?: Pick<
    ConstructorParameters<typeof RemoteAccess>[0],
    'executable' | 'spawnProcess' | 'fetcher' | 'heartbeatMs'
  >;
  /** Test seams for the reference boards' image job (SPEC-09.7): a fake codex or runner. */
  referenceOptions?: Omit<ReferenceBoardsOptions, 'outputs'>;
  /** Test seam: the one-time split of an old `vide.sqlite` (ADR-032). */
  storeSplit?: typeof splitProjectDatabase;
  /** Test seams for the opt-in reports (ADR-036): the first-run card, the site, the clock. */
  telemetryOptions?: Partial<
    Pick<
      TelemetryOptions,
      'prompt' | 'site' | 'fetcher' | 'now' | 'startDelayMs' | 'everyMs' | 'batchMs'
    >
  >;
}
import { readWebAsset } from './web-assets.ts';
import { Extensions } from '../core/extensions.ts';
import { AgentTools } from './agent-tools.ts';
import { SdkExecution } from './sdk-execution.ts';
import { ZwcadSdkExecution } from './zwcad-sdk-execution.ts';
import { AiSettings } from '../core/ai-settings.ts';
import { ProjectInstructionStore } from '../ai/instructions/project-store.ts';
import { QuestionSettings } from '../ai/question-settings.ts';
import { closeIdleCodexAppServers } from '../ai/codex-app-server.ts';
import { WebSettings } from '../ai/web-settings.ts';
import { ReviewNotes } from '../core/review-notes.ts';
import { compareReviews } from '../core/review-comparison.ts';
import { Reviews } from '../core/reviews.ts';
import { createPublicationBundle } from '../core/publication.ts';
import { SharedFeedback } from '../core/shared-feedback.ts';
import { TableViews } from '../core/table-views.ts';
import { Applications } from './application.ts';
import { listDocuments, inspectDocument } from '../../hosts/rhino/documents.ts';
import { compareCandidates, relatedCandidates } from '../core/comparison.ts';
import { quantities, quantitiesCsv } from '../core/quantities.ts';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { DomainError } from '../core/store.ts';
import { openStore } from '../core/store-open.ts';
import type { splitProjectDatabase } from '../core/project-split.ts';
import { Workspace } from '../core/workspace.ts';
import { requestInputSchema, requestMode } from '../contracts/workspace.ts';
import { Execution } from './execution.ts';
import { ModelStore, isItemList } from '../core/model-store.ts';
import { maintainModels } from '../core/model-move.ts';
import { RhinoWorkspace } from '../../hosts/rhino/workspace.ts';
import { ZwcadWorkspace } from '../../hosts/zwcad/workspace.ts';
import { dirname, join } from 'node:path';
import { importModel, recoverDwgImport } from './import-model.ts';
import { AttachmentStore } from './attachments.ts';
import { attachmentPathRoutes } from './attachment-paths.ts';
import { checkFolder, folderRoutes } from './project-files.ts';
import { ProjectFolders } from '../core/project-folders.ts';
import { Agenda } from '../core/agenda.ts';
import { agendaRoutes, agendaStatuses } from './agenda-routes.ts';
import { SharedNotes } from './shared-notes.ts';
import { notesRoutes, notesStatuses } from './notes-routes.ts';
import {
  ReferenceBoards,
  referenceRoutes,
  type ReferenceBoardsOptions,
} from './reference-boards.ts';
import { renderReport } from './report.ts';
import { RemovedProjects, removeProject } from './project-removal.ts';
import { SyncCoalescer } from './sync-coalesce.ts';
import {
  documentKey,
  runDocumentSync,
  runUserSync,
  type DocumentSyncContext,
} from './document-sync.ts';
import { SyncScheduler, type ScheduledDocument } from './sync-scheduler.ts';
import { ReadOnlyWatch } from './read-only-watch.ts';
import { sweepCopies, unsettledCopies, within } from './capture-cleanup.ts';

/** The local browser session survives restarts, so an open page keeps working after one. */
/** The desktop shell's session key, kept in the data folder; an in-memory store keeps none. */
async function localSession(directory: string | undefined) {
  if (!directory) return randomBytes(32).toString('hex');
  const file = join(directory, 'local-session.key');
  try {
    const saved = (await readFile(file, 'utf8')).trim();
    if (/^[a-f0-9]{64}$/.test(saved)) return saved;
  } catch {
    /* First start: create one. */
  }
  const value = randomBytes(32).toString('hex');
  await writeFile(file, value, { mode: 0o600 });
  return value;
}
const equal = (a: unknown, b: string) =>
  typeof a === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
/**
 * A JSON request body is held in memory, so a broken or hostile client cannot stream gigabytes:
 * the same memory guard as the host frame (ADR-031 7), set well above any real request (a request
 * with its images, a jig model). Bigger inputs (files, models) use their own streaming routes.
 */
export const JSON_BODY_BYTES = 64 * 1024 * 1024;
/** An error's own upper-case code (a DomainError's, a provider's, a host's), else undefined. */
const errorCodeOf = (error: unknown) => {
  const code =
    error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : '';
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : undefined;
};
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new DomainError('JSON_REQUIRED');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > JSON_BODY_BYTES) throw new DomainError('INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw 0;
    return z.record(z.string(), z.unknown()).parse(parsed);
  } catch {
    throw new DomainError('INVALID_INPUT');
  }
}
/** Object rows per page of `GET …/requests/:r/objects` without `ids`/`native` (T-127). */
const OBJECT_PAGE = 2000;
const statuses: Record<string, number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  JSON_REQUIRED: 415,
  GEOMETRY_BINARY_REQUIRED: 406,
  INPUT_TOO_LARGE: 413,
  REVISION_CONFLICT: 409,
  TARGET_MISMATCH: 409,
  CONTROLLER_BUSY: 409,
  PROJECT_BUSY: 409,
  WORKSPACE_CAPACITY: 409,
  STALE_REFERENCE: 409,
  LINK_NOTICE_GONE: 409,
  STRUCTURE_MODEL_INVALID: 422,
  STRUCTURE_CORE_MISSING: 503,
  HOST_RUNNING: 409,
  REFERENCE_BUSY: 409,
  REFERENCE_NOT_READY: 409,
  REFERENCE_FROZEN: 409,
  REFERENCE_TARGET_UNKNOWN: 409,
  REFERENCE_IMAGES_OFF: 409,
  REFERENCE_NO_VIEW: 409,
  ...jigStatuses,
  ...conversationStatuses,
  ...factStatuses,
  ...makeStatuses,
  ...agendaStatuses,
  ...notesStatuses,
};
export async function startServer({
  filename,
  port = 0,
  providerFactory,
  host,
  cadHost,
  applicationOptions,
  onShutdown,
  sdkOptions,
  remoteOptions,
  connectorOptions,
  referenceOptions,
  storeSplit,
  telemetryOptions,
}: ServerOptions) {
  const { store, event: storeEvent } = await openStore(filename, storeSplit),
    bootstrap = randomBytes(32).toString('hex'),
    session = await localSession(filename === ':memory:' ? undefined : dirname(filename));
  const agentTools = new AgentTools({ origin: () => origin });
  // Composer attachments (SPEC-01.12): kept per project in the data folder.
  const attachments =
    filename === ':memory:'
      ? undefined
      : new AttachmentStore(join(dirname(filename), 'attachments'));
  // Reference-image boards (SPEC-09.9): regions over image attachments, per project.
  const referenceBoards =
    filename === ':memory:'
      ? undefined
      : new ReferenceBoards(join(dirname(filename), 'reference-boards'), {
          ...referenceOptions,
          // The board's view captures and generated images are the project's outputs (SPEC-09.9).
          outputs: join(dirname(filename), 'outputs'),
        });
  // Project folders and the AI's file tools (SPEC-01.13): the data folder is never read.
  const folders = new ProjectFolders(store),
    fileContext = { dataDirectory: filename === ':memory:' ? undefined : dirname(filename) };
  const workspace = new Workspace(store),
    removedProjects = new RemovedProjects(filename === ':memory:' ? undefined : dirname(filename)),
    listProjects = () => removedProjects.visible(store.listProjects()),
    links = new DocumentLinks(store),
    tableViews = new TableViews(store),
    agenda = new Agenda(store),
    structures = new StructureStore(
      filename === ':memory:' ? null : join(dirname(filename), 'structure'),
    ),
    reviews = new Reviews(store),
    reviewNotes = new ReviewNotes(store, reviews);
  const sharedFeedback = new SharedFeedback(store, workspace);
  host ??= new RhinoWorkspace(join(dirname(filename), 'models'));
  const hosts = {
      rhino: host,
      zwcad: cadHost || new ZwcadWorkspace(join(dirname(filename), 'cad-models')),
    },
    importRecoveries = new Map<string, Promise<StoredWork>>();
  const aiSettings = new AiSettings(store),
    extensions = new Extensions(store, workspace);
  const sdk = sdkOptions
    ? new SdkExecution({ ...sdkOptions, tools: agentTools, origin: () => origin })
    : undefined;
  // Automatic document Syncs of the same document share one read (PLAN-27 T-087).
  const documentSyncs = new SyncCoalescer<StoredWork>();
  // A Live Sync waits for a full Sync of the same document that runs now (ARCH-01 §7).
  // ZWCAD drawings follow the same Live Sync (T-128); the drawing's connection decides the host.
  const liveSync = sdk
    ? new LiveSync(
        workspace,
        {
          liveSync: async (target, basis, since) =>
            (await zwcadSdk?.editors.attached.has(target.instance))
              ? zwcadSdk!.liveSync(target, basis, since)
              : sdk.liveSync(target, basis, since),
        },
        {
          settled: async (projectId, instance, documentId) =>
            Promise.all(
              (['rhino', 'zwcad'] as const).map((host) =>
                documentSyncs.current(documentKey(projectId, host, instance, documentId)),
              ),
            ),
        },
      )
    : undefined;
  const connectors = new Connectors({
    directory: dirname(filename),
    bundledRhino: sdkOptions?.plugin ?? defaultRhinoPlugin(),
    bundledZwcad: defaultZwcadConnection(),
    version: appVersion(),
    ...connectorOptions,
  });
  // Other devices reach this server only through the paired tunnel (see remote-access.ts).
  const remoteAccess = new RemoteAccess({
    ...remoteOptions,
    directory: dirname(filename),
    port: () => Number(new URL(origin).port),
    projects: listProjects,
    activity: () => store.projectActivity(),
    onQueue: (items) => offlineView.receive(items),
    onAgendaEdits: (edits) => offlineView.applyEdits(edits),
    afterHeartbeat: () => {
      void offlineView.tick().catch(() => {});
      notesTick();
    },
    onProjects: (projects) => {
      for (const project of projects) {
        // Deleted on the account site: removed here too, rows and files (SPEC-01.1). A project
        // removed here is never recreated from a list the site has not updated yet.
        if (project.deleted) {
          void removedProjects.add(project.id).catch(() => {});
          purgeRemoved(project.id);
        } else if (!removedProjects.has(project.id)) {
          try {
            store.ensureProject(project.id, project.name);
          } catch {
            /* A name the local store rejects keeps the local name. */
          }
        }
      }
    },
    status: async () => {
      const rhino = (await sdk?.editors.list(true)) || { documents: [] };
      const cad = (await zwcadSdk?.editors.attached.list()) || [];
      return {
        version: appVersion(),
        documents: [...rhino.documents, ...cad].slice(0, 20).map((item) => ({
          host: item.host ?? 'rhino',
          name: item.name,
          live: item.live ?? false,
        })),
      };
    },
  });
  // Shared notes (SPEC-10): this PC as a member of the site; a Markdown copy for the AI.
  const sharedNotes =
    filename === ':memory:'
      ? undefined
      : new SharedNotes({ remote: remoteAccess, dataDirectory: dirname(filename), agenda });
  // The copies of every project's notes refresh every ten minutes (and whenever notes are shown).
  let notesRefreshed = 0;
  function notesTick() {
    if (!sharedNotes || Date.now() - notesRefreshed < 10 * 60_000) return;
    notesRefreshed = Date.now();
    void (async () => {
      for (const project of listProjects()) await sharedNotes.list(project.id).catch(() => {});
    })();
  }
  // Offline view and site request inbox (PLAN-20).
  const offlineView = new OfflineView({
    directory: filename === ':memory:' ? undefined : dirname(filename),
    store,
    workspace,
    links,
    remote: remoteAccess,
    agenda,
  });
  /**
   * Deletes a project on this PC, asked in the app or on the account site (SPEC-01.1): its rows,
   * the files VIDE made for it in the data folder, and then the space they took in the database.
   */
  async function purgeProject(projectId: string) {
    const data = filename === ':memory:' ? undefined : dirname(filename);
    const knowledge =
      data && /^[0-9a-f-]{36}$/i.test(projectId) ? knowledgeFile(data, projectId) : undefined;
    const perProject = data
      ? [
          join(data, 'structure', `${projectId}.json`),
          join(data, 'ai-instructions', `${projectId}.json`),
          ...(knowledge
            ? [
                ...['', '-wal', '-shm'].map((end) => knowledge + end),
                knowledge.replace(/\.sqlite$/, '.structural-conditions.md'),
                // Before the split (ADR-032) these lived in knowledge/; the split keeps the old
                // DB as *.migrated.
                ...['.structural-conditions.md', '.sqlite.migrated'].map((end) =>
                  join(data, 'knowledge', projectId + end),
                ),
              ]
            : []),
        ]
      : [];
    const removed = await removeProject({
      projectId,
      store,
      links,
      removed: removedProjects,
      dataDirectory: data,
      importDirectories: [
        hosts.rhino.directory,
        hosts.zwcad.directory,
        ...(attachments ? [attachments.root] : []),
        ...(referenceBoards ? [referenceBoards.root, referenceBoards.outputs] : []),
      ],
      projectFiles: perProject,
    });
    await offlineView.forget(projectId).catch(() => {});
    store.compact();
    return removed;
  }
  // A removed project that still has rows: deleted on the site (or while its work ran). One
  // attempt at a time; PROJECT_BUSY leaves it for the next heartbeat.
  const purging = new Set<string>();
  function purgeRemoved(projectId: string) {
    if (purging.has(projectId) || !store.listProjects().some((row) => row.id === projectId)) return;
    purging.add(projectId);
    void purgeProject(projectId)
      .catch(() => {})
      .finally(() => purging.delete(projectId));
  }
  for (const projectId of removedProjects.list()) purgeRemoved(projectId);
  const zwcadSdk = sdkOptions
    ? new ZwcadSdkExecution({
        directory: join(dirname(filename), 'zwcad-sdk-models'),
        tools: agentTools,
        origin: () => origin,
      })
    : undefined;
  const applications = new Applications(store, workspace, {
    ...applicationOptions,
    sdk:
      sdk && zwcadSdk
        ? {
            preview: async (target, candidate) =>
              ((await zwcadSdk.editors.has(target.instance))
                ? zwcadSdk.editors
                : sdk.editors
              ).preview(target, candidate),
            apply: async (id, candidate, target) =>
              ((await zwcadSdk.editors.has(target.instance))
                ? zwcadSdk.editors
                : sdk.editors
              ).apply(id, candidate, target),
            reconcile: async (id, candidate, target) =>
              ((await zwcadSdk.editors.has(target.instance))
                ? zwcadSdk.editors
                : sdk.editors
              ).reconcile(id, candidate, target),
          }
        : sdk?.editors,
  });
  const rhinoImport = sdk
    ? {
        directory: host.directory,
        importFile: (projectId: string, id: string, source: string) =>
          sdk.importFile(source, (intent) => workspace.update(projectId, id, 'running', intent)),
      }
    : host;
  const syncContext: DocumentSyncContext = {
    workspace,
    sdk,
    zwcadSdk,
    rhinoImport,
    host,
    documentSyncs,
    liveSync,
    diagnostics: { write: (event, fields) => diagnostics.write(event, fields) },
  };
  /** A Live Sync with its engine record (PLAN-27 0단계). */
  async function runLiveSync(projectId: string, input: unknown) {
    if (!liveSync) throw new DomainError('RESYNC_REQUIRED');
    const began = performance.now();
    breadcrumb('live-sync-begin');
    let synced: Awaited<ReturnType<typeof liveSync.run>>;
    try {
      synced = await liveSync.run(projectId, input);
    } catch (error) {
      // Every failed Live Sync with its code (T-126); the user sees the same code.
      diagnostics.write('live-sync-failed', {
        projectId,
        ms: Math.round(performance.now() - began),
        code: errorCodeOf(error) ?? 'INTERNAL_ERROR',
        ...(error instanceof DomainError ? {} : Diagnostics.error(error)),
      });
      throw error;
    }
    diagnostics.write('live-sync', {
      ms: Math.round(performance.now() - began),
      ...('delta' in synced
        ? {
            changed: synced.delta.objects.length,
            removed: synced.delta.removed.length,
            created: synced.created,
            ...synced.timing,
          }
        : 'retry' in synced
          ? { retry: synced.retry }
          : { resync: true }),
    });
    return synced;
  }
  // Open documents of the connected hosts: the links list reads them (every open page polls it)
  // and the Sync scheduler reuses a read younger than 0.7 s instead of asking the hosts again.
  const readOpen = async () => [
    ...((await sdk?.editors.list(true).catch(() => null))?.documents ?? []),
    ...((await zwcadSdk?.editors.attached.list().catch(() => [])) ?? []),
  ];
  let openRead: { at: number; documents: ReturnType<typeof readOpen> } | undefined;
  const openDocuments = (fresh = false) => {
    const now = Date.now();
    if (fresh || !openRead || now - openRead.at > 700)
      openRead = {
        at: now,
        documents: readOpen(),
      };
    return openRead.documents;
  };
  // The engine Syncs linked files itself, with or without an open page (T-084, ARCH-01 §7).
  const scheduler =
    sdk || zwcadSdk
      ? new SyncScheduler({
          workspace,
          links,
          projects: () => listProjects(),
          open: () => openDocuments(),
          fullSync: (projectId, target) => runDocumentSync(syncContext, projectId, target),
          isOwnedOpen: async (link) =>
            link.host === 'rhino'
              ? await sdk?.editors.has(link.instance)
              : await zwcadSdk?.editors.has(link.instance),
          ...(liveSync
            ? {
                liveSync: (projectId, input) => runLiveSync(projectId, input),
              }
            : {}),
          log: (event, data) => diagnostics.write(event, data),
        })
      : undefined;
  // The current account of each CLI's default login and its usage (ADR-025: read only; accounts are
  // managed in AccountSwitch). The lookup setting sat next to VIDE's former account profiles.
  const accountUsage = new AccountUsageService(
    filename === ':memory:'
      ? {}
      : {
          file: join(dirname(filename), 'usage-settings.json'),
          legacyFile: join(dirname(filename), 'cli-profiles', 'usage-settings.json'),
        },
  );
  const diagnostics = new Diagnostics({
    directory: filename === ':memory:' ? undefined : dirname(filename),
  });
  // The data folder's opening (ADR-032): the one-time split, or why the old single DB stays.
  if (storeEvent)
    diagnostics.write(
      storeEvent.name,
      {
        ...(storeEvent.error === undefined ? {} : Diagnostics.error(storeEvent.error)),
        ...storeEvent.data,
        layout: store.layout,
      },
      true,
    );
  const diagnosticSink = (event: string, fields: Record<string, unknown>) =>
    diagnostics.write(event, fields);
  const apiErrorRepeats = new RepeatGate();
  // Error reports of the app's pages (window error / unhandled rejection): 20 a minute at most.
  const clientErrors = new RepeatGate(60_000);
  let clientWindow = { at: 0, count: 0 };
  if (filename !== ':memory:') {
    // A breadcrumb is on disk before its heavy step starts (a native crash runs no exit code).
    setBreadcrumbSink((step, fields) => diagnostics.write('step', { step, ...fields }, true));
    // The AI providers' and agent tools' own lines (T-126).
    setDiagnosticSink(diagnosticSink);
  }
  // An attached document Rhino opened read-only: one log entry with what could explain it.
  if (sdk && filename !== ':memory:') {
    const readOnly = new ReadOnlyWatch({
      write: (event, fields) => diagnostics.write(event, fields),
      describe: (target) => sdk.editors.status(target),
    });
    sdk.editors.observe = (target, snapshot) => readOnly.note(target, snapshot);
  }
  // Conversations (SPEC-02.19): sessions per turn, ledger, transcript retention (30 days).
  const conversations = new ConversationService(store, {
    diagnostics,
    // A reference board's data and output shape for its turns (SPEC-09.4, T-090).
    reference: (request) => referenceBoards?.turnItem(request),
  });
  // The per-project addendum of the AI instruction bundle (PLAN-24 지침 묶음).
  const projectInstructions = new ProjectInstructionStore(
    filename === ':memory:' ? undefined : dirname(filename),
  );
  // Settings → AI 「AI가 작업 도중에 묻기」 (T-075): the providers' own questions mid-turn, default on.
  const questionSettings = new QuestionSettings(
    filename === ':memory:' ? undefined : join(dirname(filename), 'question-settings.json'),
  );
  // Settings → AI 「AI 웹 검색」 (ADR-028, T-105): the providers' own web tools, default on.
  const webSettings = new WebSettings(
    filename === ':memory:' ? undefined : join(dirname(filename), 'web-settings.json'),
  );
  // Opt-in error/performance reports (ADR-036, SPEC-05.9): nothing is sent before the user agrees.
  const telemetry = new Telemetry({
    directory: filename === ':memory:' ? undefined : dirname(filename),
    prompt: process.env.VIDE_DESKTOP === '1',
    site: () => process.env.VIDE_TELEMETRY_SITE || remoteAccess.site || DEFAULT_SHARING_ORIGIN,
    version: appVersion,
    flush: () => diagnostics.flush(),
    sensitive: () => listProjects().map((project) => project.name),
    ...telemetryOptions,
  });
  const execution = new Execution(workspace, {
    diagnostics,
    conversations,
    questions: () => questionSettings.get().native,
    web: () => webSettings.get().web,
    projectInstructions: (projectId) => projectInstructions.text(projectId),
    selectContext: (text, candidates) =>
      selectContext(text, candidates, { dataDirectory: dirname(filename) }),
    onProviderLimit: (provider) =>
      accountUsage.markLimited(z.enum(['claude-cli', 'codex-cli']).parse(provider)),
    applyAttached: sdk
      ? (request, result, signal) =>
          applyAttachedCandidate(workspace, applications, sdk, request, result, signal)
      : undefined,
    tools: agentTools,
    providerFactory,
    host,
    hosts,
    settings: aiSettings,
    sdk,
    zwcadSdk,
    attachments,
    folders,
    fileContext,
    // A reference turn's end makes the board's next 판 and starts its image job (T-090).
    onFinished: (row) => referenceBoards?.afterTurn(row),
  });
  if (referenceBoards)
    referenceBoards.lookup = (projectId, requestId) => {
      try {
        return workspace.get(projectId, requestId);
      } catch {
        return undefined;
      }
    };
  // Signed-in services for automatic model choice; each check runs the CLIs, so it is reused briefly.
  let signedIn: { at: number; value: Promise<('claude-cli' | 'codex-cli')[]> } | undefined;
  const signedInServices = () => {
    if (!signedIn || Date.now() - signedIn.at > 60_000)
      signedIn = {
        at: Date.now(),
        value: execution
          .status()
          .then((rows) => rows.filter((row) => row.available).map((row) => row.id)),
      };
    return signedIn.value;
  };
  const modelRouter = new ModelRouter({
    dataDirectory: dirname(filename),
    log: filename !== ':memory:',
  });
  const withApplications = (request: StoredWork) => ({
    ...request,
    applications: store
      .db(request.projectId)
      .prepare(
        "SELECT id,state,result FROM commands WHERE projectId=? AND kind='applyCandidate' AND json_extract(payload,'$.requestId')=? ORDER BY rowid",
      )
      .all(request.projectId, request.id)
      .map((row) => ({
        ...row,
        result: row.result ? JSON.parse(z.string().parse(row.result)) : null,
      })),
  });
  /**
   * A request as the request list and the user's Sync answer show it (T-123): never a whole model.
   * A display Sync also leaves out its object rows (`objectsOmitted`, `objectCount`); a screen that
   * needs them reads `GET …/requests/:r/objects`.
   */
  const listed = (request: StoredWork): StoredWork => {
    const result = request.result as Record<string, unknown> | null;
    if (!result) return request;
    const { scene, definitions: _definitions, ...rest } = result;
    const light: Record<string, unknown> = scene === undefined ? { ...result } : rest;
    if (scene !== undefined || result.sceneOmitted) light.sceneOmitted = true;
    if (result.displayOnly === true && Array.isArray(result.objects)) {
      delete light.objects;
      light.objectsOmitted = true;
      light.objectCount = result.objects.length;
    }
    return { ...request, result: light as StoredWork['result'] };
  };
  let origin = '',
    authority = '',
    stopping = false;
  const server = createServer(async (request, response) => {
    const requestId = randomBytes(8).toString('hex');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    // Requests through the tunnel carry its public Host; they get their own origin and sessions.
    const remote = !!remoteAccess.host && request.headers.host === remoteAccess.host;
    const requestOrigin = remote ? `https://${remoteAccess.host}` : origin;
    // Remote clients are on mobile networks: compress large bodies when they accept gzip.
    const deliver = (status: number, contentType: string, payload: string | Buffer) => {
      if (
        remote &&
        payload.length > 16384 &&
        /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''))
      ) {
        gzip(payload, { level: 4 }, (error, packed) => {
          if (error) {
            response.writeHead(status, { 'Content-Type': contentType });
            response.end(payload);
            return;
          }
          response.writeHead(status, {
            'Content-Type': contentType,
            'Content-Encoding': 'gzip',
            Vary: 'Accept-Encoding',
          });
          response.end(packed);
        });
        return;
      }
      response.writeHead(status, { 'Content-Type': contentType });
      response.end(payload);
    };
    const send = (status: number, data: unknown) => {
      const text = JSON.stringify(data);
      if (text.length >= BIG_JSON)
        breadcrumb('send-big', { path: request.url?.split('?')[0], bytes: text.length });
      deliver(status, 'application/json; charset=utf-8', text);
    };
    const accepts = (type: string) => String(request.headers.accept ?? '').includes(type);
    try {
      if (!remote && request.headers.host !== authority) throw new DomainError('FORBIDDEN');
      // The account site asks whether this PC is the browser's own PC (answer: this host's id).
      if (
        !remote &&
        request.url === '/api/v1/hello' &&
        remoteAccess.site &&
        request.headers.origin === remoteAccess.site
      ) {
        response.setHeader('Access-Control-Allow-Origin', remoteAccess.site);
        response.setHeader('Vary', 'Origin');
        if (request.method === 'OPTIONS') {
          response.setHeader('Access-Control-Allow-Methods', 'GET');
          response.setHeader('Access-Control-Allow-Private-Network', 'true');
          response.writeHead(204);
          response.end();
          return;
        }
        if (request.method === 'GET') {
          send(200, { hostId: remoteAccess.hostId });
          return;
        }
      }
      if (request.headers.origin && request.headers.origin !== requestOrigin)
        throw new DomainError('FORBIDDEN');
      const url = new URL(request.url || '/', requestOrigin);
      // The account site's "open" link navigates here cross-site; only that page load may be.
      if (
        request.headers['sec-fetch-site'] === 'cross-site' &&
        !(
          request.method === 'GET' &&
          request.headers['sec-fetch-mode'] === 'navigate' &&
          !url.pathname.startsWith('/api/')
        )
      )
        throw new DomainError('FORBIDDEN');
      if (url.pathname === '/mcp') {
        // The agent tool endpoint serves local AI processes only.
        if (remote) throw new DomainError('FORBIDDEN');
        if (stopping) throw new DomainError('APP_STOPPING');
        await agentTools.handle(request, response, body);
        return;
      }
      if (request.method === 'GET') {
        const asset = await readWebAsset(url.pathname);
        if (asset) {
          deliver(200, asset.contentType, asset.body);
          return;
        }
      }
      if (!url.pathname.startsWith('/api/v1/')) throw new DomainError('NOT_FOUND');
      if (
        !['GET', 'POST', 'PUT'].includes(request.method || '') &&
        // Discarding a jig draft (ARCH-03 §7 `DELETE …/jig-drafts/:did`, T-064), taking a jig off
        // the project's list ([삭제] → `DELETE …/jigs/:jigId/pin`) and deleting a project with its
        // data (after the app's confirmation).
        !(
          request.method === 'DELETE' &&
          /^\/api\/v1\/projects\/[^/]+(\/jig-drafts\/[^/]+|\/jigs\/[^/]+\/pin)?$/.test(url.pathname)
        )
      ) {
        send(405, { code: 'METHOD_NOT_ALLOWED', requestId });
        return;
      }
      if (request.method !== 'GET' && request.headers.origin !== requestOrigin)
        throw new DomainError('FORBIDDEN');
      if (remote && url.pathname === '/api/v1/session' && request.method === 'POST') {
        const input = await body(request);
        const remoteSession = await remoteAccess.login(input.remoteToken);
        // Pick up projects just made or renamed on the account site before the page lists them.
        await remoteAccess.heartbeat();
        response.setHeader(
          'Set-Cookie',
          `vide_remote=${remoteSession}; HttpOnly; Secure; SameSite=Strict; Path=/`,
        );
        send(200, { authenticated: true, remote: true });
        return;
      }
      if (url.pathname === '/api/v1/session' && request.method === 'POST') {
        const input = await body(request);
        // A launch link, or a one-minute token from the account site opening this PC locally.
        if (input.remoteToken !== undefined) {
          await remoteAccess.verify(input.remoteToken);
          await remoteAccess.heartbeat();
        } else if (!equal(input.token, bootstrap)) throw new DomainError('UNAUTHORIZED');
        response.setHeader(
          'Set-Cookie',
          `vide_session_${new URL(origin).port}=${session}; HttpOnly; SameSite=Strict; Path=/`,
        );
        send(200, { authenticated: true });
        return;
      }
      const cookie = request.headers.cookie
        ?.split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith(`vide_session_${new URL(origin).port}=`))
        ?.split('=')[1];
      if (remote) {
        const remoteCookie = request.headers.cookie
          ?.split(';')
          .map((s) => s.trim())
          .find((s) => s.startsWith('vide_remote='))
          ?.split('=')[1];
        if (!remoteAccess.authorized(remoteCookie)) throw new DomainError('UNAUTHORIZED');
        // Remote sessions do project work only: no app control, accounts, settings or extensions.
        if (
          url.pathname === '/api/v1/shutdown' ||
          (url.pathname.startsWith('/api/v1/remote') && request.method !== 'GET') ||
          url.pathname.startsWith('/api/v1/connectors') ||
          (request.method !== 'GET' &&
            /^\/api\/v1\/(accounts|settings|extensions)(\/|$)/.test(url.pathname)) ||
          // Deleting a whole project and its data is done at this PC.
          (request.method === 'DELETE' && /^\/api\/v1\/projects\/[^/]+$/.test(url.pathname)) ||
          // The project's AI instructions steer every later turn: changed on this PC only.
          (request.method !== 'GET' &&
            /^\/api\/v1\/projects\/[^/]+\/ai-instructions$/.test(url.pathname)) ||
          // Releasing a direct-mode guard (bulk erase, layer deletion, purge) is confirmed at the
          // PC whose document it changes; [되돌리기] and the plan's [진행] stay remote.
          /^\/api\/v1\/projects\/[^/]+\/requests\/[^/]+\/confirm$/.test(url.pathname) ||
          // jig import and pinning are this PC's actions (ARCH-03 §7).
          /^\/api\/v1\/(jigs\/import|projects\/[^/]+\/(jigs|jig-drafts)\/[^/]+\/pin)$/.test(
            url.pathname,
          ) ||
          // Which folders of this PC the AI may read is set at this PC (SPEC-01.13 1).
          (request.method !== 'GET' &&
            /^\/api\/v1\/projects\/[^/]+\/folders(\/remove)?$/.test(url.pathname))
        )
          throw new DomainError('FORBIDDEN');
      } else if (!equal(cookie, session)) throw new DomainError('UNAUTHORIZED');
      if (stopping && request.method !== 'GET') throw new DomainError('APP_STOPPING');
      if (url.pathname === '/api/v1/connectors' && request.method === 'GET') {
        send(200, await connectors.list());
        return;
      }
      if (url.pathname === '/api/v1/connectors/rhino8/install' && request.method === 'POST') {
        send(200, await connectors.installRhino());
        return;
      }
      if (url.pathname === '/api/v1/connectors/zwcad2023/install' && request.method === 'POST') {
        send(200, await connectors.installZwcad());
        return;
      }
      if (url.pathname === '/api/v1/remote' && request.method === 'GET') {
        send(200, await remoteAccess.status());
        return;
      }
      const remoteAction = /^\/api\/v1\/remote\/(link|unlink|remote)$/.exec(url.pathname);
      if (remoteAction && request.method === 'POST') {
        const input = await body(request);
        if (remoteAction[1] === 'link')
          send(
            200,
            await remoteAccess.link(
              z.string().min(1).max(254).parse(input.username),
              z.string().min(1).max(128).parse(input.password),
              z.string().min(1).max(80).parse(input.name),
              input.origin === undefined ? undefined : z.string().url().parse(input.origin),
            ),
          );
        else if (remoteAction[1] === 'unlink') send(200, await remoteAccess.unlink());
        else send(200, await remoteAccess.setRemote(z.boolean().parse(input.enabled)));
        return;
      }
      if (url.pathname === '/api/v1/shutdown' && request.method === 'POST' && onShutdown) {
        stopping = true;
        send(200, { stopping: true });
        setImmediate(onShutdown);
        return;
      }
      const upload = /^\/api\/v1\/projects\/([^/]+)\/import$/.exec(url.pathname);
      if (upload && request.method === 'POST') {
        send(
          200,
          await importModel(
            request,
            upload[1],
            url.searchParams.get('name'),
            workspace,
            rhinoImport,
            hosts.zwcad,
            links,
          ),
        );
        return;
      }
      // Images named by a path in the composer's words (SPEC-09.11): listed and copied here only.
      if (
        await attachmentPathRoutes(url, request.method, {
          attachments,
          context: fileContext,
          project: (projectId) => store.project(projectId),
          body: () => body(request),
          send,
          remote,
        })
      )
        return;
      // Composer attachments (SPEC-01.12, ARCH-01 §3): any file type, kept per project.
      const attachmentRoute =
        /^\/api\/v1\/projects\/([^/]+)\/attachments(?:\/([0-9a-f]{24})(\/view)?)?$/.exec(
          url.pathname,
        );
      if (attachmentRoute) {
        const [, projectId, attachmentId, view] = attachmentRoute;
        store.project(projectId);
        if (!attachments) throw new DomainError('NOT_FOUND');
        if (request.method === 'POST' && !attachmentId) {
          if (request.headers['content-type'] !== 'application/octet-stream')
            throw new DomainError('INVALID_INPUT');
          send(
            200,
            await attachments.save(
              projectId,
              url.searchParams.get('name'),
              request,
              url.searchParams.get('type') ?? '',
            ),
          );
          return;
        }
        // The composer's smaller copy of a large image (what the model and the chip see).
        if (request.method === 'POST' && attachmentId && view) {
          if (request.headers['content-type'] !== 'application/octet-stream')
            throw new DomainError('INVALID_INPUT');
          send(200, await attachments.saveView(projectId, attachmentId, request));
          return;
        }
        // Only kept images are served (the chip preview); nothing else leaves as a file.
        if (request.method === 'GET' && attachmentId && !view) {
          const image = await attachments.image(projectId, attachmentId);
          if (!image) throw new DomainError('NOT_FOUND');
          response.writeHead(200, {
            'Content-Type': image.type,
            'Cache-Control': 'private, max-age=3600',
          });
          response.end(image.bytes);
          return;
        }
        throw new DomainError('NOT_FOUND');
      }
      if (
        await referenceRoutes(url, request, {
          boards: referenceBoards,
          isImage: (projectId, id) => attachments?.get(projectId, id)?.kind === 'image',
          project: (projectId) => store.project(projectId),
          body,
          send,
          response,
          remote,
        })
      )
        return;
      // Project folders (SPEC-01.13, ARCH-01 §3).
      if (
        await folderRoutes(url, request.method, {
          folders,
          context: fileContext,
          project: (projectId) => store.project(projectId),
          body: () => body(request),
          send,
        })
      )
        return;
      // The project's 할 일 on the dashboard (SPEC-01.14, ARCH-01 §3); remote sessions may edit.
      if (
        await agendaRoutes(url, request.method, {
          agenda,
          body: () => body(request),
          send,
          // [퇴근하기] → today's 일지 on the site, queued on this PC when the site is unreachable.
          dayEnded: (projectId, entry) =>
            void sharedNotes
              ?.appendJournal(projectId, `퇴근 기록 · ${entry.text}`, entry.date)
              .catch(() => {}),
          ledger: {
            item: (projectId, conversationId, ledgerId) => {
              conversations.store.get(projectId, conversationId);
              return conversations.store.ledgerItem(conversationId, ledgerId);
            },
            undone: (projectId, conversationId, ledgerId, result) => {
              const undo = conversations.addLedger(projectId, conversationId, {
                kind: 'result-ref',
                body: { appAction: 'agenda-undo', ledgerId, by: 'user', ...result },
              });
              conversations.store.supersede(conversationId, ledgerId, undo.id);
            },
          },
        })
      )
        return;
      // 노트·일지 (SPEC-10): the site's shared notes through this PC's account link.
      if (
        await notesRoutes(url, request, response, {
          notes: sharedNotes,
          project: (projectId) => store.project(projectId),
          user: async () => (await remoteAccess.status()).username,
          body: () => body(request),
          send,
        })
      )
        return;
      // Project link files (SPEC-01.11): linked from a host plugin, listed with live status.
      const linkList = /^\/api\/v1\/projects\/([^/]+)\/links$/.exec(url.pathname);
      const linkItem = /^\/api\/v1\/projects\/([^/]+)\/links\/([^/]+)$/.exec(url.pathname);
      if (linkList && request.method === 'GET') {
        store.project(linkList[1]);
        // A page's draft holds automatic Syncs of the files it uses for 5 s (ARCH-01 §7 ③).
        const page = url.searchParams.get('page');
        if (page && /^[\w-]{1,100}$/.test(page))
          scheduler?.hold(
            linkList[1],
            page,
            (url.searchParams.get('hold') ?? '').split(',').filter(Boolean).slice(0, 50),
            // The Syncs the draft uses: a user's Live Sync never edits them in place (T-127).
            (url.searchParams.get('basis') ?? '').split(',').filter(Boolean).slice(0, 200),
          );
        const open = [...(await openDocuments(true))];
        const requests = workspace.list(linkList[1]);
        // Files opened in VIDE before they were listed join the list once, hidden. A removed file
        // hides its imports, so it does not come back.
        const hiddenRequests = workspace.hiddenIds(linkList[1]);
        for (const entry of requests)
          if (
            entry.input.source === 'file' &&
            !entry.input.linkId &&
            entry.state === 'succeeded' &&
            !hiddenRequests.has(entry.id)
          )
            links.fileLink(
              linkList[1],
              entry.input.host === 'zwcad' ? 'zwcad' : 'rhino',
              importedName(entry.input.body),
              true,
            );
        // Work copies VIDE opened itself answer only whether their window is still open.
        // The window's own row first; after Save As (or a first save) that row follows the window
        // and takes the new name and path. A row reconnected by path (a reopened file, a ZWCAD
        // Sync without Link) takes the window's session, so it follows a later Save As too
        // (SPEC-01.11 1, T-095). A work copy VIDE opened keeps its own window. A host turn's live
        // links run the same step (live-links.ts).
        const { rows, matched, ownedOpen } = await followOpenDocuments(
          links,
          linkList[1],
          open,
          async (link) =>
            link.host === 'rhino'
              ? await sdk?.editors.has(link.instance)
              : await zwcadSdk?.editors.has(link.instance),
        );
        send(
          200,
          rows.map((link) => {
            const doc = matched.get(link.id)?.document;
            const file = isFileLink(link);
            const syncs = linkRequests(link, requests);
            const last = syncs.filter((entry) => entry.state === 'succeeded').at(-1);
            const latest = syncs.at(-1);
            const notice = file ? undefined : links.notice(link.id);
            // Cleanup the list offers (SPEC-01.11 1, T-107): a closed duplicate of an open window's
            // row merges into it; a closed row with no record can be taken out.
            const open = !!doc || ownedOpen.has(link.id);
            const twin = open
              ? undefined
              : rows.find(
                  (other) =>
                    other.id !== link.id &&
                    !isFileLink(other) &&
                    other.host === link.host &&
                    other.instance === link.instance &&
                    other.documentId === link.documentId &&
                    matched.has(other.id),
                );
            const cleanup =
              file || open
                ? undefined
                : twin
                  ? { kind: 'merge' as const, into: twin.id, intoName: twin.name }
                  : syncs.length === 0
                    ? { kind: 'empty' as const }
                    : undefined;
            return {
              ...link,
              kind: file ? 'file' : 'host',
              ...(notice
                ? {
                    notice:
                      notice.kind === 'followed'
                        ? {
                            kind: notice.kind,
                            reason: notice.reason,
                            from: notice.from,
                            to: notice.to,
                          }
                        : { kind: notice.kind },
                  }
                : {}),
              ...(cleanup ? { cleanup } : {}),
              connection: ownedOpen.has(link.id)
                ? {
                    instance: link.instance,
                    documentId: link.documentId,
                    live: false,
                    generation: 0,
                    objectCount: 0,
                    units: '',
                    modified: null,
                    hostBusy: false,
                  }
                : doc
                  ? {
                      instance: doc.instance,
                      documentId: doc.id,
                      live: doc.live ?? false,
                      generation: doc.generation ?? 0,
                      objectCount: doc.objectCount,
                      units: doc.units,
                      modified: doc.modified,
                      hostBusy: doc.hostBusy ?? false,
                    }
                  : null,
              lastSync: last ? { requestId: last.id, at: last.createdAt } : null,
              // The engine's Sync of this file and the stored display the page should show:
              // the revision rises with each Live Sync in place (T-084).
              ...(() => {
                const sync = scheduler?.status(linkList[1], doc as ScheduledDocument | undefined);
                return sync ? { sync } : {};
              })(),
              display: last
                ? {
                    requestId: last.id,
                    revision:
                      workspace.models(linkList[1]).header(linkList[1], last.id)?.revision ?? 0,
                  }
                : null,
              ...(latest && latest !== last && ['failed', 'unknown'].includes(latest.state)
                ? { lastError: latest.result?.code ?? latest.state }
                : {}),
            };
          }),
        );
        return;
      }
      if (linkList && request.method === 'POST') {
        store.project(linkList[1]);
        const target = hostTargetSchema
          .extend({
            host: z.enum(['rhino', 'zwcad']),
            // ADR-030: the link id the document stores for this project, read by the plugin.
            storedId: z.string().min(1).max(100).optional(),
            // The answer to a LINK_CHOICE: that row continues (its history too) or a new row.
            replace: z.union([z.literal('new'), z.string().min(1).max(100)]).optional(),
            // The plugin can show the choice (T-107); older plugins link as before.
            ask: z.boolean().optional(),
          })
          .strict()
          .parse(await body(request));
        // Attached (plugin) documents and work copies VIDE opened itself can both be linked.
        const open: LinkedDocument[] =
          target.host === 'rhino'
            ? ((await sdk?.editors.list())?.documents ?? [])
            : ((await zwcadSdk?.editors.list()) ?? []);
        const doc = open.find(
          (item) => item.instance === target.instance && item.id === target.documentId,
        );
        if (!doc) throw new DomainError('STALE_CONNECTION');
        const input = {
          host: target.host,
          name: doc.name,
          ...(doc.path ? { path: doc.path } : {}),
          instance: target.instance,
          documentId: target.documentId,
          ...(target.storedId ? { storedId: target.storedId } : {}),
          ...(target.replace ? { replace: target.replace } : {}),
        };
        // Ambiguous Links ask first (SPEC-01.11 1): a copy of a linked file open in a second
        // window, or closed rows that could be this document. The plugin asks and links again
        // with `replace`.
        const choice = target.ask
          ? links.linkChoice(
              linkList[1],
              input,
              open.map((item) => ({ ...item, host: target.host })),
            )
          : undefined;
        if (choice) {
          const requests = workspace.list(linkList[1]);
          send(409, {
            code: 'LINK_CHOICE',
            ...choice,
            choices: choice.choices.map((entry) => ({
              ...entry,
              syncs: linkRequests(links.get(linkList[1], entry.id), requests).length,
            })),
          });
          return;
        }
        const linked = links.link(linkList[1], input);
        // The plugin stores this id in the document now (ADR-030); the list says so once.
        if (target.ask && target.storedId !== linked.id) links.note(linked.id, { kind: 'stored' });
        send(201, linked);
        return;
      }
      if (linkItem && request.method === 'PUT') {
        const { hidden } = z
          .object({ hidden: z.boolean() })
          .strict()
          .parse(await body(request));
        send(200, links.setHidden(linkItem[1], linkItem[2], hidden));
        return;
      }
      // Where a request goes (SPEC-02.17): words decided without Jev, then Jev when a key is set
      // and the user has not turned it off (FR-18). Only the fixed items reach Jev: the request,
      // open-jig setting titles, jig intents, link role labels and app action names — the server
      // builds the jig and link lists itself, so no file name or path can come in (T-049).
      const routeSettings = () =>
        routeSettingsFor(
          store,
          filename === ':memory:' ? undefined : join(dirname(filename), 'route-settings.json'),
        );
      const routeQuery = /^\/api\/v1\/projects\/([^/]+)\/route$/.exec(url.pathname);
      if (routeQuery && request.method === 'POST') {
        store.project(routeQuery[1]);
        const query = z
          .object({
            body: z.string().max(4000),
            subjects: z
              .array(z.object({ id: z.string().max(200), label: z.string().max(300) }))
              .max(60),
            params: z
              .array(
                z
                  .object({
                    key: z.string().max(100),
                    title: z.string().max(200),
                    help: z.string().max(500).optional(),
                  })
                  .strict(),
              )
              .max(60)
              .optional(),
            conversation: z.string().max(60).optional(),
            opening: z.boolean().optional(),
            openJig: z.string().max(200).optional(),
          })
          .strict()
          .parse(await body(request));
        // The project's skill catalog (its jigs first); the official list if it cannot be read.
        const jigs = await skillCatalog(workspace, dirname(filename), routeQuery[1])
          .then(routeJigsOf)
          .catch(() => officialJigs(JIGS));
        const judged = await judgeRoute(
          { ...query, jigs, links: linkLabels(links.list(routeQuery[1])) },
          { dataDirectory: dirname(filename), enabled: routeSettings().get().jev },
        );
        const decision = judged.decision;
        // Result, method and time only; never the request text (SPEC-02.17 4).
        diagnostics.write('route', {
          by: decision?.by ?? 'rules',
          target: decision?.target ?? null,
          ...(decision?.action ? { action: decision.action } : {}),
          ...(decision?.app ? { action: decision.app } : {}),
          ...(decision?.param ? { param: decision.param } : {}),
          ...(decision?.jig ? { jig: decision.jig } : {}),
          ...(judged.reason ? { reason: judged.reason } : {}),
          ms: judged.ms,
        });
        send(200, decision ?? { target: null });
        return;
      }
      // 'AI 작업으로 보내기' after a route without the AI: counted to tune the rules and Jev.
      const routeRevert = /^\/api\/v1\/projects\/([^/]+)\/route\/revert$/.exec(url.pathname);
      if (routeRevert && request.method === 'POST') {
        store.project(routeRevert[1]);
        const reverted = z
          .object({
            target: z.enum(['view', 'param', 'app', 'jig', 'ask', 'document', 'make']),
            by: z.enum(['jev', 'rules']),
          })
          .strict()
          .parse(await body(request));
        diagnostics.write('route-revert', reverted);
        send(200, { ok: true });
        return;
      }
      // A page's own error (window `error` / `unhandledrejection`) for the engine log (T-126):
      // message and stack cut and cleaned of keys, at most 20 a minute, the same one once a minute.
      if (url.pathname === '/api/v1/diagnostics/client' && request.method === 'POST') {
        const report = z
          .object({
            kind: z.string().max(40).optional(),
            message: z.string().optional(),
            stack: z.string().optional(),
            source: z.string().optional(),
            line: z.number().int().optional(),
            column: z.number().int().optional(),
            route: z.string().optional(),
            version: z.string().optional(),
          })
          .parse(await body(request));
        const now = Date.now();
        if (now - clientWindow.at >= 60_000) clientWindow = { at: now, count: 0 };
        const message = scrub(report.message ?? '', 500);
        const repeated =
          clientWindow.count < 20 ? clientErrors.note(report.kind, message) : undefined;
        if (repeated !== undefined) {
          clientWindow.count++;
          diagnostics.write('client-error', {
            kind: report.kind ?? 'error',
            message,
            ...(report.stack ? { stack: scrub(report.stack, 2000) } : {}),
            ...(report.source
              ? {
                  source: scrub(report.source.split('?')[0], 200),
                  line: report.line,
                  column: report.column,
                }
              : {}),
            ...(report.route ? { route: routeOf(scrub(report.route, 200)).path } : {}),
            ...(report.version ? { pageVersion: report.version.slice(0, 40) } : {}),
            ...(remote ? { remote: true } : {}),
            ...(repeated ? { repeated } : {}),
          });
        }
        send(200, { logged: repeated !== undefined });
        return;
      }
      // [진단 묶음 내보내기] (T-126): logs, exit records, versions and a settings summary in one
      // zip under <data>/diagnostics. Never keys, logins, the DB or request text. This PC only.
      if (url.pathname === '/api/v1/diagnostics/bundle' && request.method === 'POST') {
        if (remote || filename === ':memory:') throw new DomainError('FORBIDDEN');
        const options = z
          .object({
            dumps: z.boolean().optional(),
            days: z.number().int().min(1).max(14).optional(),
          })
          .strict()
          .parse(await body(request));
        diagnostics.flush();
        send(200, await writeDiagnosticBundle({ directory: dirname(filename), ...options }));
        return;
      }
      // Opt-in reports (ADR-036, SPEC-05.9): the choice, what the next report holds and the answer
      // to [진단 묶음을 보낼까요?]. Only the PC itself decides; other devices read the state.
      if (url.pathname === '/api/v1/telemetry' && request.method === 'GET') {
        send(200, await telemetry.view(!remote));
        return;
      }
      if (url.pathname === '/api/v1/telemetry' && request.method === 'PUT') {
        if (remote) throw new DomainError('FORBIDDEN');
        const { consent } = z
          .object({ consent: z.enum(['granted', 'denied']) })
          .strict()
          .parse(await body(request));
        diagnostics.write('telemetry-consent', { consent });
        send(200, await telemetry.set(consent));
        return;
      }
      if (url.pathname === '/api/v1/telemetry/preview' && request.method === 'GET') {
        if (remote || filename === ':memory:') throw new DomainError('FORBIDDEN');
        send(200, await telemetry.preview());
        return;
      }
      if (url.pathname === '/api/v1/telemetry/crash' && request.method === 'POST') {
        if (remote || filename === ':memory:') throw new DomainError('FORBIDDEN');
        const answer = z
          .object({ send: z.boolean(), dumps: z.boolean().optional() })
          .strict()
          .parse(await body(request));
        const result = await telemetry.answerCrash(answer.send, answer.dumps);
        diagnostics.write('telemetry-bundle', {
          sent: result.sent,
          ...('reason' in result ? { reason: result.reason } : {}),
          ...('bytes' in result ? { bytes: result.bytes } : {}),
        });
        send(200, result);
        return;
      }
      if (url.pathname === '/api/v1/settings/questions') {
        if (request.method === 'PUT') {
          const { native } = questionSettings.set(
            z
              .object({ native: z.boolean() })
              .strict()
              .parse(await body(request)),
          );
          // Off: the Codex processes no turn is using go now (a running turn ends as it is).
          if (!native) await closeIdleCodexAppServers().catch(() => {});
        }
        if (request.method === 'PUT' || request.method === 'GET') {
          send(200, questionSettings.view());
          return;
        }
      }
      if (url.pathname === '/api/v1/settings/web') {
        if (request.method === 'PUT')
          webSettings.set(
            z
              .object({ web: z.boolean() })
              .strict()
              .parse(await body(request)),
          );
        if (request.method === 'PUT' || request.method === 'GET') {
          send(200, webSettings.get());
          return;
        }
      }
      if (url.pathname === '/api/v1/settings/routing') {
        if (request.method === 'PUT')
          routeSettings().set(
            z
              .object({ jev: z.boolean() })
              .strict()
              .parse(await body(request)),
          );
        if (request.method === 'PUT' || request.method === 'GET') {
          send(200, { ...routeSettings().get(), key: hasJevKey(dirname(filename)) });
          return;
        }
      }
      // Offline view on the account site and requests left there (PLAN-20).
      const offline = /^\/api\/v1\/projects\/([^/]+)\/offline-view$/.exec(url.pathname);
      if (offline && request.method === 'GET') {
        store.project(offline[1]);
        send(200, await offlineView.status(offline[1]));
        return;
      }
      if (offline && request.method === 'PUT') {
        // `enabled`: saved models (PLAN-20); `summary`: 할 일 and history summary (PLAN-33).
        const { enabled, summary } = z
          .object({ enabled: z.boolean().optional(), summary: z.boolean().optional() })
          .strict()
          .parse(await body(request));
        if (enabled !== undefined) await offlineView.setEnabled(offline[1], enabled);
        if (summary !== undefined) await offlineView.setSummary(offline[1], summary);
        send(200, await offlineView.status(offline[1]));
        return;
      }
      const offlineDismiss =
        /^\/api\/v1\/projects\/([^/]+)\/offline-view\/inbox\/([^/]+)\/dismiss$/.exec(url.pathname);
      if (offlineDismiss && request.method === 'POST') {
        await offlineView.dismiss(offlineDismiss[1], offlineDismiss[2]);
        send(200, await offlineView.status(offlineDismiss[1]));
        return;
      }
      // The links list's one-time notes and cleanup (SPEC-01.11 1, T-107).
      const linkAction =
        /^\/api\/v1\/projects\/([^/]+)\/links\/([^/]+)\/(split|merge|dismiss)$/.exec(url.pathname);
      if (linkAction && request.method === 'POST') {
        const [, projectId, linkId, action] = linkAction;
        store.project(projectId);
        if (action === 'dismiss') {
          links.dismiss(projectId, linkId);
          send(200, { ok: true });
          return;
        }
        if (action === 'split') {
          const created = links.split(projectId, linkId);
          // The window's document now carries the new row's id (ADR-030); an older plugin or a
          // closed window keeps the old one, which the next Link answers by choice.
          const target = { instance: created.instance, documentId: created.documentId };
          const writing =
            created.host === 'rhino'
              ? sdk?.editors.setLinkId(target, projectId, created.id)
              : zwcadSdk?.editors.attached.setLinkId(target, projectId, created.id);
          const stored = writing
            ? await writing.then(
                () => true,
                () => false,
              )
            : false;
          send(201, { ...created, stored });
          return;
        }
        const { into } = z
          .object({ into: z.string().min(1).max(100) })
          .strict()
          .parse(await body(request));
        const source = links.get(projectId, linkId);
        if (
          linkRequests(source, workspace.list(projectId)).some((entry) =>
            ['queued', 'running'].includes(entry.state),
          )
        )
          throw new DomainError('PROJECT_BUSY');
        send(
          200,
          links.merge(projectId, linkId, into, (ids) => workspace.forget(ids)),
        );
        return;
      }
      const linkRemove = /^\/api\/v1\/projects\/([^/]+)\/links\/([^/]+)\/remove$/.exec(
        url.pathname,
      );
      if (linkRemove && request.method === 'POST') {
        // Its records, geometry and VIDE's copies go; the user's file stays (SPEC-01.11 9).
        const removed = await removeLink({
          projectId: linkRemove[1],
          linkId: linkRemove[2],
          links,
          workspace,
          dataDirectory: filename === ':memory:' ? undefined : dirname(filename),
          importDirectories: [hosts.rhino.directory, hosts.zwcad.directory],
          projects: () => store.listProjects(),
        });
        send(200, { ok: true, ...removed });
        return;
      }
      const capture = /^\/api\/v1\/projects\/([^/]+)\/capture$/.exec(url.pathname);
      if (capture && request.method === 'POST') {
        const target = hostTargetSchema
          .extend({
            id: z.string(),
            linkId: z.string().uuid().optional(),
            /** The user asked for this Sync (↻, 지금 Sync): never shared with another. */
            fresh: z.boolean().optional(),
            /** Read the whole document even when a Live Sync could continue the shown one. */
            full: z.boolean().optional(),
          })
          .parse(await body(request));
        if (target.linkId) links.get(capture[1], target.linkId);
        const projectId = capture[1];
        // Every Sync asked here is the user's (⟳, 지금 Sync, the plugin's Sync): automatic ones are
        // the engine's own (T-084), so this one never joins another read (ARCH-01 §7). It asks the
        // host only for what changed when the shown Sync can be continued (T-123).
        // A draft or work on the file keeps its shown Sync as it is (the Live Sync goes into a copy),
        // and a Sync that succeeds ends the wait or failure the engine shows on the row.
        const { result: synced } = await runUserSync(
          {
            ...syncContext,
            ...(liveSync ? { live: runLiveSync } : {}),
            ...(scheduler
              ? {
                  holds: (id, where) => scheduler.holds(id, where),
                  heldBases: (id) => scheduler.heldBases(id),
                  synced: (id, where) => scheduler.userSynced(id, where),
                }
              : {}),
          },
          projectId,
          target,
        );
        // The request without its display geometry or object rows: the window fetches the geometry
        // as binary (`GET …/requests/:r`), never the whole model as JSON (2026-10-02, T-123).
        send(200, listed(workspace.summary(projectId, synced.id)));
        return;
      }
      const live = /^\/api\/v1\/projects\/([^/]+)\/live-sync$/.exec(url.pathname);
      if (live && request.method === 'POST') {
        if (!liveSync) throw new DomainError('RESYNC_REQUIRED');
        const synced = await runLiveSync(live[1], await body(request));
        send(200, synced);
        return;
      }
      const reviewComparison = /^\/api\/v1\/projects\/([^/]+)\/review-comparison$/.exec(
        url.pathname,
      );
      const publicExport =
        /^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/publication-export$/.exec(url.pathname);
      const feedback = /^\/api\/v1\/projects\/([^/]+)\/shared-feedback$/.exec(url.pathname);
      if (feedback && request.method === 'GET') {
        send(200, sharedFeedback.list(feedback[1]));
        return;
      }
      if (feedback && request.method === 'POST') {
        send(201, sharedFeedback.receive(feedback[1], await body(request)));
        return;
      }
      if (publicExport && request.method === 'POST') {
        const bundle = createPublicationBundle(
          lazyCandidate(workspace, publicExport[1], publicExport[2]),
          await body(request),
        );
        const bytes = Buffer.concat(bundle.chunks);
        if (bytes.byteLength > 64 * 1024 * 1024) throw new DomainError('WEB_MODEL_LIMIT');
        response.setHeader('Content-Disposition', 'attachment; filename="VIDE-publication.json"');
        const exportId = sharedFeedback.record(publicExport[1], publicExport[2], bundle.manifest);
        send(200, {
          format: 'vide-publication-v1',
          requestId: exportId,
          manifest: bundle.manifest,
          scene: JSON.parse(bytes.toString('utf8')),
        });
        return;
      }
      if (reviewComparison && request.method === 'GET') {
        const projectId = reviewComparison[1],
          before = reviews.get(projectId, url.searchParams.get('before') || ''),
          after = reviews.get(projectId, url.searchParams.get('after') || '');
        let related = false;
        try {
          // The chain needs ids only (T-129); a missing request still answers NOT_FOUND.
          related = relatedCandidates(
            workspace,
            projectId,
            workspace.brief(projectId, before.requestId),
            workspace.brief(projectId, after.requestId),
          );
        } catch (error) {
          if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error;
        }
        send(200, compareReviews(before, after, related));
        return;
      }
      const note = /^\/api\/v1\/projects\/([^/]+)\/reviews\/([^/]+)\/notes$/.exec(url.pathname);
      if (note) {
        if (request.method === 'GET') {
          send(200, reviewNotes.list(note[1], note[2]));
          return;
        }
        if (request.method === 'POST') {
          send(201, reviewNotes.create(note[1], note[2], await body(request)));
          return;
        }
      }
      const review =
        /^\/api\/v1\/projects\/([^/]+)\/reviews(?:\/([^/]+)(\/(?:preview|download))?)?$/.exec(
          url.pathname,
        );
      if (review) {
        if (request.method === 'POST' && !review[2]) {
          const input = await body(request);
          send(
            201,
            reviews.create(
              review[1],
              input,
              withApplications(
                lazyCandidate(workspace, review[1], z.string().parse(input.requestId)),
              ),
            ),
          );
          return;
        }
        if (request.method === 'GET' && !review[2]) {
          send(200, reviews.list(review[1]));
          return;
        }
        if (request.method === 'GET' && review[2]) {
          const value = reviews.get(review[1], review[2]);
          if (!review[3]) {
            send(200, value);
            return;
          }
          const saved = value.payload,
            html = renderReport(saved.project, saved.request, saved.image, saved);
          response.setHeader(
            'Content-Security-Policy',
            "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
          );
          response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            ...(review[3] === '/download'
              ? { 'Content-Disposition': 'attachment; filename="VIDE-review.html"' }
              : {}),
          });
          response.end(html);
          return;
        }
      }
      const report = /^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/report$/.exec(url.pathname);
      if (report && request.method === 'POST') {
        const html = renderReport(
          store.project(report[1]),
          withApplications(lazyCandidate(workspace, report[1], report[2])),
          (await body(request)).image,
        );
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': 'attachment; filename="VIDE-review.html"',
        });
        response.end(html);
        return;
      }
      if (url.pathname === '/api/v1/extensions' && request.method === 'GET') {
        send(200, extensions.list());
        return;
      }
      const extension = /^\/api\/v1\/extensions\/([^/]+)$/.exec(url.pathname);
      if (extension && request.method === 'PUT') {
        send(200, extensions.save(extension[1], await body(request)));
        return;
      }
      const extensionRun = /^\/api\/v1\/projects\/([^/]+)\/extensions\/([^/]+)\/run$/.exec(
        url.pathname,
      );
      if (extensionRun && request.method === 'POST') {
        send(200, extensions.execute(extensionRun[1], extensionRun[2], await body(request)));
        return;
      }
      // The project's addendum to the AI instruction bundle (PLAN-24 지침 묶음), ≤ 8 KB.
      const aiInstructions = /^\/api\/v1\/projects\/([^/]+)\/ai-instructions$/.exec(url.pathname);
      if (aiInstructions && (request.method === 'GET' || request.method === 'PUT')) {
        store.project(aiInstructions[1]);
        send(
          200,
          request.method === 'PUT'
            ? projectInstructions.save(aiInstructions[1], await body(request))
            : projectInstructions.get(aiInstructions[1]),
        );
        return;
      }
      if (url.pathname === '/api/v1/settings/ai') {
        if (request.method === 'PUT') {
          send(200, aiSettings.save(await body(request)));
          return;
        }
        if (request.method === 'GET') {
          send(200, {
            ...aiSettings.get(),
            resolved: Object.fromEntries(
              ['claude-cli', 'codex-cli'].map((id) => [id, execution.executable(id) || null]),
            ),
          });
          return;
        }
      }
      // Who each CLI's default login is (no network). Accounts are added, signed in and switched
      // in AccountSwitch (ADR-025); VIDE only reads them.
      if (url.pathname === '/api/v1/accounts' && request.method === 'GET') {
        send(200, { accounts: PROVIDERS.map((provider) => accountUsage.account(provider)) });
        return;
      }
      // JIG tab: the catalogue, and the Sync jig (relation and differences of two Syncs).
      if (url.pathname === '/api/v1/jigs' && request.method === 'GET') {
        send(200, JIGS);
        return;
      }
      const syncJig = /^\/api\/v1\/projects\/([^/]+)\/jigs\/sync$/.exec(url.pathname);
      if (syncJig && request.method === 'POST') {
        const point = z.number().finite();
        const input = z
          .object({
            rhino: z.string(),
            cad: z.string(),
            tolerance: z.number().positive().max(1).optional(),
            search: z.number().positive().max(10).optional(),
            rhinoLayers: z.array(z.string()).max(500).optional(),
            cadLayers: z.array(z.string()).max(500).optional(),
            anchor: z.object({ rhino: z.string(), cad: z.string() }).optional(),
            candidate: z
              .object({ rotation: point, translation: z.tuple([point, point]), dz: point })
              .optional(),
          })
          .strict()
          .parse(await body(request));
        // Read lazily (T-129): one scene row decoded at a time, none kept but the elements.
        const source = (id: string, host: 'rhino' | 'zwcad') => {
          const saved = workspace.lazy(syncJig[1], id);
          if (saved.state !== 'succeeded' || !saved.result || !isItemList(saved.result.scene))
            throw new DomainError('STALE_REFERENCE');
          if ((saved.result.host || 'rhino') !== host) throw new DomainError('TARGET_MISMATCH');
          return saved.result as Record<string, unknown>;
        };
        const cad = source(input.cad, 'zwcad');
        const result = runSync(source(input.rhino, 'rhino'), cad, input);
        const document = z.object({ units: z.string() }).safeParse(cad.sourceDocument);
        send(200, {
          ...result,
          rows: result.rows.slice(0, 5000),
          totalRows: result.rows.length,
          cadUnits:
            typeof cad.sourceUnits === 'string'
              ? cad.sourceUnits
              : document.success
                ? document.data.units
                : 'Millimeters',
        });
        return;
      }
      if (
        await jigRoutes(url, request, {
          workspace,
          body,
          send,
          remote,
          dataDirectory: dirname(filename),
          links,
          sdk,
          execution,
        })
      )
        return;
      if (
        await makeRoutes(url, request, {
          workspace,
          body,
          send,
          remote,
          dataDirectory: dirname(filename),
          conversations,
        })
      )
        return;
      if (await syncReadRoutes(url, request, { links, workspace, sdk, body, send })) return;
      const facts = { workspace, dataDirectory: dirname(filename), body, send, remote, response };
      if (await factRoutes(url, request, facts)) return;
      if (
        await conversationRoutes(url, request, {
          service: conversations,
          body,
          send,
          remote,
          chooseModel: async (routing, requested) =>
            modelRouter.route(routing, await execution.models(), signedInServices(), requested),
          // The answer turn of a question card (T-062): same conversation and service.
          submit: async (projectId, input, askedIn) => {
            // The answer turn keeps the Plan/Auto mode of the turn that asked (ADR-022); a deleted
            // asking request leaves the route's fallback (Plan) instead of failing the answer.
            if (askedIn) {
              let asked: { mode?: unknown; permission?: unknown } | undefined;
              try {
                asked = workspace.brief(projectId, askedIn).input;
              } catch {
                asked = undefined;
              }
              if (asked) input.mode = requestMode(asked);
            }
            conversations.fix(projectId, input);
            const result = workspace.submit(projectId, input);
            if (result.created) execution.start(result.request);
            return result.request;
          },
        })
      )
        return;
      // Structure analysis jig (J-09, SPEC-06): draft from Syncs → small edits → confirm & analyse.
      const structureJig =
        /^\/api\/v1\/projects\/([^/]+)\/jigs\/structure(?:\/(draft|edit|analyze))?$/.exec(
          url.pathname,
        );
      if (structureJig) {
        const projectId = structureJig[1];
        const action = structureJig[2];
        // A Sync read lazily (T-129): only the picked layers' rows decode their coordinates.
        const syncResult = (id: string) => {
          const saved = workspace.lazy(projectId, id);
          if (saved.state !== 'succeeded' || !saved.result || !isItemList(saved.result.scene))
            throw new DomainError('STALE_REFERENCE');
          return saved;
        };
        // A result is out of date when its Sync is gone, was changed in place by a Live Sync (its
        // manifest revision moved) or a newer Sync of the same document exists.
        const stale = (sources: { syncId: string; documentKey: string; revision?: number }[]) => {
          const rows = workspace.list(projectId);
          return sources.some((source) => {
            const saved = rows.find((row) => row.id === source.syncId);
            if (!saved) return true;
            if (
              source.revision !== undefined &&
              workspace.model(projectId, source.syncId)?.revision !== source.revision
            )
              return true;
            return rows.some(
              (row) =>
                row.state === 'succeeded' &&
                !!row.result &&
                (Array.isArray(row.result.scene) || row.result.sceneOmitted === true) &&
                row.createdAt > saved.createdAt &&
                structureDocumentKey(row.result) === source.documentKey,
            );
          });
        };
        if (!action && request.method === 'GET') {
          const record = structures.get(projectId);
          send(200, {
            draft: record.draft ?? null,
            confirmed: record.confirmed ?? null,
            draftStale: record.draft ? stale(record.draft.sources) : false,
            stale: record.confirmed ? stale(record.confirmed.sources) : false,
          });
          return;
        }
        if (action === 'draft' && request.method === 'POST') {
          const role = z.enum(['column', 'girder', 'beam', 'brace', 'other']);
          const input = z
            .object({
              sources: z
                .array(
                  z
                    .object({
                      syncId: z.string(),
                      mode: z.enum(['curves', 'breps', 'cad']),
                      layers: z.array(z.string()).optional(),
                      objectIds: z.array(z.string()).optional(),
                      cad: z
                        .object({
                          levels_m: z.array(z.number().finite()).min(1).max(50),
                          base_m: z.number().finite().optional(),
                          beamLayers: z.array(z.string()).max(200),
                          columnLayers: z.array(z.string()).max(200),
                        })
                        .strict()
                        .optional(),
                    })
                    .strict(),
                )
                .min(1)
                .max(8),
              options: z
                .object({
                  mergeTolerance_m: z.number().positive().max(0.5).optional(),
                  snap_m: z.number().positive().max(2).optional(),
                  baseFixity: z.enum(['pin', 'fixed']).optional(),
                  layerHints: z
                    .record(
                      z.string(),
                      z
                        .object({ role: role.optional(), section: z.string().max(60).optional() })
                        .strict(),
                    )
                    .optional(),
                })
                .strict()
                .optional(),
            })
            .strict()
            .parse(await body(request));
          const sources = input.sources.map((source) => {
            const result = syncResult(source.syncId).result as Record<string, unknown>;
            return {
              ...source,
              host: result.host === 'zwcad' ? ('zwcad' as const) : ('rhino' as const),
              documentId: structureDocumentKey(result),
              revision: workspace.model(projectId, source.syncId)?.revision,
              result,
            };
          });
          const draft = draftStructure(sources, input.options);
          const record = {
            ...structures.get(projectId),
            draft: {
              createdAt: new Date().toISOString(),
              model: draft.model,
              issues: draft.issues,
              checks: draft.checks,
              sources: sources.map((s) => ({
                syncId: s.syncId,
                documentKey: s.documentId,
                mode: s.mode,
                ...(s.revision === undefined ? {} : { revision: s.revision }),
              })),
            },
          };
          structures.save(projectId, record);
          send(200, record.draft);
          return;
        }
        if (action === 'edit' && request.method === 'POST') {
          const edits = draftEditsSchema.parse(await body(request));
          const record = structures.get(projectId);
          if (!record.draft) throw new DomainError('NOT_FOUND');
          const model = applyEdits(record.draft.model, edits);
          record.draft = { ...record.draft, model, checks: checkStructureModel(model).issues };
          structures.save(projectId, record);
          send(200, record.draft);
          return;
        }
        if (action === 'analyze' && request.method === 'POST') {
          z.object({ confirm: z.literal(true) })
            .strict()
            .parse(await body(request));
          const record = structures.get(projectId);
          if (!record.draft) throw new DomainError('NOT_FOUND');
          // Worker-thread path (T-052·T-054): the engine thread serialises the model and waits; a
          // newer analyze request for the same project supersedes one still queued.
          let out: Awaited<ReturnType<typeof analyzeSummary>>;
          try {
            out = await analyzeSummary(record.draft.model, undefined, {
              mode: 'confirmed',
              key: `project:${projectId}`,
              detail: 'full',
            });
          } catch (error) {
            const code = (error as { code?: string }).code;
            if (code === 'STRUCTURE_CORE_MISSING') throw new DomainError('STRUCTURE_CORE_MISSING');
            if (code === 'STRUCTURE_SUPERSEDED') throw new DomainError('PROJECT_BUSY');
            throw error;
          }
          const { summary } = out;
          if (
            summary.status === 'invalid' ||
            summary.status === 'unstable' ||
            !out.result ||
            !out.model
          ) {
            send(422, { error: 'STRUCTURE_MODEL_INVALID', issues: summary.issues });
            return;
          }
          record.confirmed = {
            confirmedAt: new Date().toISOString(),
            modelHash: summary.modelHash,
            model: out.model,
            sources: record.draft.sources.map(({ syncId, documentKey, revision }) => ({
              syncId,
              documentKey,
              ...(revision === undefined ? {} : { revision }),
            })),
            ledger: out.ledger ?? [],
            issues: summary.issues,
            result: out.result,
            summary,
            colorBands: summary.colorBands,
          };
          structures.save(projectId, record);
          send(200, { ...record.confirmed, stale: false });
          return;
        }
      }
      // The default logins' usage and reset times, and the opt-in usage lookup (this PC only).
      if (url.pathname === '/api/v1/accounts/usage' && request.method === 'GET') {
        send(200, {
          settings: accountUsage.settings(),
          accounts: await accountUsage.all(url.searchParams.get('refresh') === '1'),
        });
        return;
      }
      if (url.pathname === '/api/v1/accounts/usage-settings' && request.method === 'POST') {
        const input = z
          .object({ usageLookup: z.boolean() })
          .strict()
          .parse(await body(request));
        send(200, { settings: accountUsage.setSettings(input) });
        return;
      }
      if (url.pathname === '/api/v1/providers' && request.method === 'GET') {
        send(200, await execution.status());
        return;
      }
      if (url.pathname === '/api/v1/host' && request.method === 'GET') {
        send(200, {
          ...(sdk ? await sdk.status() : await host.status()),
          zwcadAvailable: (await zwcadSdk?.status())?.available ?? false,
        });
        return;
      }
      if (url.pathname === '/api/v1/models' && request.method === 'GET') {
        // Automatic choice (Jev) is listed last so an existing preference stays the default.
        send(200, [...(await execution.models()), ...AUTO_MODELS]);
        return;
      }
      if (url.pathname === '/api/v1/host/attached-documents' && request.method === 'GET') {
        const rhino = (await sdk?.editors.list(true)) || { instance: '1:1', documents: [] };
        const cad = (await zwcadSdk?.editors.attached.list()) || [];
        send(200, { ...rhino, documents: [...rhino.documents, ...cad] });
        return;
      }
      if (url.pathname === '/api/v1/host/documents' && request.method === 'GET') {
        const rhinoOwned = await sdk?.editors.list();
        const cadOwned = (await zwcadSdk?.editors.list()) || [];
        const owned = rhinoOwned
          ? { ...rhinoOwned, documents: [...rhinoOwned.documents, ...cadOwned] }
          : cadOwned.length
            ? { instance: cadOwned[0].instance, documents: cadOwned }
            : undefined;
        try {
          const legacy = await listDocuments();
          const documents = legacy.documents.map((doc) => ({
            ...doc,
            instance: doc.instance ?? legacy.instance,
          }));
          send(
            200,
            owned
              ? {
                  ...owned,
                  documents: [
                    ...owned.documents,
                    ...documents.filter(
                      (doc) =>
                        !owned.documents.some(
                          (item) => item.instance === doc.instance && item.id === doc.id,
                        ),
                    ),
                  ],
                }
              : legacy,
          );
        } catch (error) {
          if (!owned) throw error;
          send(200, owned);
        }
        return;
      }
      if (url.pathname === '/api/v1/host/pins' && request.method === 'POST') {
        const input = hostTargetSchema
          .extend({ ids: z.array(z.string().uuid()) })
          .parse(await body(request));
        if (!sdk) throw new DomainError('STALE_CONNECTION');
        try {
          send(
            200,
            await sdk.editors.setPins(
              { instance: input.instance, documentId: input.documentId },
              input.ids,
            ),
          );
        } catch (error) {
          // A lost or busy document answers its code (STALE_CONNECTION …); the app shows it.
          const code = (error as { code?: unknown } | undefined)?.code;
          if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code))
            throw new DomainError(code);
          throw error;
        }
        return;
      }
      if (url.pathname === '/api/v1/host/selection' && request.method === 'GET') {
        const target = hostTargetSchema.parse({
          instance: url.searchParams.get('instance'),
          documentId: Number(url.searchParams.get('document')),
        });
        send(
          200,
          (await zwcadSdk?.editors.has(target.instance))
            ? await zwcadSdk!.editors.inspect(target)
            : (await sdk?.editors.has(target.instance))
              ? await sdk!.editors.inspect(target)
              : await inspectDocument(target.instance, target.documentId),
        );
        return;
      }
      const importRecovery = /^\/api\/v1\/projects\/([^/]+)\/imports\/([^/]+)\/reconcile$/.exec(
        url.pathname,
      );
      if (importRecovery && request.method === 'POST') {
        await body(request);
        const [, projectId, id] = importRecovery,
          key = projectId + ':' + id;
        if (!importRecoveries.has(key)) {
          const pending = recoverDwgImport(projectId, id, workspace, hosts.zwcad).finally(() =>
            importRecoveries.delete(key),
          );
          importRecoveries.set(key, pending);
        }
        send(200, await importRecoveries.get(key));
        return;
      }
      const application =
        /^\/api\/v1\/projects\/([^/]+)\/applications(?:\/([^/]+)(\/reconcile)?)?$/.exec(
          url.pathname,
        );
      if (application) {
        if (request.method === 'POST' && application[3]) {
          const outcome = await applications.recover(application[1], application[2]);
          if (
            sdk &&
            outcome &&
            typeof outcome.payload.requestId === 'string' &&
            ['succeeded', 'failed'].includes(outcome.state)
          ) {
            const saved = workspace.get(application[1], outcome.payload.requestId);
            if (saved.result?.applicationId === outcome.id && saved.state === 'unknown') {
              let result: Record<string, unknown> = {
                ...saved.result,
                applicationState: outcome.state,
                phase: 'complete',
              };
              if (outcome.state === 'succeeded') {
                try {
                  const synced = await sdk.captureEditor(
                    hostTargetSchema.parse(outcome.payload),
                    () => {},
                  );
                  result = { ...result, ...synced, syncState: 'succeeded', code: undefined };
                } catch {
                  result = { ...result, syncState: 'failed', code: 'APPLIED_SYNC_FAILED' };
                }
              }
              workspace.update(
                application[1],
                saved.id,
                outcome.state === 'succeeded' ? 'succeeded' : 'failed',
                result,
              );
              // Settled: the candidate's capture has no further use (T-087).
              void sdk.copies.removeCapture(
                (saved.result.sourceDocument as { capture?: unknown } | undefined)?.capture,
                { copy: true, receipt: true },
              );
            }
          }
          send(200, outcome);
          return;
        }
        if (request.method === 'POST' && !application[2]) {
          const input = await body(request);
          send(
            201,
            await applications.prepare(application[1], z.string().parse(input.requestId), {
              instance: input.instance,
              documentId: input.documentId,
            }),
          );
          return;
        }
        if (request.method === 'POST' && application[2]) {
          send(200, await applications.confirm(application[1], application[2]));
          return;
        }
        if (request.method === 'GET' && application[2]) {
          send(200, store.getCommand(application[1], application[2]));
          return;
        }
      }
      const comparison = /^\/api\/v1\/projects\/([^/]+)\/comparison$/.exec(url.pathname);
      if (comparison && request.method === 'GET') {
        const projectId = comparison[1],
          before = lazyCandidate(workspace, projectId, url.searchParams.get('before') || ''),
          after = lazyCandidate(workspace, projectId, url.searchParams.get('after') || '');
        send(
          200,
          compareCandidates(before, after, relatedCandidates(workspace, projectId, before, after)),
        );
        return;
      }
      const view = /^\/api\/v1\/projects\/([^/]+)\/table-views(?:\/([^/]+)(\/delete)?)?$/.exec(
        url.pathname,
      );
      if (view) {
        if (request.method === 'GET' && !view[2]) {
          send(200, tableViews.list(view[1]));
          return;
        }
        if (request.method === 'POST' && view[3]) {
          send(
            200,
            tableViews.remove(
              view[1],
              view[2],
              z
                .number()
                .int()
                .parse((await body(request)).revision),
            ),
          );
          return;
        }
        if (request.method === 'POST' && !view[2]) {
          send(201, tableViews.save(view[1], await body(request)));
          return;
        }
        if (request.method === 'PUT' && view[2]) {
          send(200, tableViews.save(view[1], await body(request), view[2]));
          return;
        }
      }
      const table =
        /^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/(quantities|quantities.csv)$/.exec(
          url.pathname,
        );
      if (table && request.method === 'GET') {
        const data = quantities(
          candidateSchema.parse(lazyCandidate(workspace, table[1], table[2])),
          Object.fromEntries(url.searchParams),
        );
        if (table[3] === 'quantities') {
          send(200, data);
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="VIDE-quantities.csv"',
        });
        response.end(quantitiesCsv(data));
        return;
      }
      const artifact = /^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/(model|open)$/.exec(
        url.pathname,
      );
      if (
        artifact &&
        ((request.method === 'GET' && artifact[3] === 'model') ||
          (request.method === 'POST' && artifact[3] === 'open'))
      ) {
        const saved = workspace.get(artifact[1], artifact[2]);
        if (!saved.result?.hostExecuted || !saved.result.filename)
          throw new DomainError('NOT_FOUND');
        if (artifact[3] === 'open') {
          const host = saved.result.host === 'zwcad' ? 'zwcad' : 'rhino';
          const opened =
            saved.result.executionMode === 'sdk' && host === 'zwcad' && zwcadSdk
              ? await zwcadSdk.open(saved.result)
              : saved.result.executionMode === 'sdk' && sdk
                ? await sdk.open(saved.result)
                : await hosts[host].open(z.string().parse(saved.result.filename));
          // A work copy opened in its program is a linked file of the project (SPEC-01.11).
          const window = z
            .object({ instance: z.string(), documentId: z.number().int().positive() })
            .safeParse(opened);
          if (window.success)
            links.link(artifact[1], {
              host,
              name: `${z.object({ name: z.string() }).safeParse(saved.result.sourceDocument).data?.name ?? (saved.input.body.slice(0, 40) || 'VIDE')} · 작업 사본`,
              path: z.string().parse(saved.result.filename),
              ...window.data,
            });
          send(200, opened);
          return;
        }
        const content = await readFile(z.string().parse(saved.result.filename));
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="VIDE-candidate.${saved.result.host === 'zwcad' ? 'dwg' : '3dm'}"`,
        });
        response.end(content);
        return;
      }
      const hide = /^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/hide$/.exec(url.pathname);
      if (hide && request.method === 'POST') {
        workspace.hide(hide[1], hide[2]);
        send(200, { hidden: true });
        return;
      }
      const intervention = /^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/interventions$/.exec(
        url.pathname,
      );
      if (intervention && request.method === 'POST') {
        // Folder chips are granted only on a checked submission (SPEC-01.13 5), never here.
        const { folders: _folders, ...value } = await body(request);
        send(202, execution.intervene(intervention[1], intervention[2], value));
        return;
      }
      // Plan / Auto (ADR-022): [되돌리기] of one direct execution, the guard card's [진행], the
      // plan card's [진행] (an Auto turn in the same conversation), and [확인함] of an unresolved
      // result (T-102).
      const directAction =
        /^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/(undo|confirm|continue|acknowledge)$/.exec(
          url.pathname,
        );
      if (directAction && request.method === 'POST') {
        const [, projectId, id, action] = directAction;
        if (action === 'undo') {
          // {executionId}: one execution; {all: true}: the whole request in every file (ADR-027).
          const { executionId, all } = await body(request);
          const undone =
            all === true
              ? await execution.undoRequest(projectId, id)
              : await execution.undo(projectId, id, executionId);
          send(200, { ...undone, request: withApplications(undone.request) });
        } else if (action === 'confirm') {
          const { executionId } = await body(request);
          send(202, withApplications(await execution.confirm(projectId, id, executionId)));
        } else if (action === 'acknowledge')
          send(200, withApplications(execution.acknowledge(projectId, id)));
        else send(202, withApplications(execution.continuePlan(projectId, id)));
        return;
      }
      // The answers to a running Claude turn's own questions (AskUserQuestion, ADR-026 4): the
      // same run goes on with them.
      const questions = /^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/questions$/.exec(
        url.pathname,
      );
      if (questions && request.method === 'POST') {
        store.project(questions[1]);
        const { answers } = z
          .object({
            answers: z
              .array(
                z
                  .object({
                    id: z.string().max(40),
                    option: z.string().max(40).optional(),
                    text: z.string().max(2000).optional(),
                  })
                  .strict(),
              )
              .max(3),
          })
          .strict()
          .parse(await body(request));
        send(200, execution.answerQuestions(questions[1], questions[2], answers, remote));
        return;
      }
      const job = /^\/api\/v1\/projects\/([^/]+)\/requests(?:\/([^/]+)(\/cancel)?)?$/.exec(
        url.pathname,
      );
      const sdkRecovery = /^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/reconcile$/.exec(
        url.pathname,
      );
      if (sdkRecovery && request.method === 'POST') {
        const [, projectId, id] = sdkRecovery,
          saved = workspace.get(projectId, id);
        if (saved.state === 'succeeded') {
          send(200, withApplications(saved));
          return;
        }
        const recoverySdk = saved.result?.host === 'zwcad' ? zwcadSdk : sdk;
        if (
          saved.state !== 'unknown' ||
          saved.result?.applicationId ||
          saved.result?.executionMode !== 'sdk' ||
          !recoverySdk
        )
          throw new DomainError('NOT_FOUND');
        const key = 'sdk:' + projectId + ':' + id;
        if (!importRecoveries.has(key)) {
          const pending = recoverySdk
            .recover(saved.result)
            .then(async (result) => {
              const recovered = workspace.update(projectId, id, 'succeeded', result);
              if (saved.input.source === 'file')
                await unlink(join(host.directory, projectId, id + '.upload.3dm')).catch(() => {});
              return recovered;
            })
            .catch(() => workspace.get(projectId, id))
            .finally(() => importRecoveries.delete(key));
          importRecoveries.set(key, pending);
        }
        send(200, withApplications((await importRecoveries.get(key))!));
        return;
      }
      // The object rows of one request, without geometry (T-123): what the request list leaves out
      // of a display Sync. `ids` (comma separated) limits them to those objects, `native` to those
      // Rhino ids (any case: a jig names objects by their Rhino id). Without either the rows come
      // in pages (`offset`, `limit` up to OBJECT_PAGE, T-127); `nextOffset` names the next page.
      const requestObjects = /^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/objects$/.exec(
        url.pathname,
      );
      if (requestObjects && request.method === 'GET') {
        const [, projectId, id] = requestObjects;
        store.project(projectId);
        const wanted = url.searchParams.get('ids');
        const ids = wanted ? new Set(wanted.split(',').filter(Boolean)) : undefined;
        const nativeWanted = url.searchParams.get('native');
        const natives = nativeWanted
          ? new Set(nativeWanted.toLowerCase().split(',').filter(Boolean))
          : undefined;
        const view = workspace.model(projectId, id);
        if (!ids && !natives) {
          const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset') ?? 0)) || 0);
          const limit = Math.min(
            OBJECT_PAGE,
            Math.max(1, Math.floor(Number(url.searchParams.get('limit') ?? OBJECT_PAGE)) || 1),
          );
          // One row more tells whether another page follows.
          const rows = view
            ? view.rowsPage(offset, limit + 1)
            : ((workspace.summary(projectId, id).result?.objects ?? []) as unknown[]).slice(
                offset,
                offset + limit + 1,
              );
          send(200, {
            requestId: id,
            objects: rows.slice(0, limit),
            ...(rows.length > limit ? { nextOffset: offset + limit } : {}),
          });
          return;
        }
        const rows = view
          ? view.rows()
          : ((workspace.summary(projectId, id).result?.objects ?? []) as {
              id: string;
              nativeId?: unknown;
            }[]);
        send(200, {
          requestId: id,
          objects: rows.filter(
            (row) =>
              (!ids || ids.has(String(row.id))) &&
              (!natives ||
                (typeof row.nativeId === 'string' && natives.has(row.nativeId.toLowerCase()))),
          ),
        });
        return;
      }
      // Changes of a stored model since a manifest revision (ARCH-01 §5, T-084 notifications).
      const requestDelta = /^\/api\/v1\/projects\/([^/]+)\/requests\/([^/]+)\/delta$/.exec(
        url.pathname,
      );
      if (requestDelta && request.method === 'GET') {
        const [, projectId, id] = requestDelta;
        store.project(projectId);
        const since = Number(url.searchParams.get('since') ?? '');
        const base = url.searchParams.get('base') || undefined;
        if (!workspace.model(projectId, id)) {
          // Not stored per object (yet): the caller reads the request whole.
          workspace.summary(projectId, id);
          send(200, { requestId: id, full: true });
          return;
        }
        const delta = workspace.models(projectId).deltaSince(projectId, id, since, base);
        if (delta.full) send(200, delta);
        // The host panels keep object rows only (`view=rows`, T-123): no geometry travels.
        else if (url.searchParams.get('view') === 'rows') {
          const { scene: _scene, definitions: _definitions, ...rows } = delta;
          send(200, { ...rows, scene: [] });
        } else deliver(200, GEOMETRY_TYPE, Buffer.from(ModelStore.deltaGeometry(delta)));
        return;
      }
      if (job) {
        const [, projectId, id, cancel] = job;
        // One request as the list shows it (`?view=summary`, T-123): no geometry, no Sync rows.
        if (request.method === 'GET' && id && url.searchParams.get('view') === 'summary') {
          send(200, listed(withApplications(workspace.summary(projectId, id))));
          return;
        }
        // One request in full as binary geometry when the workspace asks for it (PLAN-18).
        if (request.method === 'GET' && id && accepts(GEOMETRY_TYPE)) {
          // A model stored per object is joined from its stored buffers (ARCH-01 §5 「API 응답」).
          const view = workspace.model(projectId, id);
          deliver(
            200,
            GEOMETRY_TYPE,
            Buffer.from(
              view
                ? view.geometry(withApplications(workspace.brief(projectId, id)))
                : encodeGeometry(withApplications(workspace.get(projectId, id))),
            ),
          );
          return;
        }
        if (request.method === 'GET') {
          // A display Sync's model is binary only (T-127): as JSON it is tens of MB. Readers that
          // need its rows or state use `/objects` or `?view=summary`.
          if (id && workspace.summary(projectId, id).result?.displayOnly === true)
            throw new DomainError('GEOMETRY_BINARY_REQUIRED');
          send(
            200,
            id
              ? withApplications(workspace.get(projectId, id))
              : (() => {
                  // Entries the user removed from the conversation are not listed.
                  const hidden = workspace.hiddenIds(projectId);
                  // The list carries no display meshes (tens of MB per Sync) and no view images
                  // sent to the AI (up to ~1 MB each); the UI fetches one request in full when it
                  // shows that model. The run itself reads the stored input.
                  return workspace
                    .list(projectId)
                    .filter((row) => !hidden.has(row.id))
                    .map(withApplications)
                    .map((row) => {
                      if (row.input && 'images' in row.input) {
                        const { images: _images, ...input } = row.input;
                        row = { ...row, input: input as typeof row.input };
                      }
                      return listed(row);
                    });
                })(),
          );
          return;
        }
        if (request.method === 'POST' && cancel) {
          send(200, execution.cancel(projectId, id));
          return;
        }
        if (request.method === 'POST' && !id) {
          const input = await body(request);
          if (input.provider === 'extension') throw new DomainError('INVALID_INPUT');
          if ('accountProfileId' in input) throw new DomainError('INVALID_INPUT');
          const existing =
            typeof input.id === 'string'
              ? store
                  .db(projectId)
                  .prepare('SELECT input FROM workspace_requests WHERE id=? AND projectId=?')
                  .get(input.id, projectId)
              : undefined;
          const old =
            existing && typeof existing.input === 'string' ? JSON.parse(existing.input) : undefined;
          // Sent through the remote tunnel (never the browser's word): such a turn starts no image
          // job on this PC's Codex login (SPEC-09.10 4). A retried request keeps the first mark.
          delete input.remote;
          if (old ? old.remote === true : remote) input.remote = true;
          // Pins on a Sync of a closed Rhino window move to the reopened one (SPEC-02.16).
          if (!old) carryPins(workspace, projectId, input);
          const routingInput = () => ({
            body: typeof input.body === 'string' ? input.body : '',
            host: typeof input.host === 'string' ? input.host : undefined,
            permission: typeof input.permission === 'string' ? input.permission : undefined,
            files: Array.isArray(input.files) ? input.files : undefined,
            pins: Array.isArray(input.pins) ? input.pins : undefined,
            sketches: Array.isArray(input.sketches) ? input.sketches : undefined,
            linkedTargets: Array.isArray(input.linkedTargets) ? input.linkedTargets : undefined,
          });
          // A reference-board turn (SPEC-09, T-090): only for an image the project keeps.
          const reference =
            input.reference !== undefined && !old
              ? (() => {
                  const attachmentId = (input.reference as { attachmentId?: unknown } | null)
                    ?.attachmentId;
                  if (
                    !referenceBoards ||
                    typeof attachmentId !== 'string' ||
                    attachments?.get(projectId, attachmentId)?.kind !== 'image'
                  )
                    throw new DomainError('NOT_FOUND');
                  return { ...referenceBoards.before(projectId, input), attachmentId };
                })()
              : undefined;
          if (reference && typeof input.conversationId !== 'string')
            input.conversationId = 'default';
          // A retried request stays where it went the first time.
          if (old) {
            if (typeof old.conversationId === 'string') input.conversationId = old.conversationId;
            else delete input.conversationId;
          }
          // A conversation's first turn fixes its service and model (the composer's own model, else
          // Jev once); later turns keep them, and another model opens a new conversation with a
          // hand-over (SPEC-02.19 2·5). `default` is the project's default conversation.
          if (typeof input.conversationId === 'string') {
            if (old) conversations.fix(projectId, input);
            else
              await conversations.place(projectId, input, {
                route: async (requested) =>
                  modelRouter.route(
                    routingInput(),
                    await execution.models(),
                    signedInServices(),
                    requested,
                  ),
              });
          }
          if (old && isAutoModel(input.model) && old.routing) {
            // A retried automatic request keeps the service and model chosen the first time.
            input.provider = old.provider;
            input.model = old.model;
            input.effort = old.effort;
            input.routing = old.routing;
          } else if (!old && isAutoModel(input.model)) {
            const decision = await modelRouter.route(
              routingInput(),
              await execution.models(),
              signedInServices(),
              input.provider === 'codex-cli' ? 'codex-cli' : 'claude-cli',
            );
            input.provider = decision.provider;
            if (decision.model) input.model = decision.model;
            else delete input.model;
            input.effort = decision.effort;
            input.routing = decision;
          }
          // Every request runs on the CLI's default login (ADR-025); a retried one keeps the
          // account an older VIDE stored with it.
          z.enum(['claude-cli', 'codex-cli']).parse(input.provider);
          if (old?.accountProfileId) input.accountProfileId = old.accountProfileId;
          // Attachment entries take what is kept (size, type, path), never the browser's word.
          if (attachments && !old) input.files = attachments.normalize(projectId, input.files);
          // Folder chips (SPEC-01.12 6, SPEC-01.13 5): checked again here, this PC only; a
          // retried request keeps the folders it was given the first time.
          if (old) {
            if (old.folders) input.folders = old.folders;
            else delete input.folders;
          } else if (input.folders !== undefined) {
            if (remote) throw new DomainError('FORBIDDEN');
            const named = requestInputSchema.shape.folders.parse(input.folders) ?? [];
            input.folders = await Promise.all(
              named.map(async (folder) => ({
                name: folder.name,
                path: await checkFolder(folder.path, fileContext),
              })),
            );
          }
          // A reference turn is recorded on its board only once the request is stored.
          const result =
            reference && referenceBoards
              ? await referenceBoards.prepare(
                  projectId,
                  input,
                  {
                    name: attachments?.get(projectId, reference.attachmentId)?.name ?? '',
                    remote,
                  },
                  () => workspace.submit(projectId, input),
                )
              : workspace.submit(projectId, input);
          if (result.created) execution.start(result.request);
          const routing = result.created
            ? (result.request.input.routing as Record<string, unknown> | undefined)
            : undefined;
          if (routing) {
            const { id: requestId, projectId: requestProject } = result.request;
            const entry = { requestId, projectId: requestProject, ...routing };
            modelRouter.record({ event: 'routed', ...entry });
            void execution.completion(requestId)?.finally(() => {
              const done = workspace.get(requestProject, requestId);
              const usage = (done.result as { usage?: Record<string, unknown> } | null)?.usage;
              modelRouter.record({
                event: 'finished',
                ...entry,
                state: done.state,
                finishedAt: new Date().toISOString(),
                inputTokens: usage?.inputTokens ?? null,
                outputTokens: usage?.outputTokens ?? null,
              });
            });
          }
          send(result.created ? 202 : 200, workspace.get(projectId, result.request.id));
          return;
        }
      }
      if (url.pathname === '/api/v1/projects') {
        if (request.method === 'GET') {
          send(200, listProjects());
          return;
        }
        if (request.method === 'POST') {
          const created = store.createProject((await body(request)).name);
          await remoteAccess.pushProject(created);
          send(201, created);
          return;
        }
      }
      const projectPath = /^\/api\/v1\/projects\/([^/]+)(\/thumbnail)?$/.exec(url.pathname);
      if (projectPath && request.method === 'DELETE' && !projectPath[2]) {
        // Asked for in the app after a confirmation; the user's own files stay.
        const projectId = projectPath[1];
        send(200, await purgeProject(projectId));
        await remoteAccess.removeProject(projectId);
        return;
      }
      if (projectPath && request.method === 'PUT' && !projectPath[2]) {
        const renamed = store.renameProject(projectPath[1], (await body(request)).name);
        await remoteAccess.pushProject(renamed);
        send(200, renamed);
        return;
      }
      if (projectPath && request.method === 'POST' && projectPath[2]) {
        // A small viewport image for the project card on the account site.
        store.project(projectPath[1]);
        const image = z
          .string()
          .max(160_000)
          .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/)
          .parse((await body(request)).image);
        send(200, { sent: await remoteAccess.pushThumbnail(projectPath[1], image) });
        return;
      }
      const match = /^\/api\/v1\/projects\/([^/]+)\/inputs(?:\/([^/]+))?$/.exec(url.pathname);
      if (match) {
        const [, projectId, inputId] = match;
        if (request.method === 'GET' && !inputId) {
          send(200, store.listInputs(projectId));
          return;
        }
        if (request.method === 'POST' && !inputId) {
          send(201, store.saveInput(projectId, await body(request)));
          return;
        }
        if (request.method === 'PUT' && inputId) {
          const input = await body(request);
          send(
            200,
            store.updateInput(
              projectId,
              inputId,
              z.number().int().parse(input.revision),
              input.body,
            ),
          );
          return;
        }
      }
      throw new DomainError('NOT_FOUND');
    } catch (error) {
      if (!(error instanceof DomainError) && !(error instanceof z.ZodError))
        diagnostics.write('server-error', {
          requestId,
          method: request.method,
          path: (request.url || '').split('?')[0],
          ...Diagnostics.error(error),
        });
      // Every error the user sees, with its code (T-126): the path without its ids plus the
      // project/request/conversation it named. A sign-in check refusing a page is not logged.
      else {
        const route = routeOf(request.url || '');
        const code = error instanceof DomainError ? error.code : 'INVALID_INPUT';
        // A page before sign-in and missing static files are not failures.
        const quiet =
          code === 'UNAUTHORIZED' || (code === 'NOT_FOUND' && !route.path.startsWith('/api/'));
        // A polled path failing the same way is written once per 10 s with the repeats counted.
        const repeated = quiet ? undefined : apiErrorRepeats.note(request.method, route.path, code);
        if (repeated !== undefined)
          diagnostics.write('api-error', {
            requestId,
            method: request.method,
            ...route,
            status: error instanceof DomainError ? (statuses[error.code] ?? 400) : 400,
            code,
            ...(error instanceof z.ZodError
              ? { fields: error.issues.slice(0, 5).map((issue) => issue.path.join('.')) }
              : {}),
            ...(repeated ? { repeated } : {}),
          });
      }
      if (!response.headersSent)
        send(
          error instanceof DomainError
            ? (statuses[error.code] ?? 400)
            : error instanceof z.ZodError
              ? 400
              : 500,
          {
            code:
              error instanceof DomainError
                ? error.code
                : error instanceof z.ZodError
                  ? 'INVALID_INPUT'
                  : 'INTERNAL_ERROR',
            ...(error instanceof PinCarryError ? { reason: error.reason } : {}),
            requestId,
          },
        );
      else response.end();
    }
  });
  // Space a move or prune left free (VACUUM skipped while the last run was busy) goes back to the
  // disk before the address opens (ARCH-01 §5 「기존 결과 옮기기」).
  if (filename !== ':memory:') {
    const started = performance.now();
    if (store.compact())
      diagnostics.write('model-vacuum', {
        ms: Math.round(performance.now() - started),
        at: 'start',
      });
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    store.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('LISTEN_FAILED');
  authority = `127.0.0.1:${address.port}`;
  origin = `http://${authority}`;
  void remoteAccess.init();
  // Provider transcripts of conversations closed 30 days ago (SPEC-02.19 1): at start, then daily.
  const sweepTranscripts = () => void conversations.sweep().catch(() => {});
  sweepTranscripts();
  const transcriptSweep = setInterval(sweepTranscripts, 24 * 60 * 60 * 1000);
  transcriptSweep.unref();
  diagnostics.write('engine-start', {
    port: address.port,
    pid: process.pid,
    version: appVersion(),
  });
  const stopHealth = filename === ':memory:' ? () => {} : startHealthLog(diagnostics);
  telemetry.start();
  scheduler?.start();
  // Sync results stored as whole JSON move to per-object storage in the background, then old
  // Syncs are pruned and the file compacted when idle (PLAN-27 1단계, ARCH-01 §5). One project DB
  // after another (ADR-032); a project removed meanwhile is skipped.
  const maintenance =
    filename === ':memory:'
      ? Promise.resolve()
      : (async () => {
          for (const db of store.databases()) {
            if (stopping) break;
            await maintainModels(db, {
              log: (event, data) => diagnostics.write(event, data),
              stopped: () => stopping || !store.databases().includes(db),
              idle: () => !stopping && documentSyncs.idle() && (scheduler?.idle() ?? true),
            }).catch((error) => {
              if (store.databases().includes(db))
                diagnostics.write('model-move-failed', Diagnostics.error(error));
            });
          }
        })();
  // Copies and work folders left by earlier runs (T-087): older than a day and not in use.
  // Only folders inside this engine's own data folder are swept.
  const own = (path: string) => (within(dirname(filename), path) ? path : undefined);
  if (sdkOptions && filename !== ':memory:')
    void sweepCopies({
      connections: own(
        sdkOptions.connectionDirectory || join(dirname(sdkOptions.directory), 'rhino-connections'),
      ),
      models: own(sdkOptions.directory),
      keep: store.databases().flatMap(unsettledCopies),
    })
      .then((swept) => {
        if (swept.captures || swept.directories || swept.sessions)
          diagnostics.write('copies-swept', swept);
      })
      .catch((error) => diagnostics.write('copies-sweep-failed', Diagnostics.error(error)));
  return {
    origin,
    diagnostics,
    launchUrl: `${origin}/#${bootstrap}`,
    store,
    agentTools,
    remoteAccess,
    close: async () => {
      stopping = true;
      diagnostics.write('engine-stop');
      // The move stops after its current row (that row is one transaction).
      await Promise.race([
        maintenance,
        new Promise((resolve) => setTimeout(resolve, 5000).unref()),
      ]);
      stopHealth();
      await telemetry.close();
      await scheduler?.stop();
      await sharedNotes?.close().catch(() => {});
      await remoteAccess.close();
      await offlineView.close();
      agentTools.close();
      // No image job starts from here on and running ones end their codex process (T-090).
      const boardsClosed = referenceBoards?.close();
      await execution.close();
      await boardsClosed;
      await referenceBoards?.idle();
      clearInterval(transcriptSweep);
      await Promise.allSettled([...importRecoveries.values()]);
      try {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      } finally {
        // Nothing this engine started outlives it: jig child processes and runners (before the
        // store they read), then the structure worker when no other engine in this process has
        // work in it (the worker is per process; a later analysis starts a new one).
        await closeJigRuntime(workspace).catch(() => {});
        const analysis = analysisWorkerStats();
        if (!analysis.running && analysis.queued === 0) await closeAnalysisWorker();
        store.close();
        setDiagnosticSink(undefined, diagnosticSink);
        diagnostics.close();
      }
    },
  };
}
