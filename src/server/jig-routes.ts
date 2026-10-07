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
import { documentHolder } from '../contracts/request-scope.ts';
import { readScopeSchema } from '../contracts/native-model.ts';
import type { SdkExecution } from './sdk-execution.ts';
import type { Execution } from './execution.ts';
import { JigRegistry, JigInvalidError, repositoryJigRoot } from '../jigs/runtime/loader.ts';
import { importPack } from '../jigs/runtime/pack.ts';
import { forkable } from '../jigs/runtime/drafts.ts';
import {
  JigRuntime,
  layersOf,
  rowsOfLayers,
  type ReadModel,
  type RuntimeOptions,
} from '../jigs/runtime/runtime.ts';
import {
  bakeOffers,
  bakeRecords,
  finishBake,
  prepareBake,
  recordBaseline,
  registerBakeJob,
  runDirectBake,
  undoBake,
  type BakeContext,
  type DirectHost,
} from '../jigs/bake/bake.ts';
import { overrideSchema, transformSchema, zoneSchema } from '../jigs/runtime/instance.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseReportTemplate,
  resolveReport,
  type ReportContext,
  type ReportModel,
} from '../jigs/runtime/report-format.ts';
import { jigReportInputs, renderJigReport, type JigReportLedgerRow } from './report.ts';
import { ConversationStore } from '../core/conversation-store.ts';
import { isItemList } from '../core/model-store.ts';
import { skillCatalog } from './skill-catalog.ts';
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
  /** Starts the work-copy bake request (only when no attached editor can run it directly). */
  execution?: Pick<Execution, 'start'> & Partial<Pick<Execution, 'resume'>>;
  /**
   * The attached editor's `direct-execute` / `direct-undo` / `fingerprint` (바로 적용). Omitted, the
   * routes use `sdk.directExecute` / `sdk.directUndo` / `sdk.fingerprint` when the engine has them.
   */
  direct?: DirectHost;
}

/** HTTP statuses of the jig error codes (ARCH-03 §7); server.ts merges them into its table. */
export const jigStatuses: Record<string, number> = {
  JIG_INVALID: 422,
  JIG_SIGNATURE: 422,
  JIG_SELFTEST_FAILED: 422,
  JIG_LIBRARY_UNKNOWN: 422,
  JIG_VERSION_EXISTS: 409,
  JIG_NOT_FORKABLE: 422,
  JIG_VERSION_NOT_NEWER: 409,
  JIG_DIGEST_MISMATCH: 409,
  JIG_PACK_FAILED: 500,
  PARAM_FIXED: 422,
  OUT_OF_RANGE: 422,
  UNIT_MISMATCH: 422,
  GATE_BLOCKED: 422,
  LAYER_ROOT_MISSING: 422,
  LAYER_PATH_INVALID: 422,
  CONFIRMATION_REQUIRED: 422,
  STALE_INPUT: 409,
  BAKE_NOT_COMPUTED: 422,
  BAKE_JOB_MISSING: 409,
  NOT_APPLIED: 409,
  BAKE_GUARDED: 409,
  BAKE_FAILED: 422,
  BAKE_READ_FAILED: 409,
  BAKE_UNDO_UNAVAILABLE: 409,
  BAKE_UNDO_NOT_LATEST: 409,
  BAKE_UNDO_FAILED: 409,
};
/** What the person can do about a blocked before-bake gate (Design SCR-13 결과 서랍). */
const bakeHints: Record<string, string> = {
  'hidden-target': 'Rhino에서 레이어를 켠 뒤 다시 누르세요',
  'layer-scope': '출력 레이어 밖에는 만들지 않습니다',
  'bake-args-safe': '키·부호 문자에 허용되지 않는 글자가 있습니다',
  'analysis-confirmed': '해석을 확정한 뒤 만드세요',
  'target-confirmed': '대상 필지를 확정한 뒤 만드세요',
};

// A diagnosis has no cap on the Syncs, layers or objects it reads (ADR-031 7).
const MAX_PACK_BYTES = 16 * 1024 * 1024;

const id = z.string().min(1).max(200);
const pick = z.object({ syncId: id, layer: z.string().max(500) }).strict();
const diagnoseInput = z
  .object({
    sources: z.array(id).min(1),
    roles: z
      .object(
        Object.fromEntries(ROLE_KEYS.map((role) => [role, z.array(pick).optional()])) as {
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
    layerRoot: z.string().min(1).max(1000).optional(),
    params: z.array(paramChange).optional(),
    conversationId: id.optional(),
    /**
     * Opened from a request (startSkill, ADR-026): no output layer yet. Computing works; Rhino에
     * 만들기 stops with LAYER_ROOT_MISSING and asks for the layer then (`PUT …/layer-root`).
     */
    layerRootLater: z.literal(true).optional(),
  })
  .strict()
  .refine((input) => !!input.layerRoot !== !!input.layerRootLater);
const setParams = z
  .object({
    values: z.array(paramChange).min(1),
    by: by.optional(),
    reason: z.string().max(2000).optional(),
    requestId: id.optional(),
  })
  .strict();
const overridesInput = z
  .object({
    add: z.array(overrideSchema).optional(),
    remove: z.array(id).optional(),
  })
  .strict();
const zonesInput = z.object({ zones: z.record(z.string(), z.array(zoneSchema)) }).strict();
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
      .array(z.object({ readId: id, layers: z.array(z.string().min(1).max(1000)).min(1) }).strict())
      .min(1),
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
type JigOutputProvider = NonNullable<RuntimeOptions['jigOutput']>;
// Producers of `jig-output` inputs per engine, by `<jig>#<output>` (the legal jig's
// `legal.constraints`, PLAN-46 T-220); registered by the server, read when a step runs.
const outputProviders = new WeakMap<Workspace, Map<string, JigOutputProvider>>();
export function provideJigOutput(
  workspace: Workspace,
  from: { jig: string; output: string },
  provider: JigOutputProvider,
) {
  let providers = outputProviders.get(workspace);
  if (!providers) outputProviders.set(workspace, (providers = new Map()));
  providers.set(`${from.jig}#${from.output}`, provider);
}
export function jigRuntimeFor(workspace: Workspace, dataDirectory: string): JigRuntime {
  let runtime = runtimes.get(workspace);
  if (!runtime) {
    const store = new JigStore(workspace.store);
    const devRoot = repositoryJigRoot();
    const registry = new JigRegistry({
      store,
      dataDir: dataDirectory,
      devRoots: devRoot ? [devRoot] : [],
    });
    runtime = new JigRuntime({
      store,
      dataDir: dataDirectory,
      registry,
      jigOutput: async (projectId, from) =>
        outputProviders.get(workspace)?.get(`${from.jig}#${from.output}`)?.(projectId, from),
    });
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
  const store = () => new JigStore(workspace.store);

  // --- registry, import, pin -------------------------------------------------------------------
  if (url.pathname === '/api/v1/jigs/packages' && method === 'GET') {
    // `forkable`: whether [수정하기] can copy the tool (its steps import nothing outside it; T-101).
    const jigs = (await runtime().registry.list()).map((entry) =>
      entry.kind === 'tool' && entry.path && !entry.corrupt
        ? { ...entry, forkable: forkable(entry.path) }
        : entry,
    );
    send(200, { jigs });
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
  // [삭제] on the jig list (T2 confirmed there): the jig leaves this project's list. The installed
  // package and the project's instances stay; instances keep their pinned version.
  if (pinRoute && method === 'DELETE') {
    if (remote) throw new DomainError('FORBIDDEN');
    const [, projectId, encoded] = pinRoute;
    const jigId = decodeURIComponent(encoded);
    if (!store().unpin(projectId, jigId)) throw new DomainError('NOT_FOUND');
    send(200, { removed: jigId, pinned: store().pinned(projectId) });
    return true;
  }
  // The skill catalog (RESEARCH-12 §6.3): what a request may open, this project's jigs first.
  const skills = /^\/api\/v1\/projects\/([^/]+)\/skills$/.exec(url.pathname);
  if (skills && method === 'GET') {
    workspace.store.project(skills[1]);
    send(200, { skills: await skillCatalog(workspace, context.dataDirectory, skills[1]) });
    return true;
  }
  const projectJigs = /^\/api\/v1\/projects\/([^/]+)\/jigs$/.exec(url.pathname);
  if (projectJigs && method === 'GET') {
    send(200, { pinned: store().pinned(projectJigs[1]) });
    return true;
  }

  // The report tab's list: every instance of the project with its jig's report frames.
  const projectReports = /^\/api\/v1\/projects\/([^/]+)\/jig-reports$/.exec(url.pathname);
  if (projectReports && method === 'GET') {
    const rt = runtime();
    const out = [];
    for (const row of rt.list(projectReports[1])) {
      const frames = await rt.registry
        .resolve(row.jigId, row.version)
        .then(reportFrames)
        .catch(() => []);
      if (frames.length) out.push({ instance: row, reports: frames });
    }
    send(200, { instances: out });
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
        const { layerRootLater: _later, ...input } = createInstance.parse(await body(request));
        send(
          200,
          await rt.createInstance(
            projectId,
            { ...input, layerRoot: input.layerRoot ?? '' },
            { layerRootLater: !input.layerRoot },
          ),
        );
        return true;
      }
      return false;
    }
    // The output layer of an instance opened without one (asked at Rhino에 만들기, ADR-026).
    if (rest === 'layer-root' && method === 'PUT') {
      const { layerRoot } = z
        .object({ layerRoot: z.string().trim().min(1).max(1000) })
        .strict()
        .parse(await body(request));
      send(200, await rt.setLayerRoot(projectId, instanceId, layerRoot));
      return true;
    }
    if (!rest) {
      if (method !== 'GET') return false;
      send(200, await rt.view(projectId, instanceId));
      return true;
    }
    // [올리기] (SPEC-07.4, PLAN-26 T-101): the instance moves to its project's pinned version.
    if (rest === 'upgrade' && method === 'POST') {
      send(200, await rt.upgrade(projectId, instanceId));
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
    // 앞 jig의 결과 (`jig-output` 입력, SPEC-07.2·07.5 6, ARCH-03 §8.5): which earlier instance it
    // reads, the candidates, and '다시 계산 필요' when that result moved since the last run.
    const jigOutput = /^jig-outputs\/([^/]+)$/.exec(rest);
    if (jigOutput && method === 'GET') {
      send(200, await rt.jigOutputState(projectId, instanceId, decodeURIComponent(jigOutput[1])));
      return true;
    }
    if (jigOutput && method === 'PUT') {
      const { instanceId: sourceId } = z
        .object({ instanceId: id.nullable() })
        .strict()
        .parse(await body(request));
      send(
        200,
        await rt.bindJigOutput(projectId, instanceId, decodeURIComponent(jigOutput[1]), sourceId),
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
    // --- 보고서 (SPEC-07.11, ARCH-03 §5.2, PLAN-22 T-057) -----------------------------------
    if (rest === 'reports' && method === 'GET') {
      const view = await rt.view(projectId, instanceId);
      send(200, {
        reports: reportFrames(await rt.registry.resolve(view.jig.id, view.jig.version)),
      });
      return true;
    }
    const reportRoute = /^reports\/([^/]+)$/.exec(rest);
    if (reportRoute && method === 'GET') {
      send(
        200,
        await instanceReport(
          rt,
          workspace,
          projectId,
          instanceId,
          decodeURIComponent(reportRoute[1]),
        ),
      );
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
      if (!context.links) throw new DomainError('EXECUTOR_NOT_READY');
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
        respected: plan.respected,
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
      const direct = directOf(context);
      if (direct && link.host === 'rhino' && !isFileLink(link)) {
        // 바로 적용: the open document, one host undo record per body, baseline read right after.
        const target = { instance: link.instance, documentId: link.documentId };
        // One writer per document (SPEC-02.9 3, ADR-027 5): another request writing it refuses the
        // bake at once (an unresolved result there does not, T-102); while it runs it holds it.
        const held = documentHolder(
          '',
          { host: 'rhino', ...target },
          workspace.claimRows(projectId),
        );
        if (held) {
          send(jigStatuses.BAKE_FAILED, {
            ...shared,
            code: 'BAKE_FAILED',
            reason: held.code,
            refused:
              '다른 작업이 이 문서를 고치는 중이라 만들지 않았습니다. 그 작업이 끝난 뒤 다시 누르세요.',
          });
          return true;
        }
        const release = workspace.holdWrite(projectId, { host: 'rhino', ...target });
        let made: Awaited<ReturnType<typeof runDirectBake>>;
        try {
          made = await runDirectBake({ ...bakeContext, direct }, prepared, target);
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          if (typeof code !== 'string' || !code.startsWith('BAKE_')) throw error;
          // Undone already (guard, failure): the card says what happened; nothing stays changed.
          const { guarded, reason, refused, undoFailed } = error as Record<string, unknown>;
          send(jigStatuses[code] ?? 409, {
            ...shared,
            code,
            ...(guarded ? { guarded } : {}),
            ...(reason ? { reason } : {}),
            // Refused before execution (read-only, busy): the reason and next step in Korean.
            ...(refused ? { refused } : {}),
            ...(undoFailed ? { undoFailed } : {}),
          });
          return true;
        } finally {
          release();
          // Requests that waited for the document go on.
          context.execution?.resume?.(projectId);
        }
        send(200, {
          ...shared,
          ...made.result,
          status: 'applied',
          runId: prepared.runId,
          chunks: prepared.codes.length,
        });
        return true;
      }
      // No attached editor: the internal work copy (the original file is not changed).
      if (!context.execution) throw new DomainError('EXECUTOR_NOT_READY');
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
        notice: '파일을 Rhino에서 열어 연결하세요',
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
        offers: bakeOffers(jig),
        stale: !!view.body.bakeStale,
      });
      return true;
    }
    const baseline = /^bakes\/([^/]+)\/baseline$/.exec(rest);
    if (baseline && method === 'POST') {
      send(200, await recordBaseline(bakeContext, projectId, instanceId, baseline[1]));
      return true;
    }
    const undo = /^bakes\/([^/]+)\/undo$/.exec(rest);
    if (undo && method === 'POST') {
      const direct = directOf(context);
      if (!direct) throw new DomainError('BAKE_UNDO_UNAVAILABLE');
      send(200, await undoBake({ store: store(), direct }, instanceId, undo[1]));
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
  // One stored Sync read lazily (T-129): layer lists decode no coordinates, a role decodes only
  // its layers' rows. A Sync that is not finished cannot be read.
  const results = new Map<string, Record<string, unknown>>();
  const syncResult = (syncId: string) => {
    const known = results.get(syncId);
    if (known) return known;
    const saved = workspace.lazy(projectId, syncId);
    if (saved.state !== 'succeeded' || !saved.result || !isItemList(saved.result.scene))
      throw new DomainError('STALE_REFERENCE');
    const result = saved.result as Record<string, unknown>;
    results.set(syncId, result);
    return result;
  };

  if (action === 'layers' && method === 'GET') {
    const ids = [...new Set((url.searchParams.get('syncIds') ?? '').split(',').filter(Boolean))];
    if (!ids.length) throw new DomainError('INVALID_INPUT');
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
    // One read per Sync of every picked layer (T-129), then each role takes its layers' rows in
    // scene order with the definitions they use: equal to `roleRows` per role and Sync.
    const picked = new Map<string, ReturnType<typeof roleRows>>();
    const readSync = (syncId: string) => {
      let read = picked.get(syncId);
      if (!read) {
        const layers = ROLE_KEYS.flatMap((role) =>
          (input.roles[role] ?? []).filter((p) => p.syncId === syncId).map((p) => p.layer),
        );
        picked.set(syncId, (read = roleRows(syncResult(syncId), syncId, layers)));
      }
      return read;
    };
    for (const role of ROLE_KEYS) {
      const picks = input.roles[role];
      if (!picks) continue;
      const rows: NonNullable<DiagnoseInputs[typeof role]> = [];
      for (const syncId of new Set(picks.map((p) => p.syncId))) {
        if (!input.sources.includes(syncId)) throw new DomainError('INVALID_INPUT');
        const layers = new Set(picks.filter((p) => p.syncId === syncId).map((p) => p.layer));
        const read = readSync(syncId);
        const definitions: typeof read.definitions = {};
        for (const row of read.rows) {
          if (!layers.has(row.layer)) continue;
          rows.push({ ...row });
          const name = row.block?.definition;
          if (name && read.definitions[name]) definitions[name] = read.definitions[name];
        }
        inputs.definitions![syncId] = { ...inputs.definitions![syncId], ...definitions };
      }
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

/** The attached editor's direct commands: the context's own, else the engine's SDK methods. */
function directOf(context: JigRouteContext): DirectHost | undefined {
  if (context.direct) return context.direct;
  const sdk = context.sdk as
    | (Record<string, unknown> & {
        directExecute?: DirectHost['execute'];
        directUndo?: DirectHost['undo'];
        // SdkExecution's names (sdk-execution.ts): runDirect(target, code, guard, {requestId, label}).
        runDirect?: (
          target: Parameters<DirectHost['execute']>[0],
          code: string,
          guard: Parameters<DirectHost['execute']>[1]['guard'],
          meta: { requestId: string; label: string },
        ) => ReturnType<DirectHost['execute']>;
        undoDirect?: DirectHost['undo'];
        fingerprint?: DirectHost['fingerprint'];
      })
    | undefined;
  const execute: DirectHost['execute'] | undefined =
    typeof sdk?.directExecute === 'function'
      ? (target, command) => sdk.directExecute!.call(sdk, target, command)
      : typeof sdk?.runDirect === 'function'
        ? (target, { code, guard, requestId, label }) =>
            sdk.runDirect!.call(sdk, target, code, guard, { requestId, label })
        : undefined;
  const undo = sdk?.directUndo ?? sdk?.undoDirect;
  if (!sdk || !execute || typeof undo !== 'function') return undefined;
  return {
    execute,
    undo: (target, undoId) => undo.call(sdk, target, undoId),
    ...(typeof sdk.fingerprint === 'function'
      ? { fingerprint: (target) => sdk.fingerprint!.call(sdk, target) }
      : {}),
  };
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
  // The stored Sync read lazily (T-129): only the picked layers' rows are decoded.
  const fromSync = (syncId: string, linkId: string) => {
    const saved = workspace.lazy(projectId, syncId);
    if (saved.state !== 'succeeded' || !saved.result || !isItemList(saved.result.scene))
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

// --- jig reports (SPEC-07.11, ARCH-03 §5.2, PLAN-22 T-057) ---------------------------------------
// A jig's report frames are its manifest `reports`, else every `reports/*.json` of the package.
// A report reads the kept output of every step that has one; a step whose output says it is a
// preview (`mode: 'preview'`, or an analysis summary not confirmed) is marked, never written as
// final. Blocks whose step has no output yet are left out; the section's claim says '아직 없음'.

type LoadedJigOf = Awaited<ReturnType<JigRegistry['resolve']>>;
export interface ReportFrameInfo {
  id: string;
  title: string;
  file: string;
}
export function reportFrames(jig: Pick<LoadedJigOf, 'manifest' | 'files'>): ReportFrameInfo[] {
  if (jig.manifest.reports?.length) return jig.manifest.reports.map((r) => ({ ...r }));
  return jig.files
    .filter((file) => /^reports\/[a-z0-9][a-z0-9-]*\.json$/.test(file))
    .map((file) => {
      const id = file.slice('reports/'.length, -'.json'.length);
      return { id, title: id, file };
    });
}
/** Whether a kept step output is final (false for previews and unconfirmed analyses). */
export function outputIsFinal(output: unknown): boolean {
  if (!output || typeof output !== 'object') return true;
  const value = output as {
    mode?: unknown;
    previewOnly?: unknown;
    summary?: { confirmed?: unknown };
  };
  if (value.mode === 'preview' || value.previewOnly === true) return false;
  if (value.summary && typeof value.summary === 'object' && value.summary.confirmed === false)
    return false;
  return true;
}
/** Leave out blocks that have nothing to show (their step has not run yet). */
export function withoutEmptyBlocks(model: ReportModel): ReportModel {
  return {
    ...model,
    sections: model.sections.map((section) => ({
      ...section,
      blocks: section.blocks.filter((block) =>
        block.kind === 'list' ? block.items.length > 0 : block.rows.length > 0,
      ),
    })),
  };
}
async function instanceReport(
  rt: JigRuntime,
  workspace: Workspace,
  projectId: string,
  instanceId: string,
  reportId: string,
) {
  const view = await rt.view(projectId, instanceId);
  const jig = await rt.registry.resolve(view.jig.id, view.jig.version);
  const frame = reportFrames(jig).find((r) => r.id === reportId);
  if (!frame) throw new DomainError('NOT_FOUND');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(jig.dir, ...frame.file.split('/')), 'utf8'));
  } catch {
    throw new DomainError('NOT_FOUND');
  }
  const parsed = parseReportTemplate(raw);
  if (!parsed.template)
    throw new JigInvalidError(
      parsed.issues.map((issue) => ({ level: 'error' as const, code: 'JIG_SCHEMA', ...issue })),
    );
  const outputs: Record<string, unknown> = {};
  const final: Record<string, boolean> = {};
  for (const step of view.steps) {
    if (!step.hasOutput) continue;
    try {
      outputs[step.id] = rt.output(projectId, instanceId, step.id);
      // A stale or re-confirm result is shown as it was, never as final.
      final[step.id] =
        outputIsFinal(outputs[step.id]) && (step.status === 'done' || step.status === 'confirmed');
    } catch {
      /* An output that went missing reads as not yet computed. */
    }
  }
  const reads = rt.reads(projectId, instanceId);
  // Question cards and answers of the conversations bound to this instance (the open items).
  const conversations = new ConversationStore(workspace.store);
  const ledger: JigReportLedgerRow[] = conversations
    .list(projectId)
    .filter((c) => c.jigInstanceId === instanceId)
    .flatMap((c) => conversations.ledger(c.id, { current: true }));
  const context: ReportContext = {
    outputs,
    params: Object.fromEntries(view.params.map((p) => [p.key, p.value])),
    inputs: jigReportInputs({ params: view.params, ledger, outputs, final }),
    final,
    source: {
      ...(reads.length ? { readAt: reads[reads.length - 1].at } : {}),
      params: {
        total: view.params.length,
        grounded: view.params.filter((p) => p.by !== 'default').length,
      },
    },
  };
  const model = withoutEmptyBlocks(resolveReport(parsed.template, context));
  const at = new Date().toISOString();
  const origin = {
    project: workspace.store.project(projectId).name,
    instance: view.title,
    version: `${view.jig.name} ${view.jig.version}`,
    at,
  };
  // A frame that says when it may be exported (SPEC-12.13 4) gives no page while it may not.
  const html = model.exportRefused?.length ? '' : renderJigReport(model, origin);
  return {
    report: { ...frame, title: frame.title === frame.id ? model.title : frame.title },
    instance: { id: view.id, title: view.title, jig: view.jig },
    origin,
    /** The resolved report: the app draws it with the kit parts (the page CSP forbids inline styles). */
    model,
    /** The exported page: self-contained, no scripts. */
    html,
  };
}
