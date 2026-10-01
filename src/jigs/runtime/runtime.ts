// The jig runtime (ARCH-03 §4·§6·§8, SPEC-07.4~07.8): instances (작업본) of a project, their
// settings with a change log and undo, overrides, zones, jig input reads, assembled input roles
// with snapshots, and runs whose results are cached by input fingerprint under
// `<data>/jigs/runs/`. Data rows live in `jig_*` (JigStore); step code runs through the runner
// its source allows. A setting change marks the steps that read it stale and makes a run in
// progress obsolete (`superseded`), so only the latest values are ever shown.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DomainError } from '../../contracts/errors.ts';
import { isNewerVersion } from '../../contracts/jig-version.ts';
import type { JigInstanceRow, JigRead, JigStore, StepStatus } from '../../core/jig-store.ts';
import { ChildRunner, type ChildRunnerOptions } from './child-runner.ts';
import { ComputeBoxRunner } from './compute-box.ts';
import type { GateContext, GateResult } from './gates.ts';
import { buildGraph, type StepGraph } from './graph.ts';
import { hashValue } from './hash.ts';
import {
  bodyOf,
  emptyBody,
  type AssembledRole,
  type InstanceBody,
  type Override,
  type Zone,
} from './instance.ts';
import type { JigRegistry, LoadedJig } from './loader.ts';
import type { ParamDecl, StepDecl } from './manifest.ts';
import { devReadPaths } from './pack.ts';
import {
  applyChanges,
  checkValue,
  displayUnit,
  initialParams,
  storageUnit,
  toDisplay,
  undoChange,
  type ParamChange,
  type ParamValue,
} from './params.ts';
import {
  EngineRunner,
  executeSteps,
  type ExecutionReport,
  type RunMode,
  type StepCache,
  type StepReport,
  type StepRunner,
} from './runner.ts';

export interface RuntimeOptions {
  store: JigStore;
  dataDir: string;
  registry: JigRegistry;
  hooks?: GateContext['hooks'];
  child?: ChildRunnerOptions;
}

export interface StepView {
  id: string;
  title: string;
  kind: StepDecl['kind'];
  speed: StepDecl['speed'];
  status: StepStatus;
  inputHash?: string;
  ms?: number | null;
  gates?: GateResult[];
  at?: string;
  hasOutput?: boolean;
}
export interface ParamView {
  key: string;
  title: string;
  group: string;
  type: ParamDecl['type'];
  unit: string;
  displayUnit: string;
  decimals?: number;
  value: number | string | boolean;
  displayValue: number | string | boolean;
  by: ParamValue['by'];
  ref?: string;
  status?: ParamValue['status'];
  at: string;
  fixedAtPin?: boolean;
  range?: ParamDecl['range'];
  choices?: ParamDecl['choices'];
  board?: boolean;
  basis?: ParamDecl['basis'];
  help?: string;
}
export interface InstanceView {
  id: string;
  projectId: string;
  jig: {
    id: string;
    version: string;
    name: string;
    kind: 'tool' | 'library';
    summary: string;
    source: string;
    /** `jig.json` `icon` (PLAN-26 T-100), when it names one. */
    icon?: string;
  };
  title: string;
  status: JigInstanceRow['status'];
  body: InstanceBody;
  steps: StepView[];
  params: ParamView[];
  inputs: LoadedJig['manifest']['inputs'];
  createdAt: string;
  updatedAt: string;
}

/** A stored model (Sync or read): scene rows with base64 layer names and block definitions. */
export interface ReadModel {
  scene: Record<string, unknown>[];
  definitions?: Record<string, unknown>;
  layers?: unknown[];
  sourceDocument?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface RoleSnapshot {
  rows: Record<string, unknown>[];
  definitions: Record<string, unknown>;
  snapshot: { ref: string; hash: string };
}

const decode64 = (value: unknown) => {
  if (typeof value !== 'string' || !value) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(value), (c) => c.charCodeAt(0)),
    );
  } catch {
    return '';
  }
};
/** Rows of the named layers (exact full path) with the block definitions they use. */
export function rowsOfLayers(model: ReadModel, layers: readonly string[]) {
  const wanted = new Set(layers);
  const names = new Map<unknown, string>();
  const definitions: Record<string, unknown> = {};
  const all = (model.definitions ?? {}) as Record<string, unknown>;
  const rows: Record<string, unknown>[] = [];
  for (const row of Array.isArray(model.scene) ? model.scene : []) {
    if (!row || typeof row !== 'object') continue;
    let layer = names.get(row.layer64);
    if (layer === undefined) names.set(row.layer64, (layer = decode64(row.layer64)));
    if (!wanted.has(layer)) continue;
    rows.push({ ...row, layer });
    const block = row.block as { definition?: unknown } | undefined;
    if (block && typeof block.definition === 'string' && all[block.definition])
      definitions[block.definition] = all[block.definition];
  }
  return { rows, definitions };
}
/** Layer names present in a model, with object counts. */
export function layersOf(model: ReadModel): { fullPath: string; objectCount: number }[] {
  const counts = new Map<string, number>();
  const names = new Map<unknown, string>();
  for (const row of Array.isArray(model.scene) ? model.scene : []) {
    if (!row || typeof row !== 'object') continue;
    let layer = names.get(row.layer64);
    if (layer === undefined) names.set(row.layer64, (layer = decode64(row.layer64)));
    counts.set(layer, (counts.get(layer) ?? 0) + 1);
  }
  return [...counts].map(([fullPath, objectCount]) => ({ fullPath, objectCount }));
}
const globToRegExp = (glob: string) =>
  new RegExp(
    '^' +
      glob
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
    'i',
  );

export class JigRuntime {
  private readonly store: JigStore;
  private readonly dataDir: string;
  readonly registry: JigRegistry;
  private readonly hooks: GateContext['hooks'];
  private readonly childOptions: ChildRunnerOptions;
  private readonly runners = new Map<string, StepRunner>();
  private readonly generations = new Map<string, number>();
  private readonly graphs = new Map<string, StepGraph>();

  constructor(options: RuntimeOptions) {
    this.store = options.store;
    this.dataDir = options.dataDir;
    this.registry = options.registry;
    this.hooks = options.hooks;
    this.childOptions = options.child ?? {};
  }

  // --- files ---------------------------------------------------------------------------------
  private file(ref: string) {
    return join(this.dataDir, 'jigs', ...ref.split('/'));
  }
  private writeGz(ref: string, value: unknown) {
    const target = this.file(ref);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, gzipSync(Buffer.from(JSON.stringify(value), 'utf8')));
  }
  private readGz<T = unknown>(ref: string): T | undefined {
    const target = this.file(ref);
    if (!existsSync(target)) return undefined;
    return JSON.parse(gunzipSync(readFileSync(target)).toString('utf8')) as T;
  }

  // --- jigs and runners ----------------------------------------------------------------------
  private async jigOf(instance: JigInstanceRow): Promise<LoadedJig> {
    return this.registry.resolve(instance.jigId, instance.version);
  }
  private graphOf(jig: LoadedJig) {
    const key = `${jig.id}@${jig.version}@${jig.digest}`;
    let graph = this.graphs.get(key);
    if (!graph) this.graphs.set(key, (graph = buildGraph(jig.manifest).graph));
    return graph;
  }
  runnerFor(jig: LoadedJig): StepRunner {
    const key = `${jig.id}@${jig.version}@${jig.source}`;
    let runner = this.runners.get(key);
    if (!runner) {
      runner =
        jig.source === 'builtin'
          ? new EngineRunner()
          : jig.source === 'ai-draft'
            ? new ComputeBoxRunner()
            : new ChildRunner(jig.source, { ...devReadPaths(jig), ...this.childOptions });
      this.runners.set(key, runner);
    }
    return runner;
  }
  async close() {
    await Promise.all([...this.runners.values()].map((runner) => runner.close()));
    this.runners.clear();
  }

  // --- instances -----------------------------------------------------------------------------
  private bump(instanceId: string) {
    this.generations.set(instanceId, (this.generations.get(instanceId) ?? 0) + 1);
  }
  private save(instance: JigInstanceRow, body: InstanceBody, status?: JigInstanceRow['status']) {
    return this.store.updateInstance(instance.projectId, instance.id, {
      body: body as unknown as Record<string, unknown>,
      ...(status ? { status } : {}),
    });
  }

  async createInstance(
    projectId: string,
    input: {
      jig: string;
      version?: string;
      title: string;
      layerRoot: string;
      params?: ParamChange[];
      conversationId?: string;
    },
    options: {
      layerExists?: (layerRoot: string) => boolean | undefined;
      /** Opened from a request (ADR-026): the output layer is asked at Rhino에 만들기. */
      layerRootLater?: boolean;
    } = {},
  ): Promise<InstanceView> {
    if (!input.layerRoot && !options.layerRootLater) throw new DomainError('INVALID_INPUT');
    if (input.layerRoot && options.layerExists?.(input.layerRoot) === false)
      throw new DomainError('LAYER_ROOT_MISSING');
    const pinned = this.store.pinned(projectId).find((p) => p.jigId === input.jig);
    const jig = await this.registry.resolve(input.jig, input.version ?? pinned?.version);
    if (jig.manifest.kind !== 'tool') throw new DomainError('INVALID_INPUT');
    const params = input.params?.length
      ? applyChanges(jig.manifest, initialParams(jig.manifest), input.params, {
          by: 'user',
          atPin: true,
        }).next
      : initialParams(jig.manifest);
    const body = emptyBody(input.layerRoot, params);
    if (input.conversationId) body.conversationId = input.conversationId;
    const row = this.store.createInstance(projectId, {
      jigId: jig.id,
      version: jig.version,
      title: input.title,
      body: body as unknown as Record<string, unknown>,
    });
    return this.view(projectId, row.id);
  }

  /** Sets the output layer of an instance that has none yet; a set one never changes (SPEC-07.4). */
  async setLayerRoot(
    projectId: string,
    instanceId: string,
    layerRoot: string,
    options: { layerExists?: (layerRoot: string) => boolean | undefined } = {},
  ): Promise<InstanceView> {
    const instance = this.store.instance(projectId, instanceId);
    const body = bodyOf(instance.body);
    if (body.layerRoot) throw new DomainError('INVALID_INPUT');
    if (options.layerExists?.(layerRoot) === false) throw new DomainError('LAYER_ROOT_MISSING');
    this.save(instance, { ...body, layerRoot });
    return this.view(projectId, instanceId);
  }

  /**
   * [올리기] (SPEC-07.4, PLAN-26 T-101): the person moves an instance to the version pinned to its
   * project — never automatically. A setting the new version still declares keeps its value when
   * the new declaration accepts it (else its default); every computed step becomes '다시 계산
   * 필요'. A human step keeps its confirmation, which the next run compares by input fingerprint
   * (as after a setting change). Already at the pinned version, nothing changes. An older pinned
   * version (an imported older pack re-pinned over a fork) is no 올리기: JIG_VERSION_NOT_NEWER.
   */
  async upgrade(projectId: string, instanceId: string): Promise<InstanceView> {
    const instance = this.store.instance(projectId, instanceId);
    const pinned = this.store.pinned(projectId).find((row) => row.jigId === instance.jigId);
    if (!pinned) throw new DomainError('NOT_FOUND');
    if (pinned.version === instance.version) return this.view(projectId, instanceId);
    if (!isNewerVersion(pinned.version, instance.version))
      throw new DomainError('JIG_VERSION_NOT_NEWER');
    const jig = await this.registry.resolve(instance.jigId, pinned.version);
    if (jig.manifest.kind !== 'tool') throw new DomainError('INVALID_INPUT');
    const body = bodyOf(instance.body);
    const params = initialParams(jig.manifest);
    for (const decl of jig.manifest.params) {
      const kept = body.params[decl.key];
      if (!kept || kept.by === 'default') continue;
      try {
        params[decl.key] = { ...kept, value: checkValue(decl, kept.value) };
      } catch {
        /* the new version no longer accepts the value: its default */
      }
    }
    this.markStale(
      jig,
      instanceId,
      this.store.runs(instanceId).map((run) => run.stepId),
    );
    this.bump(instanceId);
    this.store.updateInstance(projectId, instanceId, {
      version: jig.version,
      body: { ...body, params } as unknown as Record<string, unknown>,
      status: instance.status === 'new' ? 'new' : 'stale',
    });
    return this.view(projectId, instanceId);
  }

  async view(projectId: string, instanceId: string): Promise<InstanceView> {
    const instance = this.store.instance(projectId, instanceId);
    const jig = await this.jigOf(instance);
    const body = bodyOf(instance.body);
    const runs = new Map(this.store.runs(instanceId).map((run) => [run.stepId, run]));
    const steps: StepView[] = jig.manifest.steps.map((step) => {
      const run = runs.get(step.id);
      return {
        id: step.id,
        title: step.title,
        kind: step.kind,
        speed: step.speed,
        status: run?.status ?? 'pending',
        ...(run
          ? {
              inputHash: run.inputHash,
              ms: run.ms,
              gates: (run.gates as GateResult[] | null) ?? [],
              at: run.at,
              hasOutput: !!run.outputRef && existsSync(this.file(run.outputRef)),
            }
          : {}),
      };
    });
    const params: ParamView[] = jig.manifest.params.map((decl) => {
      const value = body.params[decl.key] ?? {
        value: decl.default,
        by: 'default' as const,
        at: instance.createdAt,
      };
      return {
        key: decl.key,
        title: decl.title,
        group: decl.group,
        type: decl.type,
        unit: storageUnit(decl),
        displayUnit: displayUnit(decl),
        ...(decl.display ? { decimals: decl.display.decimals } : {}),
        value: value.value,
        displayValue: typeof value.value === 'number' ? toDisplay(decl, value.value) : value.value,
        by: value.by,
        ...(value.ref ? { ref: value.ref } : {}),
        ...(value.status ? { status: value.status } : {}),
        at: value.at,
        ...(decl.fixedAtPin ? { fixedAtPin: true } : {}),
        ...(decl.range ? { range: decl.range } : {}),
        ...(decl.choices ? { choices: decl.choices } : {}),
        ...(decl.board ? { board: true } : {}),
        ...(decl.basis ? { basis: decl.basis } : {}),
        ...(decl.help ? { help: decl.help } : {}),
      };
    });
    return {
      id: instance.id,
      projectId,
      jig: {
        id: jig.id,
        version: jig.version,
        name: jig.manifest.name,
        kind: jig.manifest.kind,
        summary: jig.manifest.summary,
        source: jig.source,
        ...(jig.manifest.icon ? { icon: jig.manifest.icon } : {}),
      },
      title: instance.title,
      status: instance.status,
      body,
      steps,
      params,
      inputs: jig.manifest.inputs,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
    };
  }
  list(projectId: string) {
    return this.store.instances(projectId).map((row) => ({
      id: row.id,
      jigId: row.jigId,
      version: row.version,
      title: row.title,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  // --- settings ------------------------------------------------------------------------------
  async setParams(
    projectId: string,
    instanceId: string,
    input: { values: ParamChange[]; by: ParamValue['by']; reason?: string; requestId?: string },
  ) {
    const instance = this.store.instance(projectId, instanceId);
    const jig = await this.jigOf(instance);
    const body = bodyOf(instance.body);
    const { next, entries, keys } = applyChanges(jig.manifest, body.params, input.values, {
      by: input.by,
    });
    const seqs = entries.map(
      (entry) =>
        this.store.appendParam(instanceId, {
          key: entry.key,
          old: entry.old,
          new: entry.new,
          by: input.by,
          reason: input.reason ?? null,
          requestId: input.requestId ?? null,
        }).seq,
    );
    const affected = this.graphOf(jig).affectedByParams(keys);
    this.markStale(jig, instanceId, affected);
    body.params = next;
    this.bump(instanceId);
    this.save(instance, body, instance.status === 'new' ? 'new' : 'stale');
    return { seqs, affected, changed: keys, instance: await this.view(projectId, instanceId) };
  }
  private hasRun(instanceId: string, stepId: string) {
    try {
      this.store.run(instanceId, stepId);
      return true;
    } catch {
      return false;
    }
  }
  /** Mark computed steps stale; a human step keeps its confirmation (the run compares fingerprints). */
  private markStale(jig: LoadedJig, instanceId: string, stepIds: readonly string[]) {
    const human = new Set(jig.manifest.steps.filter((s) => s.kind === 'human').map((s) => s.id));
    this.store.setRunStatus(
      instanceId,
      stepIds.filter((id) => !human.has(id) && this.hasRun(instanceId, id)),
      'stale',
    );
  }
  async undo(projectId: string, instanceId: string, seq: number) {
    const instance = this.store.instance(projectId, instanceId);
    const jig = await this.jigOf(instance);
    const entry = this.store.paramEntry(instanceId, seq);
    const change = undoChange(jig.manifest, entry);
    return this.setParams(projectId, instanceId, {
      values: [change],
      by: 'user',
      reason: `undo:${seq}`,
    });
  }
  paramLog(projectId: string, instanceId: string) {
    this.store.instance(projectId, instanceId);
    return this.store.paramLog(instanceId);
  }

  // --- overrides and zones -------------------------------------------------------------------
  async setOverrides(
    projectId: string,
    instanceId: string,
    input: { add?: (Omit<Override, 'id' | 'at'> & { id?: string })[]; remove?: string[] },
  ) {
    const instance = this.store.instance(projectId, instanceId);
    const body = bodyOf(instance.body);
    const remove = new Set(input.remove ?? []);
    const at = new Date().toISOString();
    body.overrides = [
      ...body.overrides.filter((o) => !remove.has(o.id)),
      ...(input.add ?? []).map((o) => ({ ...o, id: o.id ?? randomUUID(), at }) as Override),
    ];
    // Every step's fingerprint includes the overrides (ARCH-03 §6.3).
    const jig = await this.jigOf(instance);
    this.markStale(
      jig,
      instanceId,
      jig.manifest.steps.map((s) => s.id),
    );
    this.bump(instanceId);
    this.save(instance, body, instance.status === 'new' ? 'new' : 'stale');
    return body.overrides;
  }
  async setZones(projectId: string, instanceId: string, zones: Record<string, Zone[]>) {
    const instance = this.store.instance(projectId, instanceId);
    const jig = await this.jigOf(instance);
    const body = bodyOf(instance.body);
    for (const key of Object.keys(zones)) {
      const input = jig.manifest.inputs.find((i) => i.key === key);
      if (!input || input.kind !== 'zone') throw new DomainError('INVALID_INPUT');
    }
    body.zones = { ...body.zones, ...zones };
    this.markStale(jig, instanceId, this.graphOf(jig).affectedByInputs(Object.keys(zones)));
    this.bump(instanceId);
    this.save(instance, body, instance.status === 'new' ? 'new' : 'stale');
    return body.zones;
  }

  // --- reads and assembly --------------------------------------------------------------------
  /** Keep a jig input read (§8): the model goes to `<data>/jigs/reads/`, the row to `jig_reads`. */
  recordRead(
    projectId: string,
    instanceId: string,
    input: {
      linkId: string;
      revisionKey: string;
      layers: string[];
      includeHidden: boolean;
      purpose: 'assembly' | 'pre-bake';
      model: ReadModel;
    },
  ): JigRead & { objectCount: number; layerTable: { fullPath: string; objectCount: number }[] } {
    this.store.instance(projectId, instanceId);
    const ref = `reads/${randomUUID()}.json.gz`;
    const { model } = input;
    this.writeGz(ref, model);
    const row = this.store.addRead(instanceId, {
      linkId: input.linkId,
      revisionKey: input.revisionKey,
      layers: input.layers,
      includeHidden: input.includeHidden,
      purpose: input.purpose,
      ref,
    });
    return {
      ...row,
      objectCount: Array.isArray(model.scene) ? model.scene.length : 0,
      layerTable: layersOf(model),
    };
  }
  readModel(instanceId: string, readId: string): { read: JigRead; model: ReadModel } {
    const read = this.store.read(instanceId, readId);
    const model = this.readGz<ReadModel>(read.ref);
    if (!model) throw new DomainError('STALE_REFERENCE');
    return { read, model };
  }
  reads(projectId: string, instanceId: string) {
    this.store.instance(projectId, instanceId);
    return this.store.reads(instanceId);
  }

  /** Rule candidates for each assembly role from the instance's reads (the AI proposal is T-063+). */
  async proposeAssembly(projectId: string, instanceId: string, roles?: string[]) {
    const instance = this.store.instance(projectId, instanceId);
    const jig = await this.jigOf(instance);
    const reads = this.store.reads(instanceId);
    const layerLists = reads.map((read) => {
      const model = this.readGz<ReadModel>(read.ref);
      return { read, layers: model ? layersOf(model) : [] };
    });
    const proposals: Record<
      string,
      {
        candidates: {
          readId: string;
          linkId: string;
          layer: string;
          objectCount: number;
          reason: string;
        }[];
        proposedBy: 'rule';
      }
    > = {};
    for (const input of jig.manifest.inputs) {
      if (input.kind !== 'assembly') continue;
      for (const role of input.roles) {
        const key = `${input.key}.${role.role}`;
        if (roles && !roles.includes(key) && !roles.includes(role.role)) continue;
        const patterns = (role.hints.layers ?? []).map(globToRegExp);
        const words = (role.hints.words ?? []).map((w) => w.toLowerCase());
        const candidates: (typeof proposals)[string]['candidates'] = [];
        for (const { read, layers } of layerLists)
          for (const layer of layers) {
            const name = layer.fullPath.split('::').at(-1) ?? layer.fullPath;
            const byGlob = patterns.some((p) => p.test(layer.fullPath) || p.test(name));
            const byWord = words.find((w) => layer.fullPath.toLowerCase().includes(w));
            if (byGlob || byWord)
              candidates.push({
                readId: read.id,
                linkId: read.linkId,
                layer: layer.fullPath,
                objectCount: layer.objectCount,
                reason: byGlob
                  ? `레이어 이름 규칙(${role.hints.layers?.join(', ')})`
                  : `이름에 '${byWord}'`,
              });
          }
        proposals[key] = { candidates, proposedBy: 'rule' };
      }
    }
    return { proposals, ai: 'unavailable' as const };
  }

  private inputKeyOf(jig: LoadedJig, roleKey: string) {
    const [inputKey, role] = roleKey.split('.');
    const input = jig.manifest.inputs.find((i) => i.key === inputKey);
    if (!input || input.kind !== 'assembly' || !input.roles.some((r) => r.role === role))
      throw new DomainError('NOT_FOUND');
    return { inputKey, role };
  }
  /** Confirm or replace one assembled role: the layer rows of the named reads become its snapshot. */
  async setAssembly(
    projectId: string,
    instanceId: string,
    roleKey: string,
    input: {
      sources: { readId: string; layers: string[] }[];
      transform?: AssembledRole['transform'];
      confirm: boolean;
      by: string;
      reason?: string;
    },
  ) {
    const instance = this.store.instance(projectId, instanceId);
    const jig = await this.jigOf(instance);
    const { inputKey, role } = this.inputKeyOf(jig, roleKey);
    const body = bodyOf(instance.body);
    const rows: Record<string, unknown>[] = [];
    const definitions: Record<string, unknown> = {};
    const sources: AssembledRole['sources'] = [];
    for (const source of input.sources) {
      const { read, model } = this.readModel(instanceId, source.readId);
      const picked = rowsOfLayers(model, source.layers);
      rows.push(...picked.rows);
      Object.assign(definitions, picked.definitions);
      sources.push({
        linkId: read.linkId,
        readId: read.id,
        layers: source.layers,
        revisionKey: read.revisionKey,
      });
    }
    const snapshot = { rows, definitions };
    const hash = hashValue(snapshot);
    const ref = `inputs/${instanceId}/${roleKey.replace(/[^A-Za-z0-9_.-]/g, '_')}-${hash.slice(0, 16)}.json.gz`;
    this.writeGz(ref, snapshot);
    const at = new Date().toISOString();
    body.assembly[roleKey] = {
      role,
      sources,
      ...(input.transform ? { transform: input.transform } : {}),
      proposedBy: 'rule',
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.confirm ? { confirmed: { by: input.by, at } } : {}),
      snapshot: { ref, hash },
    };
    this.markStale(jig, instanceId, this.graphOf(jig).affectedByInputs([inputKey, roleKey]));
    this.bump(instanceId);
    this.save(instance, body, instance.status === 'new' ? 'new' : 'stale');
    return body.assembly[roleKey];
  }

  /** Input values for execution: assembled roles (snapshots read back) and zones. */
  private executionInputs(jig: LoadedJig, body: InstanceBody) {
    const inputs: Record<string, unknown> = {};
    for (const input of jig.manifest.inputs) {
      if (input.kind === 'assembly') {
        const roles: Record<string, RoleSnapshot> = {};
        for (const role of input.roles) {
          const assembled = body.assembly[`${input.key}.${role.role}`];
          if (!assembled) continue;
          const snapshot = this.readGz<{
            rows: Record<string, unknown>[];
            definitions: Record<string, unknown>;
          }>(assembled.snapshot.ref);
          if (snapshot) roles[role.role] = { ...snapshot, snapshot: assembled.snapshot };
        }
        inputs[input.key] = roles;
      } else if (input.kind === 'zone') inputs[input.key] = body.zones[input.key] ?? [];
    }
    return inputs;
  }

  // --- runs ----------------------------------------------------------------------------------
  private cacheFor(instanceId: string): StepCache {
    const refOf = (stepId: string, hash: string) => `runs/${instanceId}/${stepId}-${hash}.json.gz`;
    return {
      get: async (stepId, hash) => this.readGz(refOf(stepId, hash)),
      put: async (stepId, hash, output) => {
        const ref = refOf(stepId, hash);
        this.writeGz(ref, output);
        return ref;
      },
      previous: async (stepId) => {
        if (!this.hasRun(instanceId, stepId)) return null;
        const run = this.store.run(instanceId, stepId);
        const output = run.outputRef ? this.readGz(run.outputRef) : undefined;
        return output === undefined ? null : { inputHash: run.inputHash, output };
      },
    };
  }
  private confirmations(instanceId: string, jig: LoadedJig) {
    const out: Record<string, string> = {};
    for (const run of this.store.runs(instanceId))
      if (
        jig.manifest.steps.some((s) => s.id === run.stepId && s.kind === 'human') &&
        (run.status === 'confirmed' || run.status === 'reconfirm')
      )
        out[run.stepId] = run.inputHash;
    return out;
  }

  /** Run the steps (SPEC-07.7): cached results are reused, changed steps and those after recompute. */
  async run(
    projectId: string,
    instanceId: string,
    input: {
      until?: string;
      mode: RunMode;
      currentRevisions?: Record<string, string>;
      /** Internal: the overrides a step asked for were written already in this call. */
      applied?: boolean;
    } = {
      mode: 'geometry',
    },
  ): Promise<ExecutionReport & { status: JigInstanceRow['status'] }> {
    const instance = this.store.instance(projectId, instanceId);
    const jig = await this.jigOf(instance);
    const body = bodyOf(instance.body);
    if (input.until && !jig.manifest.steps.some((s) => s.id === input.until))
      throw new DomainError('NOT_FOUND');
    const generation = this.generations.get(instanceId) ?? 0;
    const report = await executeSteps({
      jig,
      runner: this.runnerFor(jig),
      cache: this.cacheFor(instanceId),
      mode: input.mode,
      inputs: this.executionInputs(jig, body),
      params: body.params,
      overrides: body.overrides,
      assembly: body.assembly,
      currentRevisions: input.currentRevisions,
      layerRoot: body.layerRoot,
      hooks: this.hooks,
      confirmations: this.confirmations(instanceId, jig),
      until: input.until,
      graph: this.graphOf(jig),
      isCurrent: () => (this.generations.get(instanceId) ?? 0) === generation,
    });
    if (report.superseded || input.mode === 'preview')
      return { ...report, status: instance.status };
    const confirmed = this.confirmations(instanceId, jig);
    for (const step of report.steps) {
      const status = persistedStatus(step);
      if (!status) continue;
      // A human step's row keeps the fingerprint the person confirmed; `reconfirm` only flags it.
      const inputHash =
        step.kind === 'human' && status === 'reconfirm' ? confirmed[step.id] : step.inputHash;
      this.store.saveRun(instanceId, step.id, {
        inputHash,
        outputRef:
          step.outputRef ??
          (step.cached ? `runs/${instanceId}/${step.id}-${step.inputHash}.json.gz` : null),
        ms: step.ms,
        status,
        gates: step.gates,
      });
    }
    const status: JigInstanceRow['status'] = report.steps.some((s) => s.status === 'gate-failed')
      ? 'gate-failed'
      : report.blocked
        ? 'stale'
        : 'computed';
    this.save(instance, body, status);
    // A step asked to write overrides (e.g. 선정 단면 적용, SPEC-06.12): upsert them by id, which
    // makes every step stale, and compute once more so the screen shows the new model at once.
    // The confirmation that led here no longer matches, so the second run asks nothing again.
    const add = report.applies.flatMap((a) => a.overrides);
    if (add.length && !input.applied) {
      await this.setOverrides(projectId, instanceId, { add, remove: add.map((o) => o.id) });
      return this.run(projectId, instanceId, { ...input, applied: true });
    }
    return { ...report, status };
  }

  /** A person confirms a human step for one input fingerprint (SPEC-07.7). */
  async confirmStep(projectId: string, instanceId: string, stepId: string, inputHash: string) {
    const instance = this.store.instance(projectId, instanceId);
    const jig = await this.jigOf(instance);
    const step = jig.manifest.steps.find((s) => s.id === stepId);
    if (!step || step.kind !== 'human') throw new DomainError('NOT_FOUND');
    this.store.saveRun(instanceId, stepId, { inputHash, status: 'confirmed' });
    return this.view(projectId, instanceId);
  }
  /** The kept output of a step's latest run, when it has one. */
  output(projectId: string, instanceId: string, stepId: string): unknown {
    this.store.instance(projectId, instanceId);
    if (!this.hasRun(instanceId, stepId)) throw new DomainError('NOT_FOUND');
    const run = this.store.run(instanceId, stepId);
    const output = run.outputRef ? this.readGz(run.outputRef) : undefined;
    if (output === undefined) throw new DomainError('NOT_FOUND');
    return output;
  }
}

/** What a report status becomes in `jig_runs` (`blocked`/`skipped` leave the row as it is). */
function persistedStatus(step: StepReport): StepStatus | undefined {
  switch (step.status) {
    case 'done':
      return 'done';
    case 'failed':
    case 'gate-failed':
      return 'failed';
    case 'waiting':
    case 'confirmed':
    case 'reconfirm':
      return step.status;
    default:
      return undefined;
  }
}
