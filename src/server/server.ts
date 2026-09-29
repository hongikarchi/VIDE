import { selectContext } from '../ai/context-selector.ts';
import { GEOMETRY_TYPE, encodeGeometry } from '../contracts/geometry-transfer.ts';
import { applyAttachedCandidate } from './attached-application.ts';
import { LiveSync } from './live-sync.ts';
import { RemoteAccess } from './remote-access.ts';
import { OfflineView } from './offline-view.ts';
import { Connectors, type ConnectorOptions } from './connectors.ts';
import { appVersion, defaultRhinoPlugin, defaultZwcadConnection } from './sdk-options.ts';
import { gzip } from 'node:zlib';
import { AccountProfiles } from '../ai/account-profiles.ts';
import { AccountUsageService } from '../ai/account-usage.ts';
import { JIGS } from '../jigs/catalog.ts';
import { runSync } from '../jigs/sync.ts';
import {
  analyzeConfirmed,
  applyEdits,
  checkModel as checkStructureModel,
  documentKey as structureDocumentKey,
  draftEditsSchema,
  draftStructure,
  StructureStore,
} from '../jigs/structure/index.ts';
import { AUTO_MODELS, ModelRouter, isAutoModel } from '../ai/model-router.ts';
import { Diagnostics } from './diagnostics.ts';
import {
  knowledgeEvidence,
  knowledgeFile,
  knowledgeIssue,
  knowledgeSearch,
  knowledgeSummary,
  openKnowledgeSource,
} from '../jigs/knowledge.ts';
import { DocumentLinks, isFileLink } from '../core/document-links.ts';
import { AccountLogin } from '../ai/account-login.ts';
import { z } from 'zod';
import type { IncomingMessage } from 'node:http';
import type { StoredWork } from '../contracts/stored-work.ts';
import { hostTargetSchema } from '../contracts/host-documents.ts';
import { candidateSchema } from '../core/reviews.ts';
type ExecutionOptions = NonNullable<ConstructorParameters<typeof Execution>[1]>;
interface ServerOptions {
  filename: string;
  port?: number;
  providerFactory?: ExecutionOptions['providerFactory'];
  loginOptions?: ConstructorParameters<typeof AccountLogin>[0];
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
}
import { readWebAsset } from './web-assets.ts';
import { Extensions } from '../core/extensions.ts';
import { AgentTools } from './agent-tools.ts';
import { SdkExecution } from './sdk-execution.ts';
import { ZwcadSdkExecution } from './zwcad-sdk-execution.ts';
import { AiSettings } from '../core/ai-settings.ts';
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
import { Store, DomainError } from '../core/store.ts';
import { Workspace } from '../core/workspace.ts';
import { Execution } from './execution.ts';
import { captureMeasurements } from '../core/measurement-cache.ts';
import { RhinoWorkspace } from '../../hosts/rhino/workspace.ts';
import { ZwcadWorkspace } from '../../hosts/zwcad/workspace.ts';
import { dirname, join } from 'node:path';
import { importModel, captureModel, recoverDwgImport } from './import-model.ts';
import { renderReport } from './report.ts';

/** The file name of an import request ("plan.dwg 불러오기"). */
const importedName = (body: string) => body.replace(/ 불러오기$/, '');

/** The local browser session survives restarts, so an open page keeps working after one. */
async function localSession(directory: string) {
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
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new DomainError('JSON_REQUIRED');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new DomainError('INPUT_TOO_LARGE');
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
const statuses: Record<string, number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  JSON_REQUIRED: 415,
  INPUT_TOO_LARGE: 413,
  REVISION_CONFLICT: 409,
  TARGET_MISMATCH: 409,
  CONTROLLER_BUSY: 409,
  PROJECT_BUSY: 409,
  WORKSPACE_CAPACITY: 409,
  STALE_REFERENCE: 409,
  STRUCTURE_MODEL_INVALID: 422,
  STRUCTURE_CORE_MISSING: 503,
  HOST_RUNNING: 409,
};
export async function startServer({
  filename,
  port = 0,
  providerFactory,
  loginOptions,
  host,
  cadHost,
  applicationOptions,
  onShutdown,
  sdkOptions,
  remoteOptions,
  connectorOptions,
}: ServerOptions) {
  const store = new Store(filename),
    bootstrap = randomBytes(32).toString('hex'),
    session = await localSession(dirname(filename));
  const agentTools = new AgentTools();
  const accountLogin = new AccountLogin(loginOptions);
  const workspace = new Workspace(store),
    links = new DocumentLinks(store.db),
    tableViews = new TableViews(store),
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
  const liveSync = sdk ? new LiveSync(workspace, sdk) : undefined;
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
    projects: () => store.listProjects(),
    activity: () => store.projectActivity(),
    onQueue: (items) => offlineView.receive(items),
    afterHeartbeat: () => void offlineView.tick().catch(() => {}),
    onProjects: (projects) => {
      for (const project of projects)
        if (!project.deleted) {
          try {
            store.ensureProject(project.id, project.name);
          } catch {
            /* A name the local store rejects keeps the local name. */
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
  // Offline view and site request inbox (PLAN-20).
  const offlineView = new OfflineView({
    directory: filename === ':memory:' ? undefined : dirname(filename),
    store,
    workspace,
    links,
    remote: remoteAccess,
  });
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
  const profiles = new AccountProfiles(join(dirname(filename), 'cli-profiles'), (provider) => {
    const persisted = store.db
      .prepare(
        "SELECT 1 FROM workspace_requests WHERE json_extract(input,'$.provider')=? AND state IN ('queued','running','unknown') LIMIT 1",
      )
      .get(provider);
    return (
      !!persisted ||
      accountLogin.busy(provider) ||
      (typeof execution !== 'undefined' &&
        [...execution.active.keys()].some((id) =>
          store.db
            .prepare(
              "SELECT 1 FROM workspace_requests WHERE id=? AND json_extract(input,'$.provider')=?",
            )
            .get(id, provider),
        ))
    );
  });
  const accountUsage = new AccountUsageService({
    profiles,
    file: join(dirname(filename), 'cli-profiles', 'usage-settings.json'),
  });
  const diagnostics = new Diagnostics({
    directory: filename === ':memory:' ? undefined : dirname(filename),
  });
  const execution = new Execution(workspace, {
    diagnostics,
    selectContext: (text, candidates) =>
      selectContext(text, candidates, { dataDirectory: dirname(filename) }),
    onProviderLimit: (provider, id) =>
      accountUsage.markLimited(z.enum(['claude-cli', 'codex-cli']).parse(provider), id),
    applyAttached: sdk
      ? (request, result, signal) =>
          applyAttachedCandidate(workspace, applications, sdk, request, result, signal)
      : undefined,
    profiles,
    tools: agentTools,
    providerFactory,
    host,
    hosts,
    settings: aiSettings,
    sdk,
    zwcadSdk,
  });
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
    applications: store.db
      .prepare(
        "SELECT id,state,result FROM commands WHERE projectId=? AND kind='applyCandidate' AND json_extract(payload,'$.requestId')=? ORDER BY rowid",
      )
      .all(request.projectId, request.id)
      .map((row) => ({
        ...row,
        result: row.result ? JSON.parse(z.string().parse(row.result)) : null,
      })),
  });
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
    const send = (status: number, data: unknown) =>
      deliver(status, 'application/json; charset=utf-8', JSON.stringify(data));
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
      if (!['GET', 'POST', 'PUT'].includes(request.method || '')) {
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
            /^\/api\/v1\/(accounts|settings|extensions)(\/|$)/.test(url.pathname))
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
      // Project link files (SPEC-01.11): linked from a host plugin, listed with live status.
      const linkList = /^\/api\/v1\/projects\/([^/]+)\/links$/.exec(url.pathname);
      const linkItem = /^\/api\/v1\/projects\/([^/]+)\/links\/([^/]+)$/.exec(url.pathname);
      if (linkList && request.method === 'GET') {
        store.project(linkList[1]);
        const open = [
          ...((await sdk?.editors.list(true).catch(() => null))?.documents ?? []),
          ...((await zwcadSdk?.editors.attached.list().catch(() => [])) ?? []),
        ];
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
        const ownedOpen = new Set<string>();
        for (const link of links.list(linkList[1]))
          if (
            !isFileLink(link) &&
            !open.some((item) => item.instance === link.instance) &&
            (link.host === 'rhino'
              ? await sdk?.editors.has(link.instance).catch(() => false)
              : await zwcadSdk?.editors.has(link.instance).catch(() => false))
          )
            ownedOpen.add(link.id);
        send(
          200,
          links.list(linkList[1]).map((link) => {
            const doc = open.find(
              (item) =>
                (item.host ?? 'rhino') === link.host &&
                (link.path && item.path
                  ? item.path.toLowerCase() === link.path.toLowerCase()
                  : item.instance === link.instance && item.id === link.documentId),
            );
            const file = isFileLink(link);
            const syncs = requests.filter(
              (entry) =>
                entry.input.linkId === link.id ||
                (file &&
                  !entry.input.linkId &&
                  entry.input.source === 'file' &&
                  entry.input.host === link.host &&
                  importedName(entry.input.body).toLowerCase() === link.name.toLowerCase()),
            );
            const last = syncs.filter((entry) => entry.state === 'succeeded').at(-1);
            const latest = syncs.at(-1);
            return {
              ...link,
              kind: file ? 'file' : 'host',
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
          .extend({ host: z.enum(['rhino', 'zwcad']) })
          .strict()
          .parse(await body(request));
        // Attached (plugin) documents and work copies VIDE opened itself can both be linked.
        const open =
          target.host === 'rhino'
            ? ((await sdk?.editors.list())?.documents ?? [])
            : ((await zwcadSdk?.editors.list()) ?? []);
        const doc = open.find(
          (item) => item.instance === target.instance && item.id === target.documentId,
        );
        if (!doc) throw new DomainError('STALE_CONNECTION');
        send(
          201,
          links.link(linkList[1], {
            host: target.host,
            name: doc.name,
            ...('path' in doc && doc.path ? { path: doc.path } : {}),
            instance: target.instance,
            documentId: target.documentId,
          }),
        );
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
      // Offline view on the account site and requests left there (PLAN-20).
      const offline = /^\/api\/v1\/projects\/([^/]+)\/offline-view$/.exec(url.pathname);
      if (offline && request.method === 'GET') {
        store.project(offline[1]);
        send(200, await offlineView.status(offline[1]));
        return;
      }
      if (offline && request.method === 'PUT') {
        const { enabled } = z
          .object({ enabled: z.boolean() })
          .strict()
          .parse(await body(request));
        await offlineView.setEnabled(offline[1], enabled);
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
      const linkRemove = /^\/api\/v1\/projects\/([^/]+)\/links\/([^/]+)\/remove$/.exec(
        url.pathname,
      );
      if (linkRemove && request.method === 'POST') {
        const removed = links.get(linkRemove[1], linkRemove[2]);
        // A file opened in VIDE also leaves the work history (records kept), so it stays removed.
        if (isFileLink(removed))
          for (const entry of workspace.list(linkRemove[1]))
            if (
              entry.input.source === 'file' &&
              !['queued', 'running'].includes(entry.state) &&
              (entry.input.linkId === removed.id ||
                (!entry.input.linkId &&
                  importedName(entry.input.body).toLowerCase() === removed.name.toLowerCase()))
            )
              workspace.hide(linkRemove[1], entry.id);
        links.remove(linkRemove[1], linkRemove[2]);
        send(200, { ok: true });
        return;
      }
      const capture = /^\/api\/v1\/projects\/([^/]+)\/capture$/.exec(url.pathname);
      if (capture && request.method === 'POST') {
        const target = hostTargetSchema
          .extend({ id: z.string(), linkId: z.string().uuid().optional() })
          .parse(await body(request));
        if (target.linkId) links.get(capture[1], target.linkId);
        const own = await sdk?.editors.has(target.instance);
        const cadOwn = await zwcadSdk?.editors.has(target.instance);
        // Sync timing (PLAN-18 step 3): the host read (meshing, pages) and the rest (checks, storing).
        const began = performance.now();
        let hostMs: number | undefined;
        const timed =
          <T>(read: () => Promise<T>) =>
          async () => {
            const start = performance.now();
            try {
              return await read();
            } finally {
              hostMs = Math.round(performance.now() - start);
            }
          };
        const captured = await captureModel(
          capture[1],
          target,
          workspace,
          own ? rhinoImport : host,
          cadOwn
            ? timed(async () => zwcadSdk!.editors.capture(target))
            : own
              ? timed(async () =>
                  sdk!.syncEditor(
                    target,
                    (intent) => workspace.update(capture[1], target.id, 'running', intent),
                    // Attached display reads never measure; skip parsing every stored model.
                    (await sdk!.editors.connectionKind(target.instance)) === 'attached-editor'
                      ? []
                      : captureMeasurements(workspace.list(capture[1], { full: true }), target),
                  ),
                )
              : undefined,
          cadOwn ? 'zwcad' : 'rhino',
        );
        const scene = (captured.result as { scene?: unknown[] } | null)?.scene;
        diagnostics.write('sync', {
          request: target.id,
          host: cadOwn ? 'zwcad' : 'rhino',
          state: captured.state,
          ms: Math.round(performance.now() - began),
          hostMs,
          objects: Array.isArray(scene) ? scene.length : undefined,
        });
        if (!cadOwn) liveSync?.record(capture[1], captured);
        send(200, captured);
        return;
      }
      const live = /^\/api\/v1\/projects\/([^/]+)\/live-sync$/.exec(url.pathname);
      if (live && request.method === 'POST') {
        if (!liveSync) throw new DomainError('RESYNC_REQUIRED');
        const began = performance.now();
        const synced = await liveSync.run(live[1], await body(request));
        diagnostics.write('live-sync', { ms: Math.round(performance.now() - began) });
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
          workspace.get(publicExport[1], publicExport[2]),
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
          related = relatedCandidates(
            workspace,
            projectId,
            workspace.get(projectId, before.requestId),
            workspace.get(projectId, after.requestId),
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
              withApplications(workspace.get(review[1], z.string().parse(input.requestId))),
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
          withApplications(workspace.get(report[1], report[2])),
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
      if (url.pathname === '/api/v1/accounts') {
        if (request.method === 'GET') {
          send(200, profiles.list());
          return;
        }
        if (request.method === 'POST') {
          const input = z
            .object({ provider: z.enum(['claude-cli', 'codex-cli']), label: z.string() })
            .strict()
            .parse(await body(request));
          send(201, profiles.add(input.provider, input.label));
          return;
        }
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
        const source = (id: string, host: 'rhino' | 'zwcad') => {
          const saved = workspace.get(syncJig[1], id);
          if (saved.state !== 'succeeded' || !saved.result || !Array.isArray(saved.result.scene))
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
      // Structure analysis jig (J-09, SPEC-06): draft from Syncs → small edits → confirm & analyse.
      const structureJig =
        /^\/api\/v1\/projects\/([^/]+)\/jigs\/structure(?:\/(draft|edit|analyze))?$/.exec(
          url.pathname,
        );
      if (structureJig) {
        const projectId = structureJig[1];
        const action = structureJig[2];
        const syncResult = (id: string) => {
          const saved = workspace.get(projectId, id);
          if (saved.state !== 'succeeded' || !saved.result || !Array.isArray(saved.result.scene))
            throw new DomainError('STALE_REFERENCE');
          return saved;
        };
        // A result is out of date when its Sync is gone or a newer Sync of the same document exists.
        const stale = (sources: { syncId: string; documentKey: string }[]) => {
          const rows = workspace.list(projectId);
          return sources.some((source) => {
            const saved = rows.find((row) => row.id === source.syncId);
            if (!saved) return true;
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
                      layers: z.array(z.string()).max(500).optional(),
                      objectIds: z.array(z.string()).max(20000).optional(),
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
          let out: ReturnType<typeof analyzeConfirmed>;
          try {
            out = analyzeConfirmed(record.draft.model);
          } catch (error) {
            const code = (error as { code?: string }).code;
            if (code === 'STRUCTURE_MODEL_INVALID') {
              send(422, { error: code, issues: (error as { issues?: unknown }).issues ?? [] });
              return;
            }
            if (code === 'STRUCTURE_CORE_MISSING') throw new DomainError('STRUCTURE_CORE_MISSING');
            throw error;
          }
          record.confirmed = {
            confirmedAt: new Date().toISOString(),
            modelHash: out.result.modelHash,
            model: out.model,
            sources: record.draft.sources.map(({ syncId, documentKey }) => ({
              syncId,
              documentKey,
            })),
            ledger: out.ledger,
            issues: out.issues,
            result: out.result,
          };
          structures.save(projectId, record);
          send(200, { ...record.confirmed, stale: false });
          return;
        }
      }
      // Project knowledge jig (trial, read-only): issue notes, search and evidence of one project's DB.
      const knowledge =
        /^\/api\/v1\/projects\/([^/]+)\/jigs\/knowledge(?:\/(issues|statements|sources)\/(\d+)(\/open)?|\/(search))?$/.exec(
          url.pathname,
        );
      if (knowledge) {
        store.project(knowledge[1]);
        const file = knowledgeFile(dirname(filename), knowledge[1]);
        const [, , kind, id, openPath, search] = knowledge;
        if (request.method === 'GET' && !kind && !search) {
          send(200, knowledgeSummary(file));
          return;
        }
        if (request.method === 'GET' && search) {
          const params = url.searchParams;
          send(
            200,
            knowledgeSearch(file, params.get('q') ?? '', {
              kind: params.get('kind') || undefined,
              discipline: params.get('discipline') || undefined,
            }),
          );
          return;
        }
        if (request.method === 'GET' && kind === 'issues' && !openPath) {
          send(200, knowledgeIssue(file, Number(id)));
          return;
        }
        if (request.method === 'GET' && kind === 'statements' && !openPath) {
          send(200, knowledgeEvidence(file, Number(id)));
          return;
        }
        if (request.method === 'POST' && kind === 'sources' && openPath) {
          send(200, openKnowledgeSource(file, Number(id)));
          return;
        }
      }
      // Per-account sign-in, usage and reset times; switching settings.
      if (url.pathname === '/api/v1/accounts/usage' && request.method === 'GET') {
        send(200, {
          settings: accountUsage.settings(),
          accounts: await accountUsage.all(url.searchParams.get('refresh') === '1'),
        });
        return;
      }
      if (url.pathname === '/api/v1/accounts/usage-settings' && request.method === 'POST') {
        const input = z
          .object({
            usageLookup: z.boolean().optional(),
            autoSwitch: z.boolean().optional(),
            threshold: z.number().int().min(50).max(100).optional(),
          })
          .strict()
          .parse(await body(request));
        send(200, { settings: accountUsage.setSettings(input) });
        return;
      }
      if (url.pathname === '/api/v1/accounts/remove' && request.method === 'POST') {
        const input = z
          .object({
            provider: z.enum(['claude-cli', 'codex-cli']),
            id: z.string().uuid(),
            deleteLocalData: z.literal(true),
          })
          .strict()
          .parse(await body(request));
        profiles.assertIdle(input.provider);
        profiles.directory(input.provider, input.id);
        const status = await execution
          .provider({ provider: input.provider, accountProfileId: input.id })
          .status();
        if (status.available || status.reason !== 'SUBSCRIPTION_LOGIN_REQUIRED')
          throw new DomainError('PROFILE_LOGOUT_REQUIRED');
        send(200, profiles.remove(input.provider, input.id));
        return;
      }
      if (url.pathname === '/api/v1/accounts/rename' && request.method === 'POST') {
        const input = z
          .object({
            provider: z.enum(['claude-cli', 'codex-cli']),
            id: z.string(),
            label: z.string().max(80),
          })
          .strict()
          .parse(await body(request));
        send(200, profiles.rename(input.provider, input.id, input.label));
        return;
      }
      if (url.pathname === '/api/v1/accounts/select' && request.method === 'POST') {
        const input = z
          .object({ provider: z.enum(['claude-cli', 'codex-cli']), id: z.string() })
          .strict()
          .parse(await body(request));
        if (accountLogin.busy(input.provider)) throw new DomainError('PROFILE_LOGIN_IN_PROGRESS');
        const status = await execution
          .provider({ provider: input.provider, accountProfileId: input.id })
          .status();
        if (!status.available) throw new DomainError('SUBSCRIPTION_LOGIN_REQUIRED');
        send(200, profiles.select(input.provider, input.id));
        return;
      }
      if (url.pathname === '/api/v1/accounts/login-command' && request.method === 'POST') {
        const input = z
          .object({ provider: z.enum(['claude-cli', 'codex-cli']), id: z.string() })
          .strict()
          .parse(await body(request));
        profiles.assertIdle(input.provider);
        const directory = profiles.directory(input.provider, input.id);
        if (!directory) throw new DomainError('INVALID_INPUT');
        const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
        const key = input.provider === 'codex-cli' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
        send(200, {
          command: `$env:${key}=${quote(directory)}; & ${quote(execution.executable(input.provider) ?? '')} ${input.provider === 'codex-cli' ? 'login -c \'cli_auth_credentials_store="file"\' -c \'forced_login_method="chatgpt"\'' : 'auth login --claudeai'}`,
        });
        return;
      }
      if (url.pathname === '/api/v1/accounts/login' && request.method === 'GET') {
        // Sign-in addresses and codes are for this PC's screen only, never a remote device.
        send(
          200,
          accountLogin
            .list()
            .map(({ prompt, ...status }) => (remote ? status : { ...status, prompt })),
        );
        return;
      }
      if (url.pathname === '/api/v1/accounts/login/code' && request.method === 'POST') {
        const input = z
          .object({ provider: z.enum(['claude-cli', 'codex-cli']), code: z.string().max(2048) })
          .strict()
          .parse(await body(request));
        send(200, accountLogin.submitCode(input.provider, input.code));
        return;
      }
      if (
        ['/api/v1/accounts/login', '/api/v1/accounts/logout'].includes(url.pathname) &&
        request.method === 'POST'
      ) {
        const input = z
          .object({
            provider: z.enum(['claude-cli', 'codex-cli']),
            id: z.string(),
            browser: z.boolean().optional(),
          })
          .strict()
          .parse(await body(request));
        profiles.assertIdle(input.provider);
        const directory = profiles.directory(input.provider, input.id);
        if (!directory) throw new DomainError('INVALID_INPUT');
        const executable = execution.executable(input.provider);
        if (!executable) throw new DomainError('CLI_UNAVAILABLE');
        send(
          202,
          accountLogin.start({
            operation: url.pathname.endsWith('/logout') ? 'logout' : 'login',
            provider: input.provider,
            profileId: input.id,
            directory,
            executable,
            browser: input.browser,
            verify: () =>
              execution.provider({ provider: input.provider, accountProfileId: input.id }).status(),
          }),
        );
        return;
      }
      if (url.pathname === '/api/v1/accounts/login/cancel' && request.method === 'POST') {
        const input = z
          .object({ provider: z.enum(['claude-cli', 'codex-cli']) })
          .strict()
          .parse(await body(request));
        send(200, accountLogin.cancel(input.provider));
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
          .extend({ ids: z.array(z.string().uuid()).max(5000) })
          .parse(await body(request));
        if (!sdk) throw Object.assign(new Error('STALE_CONNECTION'), { code: 'STALE_CONNECTION' });
        send(
          200,
          await sdk.editors.setPins(
            { instance: input.instance, documentId: input.documentId },
            input.ids,
          ),
        );
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
          before = workspace.get(projectId, url.searchParams.get('before') || ''),
          after = workspace.get(projectId, url.searchParams.get('after') || '');
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
          candidateSchema.parse(workspace.get(table[1], table[2])),
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
        send(202, execution.intervene(intervention[1], intervention[2], await body(request)));
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
      if (job) {
        const [, projectId, id, cancel] = job;
        // One request in full as binary geometry when the workspace asks for it (PLAN-18).
        if (request.method === 'GET' && id && accepts(GEOMETRY_TYPE)) {
          deliver(
            200,
            GEOMETRY_TYPE,
            Buffer.from(encodeGeometry(withApplications(workspace.get(projectId, id)))),
          );
          return;
        }
        if (request.method === 'GET') {
          send(
            200,
            id
              ? withApplications(workspace.get(projectId, id))
              : (() => {
                  // Entries the user removed from the conversation are not listed.
                  const hidden = workspace.hiddenIds(projectId);
                  // The list carries no display meshes (tens of MB per Sync); the UI fetches one
                  // request in full when it shows that model.
                  return workspace
                    .list(projectId)
                    .filter((row) => !hidden.has(row.id))
                    .map(withApplications)
                    .map((row) => {
                      const result = row.result;
                      if (!result || !Array.isArray(result.scene)) return row;
                      const { scene: _scene, definitions: _definitions, ...rest } = result;
                      return { ...row, result: { ...rest, sceneOmitted: true } };
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
              ? store.db
                  .prepare('SELECT input FROM workspace_requests WHERE id=? AND projectId=?')
                  .get(input.id, projectId)
              : undefined;
          const old =
            existing && typeof existing.input === 'string' ? JSON.parse(existing.input) : undefined;
          if (old && isAutoModel(input.model) && old.routing) {
            // A retried automatic request keeps the service and model chosen the first time.
            input.provider = old.provider;
            input.model = old.model;
            input.effort = old.effort;
            input.routing = old.routing;
          } else if (!old && isAutoModel(input.model)) {
            const decision = await modelRouter.route(
              {
                body: typeof input.body === 'string' ? input.body : '',
                host: typeof input.host === 'string' ? input.host : undefined,
                permission: typeof input.permission === 'string' ? input.permission : undefined,
                files: Array.isArray(input.files) ? input.files : undefined,
                pins: Array.isArray(input.pins) ? input.pins : undefined,
                sketches: Array.isArray(input.sketches) ? input.sketches : undefined,
                linkedTargets: Array.isArray(input.linkedTargets) ? input.linkedTargets : undefined,
              },
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
          const provider = z.enum(['claude-cli', 'codex-cli']).parse(input.provider);
          if (old) {
            if (old.accountProfileId) input.accountProfileId = old.accountProfileId;
          } else {
            if (accountLogin.busy(provider)) throw new DomainError('PROFILE_LOGIN_IN_PROGRESS');
            // Automatic switching (when on): an account near or at its limit hands the request to
            // the signed-in account of the same service with the most headroom.
            const chosen = await accountUsage.choose(provider, profiles.selected(provider));
            input.accountProfileId = chosen.id;
            if (chosen.switched) {
              input.accountSwitchedFrom = chosen.from;
              if (!profiles.list().pending[provider]) profiles.select(provider, chosen.id);
            }
          }
          const result = workspace.submit(projectId, input);
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
          send(200, store.listProjects());
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
            requestId,
          },
        );
      else response.end();
    }
  });
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
  diagnostics.write('engine-start', {
    port: address.port,
    pid: process.pid,
    version: appVersion(),
  });
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
      await remoteAccess.close();
      await accountLogin.close();
      agentTools.close();
      await execution.close();
      await Promise.allSettled([...importRecoveries.values()]);
      return new Promise<void>((resolve, reject) =>
        server.close((error) => {
          store.close();
          error ? reject(error) : resolve();
        }),
      );
    },
  };
}
