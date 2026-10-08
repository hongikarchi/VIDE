// Rhino에 만들기 (SPEC-07.12·13·17, ARCH-03 §9, decision A7): a deterministic host write with no
// AI. `prepareBake` reads the linked document once more (hidden objects included), classifies the
// objects an earlier bake recorded, runs the before-bake gates and renders the fixed templates
// with one data block each. With an attached Rhino (user decision 2026-09-30, '바로 적용'),
// `runDirectBake` runs the bodies through the host's `direct-execute` in the open document, one
// undo record each (label 'VIDE jig: <name>'), reads the document right after and writes the bake
// record with its baseline — no candidate, no separate apply step; `undoBake` asks the host to undo
// the last bake. Without an attached editor the route keeps the internal work copy: a `jig-bake`
// request whose job is kept here until the executor runs it through `SdkExecution.runFixed`,
// `finishBake` writes the record and `recordBaseline` fills its fingerprints later.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../contracts/errors.ts';
import { directRefusal } from '../../contracts/direct-refusal.ts';
import { layerPathProblem } from '../../contracts/layer-path.ts';
import type { JigBake, JigStore } from '../../core/jig-store.ts';
import type { HostTarget } from '../../contracts/host-documents.ts';
import { runGates, type GateResult } from '../runtime/gates.ts';
import type { LoadedJig } from '../runtime/loader.ts';
import type { BakeDecl, GateUse } from '../runtime/manifest.ts';
import type { InstanceView, JigRuntime, ReadModel } from '../runtime/runtime.ts';
import type { SurfaceSample } from '../../contracts/paneling.ts';
import { isPanelTemplate, unsafeArgs, type BakeItem, type SurfaceHeader } from './data-block.ts';
import { bakeDeclOf, bakeDeclsOf, builtinOutput, isBuiltinBake } from './builtin.ts';
import { FAIL_LAYER, failureCode, isPanelDecl, LAYOUT_STEP, panelRows } from './panels.ts';
import {
  absorbedOf,
  extractItems,
  itemsPath,
  layerUsable,
  planBake,
  readLayers,
  readObjects,
  type BakePlan,
  type BakeRecordItems,
  type Preserved,
  type Resolve,
} from './plan.ts';
import { renderChunks, type BakeChunk } from './templates.ts';

export interface BakeRead {
  linkId: string;
  revisionKey: string;
  model: ReadModel;
}
export interface BakeContext {
  runtime: JigRuntime;
  store: JigStore;
  /** The whole linked document, hidden objects included (SPEC-07.12 3). */
  read: (linkId: string) => Promise<BakeRead>;
}
export interface BakeInput {
  projectId: string;
  instanceId: string;
  bakeIds: string[];
  linkId?: string;
  resolve?: Record<string, Resolve>;
}
/** What one bake declaration did (or will do); the card shows these counts (Design SCR-13). */
export interface BakeOutcome {
  bakeId: string;
  template: BakeDecl['template'];
  layer: string;
  added: string[];
  replaced: string[];
  dropped: string[];
  preserved: Preserved[];
  /** Person-edited objects taken as 수정 사항; left as they are (SPEC-07.13). */
  respected: string[];
  kept: string[];
  deleted: string[];
  copies: number;
  /** Items the template could not make (invalid geometry). */
  failed: string[];
  /** Why each failed key failed, when the template said (패널링: left on the failure layer). */
  failures?: { key: string; reason: string; code: string }[];
  chunks: number;
  templateHash: string;
  recordId?: string;
  /** Person-edited objects kept although the results no longer have their key (패널링 '이전 배치에서 보존'). */
  preservedEarlier?: number;
  /** 패널링: the largest difference between the actual face and the sample at the made corners (m). */
  deviationMax?: number;
  /** Above this the card says '표본이 거칩니다 · 촘촘하게 다시 읽기' (m). */
  deviationLimit?: number;
}
/** What the declarations of a bake take from the results. */
interface DeclItems {
  decl: BakeDecl;
  items: BakeItem[];
  inputHash?: string;
  stepId: string;
  surface?: SurfaceHeader;
  deviationLimit?: number;
}
export interface BakeSummary {
  runId: string;
  readId: string;
  linkId: string;
  revisionKey: string;
  bakes: BakeOutcome[];
  totals: {
    added: number;
    replaced: number;
    preserved: number;
    respected: number;
    copies: number;
    deleted: number;
    failed: number;
  };
  layers: string[];
  text: string;
  /** Made directly in the open document (one host undo record per body); undone by `undoBake`. */
  direct?: boolean;
  /** Host undo records the run made: 'Rhino Ctrl+Z n번' (SPEC-16.9 1). */
  undos?: number;
}
/** A prepared bake the executor runs: fixed bodies, and what to do with the receipt. */
export interface BakeJob {
  requestId: string;
  instanceId: string;
  runId: string;
  codes: string[];
  /** The forced read's document revision token; a work copy of another revision is stale. */
  expectedDocumentHash?: string;
  finish(result: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const RESOLVE_CODE = 'BAKE_NOT_COMPUTED';
const receiptSchema = z.object({
  removed: z.number().int().nonnegative(),
  keys: z.array(z.string()),
  ids: z.array(z.string().uuid()),
  failed: z.array(z.string()).default([]),
  /** Panel templates: the reason of each failed key (same order), the sample difference per key (m, −1 = none). */
  reasons: z.array(z.string()).optional(),
  dev: z.array(z.number()).optional(),
});
type Receipt = z.infer<typeof receiptSchema>;
/** A panel template refused the whole body: the face is not the one the sample was read from. */
const rejectionOf = (value: unknown) => {
  const rejected = (value as { rejected?: unknown } | null)?.rejected;
  return typeof rejected === 'string' ? rejected : undefined;
};
/** Failures with reasons and the largest sample difference of a bake's receipts. */
function receiptFacts(receipts: readonly (Receipt | undefined)[]) {
  const failures: { key: string; reason: string; code: string }[] = [];
  let deviationMax: number | undefined;
  for (const receipt of receipts) {
    if (!receipt) continue;
    receipt.failed.forEach((key, i) => {
      const reason = receipt.reasons?.[i] ?? '';
      if (reason) failures.push({ key, reason, code: failureCode(reason) });
    });
    for (const d of receipt.dev ?? []) if (d >= 0) deviationMax = Math.max(deviationMax ?? 0, d);
  }
  return { failures, deviationMax };
}
/** The optional outcome fields a bake has only when it has them (generic bakes stay as they were). */
function panelFacts(
  facts: ReturnType<typeof receiptFacts>,
  preservedEarlier: number,
  deviationLimit: number | undefined,
): Partial<BakeOutcome> {
  return {
    ...(facts.failures.length ? { failures: facts.failures } : {}),
    ...(preservedEarlier ? { preservedEarlier } : {}),
    ...(facts.deviationMax !== undefined ? { deviationMax: facts.deviationMax } : {}),
    ...(deviationLimit !== undefined ? { deviationLimit } : {}),
  };
}

// --- job registry (one engine process) ---------------------------------------------------------
const jobs = new Map<string, BakeJob>();
const MAX_JOBS = 64;
export function registerBakeJob(job: BakeJob) {
  if (jobs.size >= MAX_JOBS) jobs.delete(jobs.keys().next().value as string);
  jobs.set(job.requestId, job);
}
/**
 * The job of a `jig-bake` request, taken once; a bake request without one (a restart, or a
 * request that never came through the bake route) fails instead of running anything.
 */
export function bakeJobOf(request: {
  id: string;
  input: Record<string, unknown>;
}): BakeJob | undefined {
  const jig = request.input.jig;
  if (!jig || typeof jig !== 'object' || (jig as { kind?: unknown }).kind !== 'jig-bake')
    return undefined;
  const job = jobs.get(request.id);
  if (!job) throw new DomainError('BAKE_JOB_MISSING');
  jobs.delete(request.id);
  return job;
}
export const pendingBakeJobs = () => jobs.size;

// --- prepare -----------------------------------------------------------------------------------
export interface PreparedBake {
  projectId: string;
  instanceId: string;
  readId: string;
  read: BakeRead;
  runId: string;
  linkId: string;
  gates: GateResult[];
  /** Block-level gate names that failed, plus argument problems; empty when the bake may run. */
  blocked: string[];
  problems: string[];
  /** Overrides added for `absorb` choices; the instance must be recomputed before baking. */
  absorbed: number;
  plans: {
    decl: BakeDecl;
    plan: BakePlan;
    chunks: BakeChunk[];
    preservedEarlier: number;
    /** 패널링: '표본이 거칩니다' above this sample-vs-surface difference (m). */
    deviationLimit?: number;
  }[];
  codes: string[];
  layers: string[];
  jig: LoadedJig;
  view: InstanceView;
}
const layerPathOf = (layerRoot: string, decl: BakeDecl) => `${layerRoot}::${decl.layer}`;

/** The latest applied record and the unapplied ones whose objects may still be in the document. */
function recordsOf(store: JigStore, instanceId: string, bakeId: string, linkId: string) {
  const all = store.bakes(instanceId, bakeId, linkId);
  const applied = all.filter((record) => record.appliedAt);
  const prior = applied.at(-1);
  const pending = all.filter(
    (record) => !record.appliedAt && (!prior || record.runId !== prior.runId),
  );
  return { prior, pending };
}

export async function prepareBake(ctx: BakeContext, input: BakeInput): Promise<PreparedBake> {
  const { runtime, store } = ctx;
  const view = await runtime.view(input.projectId, input.instanceId);
  // Opened from a request without an output layer (ADR-026): asked for before anything is made.
  // A root that is not in the document yet is fine: the template makes every missing level.
  if (!view.body.layerRoot) throw new DomainError('LAYER_ROOT_MISSING');
  const jig = await runtime.registry.resolve(view.jig.id, view.jig.version);
  const decls = input.bakeIds.map((id) => {
    const decl = bakeDeclOf(jig, id);
    if (!decl) throw new DomainError('NOT_FOUND');
    return decl;
  });
  if (!decls.length) throw new DomainError('INVALID_INPUT');
  const linkId = input.linkId ?? singleLink(view);
  const problems: string[] = [];
  // Items come from computed, current step results only.
  const extracted = decls.map((decl): DeclItems => {
    if (isPanelDecl(decl)) {
      // 패널링 (SPEC-16.9): the stage result → panel items, the picked face's header.
      const { stepId } = itemsPath(decl);
      const step = view.steps.find((s) => s.id === stepId);
      const layoutStep = view.steps.find((s) => s.id === LAYOUT_STEP);
      if (!step || step.status !== 'done' || !layoutStep || layoutStep.status !== 'done')
        throw new DomainError(RESOLVE_CODE);
      const output = runtime.output(input.projectId, input.instanceId, stepId);
      const surfaceInput = jig.manifest.inputs.find((i) => i.kind === 'host-surface');
      const kept = surfaceInput
        ? runtime.hostSurface(input.projectId, input.instanceId, surfaceInput.key)
        : null;
      const rows = panelRows({
        decl,
        stepId,
        output,
        layout:
          stepId === LAYOUT_STEP
            ? output
            : runtime.output(input.projectId, input.instanceId, LAYOUT_STEP),
        sample: (kept?.sample as SurfaceSample | undefined) ?? null,
        manifestParams: jig.manifest.params,
        params: view.body.params,
        layerRoot: view.body.layerRoot,
      });
      // No joint lines (줄눈 0) is fine; no panel is not.
      if (!rows.items.length && !rows.problems.length && isPanelTemplate(decl.template))
        rows.problems.push('만들 패널이 없습니다');
      problems.push(...rows.problems.map((p) => `${decl.id}: ${p}`));
      return {
        decl,
        items: rows.items,
        inputHash: step.inputHash,
        stepId,
        surface: rows.surface,
        deviationLimit: rows.deviationLimit,
      };
    }
    if (isBuiltinBake(decl)) {
      // Built-in bakes read every finished code step; nothing finished yet is not computed.
      const done = view.steps.filter((s) => s.status === 'done');
      if (!done.length) throw new DomainError(RESOLVE_CODE);
      const outputs = done.map((s) => runtime.output(input.projectId, input.instanceId, s.id));
      const result = extractItems(decl, builtinOutput(outputs));
      if (!result.items.length) result.problems.push('만들 항목이 없습니다');
      problems.push(...result.problems.map((p) => `${decl.id}: ${p}`));
      const last = done.at(-1)!;
      return { decl, items: result.items, inputHash: last.inputHash, stepId: last.id };
    }
    const { stepId } = itemsPath(decl);
    const step = view.steps.find((s) => s.id === stepId);
    if (!step || step.status !== 'done') throw new DomainError(RESOLVE_CODE);
    const output = runtime.output(input.projectId, input.instanceId, stepId);
    const result = extractItems(decl, output);
    problems.push(...result.problems.map((p) => `${decl.id}: ${p}`));
    return { decl, items: result.items, inputHash: step.inputHash, stepId };
  });
  // The forced read: the whole document with hidden objects, kept as a pre-bake read (§8).
  const read = await ctx.read(linkId);
  const recorded = runtime.recordRead(input.projectId, input.instanceId, {
    linkId: read.linkId,
    revisionKey: read.revisionKey,
    layers: [],
    includeHidden: true,
    purpose: 'pre-bake',
    model: read.model,
  });
  const runId = randomUUID();
  const gates: GateResult[] = [];
  const blocked = new Set<string>();
  const plans: PreparedBake['plans'] = [];
  const codes: string[] = [];
  const layers: string[] = [];
  let absorbed = 0;
  const analysisConfirmed = () =>
    jig.manifest.steps.some(
      (step) =>
        step.kind === 'human' &&
        step.slot === 'confirm-analysis' &&
        view.steps.find((s) => s.id === step.id)?.status === 'confirmed',
    );
  // SPEC-12.3의 3: a site is made only after a person confirmed the target parcels.
  const targetConfirmed = () =>
    jig.manifest.steps.some(
      (step) =>
        step.kind === 'human' &&
        step.slot === 'confirm-target' &&
        view.steps.find((s) => s.id === step.id)?.status === 'confirmed',
    );
  for (const { decl, items, inputHash, stepId, surface, deviationLimit } of extracted) {
    const layerPath = layerPathOf(view.body.layerRoot, decl);
    layers.push(layerPath);
    // Missing levels are made by the template (ARCH-03 §9.5); only the path text must be usable.
    const pathProblem = layerPathProblem(layerPath);
    if (pathProblem) problems.push(`${decl.id}: 출력 레이어 ${layerPath} — ${pathProblem}`);
    const { prior, pending } = recordsOf(store, input.instanceId, decl.id, linkId);
    const plan = planBake({
      instanceId: input.instanceId,
      bakeId: decl.id,
      planned: items,
      prior,
      pending,
      read: read.model,
      resolve: input.resolve,
      absorbed: absorbedOf(view.body.overrides ?? [], decl.id),
    });
    if (plan.absorbed.length) {
      await runtime.setOverrides(input.projectId, input.instanceId, { add: plan.absorbed });
      absorbed += plan.absorbed.length;
    }
    // Before-bake gates: layer scope, hidden targets, the declaration's own, and the arguments.
    const table = readLayers(read.model);
    const output = layerUsable(table, layerPath);
    const targets = [
      ...plan.hiddenTargets,
      ...(!output.visible || output.locked
        ? [{ key: `(출력 레이어 ${layerPath})`, layer: layerPath, ...output }]
        : []),
    ];
    const uses: GateUse[] = [
      { use: 'layer-scope' },
      { use: 'hidden-target' },
      ...(decl.requires ?? []).map((use) => ({ use })),
    ];
    const run = runGates(uses, 'before-bake', {
      manifest: jig.manifest,
      stepId,
      inputs: {},
      params: view.body.params,
      inputHash,
      layerRoot: view.body.layerRoot,
      bake: { targets, layers: [layerPath] },
      hooks: { analysisConfirmed, targetConfirmed },
    });
    gates.push(...run.results);
    run.blocked.forEach((name) => blocked.add(name));
    const unsafe = unsafeArgs(plan.create);
    gates.push({
      name: 'bake-args-safe',
      timing: 'before-bake',
      level: 'block',
      ok: !unsafe.length,
      failed: unsafe,
      message: unsafe.length ? `키·부호 문자 규칙에 맞지 않는 항목 ${unsafe.length}개` : '',
    });
    if (unsafe.length) blocked.add('bake-args-safe');
    const chunks =
      // 패널링 with nothing to make or delete (no joint lines): no body, no empty host record.
      blocked.size ||
      problems.length ||
      absorbed ||
      (isPanelDecl(decl) && !plan.create.length && !plan.deleteIds.length)
        ? []
        : renderChunks(
            {
              template: decl.template,
              jigId: jig.id,
              instanceId: input.instanceId,
              bakeId: decl.id,
              runId,
              layerPath,
              deleteIds: plan.deleteIds,
              ...(surface ? { surface } : {}),
            },
            plan.create,
          );
    codes.push(...chunks.map((chunk) => chunk.code));
    const planned = new Set(items.map((item) => item.key));
    plans.push({
      decl,
      plan,
      chunks,
      // Person-edited objects of keys the results no longer have (another 패널링 layout).
      preservedEarlier: plan.preserved.filter((p) => !planned.has(p.key)).length,
      ...(deviationLimit !== undefined ? { deviationLimit } : {}),
    });
  }
  return {
    projectId: input.projectId,
    instanceId: input.instanceId,
    readId: recorded.id,
    read,
    runId,
    linkId,
    gates,
    blocked: [...blocked],
    problems,
    absorbed,
    plans,
    codes,
    layers,
    jig,
    view,
  };
}

/** The one Rhino link the instance's assembled roles read; a bake needs an explicit one otherwise. */
function singleLink(view: InstanceView): string {
  const ids = new Set<string>();
  for (const role of Object.values(view.body.assembly))
    for (const source of role.sources) ids.add(source.linkId);
  // A picked face (`host-surface`, 패널링) names its link too (SPEC-16.3).
  for (const surface of Object.values(view.body.hostSurfaces ?? {})) ids.add(surface.linkId);
  if (ids.size !== 1) throw new DomainError('INVALID_INPUT');
  return [...ids][0];
}

// --- finish (after the work copy ran) ------------------------------------------------------------
/**
 * Write the bake records from the worker receipts and describe the candidate. The record's
 * fingerprints stay empty until `recordBaseline` reads the applied document (SPEC-07.17).
 */
export function finishBake(
  ctx: Pick<BakeContext, 'store'>,
  prepared: PreparedBake,
  requestId: string,
  result: Record<string, unknown>,
): { result: Record<string, unknown>; summary: BakeSummary } {
  const values = z.array(z.unknown()).parse(result.values ?? []);
  let index = 0;
  const bakes: BakeOutcome[] = [];
  for (const { decl, plan, chunks, preservedEarlier, deviationLimit } of prepared.plans) {
    const layerPath = layerPathOf(prepared.view.body.layerRoot, decl);
    const failLayer = `${prepared.view.body.layerRoot}::${FAIL_LAYER}`;
    const items: BakeRecordItems = { ...plan.carry };
    const failed: string[] = [];
    const receipts: Receipt[] = [];
    for (const chunk of chunks) {
      const value = values[index++];
      if (rejectionOf(value))
        throw Object.assign(new DomainError('BAKE_SURFACE_CHANGED'), {
          reason: rejectionOf(value),
        });
      const receipt = receiptSchema.parse(value);
      receipts.push(receipt);
      // A panel that failed is left on the failure layer (outline under its key, number `<key>:no`).
      const onFailLayer = new Set(receipt.reasons ? receipt.failed : []);
      receipt.keys.forEach((key, i) => {
        items[key] = {
          nativeId: receipt.ids[i],
          hash: '',
          layer:
            onFailLayer.has(key) || onFailLayer.has(key.replace(/:no$/, ''))
              ? failLayer
              : layerPath,
          runId: prepared.runId,
          state: 'jig',
        };
      });
      failed.push(...receipt.failed);
      // Every planned key came back made or failed; anything else is a template fault.
      const expected = new Set(chunk.keys);
      for (const key of [...receipt.keys, ...receipt.failed]) expected.delete(key);
      if (expected.size) throw new DomainError('BAKE_RECEIPT_MISMATCH');
    }
    const record = ctx.store.addBake(prepared.instanceId, {
      bakeId: decl.id,
      linkId: prepared.linkId,
      requestId,
      runId: prepared.runId,
      items,
      baselineReadId: null,
    });
    const facts = receiptFacts(receipts);
    bakes.push({
      bakeId: decl.id,
      template: decl.template,
      layer: layerPath,
      added: plan.added.filter((key) => !failed.includes(key)),
      replaced: plan.replaced.filter((key) => !failed.includes(key)),
      dropped: plan.dropped,
      preserved: plan.preserved,
      respected: plan.respected,
      kept: plan.kept,
      deleted: plan.deleted,
      copies: plan.copies,
      failed,
      chunks: chunks.length,
      templateHash: chunks[0]?.templateHash ?? '',
      recordId: record.id,
      ...panelFacts(facts, preservedEarlier, deviationLimit),
    });
  }
  const summary = summarize(prepared, bakes);
  return { result: { ...result, text: summary.text, bake: summary }, summary };
}
function summarize(prepared: PreparedBake, bakes: BakeOutcome[]): BakeSummary {
  const totals = {
    added: 0,
    replaced: 0,
    preserved: 0,
    respected: 0,
    copies: 0,
    deleted: 0,
    failed: 0,
  };
  for (const bake of bakes) {
    totals.added += bake.added.length;
    totals.replaced += bake.replaced.length;
    totals.preserved += bake.preserved.length;
    totals.respected += bake.respected.length;
    totals.copies += bake.copies;
    totals.deleted += bake.deleted.length;
    totals.failed += bake.failed.length;
  }
  const parts = [
    `추가 ${totals.added}`,
    `교체 ${totals.replaced}`,
    `사람이 고친 것 보존 ${totals.preserved}`,
    ...(totals.respected ? [`수정 사항으로 받은 것 ${totals.respected}`] : []),
    `복사본 그대로 ${totals.copies}`,
    `사람이 지운 것 ${totals.deleted}`,
  ];
  if (totals.failed) parts.push(`만들지 못함 ${totals.failed}`);
  const earlier = bakes.reduce((n, bake) => n + (bake.preservedEarlier ?? 0), 0);
  if (earlier) parts.push(`이전 배치에서 보존 ${earlier}`);
  return {
    runId: prepared.runId,
    readId: prepared.readId,
    linkId: prepared.linkId,
    revisionKey: prepared.read.revisionKey,
    bakes,
    totals,
    layers: prepared.layers,
    text: `Rhino에 만들기 · ${parts.join(' · ')} · 레이어 ${prepared.layers.join(', ')}`,
  };
}

// --- direct bake (바로 적용, user decision 2026-09-30) -------------------------------------------
/** The host guard of `direct-execute`: a guarded effect without confirmation is undone. */
export interface DirectGuard {
  confirmed: boolean;
  maxDeletes: number;
}
export interface DirectCommand {
  requestId: string;
  code: string;
  label: string;
  guard: DirectGuard;
}
export interface DirectChange {
  nativeId: string;
  hash?: string;
  layer?: string;
}
export interface DirectResult {
  ok: boolean;
  undoId?: string;
  changes?: { added?: DirectChange[]; changed?: DirectChange[]; removed?: DirectChange[] };
  guarded?: { kind: string; detail?: unknown };
  /** The body's return value, when the host passes it on (a template's receipt). */
  value?: unknown;
  log?: unknown;
  code?: string;
  reason?: string;
}
/** The attached editor's direct commands (`direct-execute`, `direct-undo`, `fingerprint`). */
export interface DirectHost {
  execute(target: HostTarget, command: DirectCommand): Promise<DirectResult>;
  undo(target: HostTarget, undoId: string): Promise<{ ok: boolean; reason?: string }>;
  fingerprint?(target: HostTarget): Promise<{ documentHash: string; revision?: unknown }>;
}
export interface DirectBakeContext extends BakeContext {
  direct: DirectHost;
}
/** What `undoBake` needs of a direct run; kept for this engine process (the host's undo stack). */
interface DirectRun {
  instanceId: string;
  target: HostTarget;
  undoIds: string[];
  recordIds: string[];
}
const directRuns = new Map<string, DirectRun>();
const directFailure = (code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new DomainError(code), extra);

/** Undo the records of a run, newest first; the first refusal stops (the rest stay). */
async function undoAll(direct: DirectHost, target: HostTarget, undoIds: readonly string[]) {
  for (const undoId of [...undoIds].reverse()) {
    const undone = await direct.undo(target, undoId);
    if (!undone.ok) return undone.reason ?? 'failed';
  }
  return undefined;
}

/**
 * Run a prepared bake in the attached document: every body through `direct-execute`, each inside
 * one host undo record labelled 'VIDE jig: <name>'. The guard allows deleting only as many objects
 * as the body lists (recorded GUIDs, re-checked by their tags in the template), and every removed
 * object must be one of them; otherwise the run is undone (`BAKE_GUARDED`). A failing body undoes
 * the bodies before it (`BAKE_FAILED`). The document is read right after the run: the record gets
 * its fingerprints and `appliedAt` at once. A failed read keeps the record without fingerprints
 * (the card's [반영 결과 읽기] retries it through `recordBaseline`) when the receipts say which
 * key became which object, and undoes the run when they do not.
 */
export async function runDirectBake(
  ctx: DirectBakeContext,
  prepared: PreparedBake,
  target: HostTarget,
): Promise<{ result: Record<string, unknown>; summary: BakeSummary; undoIds: string[] }> {
  const { direct } = ctx;
  if (!prepared.codes.length) throw new DomainError('INVALID_INPUT');
  if (direct.fingerprint) {
    // The document must still be the one the forced read saw.
    const expected = (prepared.read.model.sourceDocument as { documentHash?: unknown } | undefined)
      ?.documentHash;
    const now = await direct.fingerprint(target);
    if (typeof expected === 'string' && now.documentHash !== expected)
      throw new DomainError('STALE_INPUT');
  }
  const requestId = randomUUID();
  const label = `VIDE jig: ${prepared.jig.manifest.name}`;
  const undoIds: string[] = [];
  const values: unknown[] = [];
  const log: unknown[] = [];
  let removedTotal = 0;
  const rollback = async (code: string, extra: Record<string, unknown> = {}) => {
    const undoFailed = await undoAll(direct, target, undoIds);
    throw directFailure(code, { ...extra, ...(undoFailed ? { undoFailed } : {}) });
  };
  for (const { chunks } of prepared.plans)
    for (const chunk of chunks) {
      const allowed = new Set(chunk.deleteIds.map((id) => id.toLowerCase()));
      let run: DirectResult;
      try {
        run = await direct.execute(target, {
          requestId: `${requestId}:${undoIds.length}`,
          code: chunk.code,
          label,
          guard: { confirmed: false, maxDeletes: chunk.deleteIds.length },
        });
      } catch (error) {
        // Refused before it touched the document (read-only, busy, closed): this body did not run;
        // the bodies before it are undone. Any other failure leaves the document unknown.
        const refusal = directRefusal('rhino', error);
        if (!refusal) throw error;
        await rollback('BAKE_FAILED', { reason: refusal.code, refused: refusal.reason });
        throw error;
      }
      if (run.log !== undefined) log.push(run.log);
      if (run.guarded)
        // The host already undid this body's record; the ones before it are undone here.
        await rollback('BAKE_GUARDED', { guarded: run.guarded });
      // A panel template made nothing: the face is not the one the sample was read from
      // (SPEC-16.9 2 '기준 면이 바뀜 · 다시 읽기'); the bodies before it are undone.
      const rejected = run.ok ? rejectionOf(run.value) : undefined;
      if (rejected) await rollback('BAKE_SURFACE_CHANGED', { reason: rejected });
      if (!run.ok || !run.undoId)
        await rollback('BAKE_FAILED', { reason: run.reason ?? run.code, log: run.log });
      undoIds.push(run.undoId!);
      const removed = run.changes?.removed ?? [];
      // Bakes never delete an object no record lists.
      if (removed.some((object) => !allowed.has(object.nativeId.toLowerCase())))
        await rollback('BAKE_GUARDED', {
          guarded: { kind: 'bulk-delete', detail: '기록에 없는 객체를 지우려 했습니다' },
        });
      removedTotal += removed.length;
      values.push(run.value ?? null);
    }
  // The read right after the run is the baseline (SPEC-07.17); objects match by run and key.
  let read: BakeRead | undefined;
  try {
    read = await ctx.read(prepared.linkId);
  } catch (error) {
    if (!values.every((value) => receiptSchema.safeParse(value).success))
      await rollback('BAKE_READ_FAILED', {
        cause: error instanceof Error ? error.message : String(error),
      });
  }
  const baseline = read
    ? ctx.runtime.recordRead(prepared.projectId, prepared.instanceId, {
        linkId: read.linkId,
        revisionKey: read.revisionKey,
        layers: [],
        includeHidden: true,
        purpose: 'pre-bake',
        model: read.model,
      })
    : undefined;
  const found = new Map<string, { nativeId: string; hash: string; layer: string }>();
  if (read)
    for (const object of readObjects(read.model).values())
      if (object.tags['vide-run'] === prepared.runId && object.tags['vide-key'])
        found.set(`${object.tags['vide-bake']}\u0000${object.tags['vide-key']}`, object);
  const appliedAt = new Date().toISOString();
  const bakes: BakeOutcome[] = [];
  let index = 0;
  for (const { decl, plan, chunks, preservedEarlier, deviationLimit } of prepared.plans) {
    const layerPath = layerPathOf(prepared.view.body.layerRoot, decl);
    const items: BakeRecordItems = { ...plan.carry };
    const failed: string[] = [];
    const receipts: Receipt[] = [];
    for (const chunk of chunks) {
      const receipt = receiptSchema.safeParse(values[index++]);
      if (receipt.success) receipts.push(receipt.data);
      const ids = receipt.success
        ? new Map(receipt.data.keys.map((key, i) => [key, receipt.data.ids[i]]))
        : undefined;
      // Objects a template made beside a planned key (a failed panel's number `<key>:no`) are
      // recorded too, so the next bake replaces or removes them like the rest.
      const extra = receipt.success
        ? receipt.data.keys.filter((key) => !chunk.keys.includes(key))
        : [];
      // Failed panels left on the failure layer have an object, but they are failures all the same.
      if (receipt.success && receipt.data.reasons) failed.push(...receipt.data.failed);
      for (const key of [...chunk.keys, ...extra]) {
        const object = found.get(`${decl.id}\u0000${key}`);
        const nativeId = object?.nativeId ?? (read ? undefined : ids?.get(key));
        if (!nativeId) {
          failed.push(key);
          continue;
        }
        items[key] = {
          nativeId,
          hash: object?.hash ?? '',
          layer: object?.layer ?? layerPath,
          runId: prepared.runId,
          state: 'jig',
        };
      }
    }
    const added = ctx.store.addBake(prepared.instanceId, {
      bakeId: decl.id,
      linkId: prepared.linkId,
      requestId,
      runId: prepared.runId,
      items,
      baselineReadId: baseline?.id ?? null,
    });
    const record = baseline
      ? ctx.store.updateBake(prepared.instanceId, added.id, { appliedAt })
      : added;
    const failedSet = new Set(failed);
    bakes.push({
      bakeId: decl.id,
      template: decl.template,
      layer: layerPath,
      added: plan.added.filter((key) => !failedSet.has(key)),
      replaced: plan.replaced.filter((key) => !failedSet.has(key)),
      dropped: plan.dropped,
      preserved: plan.preserved,
      respected: plan.respected,
      kept: plan.kept,
      deleted: plan.deleted,
      copies: plan.copies,
      failed: [...failedSet],
      chunks: chunks.length,
      templateHash: chunks[0]?.templateHash ?? '',
      recordId: record.id,
      ...panelFacts(receiptFacts(receipts), preservedEarlier, deviationLimit),
    });
  }
  directRuns.set(prepared.runId, {
    instanceId: prepared.instanceId,
    target,
    undoIds,
    recordIds: bakes.map((bake) => bake.recordId!),
  });
  if (directRuns.size > MAX_JOBS) directRuns.delete(directRuns.keys().next().value as string);
  const summarized = summarize(prepared, bakes);
  const summary = {
    ...summarized,
    // Several bodies are several Rhino undo records (SPEC-16.9 1).
    text:
      undoIds.length > 1
        ? `${summarized.text} · Rhino Ctrl+Z ${undoIds.length}번`
        : summarized.text,
    direct: true,
    undos: undoIds.length,
  };
  return {
    result: {
      text: summary.text,
      bake: summary,
      requestId,
      undoIds,
      removed: removedTotal,
      baseline: baseline ? 'recorded' : 'pending',
      ...(log.length ? { log } : {}),
    },
    summary,
    undoIds,
  };
}

/** Whether the run of a record can still be undone from VIDE (this engine process made it). */
export const bakeUndoable = (record: Pick<JigBake, 'runId' | 'instanceId'>) =>
  directRuns.get(record.runId)?.instanceId === record.instanceId;

/**
 * [되돌리기] of a direct bake: the host undoes the run's records, newest first, only while they
 * are the document's latest (`BAKE_UNDO_NOT_LATEST` otherwise). The run's records lose `appliedAt`
 * so the next bake plans from the bake before it again (its objects are back).
 */
export async function undoBake(
  ctx: Pick<BakeContext, 'store'> & { direct: DirectHost },
  instanceId: string,
  recordId: string,
): Promise<{ ok: true; runId: string; records: string[] }> {
  const record = ctx.store.bake(instanceId, recordId);
  const run = directRuns.get(record.runId);
  if (!run || run.instanceId !== instanceId) throw new DomainError('BAKE_UNDO_UNAVAILABLE');
  const [latest, ...rest] = [...run.undoIds].reverse();
  const first = await ctx.direct.undo(run.target, latest);
  if (!first.ok)
    throw directFailure(
      first.reason === 'not-latest' ? 'BAKE_UNDO_NOT_LATEST' : 'BAKE_UNDO_FAILED',
      { reason: first.reason },
    );
  const remaining = rest.reverse();
  const failed = await undoAll(ctx.direct, run.target, remaining);
  directRuns.delete(record.runId);
  for (const id of run.recordIds) ctx.store.updateBake(instanceId, id, { appliedAt: null });
  if (failed) throw directFailure('BAKE_UNDO_FAILED', { reason: failed, partial: true });
  return { ok: true, runId: record.runId, records: run.recordIds };
}

// --- baseline (after the person applied the candidate) ------------------------------------------
/**
 * Read the applied document and store the display-path fingerprints of this run's objects in the
 * record (ARCH-03 §9.3 6). Objects are matched by `vide-run` and `vide-key`, so a GUID the
 * application had to change is corrected too. Without any object of the run the candidate was
 * not applied (`NOT_APPLIED`); a failed read leaves the record as it is, to be retried.
 */
export async function recordBaseline(
  ctx: BakeContext,
  projectId: string,
  instanceId: string,
  recordId: string,
): Promise<{ record: JigBake; recorded: number; missing: string[] }> {
  const record = ctx.store.bake(instanceId, recordId);
  const read = await ctx.read(record.linkId);
  const byKey = new Map<string, { nativeId: string; hash: string; layer: string }>();
  for (const object of readObjects(read.model).values())
    if (object.tags['vide-run'] === record.runId && object.tags['vide-key'])
      byKey.set(object.tags['vide-key'], object);
  if (!byKey.size) throw new DomainError('NOT_APPLIED');
  const recorded = ctx.runtime.recordRead(projectId, instanceId, {
    linkId: read.linkId,
    revisionKey: read.revisionKey,
    layers: [],
    includeHidden: true,
    purpose: 'pre-bake',
    model: read.model,
  });
  const items = { ...(record.items as BakeRecordItems) };
  const missing: string[] = [];
  let count = 0;
  for (const [key, item] of Object.entries(items)) {
    if (item.runId !== record.runId || item.state !== 'jig') continue;
    const object = byKey.get(key);
    if (!object) {
      missing.push(key);
      continue;
    }
    items[key] = { ...item, nativeId: object.nativeId, hash: object.hash, layer: object.layer };
    count++;
  }
  const updated = ctx.store.updateBake(instanceId, recordId, {
    items,
    baselineReadId: recorded.id,
    appliedAt: new Date().toISOString(),
  });
  return { record: updated, recorded: count, missing };
}

/** Records of an instance for the card: one line per bake and link, newest first. */
export function bakeRecords(store: JigStore, instanceId: string, jig: LoadedJig, linkId?: string) {
  const out: (JigBake & { pendingBaseline: boolean; undone: boolean; undoable: boolean })[] = [];
  for (const decl of bakeDeclsOf(jig)) {
    const records = linkId
      ? store.bakes(instanceId, decl.id, linkId)
      : allBakes(store, instanceId, decl.id);
    for (const record of records) {
      // A record with a baseline read but no `appliedAt` was undone (`undoBake`).
      const undone = !record.appliedAt && !!record.baselineReadId;
      out.push({
        ...record,
        pendingBaseline: !record.appliedAt && !undone,
        undone,
        undoable: !undone && bakeUndoable(record),
      });
    }
  }
  return out.reverse();
}
function allBakes(store: JigStore, instanceId: string, bakeId: string) {
  const links = new Set<string>();
  for (const read of store.reads(instanceId)) links.add(read.linkId);
  return [...links].flatMap((linkId) => store.bakes(instanceId, bakeId, linkId));
}
/** The bakes an instance can offer, for the card (the jig's own, then the built-ins). */
export const bakeOffers = (jig: LoadedJig) =>
  bakeDeclsOf(jig).map((decl) => ({
    id: decl.id,
    template: decl.template,
    layer: decl.layer,
    requires: decl.requires ?? [],
    builtin: isBuiltinBake(decl),
  }));
export type { BakeItem, BakePlan, Preserved, Resolve };
