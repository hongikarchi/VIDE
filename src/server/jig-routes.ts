// JIG routes (ARCH-03 §7); server.ts hands requests here first. Instances (작업본), settings with
// undo, overrides, zones, jig input reads (§8), assembly proposal/confirmation, runs and human
// step confirmation live on `/api/v1/projects/:id/jig-instances/…`; the package registry, `.vjig`
// import (§12) and pinning on `/api/v1/jigs…` and `/api/v1/projects/:id/jigs…`. Import and pin
// are confirmed actions (SPEC-02.19 T2) and refuse remote sessions. The temporary S-06 diagnosis
// routes of PLAN-23 T-044 stay until T-051 moves the step to the v3 runner.

import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import { JigStore } from '../core/jig-store.ts';
import type { Workspace } from '../core/workspace.ts';
import { isFileLink, type DocumentLink, type DocumentLinks } from '../core/document-links.ts';
import { readScopeSchema } from '../contracts/native-model.ts';
import type { SdkExecution } from './sdk-execution.ts';
import type { Execution } from './execution.ts';
import { JigRegistry, JigInvalidError, repositoryJigRoot } from '../jigs/runtime/loader.ts';
import { importPack } from '../jigs/runtime/pack.ts';
import { JigRuntime, layersOf, rowsOfLayers, type ReadModel } from '../jigs/runtime/runtime.ts';
import {
  bakeRecords,
  finishBake,
  prepareBake,
  recordBaseline,
  registerBakeJob,
  type BakeContext,
} from '../jigs/bake/bake.ts';
import { overrideSchema, transformSchema, zoneSchema } from '../jigs/runtime/instance.ts';
import { diagnose, type DiagnoseInputs } from '../../extensions/jigs/s06-frame/steps/diagnose.ts';
import { ROLE_KEYS } from '../../extensions/jigs/s06-frame/steps/labels.ts';
import {
  documentName,
  guessRoles,
  roleRows,
  syncLayers,
} from '../../extensions/jigs/s06-frame/steps/sync-input.ts';

export interface JigRouteContext {
  workspace: Workspace;
  body: (request: IncomingMessage) => Promise<Record<string, unknown>>;
  send: (status: number, data: unknown) => void;
  /** The engine's data folder (`<data>` of ARCH-03 §2.3). */
  dataDirectory: string;
  /** The request came through the remote tunnel (ARCH-01 §1.3). */
  remote?: boolean;
  links?: DocumentLinks;
  sdk?: Pick<SdkExecution, 'readLayers' | 'importFile'>;
  /** Starts the bake request (Rhino에 만들기 runs as a normal candidate request). */
  execution?: Pick<Execution, 'start'>;
}

/** HTTP statuses of the jig error codes (ARCH-03 §7); server.ts merges them into its table. */
export const jigStatuses: Record<string, number> = {
  JIG_INVALID: 422,
  JIG_SIGNATURE: 422,
  JIG_SELFTEST_FAILED: 422,
  JIG_LIBRARY_UNKNOWN: 422,
  JIG_VERSION_EXISTS: 409,
  JIG_DIGEST_MISMATCH: 409,
  JIG_PACK_FAILED: 500,
  PARAM_FIXED: 422,
  OUT_OF_RANGE: 422,
  UNIT_MISMATCH: 422,
  GATE_BLOCKED: 422,
  LAYER_ROOT_MISSING: 422,
  CONFIRMATION_REQUIRED: 422,
  STALE_INPUT: 409,
  BAKE_NOT_COMPUTED: 422,
  BAKE_JOB_MISSING: 409,
  NOT_APPLIED: 409,
};
/** What the person can do about a blocked before-bake gate (Design SCR-13 결과 서랍). */
const bakeHints: Record<string, string> = {
  'hidden-target': 'Rhino에서 레이어를 켠 뒤 다시 누르세요',
  'layer-scope': '출력 레이어 밖에는 만들지 않습니다',
  'bake-args-safe': '키·부호 문자에 허용되지 않는 글자가 있습니다',
  'analysis-confirmed': '해석을 확정한 뒤 만드세요',
};

/** Most Syncs one diagnosis reads (linked documents) and objects it takes over all roles. */
const MAX_SOURCES = 8;
const MAX_OBJECTS = 50000;
const MAX_PACK_BYTES = 16 * 1024 * 1024;

const id = z.string().min(1).max(200);
const pick = z.object({ syncId: id, layer: z.string().max(500) }).strict();
const diagnoseInput = z
  .object({
    sources: z.array(id).min(1).max(MAX_SOURCES),
    roles: z
      .object(
        Object.fromEntries(ROLE_KEYS.map((role) => [role, z.array(pick).max(8).optional()])) as {
          [K in (typeof ROLE_KEYS)[number]]: z.ZodOptional<z.ZodArray<typeof pick>>;
        },
      )
      .strict(),
    params: z
      .object({
        spanMax: z.number().positive().max(100).optional(),
        splitTol: z.number().min(0).max(5).optional(),
        columnSize: z.number().positive().max(5).optional(),
        capClearance: z.number().min(0).max(10).optional(),
        openCutRule: z.enum(['consult', 'forbid']).optional(),
        openCutSize: z.number().positive().max(20).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const paramValue = z.union([z.number(), z.string().max(200), z.boolean()]);
const paramChange = z
  .object({
    key: id,
    value: paramValue,
    unit: z.string().max(10).optional(),
    ref: z.string().max(200).optional(),
    note: z.string().max(500).optional(),
  })
  .strict();
const by = z.enum(['default', 'user', 'decision', 'fact', 'ai', 'rhino', 'sketch']);
const createInstance = z
  .object({
    jig: z.string().min(1).max(100),
    version: z.string().max(50).optional(),
    title: z.string().min(1).max(500),
    layerRoot: z.string().min(1).max(1000),
    params: z.array(paramChange).max(100).optional(),
    conversationId: id.optional(),
  })
  .strict();
const setParams = z
  .object({
    values: z.array(paramChange).min(1).max(100),
    by: by.optional(),
    reason: z.string().max(2000).optional(),
    requestId: id.optional(),
  })
  .strict();
const overridesInput = z
  .object({
    add: z.array(overrideSchema).max(200).optional(),
    remove: z.array(id).max(200).optional(),
  })
  .strict();
const zonesInput = z.object({ zones: z.record(z.string(), z.array(zoneSchema).max(200)) }).strict();
const readInput = readScopeSchema
  .extend({
    linkId: id.optional(),
    syncId: id.optional(),
    purpose: z.enum(['assembly', 'pre-bake']).optional(),
  })
  .strict();
const assemblyInput = z
  .object({
    sources: z
      .array(
        z
          .object({ readId: id, layers: z.array(z.string().min(1).max(1000)).min(1).max(200) })
          .strict(),
      )
      .min(1)
      .max(20),
    transform: transformSchema.optional(),
    confirm: z.boolean(),
    reason: z.string().max(500).optional(),
  })
  .strict();
const runInput = z
  .object({ until: id.optional(), mode: z.enum(['geometry', 'preview', 'confirmed']).optional() })
  .strict();
const bakeInput = z
  .object({
    bake: z.array(id).min(1).max(20),
    linkId: id.optional(),
    resolve: z.record(z.string().max(200), z.enum(['keep', 'overwrite', 'absorb'])).optional(),
  })
  .strict();
const pinInput = z
  .object({
    version: z.string().min(1).max(50),
    approvedCaps: z.array(z.string().max(40)).max(20).optional(),
    confirm: z.literal(true).optional(),
  })
  .strict();
const fileImport = z.object({
  filename: z.string(),
  fileHash: z.string().regex(/^[a-f0-9]{64}$/),
  verified: z.literal(true),
});

// One runtime per engine (keyed by its workspace); child processes and caches live in it.
const runtimes = new WeakMap<Workspace, JigRuntime>();
export function jigRuntimeFor(workspace: Workspace, dataDirectory: string): JigRuntime {
  let runtime = runtimes.get(workspace);
  if (!runtime) {
    const store = new JigStore(workspace.store.db);
    const devRoot = repositoryJigRoot();
    const registry = new JigRegistry({
      store,
      dataDir: dataDirectory,
      devRoots: devRoot ? [devRoot] : [],
    });
    runtime = new JigRuntime({ store, dataDir: dataDirectory, registry });
    runtimes.set(workspace, runtime);
  }
  return runtime;
}
/** Stop the runtime's child processes (tests, shutdown). */
export async function closeJigRuntime(workspace: Workspace) {
  const runtime = runtimes.get(workspace);
  runtimes.delete(workspace);
  await runtime?.close();
}

async function rawBody(request: IncomingMessage, max = MAX_PACK_BYTES): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > max) throw new DomainError('INPUT_TOO_LARGE');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Answer a jig route; false when the request is not one. */
export async function jigRoutes(
  url: URL,
  request: IncomingMessage,
  context: JigRouteContext,
): Promise<boolean> {
  const { workspace, body, send, remote = false } = context;
  const method = request.method ?? 'GET';
  const runtime = () => jigRuntimeFor(workspace, context.dataDirectory);
  const store = () => new JigStore(workspace.store.db);

  // --- registry, import, pin -------------------------------------------------------------------
  if (url.pathname === '/api/v1/jigs/packages' && method === 'GET') {
    send(200, { jigs: await runtime().registry.list() });
    return true;
  }
  if (url.pathname === '/api/v1/jigs/import' && method === 'POST') {
    if (remote) throw new DomainError('FORBIDDEN');
    if (url.searchParams.get('confirm') !== 'true') throw new DomainError('CONFIRMATION_REQUIRED');
    const bytes = await rawBody(request);
    const approved = url.searchParams.get('approvedCaps');
    try {
      const result = await importPack(bytes, {
        store: store(),
        dataDir: context.dataDirectory,
        ...(approved !== null ? { approvedCaps: approved.split(',').filter(Boolean) } : {}),
        onInstalled: (jigId, version) => runtime().registry.forget(jigId, version),
      });
      send(200, result);
    } catch (error) {
      if (error instanceof JigInvalidError) {
        send(422, { code: 'JIG_INVALID', issues: error.issues });
        return true;
      }
      throw error;
    }
    return true;
  }
  const pinRoute = /^\/api\/v1\/projects\/([^/]+)\/jigs\/([^/]+)\/pin$/.exec(url.pathname);
  if (pinRoute && method === 'POST') {
    if (remote) throw new DomainError('FORBIDDEN');
    const [, projectId, encoded] = pinRoute;
    const jigId = decodeURIComponent(encoded);
    const input = pinInput.parse(await body(request));
    if (!input.confirm) throw new DomainError('CONFIRMATION_REQUIRED');
    const jig = await runtime().registry.resolve(jigId, input.version);
    send(200, {
      pinned: store().pin(projectId, jig.id, jig.version),
      capabilities: jig.manifest.capabilities,
    });
    return true;
  }
  const projectJigs = /^\/api\/v1\/projects\/([^/]+)\/jigs$/.exec(url.pathname);
  if (projectJigs && method === 'GET') {
    send(200, { pinned: store().pinned(projectJigs[1]) });
    return true;
  }

  // --- instances ------------------------------------------------------------------------------
  const instances = /^\/api\/v1\/projects\/([^/]+)\/jig-instances(?:\/([^/]+)(?:\/(.+))?)?$/.exec(
    url.pathname,
  );
  if (instances) {
    const [, projectId, instanceId, rest] = instances;
    const rt = runtime();
    if (!instanceId) {
      if (method === 'GET') {
        send(200, { instances: rt.list(projectId) });
        return true;
      }
      if (method === 'POST') {
        const input = createInstance.parse(await body(request));
        const layerExists = (layerRoot: string) => {
          // The output layer must exist in a linked document; stored Sync layer tables are the evidence.
          const tables = workspace
            .list(projectId)
            .filter(
              (entry) =>
                entry.state === 'succeeded' &&
                Array.isArray((entry.result as { layers?: unknown })?.layers),
            )
            .map((entry) => (entry.result as { layers: { fullPath?: unknown }[] }).layers);
          if (!tables.length) return undefined;
          return tables.some((table) => table.some((layer) => layer.fullPath === layerRoot));
        };
        send(200, await rt.createInstance(projectId, input, { layerExists }));
        return true;
      }
      return false;
    }
    if (!rest) {
      if (method !== 'GET') return false;
      send(200, await rt.view(projectId, instanceId));
      return true;
    }
    if (rest === 'params' && method === 'PUT') {
      const input = setParams.parse(await body(request));
      send(
        200,
        await rt.setParams(projectId, instanceId, {
          values: input.values,
          by: input.by ?? 'user',
          reason: input.reason,
          requestId: input.requestId,
        }),
      );
      return true;
    }
    if (rest === 'params/undo' && method === 'POST') {
      const { seq } = z
        .object({ seq: z.number().int().positive() })
        .strict()
        .parse(await body(request));
      send(200, await rt.undo(projectId, instanceId, seq));
      return true;
    }
    if (rest === 'params/log' && method === 'GET') {
      send(200, { log: rt.paramLog(projectId, instanceId) });
      return true;
    }
    if (rest === 'overrides' && method === 'POST') {
      const input = overridesInput.parse(await body(request));
      send(200, { overrides: await rt.setOverrides(projectId, instanceId, input) });
      return true;
    }
    if (rest === 'zones' && method === 'PUT') {
      const input = zonesInput.parse(await body(request));
      const at = new Date().toISOString();
      const zones = Object.fromEntries(
        Object.entries(input.zones).map(([key, list]) => [
          key,
          list.map((zone) => ({
            ...zone,
            source: zone.source ?? { value: zone.id, by: 'user' as const, at },
          })),
        ]),
      );
      send(200, { zones: await rt.setZones(projectId, instanceId, zones) });
      return true;
    }
    if (rest === 'reads' && method === 'GET') {
      send(200, { reads: rt.reads(projectId, instanceId) });
      return true;
    }
    if (rest === 'reads' && method === 'POST') {
      const { purpose, linkId, syncId, ...scope } = readInput.parse(await body(request));
      const layers = scope.layers ?? [];
      const read = await readForJig(context, projectId, {
        linkId,
        syncId,
        layers,
        includeHidden: !!scope.includeHidden,
      });
      const record = rt.recordRead(projectId, instanceId, {
        linkId: read.linkId,
        revisionKey: read.revisionKey,
        layers,
        includeHidden: !!scope.includeHidden,
        purpose: purpose ?? 'assembly',
        model: read.model,
      });
      send(200, {
        readId: record.id,
        linkId: record.linkId,
        revisionKey: record.revisionKey,
        purpose: record.purpose,
        objectCount: record.objectCount,
        layers: record.layerTable,
        ref: record.ref,
        at: record.at,
      });
      return true;
    }
    if (rest === 'assembly/propose' && method === 'POST') {
      const { roles } = z
        .object({ roles: z.array(z.string().max(200)).max(50).optional() })
        .strict()
        .parse(await body(request));
      send(200, await rt.proposeAssembly(projectId, instanceId, roles));
      return true;
    }
    const assembly = /^assembly\/([^/]+)$/.exec(rest);
    if (assembly && method === 'PUT') {
      const input = assemblyInput.parse(await body(request));
      send(
        200,
        await rt.setAssembly(projectId, instanceId, decodeURIComponent(assembly[1]), {
          ...input,
          by: 'user',
        }),
      );
      return true;
    }
    if (rest === 'run' && method === 'POST') {
      const input = runInput.parse(await body(request));
      send(
        200,
        await rt.run(projectId, instanceId, { until: input.until, mode: input.mode ?? 'geometry' }),
      );
      return true;
    }
    const confirm = /^steps\/([^/]+)\/confirm$/.exec(rest);
    if (confirm && method === 'POST') {
      const { inputHash } = z
        .object({ inputHash: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(await body(request));
      send(200, await rt.confirmStep(projectId, instanceId, confirm[1], inputHash));
      return true;
    }
    const output = /^steps\/([^/]+)\/output$/.exec(rest);
    if (output && method === 'GET') {
      send(200, { stepId: output[1], output: rt.output(projectId, instanceId, output[1]) });
      return true;
    }
    // --- Rhino에 만들기 (SPEC-07.12, ARCH-03 §9.3) ---------------------------------------------
    const bakeContext: BakeContext = {
      runtime: rt,
      store: store(),
      read: (linkId) => readForJig(context, projectId, { linkId, layers: [], includeHidden: true }),
    };
    if (rest === 'bake' && method === 'POST') {
      const input = bakeInput.parse(await body(request));
      if (!context.execution || !context.links) throw new DomainError('EXECUTOR_NOT_READY');
      const prepared = await prepareBake(bakeContext, {
        projectId,
        instanceId,
        bakeIds: input.bake,
        linkId: input.linkId,
        resolve: input.resolve,
      });
      const plans = prepared.plans.map(({ decl, plan }) => ({
        bakeId: decl.id,
        template: decl.template,
        layer: `${prepared.view.body.layerRoot}::${decl.layer}`,
        added: plan.added,
        replaced: plan.replaced,
        dropped: plan.dropped,
        preserved: plan.preserved,
        kept: plan.kept,
        deleted: plan.deleted,
        copies: plan.copies,
        hiddenTargets: plan.hiddenTargets,
      }));
      const shared = {
        readId: prepared.readId,
        revisionKey: prepared.read.revisionKey,
        linkId: prepared.linkId,
        gates: prepared.gates,
        plans,
      };
      if (prepared.absorbed) {
        // Absorbed edits are overrides now; the results must be recomputed before they are made.
        send(200, { ...shared, status: 'absorbed', absorbed: prepared.absorbed });
        return true;
      }
      if (prepared.blocked.length || prepared.problems.length) {
        send(422, {
          ...shared,
          code: 'GATE_BLOCKED',
          blocked: prepared.blocked,
          problems: prepared.problems,
          hints: prepared.blocked.map((name) => bakeHints[name]).filter(Boolean),
        });
        return true;
      }
      const link = context.links.get(projectId, prepared.linkId);
      const basis = latestSyncOf(workspace, projectId, link);
      if (!basis) throw new DomainError('STALE_REFERENCE');
      const requestId = randomUUID();
      const submitted = workspace.submit(projectId, {
        id: requestId,
        body: `Rhino에 만들기 · ${prepared.jig.manifest.name} · ${prepared.plans
          .map(({ decl }) => decl.layer)
          .join(', ')}`,
        permission: 'candidate',
        provider: 'claude-cli',
        pins: [],
        sketches: [],
        files: [],
        host: 'rhino',
        baseRequestId: basis.id,
        hostUse: 'write',
        jig: {
          kind: 'jig-bake',
          instanceId,
          bakeIds: input.bake,
          linkId: prepared.linkId,
          readId: prepared.readId,
          runId: prepared.runId,
        },
      });
      const source = prepared.read.model.sourceDocument as { documentHash?: unknown } | undefined;
      registerBakeJob({
        requestId,
        instanceId,
        runId: prepared.runId,
        codes: prepared.codes,
        ...(typeof source?.documentHash === 'string'
          ? { expectedDocumentHash: source.documentHash }
          : {}),
        finish: async (result) =>
          finishBake({ store: store() }, prepared, requestId, result).result,
      });
      context.execution.start(submitted.request);
      send(200, {
        ...shared,
        status: 'submitted',
        requestId,
        runId: prepared.runId,
        chunks: prepared.codes.length,
        waiting: submitted.request.state === 'queued' ? submitted.request.result : undefined,
      });
      return true;
    }
    if (rest === 'bakes' && method === 'GET') {
      const view = await rt.view(projectId, instanceId);
      const jig = await rt.registry.resolve(view.jig.id, view.jig.version);
      send(200, {
        bakes: bakeRecords(store(), instanceId, jig, url.searchParams.get('linkId') ?? undefined),
      });
      return true;
    }
    const baseline = /^bakes\/([^/]+)\/baseline$/.exec(rest);
    if (baseline && method === 'POST') {
      send(200, await recordBaseline(bakeContext, projectId, instanceId, baseline[1]));
      return true;
    }
    return false;
  }

  // --- S-06 diagnosis (PLAN-23 T-044, temporary) ------------------------------------------------
  const route = /^\/api\/v1\/projects\/([^/]+)\/jigs\/structure\/(layers|diagnose)$/.exec(
    url.pathname,
  );
  if (!route) return false;
  const [, projectId, action] = route;
  // One stored Sync with its display geometry; a Sync that is not finished cannot be read.
  const results = new Map<string, Record<string, unknown>>();
  const syncResult = (syncId: string) => {
    const known = results.get(syncId);
    if (known) return known;
    const saved = workspace.get(projectId, syncId);
    if (saved.state !== 'succeeded' || !saved.result || !Array.isArray(saved.result.scene))
      throw new DomainError('STALE_REFERENCE');
    const result = saved.result as Record<string, unknown>;
    results.set(syncId, result);
    return result;
  };

  if (action === 'layers' && method === 'GET') {
    const ids = [...new Set((url.searchParams.get('syncIds') ?? '').split(',').filter(Boolean))];
    if (!ids.length || ids.length > MAX_SOURCES) throw new DomainError('INVALID_INPUT');
    const sources = ids.map((syncId) => {
      const result = syncResult(syncId);
      return { syncId, document: documentName(result), layers: syncLayers(result) };
    });
    send(200, { sources, guess: guessRoles(sources) });
    return true;
  }
  if (action === 'diagnose' && method === 'POST') {
    const input = diagnoseInput.parse(await body(request));
    const inputs: DiagnoseInputs = { definitions: {} };
    let objects = 0;
    for (const role of ROLE_KEYS) {
      const picks = input.roles[role];
      if (!picks) continue;
      const rows: NonNullable<DiagnoseInputs[typeof role]> = [];
      for (const syncId of new Set(picks.map((p) => p.syncId))) {
        if (!input.sources.includes(syncId)) throw new DomainError('INVALID_INPUT');
        const layers = picks.filter((p) => p.syncId === syncId).map((p) => p.layer);
        const read = roleRows(syncResult(syncId), syncId, layers);
        rows.push(...read.rows);
        inputs.definitions![syncId] = { ...inputs.definitions![syncId], ...read.definitions };
      }
      objects += rows.length;
      if (objects > MAX_OBJECTS) throw new DomainError('INPUT_TOO_LARGE');
      inputs[role] = rows;
    }
    const start = performance.now();
    const output = diagnose(inputs, input.params);
    send(200, {
      ...output,
      ms: Math.round(performance.now() - start),
      sources: input.sources.map((syncId) => ({
        syncId,
        document: documentName(syncResult(syncId)),
      })),
    });
    return true;
  }
  return false;
}

/**
 * The newest finished Sync of a linked document (the display Sync of an open document, or the
 * import of a file opened in VIDE): the bake's basis. Never a candidate — a candidate's work copy
 * is an older state of the document, and the bake must start from the document as it is now.
 */
function latestSyncOf(workspace: Workspace, projectId: string, link: DocumentLink) {
  return workspace
    .list(projectId)
    .filter((entry) => {
      if (entry.state !== 'succeeded' || !entry.result?.hostExecuted) return false;
      if ((entry.result.host ?? 'rhino') !== 'rhino') return false;
      if (entry.result.displayOnly !== true && entry.input.source !== 'file') return false;
      if (entry.input.linkId === link.id) return true;
      const source = entry.result.sourceDocument as
        | { instance?: unknown; documentId?: unknown }
        | undefined;
      return source?.instance === link.instance && source.documentId === link.documentId;
    })
    .at(-1);
}

/**
 * A jig input read (ARCH-03 §8): only the named layers. A linked Rhino document is read from the
 * host (attached) or its work copy (file opened in VIDE); a ZWCAD link, a `syncId`, or an engine
 * without host access filters the stored display Sync on the server. Nothing here touches the
 * Live Sync basis, the viewport or the request history.
 */
async function readForJig(
  context: JigRouteContext,
  projectId: string,
  input: { linkId?: string; syncId?: string; layers: string[]; includeHidden: boolean },
): Promise<{ linkId: string; revisionKey: string; model: ReadModel }> {
  const { workspace, links, sdk } = context;
  const fromSync = (syncId: string, linkId: string) => {
    const saved = workspace.get(projectId, syncId);
    if (saved.state !== 'succeeded' || !saved.result || !Array.isArray(saved.result.scene))
      throw new DomainError('STALE_REFERENCE');
    const result = saved.result as ReadModel;
    const source = (result.sourceDocument ?? {}) as Record<string, unknown>;
    // No layer named: the whole stored model (a bake's forced read).
    const picked = rowsOfLayers(
      result,
      input.layers.length ? input.layers : layersOf(result).map((layer) => layer.fullPath),
    );
    const model: ReadModel = {
      scene: picked.rows,
      definitions: picked.definitions,
      sourceDocument: source,
      ...(Array.isArray(result.layers) ? { layers: result.layers } : {}),
      origin: { syncId },
    };
    return {
      linkId,
      revisionKey: `${String(source.instance ?? '')}|${String(source.documentId ?? '')}|${String(source.revision ?? source.documentHash ?? '')}`,
      model,
    };
  };
  if (input.syncId) return fromSync(input.syncId, input.linkId ?? `sync:${input.syncId}`);
  if (!input.linkId || !links) throw new DomainError('INVALID_INPUT');
  const link = links.get(projectId, input.linkId);
  const scope = {
    ...(input.layers.length ? { layers: input.layers } : {}),
    ...(input.includeHidden ? { includeHidden: true } : {}),
  };
  if (link.host === 'rhino' && sdk) {
    if (isFileLink(link)) {
      const latest = workspace
        .list(projectId, { full: true })
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
      return {
        linkId: link.id,
        revisionKey: `${link.instance}|${link.documentId}|${copy.data.fileHash}`,
        model: model as unknown as ReadModel,
      };
    }
    const read = await sdk.readLayers(
      { instance: link.instance, documentId: link.documentId },
      scope,
    );
    return {
      linkId: link.id,
      revisionKey: `${link.instance}|${link.documentId}|${read.sourceDocument.revision ?? ''}`,
      model: read as unknown as ReadModel,
    };
  }
  // ZWCAD (or no host access): the newest stored Sync of the link, filtered here.
  const latest = workspace
    .list(projectId)
    .filter((entry) => entry.state === 'succeeded' && entry.input.linkId === link.id)
    .at(-1);
  if (!latest) throw new DomainError('STALE_REFERENCE');
  return fromSync(latest.id, link.id);
}
