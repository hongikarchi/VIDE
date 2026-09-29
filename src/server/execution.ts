import {
  CONTEXT_LIMIT,
  selectContext,
  type ContextCandidate,
  type ContextChoice,
} from '../ai/context-selector.ts';
import { isDwgSdkEditMode } from '../contracts/dwg-edit-mode.ts';
import type { AccountProfiles } from '../ai/account-profiles.ts';
import { executionLimits } from '../contracts/execution-limits.ts';
import { modelContext } from './model-context.ts';
import { CLAUDE_MODELS, claudeEfforts, modelName } from './model-capabilities.ts';
import { requestConflict } from '../contracts/request-scope.ts';
import { z } from 'zod';
import { runLinked } from './linked-execution.ts';
import type { AgentTools } from './agent-tools.ts';
import type { Workspace } from '../core/workspace.ts';
import type { StoredWork } from '../contracts/stored-work.ts';
import type { RequestInput } from '../contracts/workspace.ts';
import type { CliOptions, ProviderContext, Progress, ProviderStatus } from '../ai/claude-cli.ts';
import type { GeometryObject } from '../core/geometry.ts';
import type { SdkExecution } from './sdk-execution.ts';
import type { ZwcadSdkExecution } from './zwcad-sdk-execution.ts';
import { workspaceResultSchema } from '../contracts/workspace-result.ts';
interface Provider {
  run(
    context: ProviderContext,
    options: { signal: AbortSignal; onProgress: (event: Progress) => void },
  ): Promise<{ text: string; [key: string]: unknown }>;
  status(): Promise<ProviderStatus>;
}
interface Host {
  build(
    projectId: string,
    id: string,
    objects: GeometryObject[],
    previous?: Record<string, unknown>,
  ): Promise<unknown>;
}
interface Options {
  applyAttached?: (
    request: StoredWork,
    result: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<unknown>;
  profiles?: AccountProfiles;
  tools?: AgentTools;
  providerFactory?: (options: CliOptions & { provider: string }) => Provider;
  host?: Host;
  hosts?: Partial<Record<'rhino' | 'zwcad', Host>>;
  settings?: { get: () => { paths: Partial<Record<string, string | null>> } };
  sdk?: SdkExecution;
  zwcadSdk?: ZwcadSdkExecution;
  /** A request stopped on its account's subscription limit (so the next one can switch). */
  onProviderLimit?: (provider: string, accountProfileId: string) => void;
  /** Start/end, duration and failure code of every run (diagnostic log). */
  diagnostics?: Diagnostics;
  /** Which earlier exchanges go with a request (Jev when a key is set; else the last six). */
  selectContext?: (body: string, candidates: ContextCandidate[]) => Promise<ContextChoice>;
}
/**
 * Jig review gate (RESEARCH-05 standard gates): an AI review of a Sync jig table may cite only the
 * table's rows. Unknown row ids are reported with the answer instead of being passed silently.
 */
function jigCheck(input: Record<string, unknown>, text: string) {
  const jig = z
    .object({ kind: z.literal('sync-review'), rows: z.array(z.string()).max(20000) })
    .safeParse(input.jig);
  if (!jig.success) return {};
  const known = new Set(jig.data.rows);
  const cited = [...new Set(text.match(/\bR\d+\b/g) ?? [])];
  const unknown = cited.filter((row) => !known.has(row));
  return {
    jigCheck: { gate: 'ref-whitelist', cited: cited.length, unknown },
    ...(unknown.length
      ? {
          text:
            text +
            `\n\n⚠ 검증: 표에 없는 행 ${unknown.join(', ')}을(를) 인용했습니다. 해당 부분은 근거가 없는 내용이니 확인하세요.`,
        }
      : {}),
  };
}
const pinsSchema = z.array(
  z
    .object({
      id: z.string(),
      basis: z.string(),
      role: z.enum(['target', 'preserve', 'reference']),
    })
    .passthrough(),
);
const executionResultSchema = workspaceResultSchema.extend({
  referenceOnly: z.boolean().optional(),
});
const errorSchema = z
  .object({ code: z.string().optional(), intent: z.record(z.string(), z.unknown()).optional() })
  .passthrough();
const errorData = (cause: unknown) => errorSchema.safeParse(cause).data ?? {};

import { installedCodex } from '../ai/paths.ts';
import { createProvider } from '../ai/providers.ts';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { geometryContract, interpret, protectGeometry } from '../core/geometry.ts';
import { Diagnostics } from './diagnostics.ts';

export class Execution {
  workspace: Workspace;
  applyAttached?: Options['applyAttached'];
  onProviderLimit?: Options['onProviderLimit'];
  profiles?: AccountProfiles;
  providerFactory: NonNullable<Options['providerFactory']>;
  host?: Host;
  hosts: Partial<Record<'rhino' | 'zwcad', Host>>;
  settings?: Options['settings'];
  sdk?: SdkExecution;
  zwcadSdk?: ZwcadSdkExecution;
  tools?: AgentTools;
  diagnostics?: Diagnostics;
  selectContext: NonNullable<Options['selectContext']>;
  active = new Map<
    string,
    { controller: AbortController; completion: Promise<void>; projectId: string }
  >();
  constructor(
    workspace: Workspace,
    {
      providerFactory = createProvider,
      host,
      hosts,
      settings,
      sdk,
      zwcadSdk,
      tools,
      profiles,
      applyAttached,
      onProviderLimit,
      diagnostics,
      selectContext: choose = (body, candidates) =>
        selectContext(body, candidates, { key: () => '' }),
    }: Options = {},
  ) {
    this.workspace = workspace;
    this.onProviderLimit = onProviderLimit;
    this.applyAttached = applyAttached;
    this.profiles = profiles;
    this.providerFactory = providerFactory;
    this.host = host;
    this.active = new Map();
    this.hosts = hosts || { rhino: host };
    this.settings = settings;
    this.sdk = sdk;
    this.zwcadSdk = zwcadSdk;
    this.tools = tools;
    this.diagnostics = diagnostics;
    this.selectContext = choose;
  }
  executable(provider: string) {
    return (
      this.settings?.get().paths[provider] ||
      (provider === 'claude-cli'
        ? process.env.VIDE_CLAUDE_PATH || join(homedir(), '.local', 'bin', 'claude.exe')
        : process.env.VIDE_CODEX_PATH || installedCodex())
    );
  }
  provider(
    input: Pick<
      RequestInput,
      'provider' | 'model' | 'effort' | 'accountProfileId' | 'executionLimits'
    >,
    agent?: unknown,
  ) {
    const executable = this.executable(input.provider);
    return this.providerFactory({
      provider: input.provider,
      executable,
      configDirectory:
        input.provider !== 'extension'
          ? this.profiles?.directory(
              input.provider,
              input.accountProfileId ?? this.profiles.list().active[input.provider],
            )
          : undefined,
      timeoutMs: executionLimits(input).timeoutSeconds * 1000,
      agent,
      model: input.model && input.model !== input.provider ? input.model : undefined,
      effort: input.effort && input.effort !== 'default' ? input.effort : undefined,
    });
  }
  async models() {
    // Explicit models only: a "CLI default" entry hid which model actually ran. ChatGPT models
    // come from the Codex CLI's own catalog; Claude Code keeps none, so the current family is listed.
    const catalog: { id: string; name: string; provider: string; efforts: string[] }[] = [];
    for (const [id, name] of CLAUDE_MODELS)
      catalog.push({ id, name, provider: 'claude-cli', efforts: claudeEfforts(id) });
    // The Codex CLI keeps its model list per account folder; a newly added account has none until
    // its first run, so fall back to the default folder, then to the CLI's own default model.
    const codexCache = z.object({
      models: z
        .array(
          z.object({
            slug: z.string(),
            visibility: z.string().optional(),
            display_name: z.string().optional(),
            supported_reasoning_levels: z.array(z.object({ effort: z.string() })).optional(),
          }),
        )
        .optional(),
    });
    const active = this.profiles?.directory('codex-cli', this.profiles.list().active['codex-cli']);
    const folders = [...(active ? [active] : []), join(homedir(), '.codex')];
    for (const folder of folders) {
      try {
        const cache = codexCache.parse(
          JSON.parse(await readFile(join(folder, 'models_cache.json'), 'utf8')),
        );
        for (const model of cache.models || [])
          if (model.visibility !== 'hide' && /^[a-zA-Z0-9._-]{1,100}$/.test(model.slug))
            catalog.push({
              id: model.slug,
              name: model.display_name || model.slug,
              provider: 'codex-cli',
              efforts: [
                'default',
                ...(model.supported_reasoning_levels || [])
                  .map((x) => x.effort)
                  .filter((x) => ['low', 'medium', 'high', 'xhigh', 'max'].includes(x)),
              ],
            });
      } catch {
        /* No cached catalog in this folder. */
      }
      if (catalog.some((model) => model.provider === 'codex-cli')) break;
    }
    if (!catalog.some((model) => model.provider === 'codex-cli'))
      catalog.push({
        id: 'codex-cli',
        name: 'ChatGPT (CLI 기본 모델)',
        provider: 'codex-cli',
        efforts: ['default'],
      });
    try {
      const settings = z
        .object({ model: z.string().optional() })
        .parse(
          JSON.parse(
            await readFile(
              join(
                this.profiles?.directory('claude-cli', this.profiles.list().active['claude-cli']) ??
                  join(homedir(), '.claude'),
                'settings.json',
              ),
              'utf8',
            ),
          ),
        );
      // Aliases (opus, sonnet…) name a listed model; only an explicit other ID is added.
      if (
        typeof settings.model === 'string' &&
        settings.model.startsWith('claude-') &&
        /^[a-zA-Z0-9._-]{1,100}(?:\[1m\])?$/.test(settings.model)
      )
        catalog.push({
          id: settings.model,
          name: modelName(settings.model),
          provider: 'claude-cli',
          efforts: claudeEfforts(settings.model),
        });
    } catch {
      /* Optional provider preferences: built-in model remains usable. */
    }
    return catalog.filter(
      (model, index) => catalog.findIndex((entry) => entry.id === model.id) === index,
    );
  }
  async status() {
    return Promise.all(
      (['claude-cli', 'codex-cli'] as const).map(async (provider) => {
        try {
          return { id: provider, ...(await this.provider({ provider }).status()) };
        } catch (error) {
          return {
            id: provider,
            available: false,
            reason: errorData(error).code || 'CLI_UNAVAILABLE',
          };
        }
      }),
    );
  }
  start(request: StoredWork) {
    if (this.active.has(request.id)) return;
    const controller = new AbortController();
    const completion = this.traced(request, this.run(request, controller)).finally(() =>
      this.active.delete(request.id),
    );
    this.active.set(request.id, { controller, completion, projectId: request.projectId });
  }
  /** Diagnostic start/end lines around one run: IDs, model, duration, final state and code. */
  private traced<T>(request: StoredWork, run: Promise<T>) {
    const started = performance.now();
    const input = request.input as Record<string, unknown>;
    const base = { requestId: request.id, projectId: request.projectId };
    this.diagnostics?.write('request-start', {
      ...base,
      provider: input.provider,
      model: input.model ?? null,
      effort: input.effort ?? null,
      host: input.host ?? 'rhino',
      permission: input.permission,
    });
    return run
      .catch((error: unknown) => {
        this.diagnostics?.write('request-crash', { ...base, ...Diagnostics.error(error) });
        throw error;
      })
      .finally(() => {
        let state = 'unknown',
          code: unknown = null;
        try {
          const done = this.workspace.get(request.projectId, request.id);
          state = done.state;
          code = (done.result as { code?: unknown } | null)?.code ?? null;
        } catch {
          /* The request may be gone (project removed). */
        }
        this.diagnostics?.write('request-end', {
          ...base,
          state,
          code,
          ms: Math.round(performance.now() - started),
        });
      });
  }
  intervene(projectId: string, predecessorId: string, value: unknown) {
    const saved = this.workspace.intervene(projectId, predecessorId, value);
    if (!saved.created) return saved.request;
    const predecessor = this.active.get(predecessorId);
    const { request } = saved;
    if (!predecessor || predecessor.projectId !== projectId)
      return this.workspace.update(projectId, request.id, 'interrupted', {
        code: 'PREDECESSOR_UNAVAILABLE',
      });
    const controller = new AbortController();
    const completion = (async () => {
      await predecessor.completion;
      if (controller.signal.aborted) {
        this.workspace.update(projectId, request.id, 'cancelled');
        return;
      }
      const previous = this.workspace.get(projectId, predecessorId);
      const children = this.workspace
        .list(projectId)
        .filter((row) => row.input.parentRequestId === predecessorId);
      if (
        previous.state === 'unknown' ||
        children.some((row) => row.state === 'unknown' || row.result?.hostExecuted)
      ) {
        this.workspace.update(projectId, request.id, 'interrupted', {
          code: 'INTERVENTION_REVIEW_REQUIRED',
        });
        return;
      }
      const conflict = requestConflict(
        request.input,
        this.workspace.list(projectId).filter((row) => row.id !== request.id),
      );
      if (conflict) {
        this.workspace.update(projectId, request.id, 'interrupted', { code: conflict });
        return;
      }
      await this.traced(request, this.run(request, controller));
    })()
      .catch(() => {
        this.workspace.update(projectId, request.id, 'interrupted', {
          code: 'INTERVENTION_REVIEW_REQUIRED',
        });
      })
      .finally(() => this.active.delete(request.id));
    this.active.set(request.id, { controller, completion, projectId });
    predecessor.controller.abort();
    return request;
  }
  async run(request: StoredWork, controller: AbortController) {
    const { projectId, id, input } = request;
    // A jig's AI review reads only the attached jig table: no host, no document context.
    const jigReview = z
      .object({ kind: z.enum(['sync-review', 'structure-draft-review']) })
      .safeParse(input.jig).success;
    const target = input.host || 'rhino',
      host = jigReview ? undefined : this.hosts[target];
    this.workspace.update(projectId, id, 'running');
    let hostIntent: Record<string, unknown> | undefined;
    try {
      if (input.applyToSource && (!this.sdk || !this.applyAttached))
        throw { code: 'EXECUTOR_NOT_READY' };
      const pins = pinsSchema.parse(input.pins);
      const items: { id: string; type: string; data: unknown }[] = [
        ...pins.map((data, i) => ({ id: `pin-${i}`, type: 'object-reference', data })),
        ...input.sketches.map((data, i) => ({ id: `sketch-${i}`, type: 'sketch', data })),
        ...input.files.map((data, i) => ({ id: `file-${i}`, type: 'file', data })),
      ];
      if (input.linkedTargets) {
        if (!this.sdk || !this.zwcadSdk || !this.tools) throw { code: 'EXECUTOR_NOT_READY' };
        await runLinked({
          request,
          workspace: this.workspace,
          tools: this.tools,
          drivers: { rhino: this.sdk, zwcad: this.zwcadSdk },
          items,
          signal: controller.signal,
          provider: (agent) => this.provider(input, agent),
        });
        return;
      }
      const basis = jigReview ? undefined : this.workspace.basis(projectId, input);
      const previous = basis
        ? { ...basis, result: executionResultSchema.parse(basis.result) }
        : undefined;
      // The drawing open in ZWCAD (connection plugin) is edited directly by its own path.
      const openCadDrawing =
        previous?.result.host === 'zwcad' &&
        previous.result.displayOnly === true &&
        (previous.result.sourceDocument as { connection?: string } | undefined)?.connection ===
          'attached-editor';
      if (
        previous?.result.referenceOnly &&
        !openCadDrawing &&
        (!isDwgSdkEditMode(previous.result.dwgEditMode) ||
          (previous.result.dwgEditMode === 'linear-entities-v1' && !this.zwcadSdk)) &&
        input.permission === 'candidate'
      )
        throw { code: 'ZWCAD_REFERENCE_ONLY' };
      const referenced = pins.map((pin) => {
        const source = this.workspace.get(projectId, pin.basis),
          result = executionResultSchema.parse(source.result);
        return {
          role: pin.role,
          sourceRequestId: source.id,
          host: result.host || 'rhino',
          object: result.objects?.find((o) => o.id === pin.id),
        };
      });
      if (referenced.length)
        items.push({ id: 'referenced-geometry', type: 'geometry-reference', data: referenced });
      const hidden = this.workspace.hiddenIds(projectId);
      const earlier = this.workspace
        .list(projectId)
        .filter((r) => r.id !== id && r.state === 'succeeded' && !hidden.has(r.id))
        .map((r) => ({
          id: r.id,
          request: r.input.body,
          response: typeof r.result?.text === 'string' ? r.result.text : undefined,
        }));
      // Six or fewer all go without a Jev call (and without an extra wait before the run).
      const context =
        earlier.length <= CONTEXT_LIMIT
          ? { ids: earlier.map((entry) => entry.id), by: 'all' as const, ms: 0 }
          : await this.selectContext(input.body, earlier);
      this.diagnostics?.write('context', {
        request: id,
        by: context.by,
        ms: context.ms,
        sent: context.ids.length,
        of: earlier.length,
        ...(context.reason ? { reason: context.reason } : {}),
      });
      const chosen = new Set(context.ids);
      const conversation = earlier
        .filter((entry) => chosen.has(entry.id))
        .map((entry) => ({ request: entry.request, response: entry.response }));
      if (conversation.length)
        items.push({ id: 'conversation', type: 'conversation', data: conversation });
      const sdk = jigReview ? undefined : target === 'rhino' ? this.sdk : this.zwcadSdk;
      if (sdk)
        items.push(
          ...modelContext(
            previous?.result,
            pins.filter((pin) => pin.basis === previous?.id).map((pin) => pin.id),
          ),
        );
      else if (host)
        items.push({ id: 'working-model', type: 'geometry', data: previous?.result.objects || [] });
      if (!sdk && previous?.result.scene)
        items.push({
          id: 'measurements',
          type: 'native-measurements',
          data: previous.result.scene.map(({ id, area, volume, length, boundsSize, layer64 }) => ({
            id,
            area,
            volume,
            length,
            boundsSize,
            layer: layer64 ? Buffer.from(layer64, 'base64').toString('utf8') : null,
          })),
        });
      if (sdk) {
        const result = await sdk.run({
          input,
          previous,
          items,
          signal: controller.signal,
          provider: (agent) => this.provider(input, agent),
          update: (progress) => {
            if (progress.phase === 'host') hostIntent = progress;
            this.workspace.update(projectId, id, 'running', progress);
          },
        });
        if (input.applyToSource && result.hostExecuted && target !== 'zwcad')
          await this.applyAttached!(request, result, controller.signal);
        else this.workspace.update(projectId, id, 'succeeded', result);
        return;
      }
      const targetContract =
        target === 'zwcad'
          ? 'Target is ZWCAD: only planar XY polylines, their move and remove are supported. No solid operations.'
          : 'Target is Rhino.';
      const dwgContract =
        previous?.result.dwgEditMode === 'polyline-vertices-v1'
          ? ' Imported DWG: ONLY move/vertices of existing IDs. Preserve names, object count and unmentioned geometry. No add/copy/remove in this path.'
          : '';
      const goal =
        (host
          ? geometryContract +
            '\n' +
            targetContract +
            dwgContract +
            ' Other-host pinned geometry is read-only reference in meters, never a writable target.\nPermission: ' +
            input.permission +
            '\nUser request: '
          : '') + (input.body || '첨부한 설계 문맥을 검토해 주세요.');
      const result = await this.provider(input).run(
        { goal, revision: 1, items, includedIds: items.map((item) => item.id) },
        {
          signal: controller.signal,
          onProgress: (event) =>
            this.workspace.update(projectId, id, 'running', {
              phase: event.state === 'stopping' ? 'stopping' : 'model',
              hostExecuted: false,
            }),
        },
      );
      if (host) {
        const proposal = interpret(result.text, previous?.result.objects || [], input.permission);
        const protectedIds = pins
          .filter(
            (pin) => ['preserve', 'reference'].includes(pin.role) && pin.basis === previous?.id,
          )
          .map((pin) => pin.id);
        protectGeometry(previous?.result.objects || [], proposal.objects, protectedIds);
        if (controller.signal.aborted) throw { code: 'CANCELLED' };
        if (proposal.changed) {
          hostIntent = {
            phase: 'host',
            hostExecuted: false,
            objects: proposal.objects,
            baseRequestId: previous?.id,
            host: target,
          };
          this.workspace.update(projectId, id, 'running', hostIntent);
          const returned = await host.build(projectId, id, proposal.objects, previous?.result);
          const checked = z
            .object({
              scene: z.array(
                z.object({ id: z.string(), nativeId: z.string().optional() }).passthrough(),
              ),
            })
            .passthrough()
            .safeParse(returned);
          if (!checked.success) throw { code: 'HOST_RESULT_UNKNOWN' };
          const native = checked.data;
          if (
            proposal.objects.some(
              (object) =>
                object.kind === 'native' &&
                !native.scene.find((scene) => scene.id === object.id)?.nativeId,
            )
          )
            throw { code: 'HOST_RESULT_UNKNOWN' };
          const objects = proposal.objects.map((o) =>
            o.kind === 'native'
              ? { ...o, nativeId: native.scene.find((x) => x.id === o.id)?.nativeId }
              : o,
          );
          this.workspace.update(projectId, id, 'succeeded', {
            ...result,
            text: proposal.message,
            objects,
            ...native,
            sourceDocument: previous?.result.sourceDocument,
            baseRequestId: previous?.id,
            host: target,
            hostExecuted: true,
          });
        } else
          this.workspace.update(projectId, id, 'succeeded', {
            ...result,
            text: proposal.message,
            hostExecuted: false,
          });
      } else
        this.workspace.update(projectId, id, 'succeeded', {
          ...result,
          ...jigCheck(input, result.text),
          hostExecuted: false,
        });
    } catch (cause) {
      const error = errorData(cause);
      if (error.code === 'PROVIDER_LIMIT')
        this.onProviderLimit?.(
          String(request.input.provider),
          String(request.input.accountProfileId ?? 'default'),
        );
      this.workspace.update(
        projectId,
        id,
        error.code === 'CANCELLED'
          ? 'cancelled'
          : error.code === 'HOST_RESULT_UNKNOWN'
            ? 'unknown'
            : 'failed',
        {
          ...(error.code === 'HOST_RESULT_UNKNOWN' ? error.intent || hostIntent : {}),
          code: error.code || 'EXECUTION_FAILED',
          hostExecuted: false,
        },
      );
    }
  }
  /** Settles when the request's run ends (undefined when it is not running here). */
  completion(id: string): Promise<unknown> | undefined {
    return this.active.get(id)?.completion;
  }
  cancel(projectId: string, id: string) {
    const active = this.active.get(id);
    if (active?.projectId === projectId) active.controller.abort();
    return this.workspace.get(projectId, id);
  }
  async close() {
    const active = [...this.active.values()];
    active.forEach((x) => x.controller.abort());
    await Promise.all(active.map((x) => x.completion));
  }
}
