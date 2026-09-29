// Structure analysis jig (J-09, SPEC-06): draft → check → confirm → analyse, with a per-project record.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  StructureModel,
  StructureModelInput,
  StructureResult,
} from '../../contracts/structure-model.ts';
import { hId, hName, parseSectionName } from './sections.ts';
import { analyzeStructure, modelHash } from './core.ts';
import {
  buildDraft,
  type Draft,
  type DraftIssue,
  type DraftOptions,
  type DraftSource,
} from './input.ts';
import { distributeAreaLoads, type LedgerRow } from './loads.ts';
import { checkModel, classifyFailures } from './review.ts';

export { buildDraft, checkModel };
export type { DraftIssue, DraftOptions, DraftSource };

/** Identity of the document a Sync result came from, to tell a newer Sync of the same document. */
export function documentKey(result: Record<string, unknown>): string {
  const doc = (result.sourceDocument ?? {}) as Record<string, unknown>;
  const host = String(result.host ?? 'rhino');
  return `${host}:${String(doc.documentId ?? doc.id ?? doc.path ?? doc.name ?? '')}`;
}

export interface StructureDraftRecord {
  createdAt: string;
  model: StructureModelInput;
  issues: DraftIssue[];
  checks: DraftIssue[];
  sources: { syncId: string; documentKey: string; mode: DraftSource['mode'] }[];
}

export interface StructureRecord {
  confirmedAt: string;
  modelHash: string;
  model: StructureModel;
  sources: { syncId: string; documentKey: string }[];
  ledger: LedgerRow[];
  issues: DraftIssue[];
  result: StructureResult;
}

export function draftStructure(
  sources: DraftSource[],
  options?: DraftOptions,
): Draft & { checks: DraftIssue[] } {
  const draft = buildDraft(sources, options);
  const { issues } = checkModel(draft.model);
  return { ...draft, checks: issues };
}

/** Analyse a confirmed model: contract → area loads → core → failure causes. */
export function analyzeConfirmed(input: unknown): {
  model: StructureModel;
  ledger: LedgerRow[];
  issues: DraftIssue[];
  result: StructureResult;
} {
  const { issues, model } = checkModel(input);
  if (!model || issues.some((i) => i.level === 'error'))
    throw Object.assign(new Error('The model has blocking check errors'), {
      code: 'STRUCTURE_MODEL_INVALID',
      issues,
    });
  const distributed = distributeAreaLoads(model);
  const raw = analyzeStructure(distributed.model);
  const result =
    raw.status === 'ok'
      ? classifyFailures(model, { ...raw, modelHash: modelHash(model) }, distributed.ledger)
      : raw;
  return { model, ledger: distributed.ledger, issues, result };
}

const names = z.array(z.string().max(120)).max(20000);
const point = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
/** Small edits the screen sends instead of a whole model (requests are limited to 1 MB). */
export const draftEditsSchema = z
  .object({
    sections: z
      .array(z.object({ members: names, name: z.string().max(60) }).strict())
      .max(200)
      .optional(),
    roles: z
      .array(
        z
          .object({ members: names, role: z.enum(['column', 'girder', 'beam', 'brace', 'other']) })
          .strict(),
      )
      .max(200)
      .optional(),
    supports: z
      .array(z.object({ nodes: names, fixity: z.enum(['pin', 'fixed', 'free']) }).strict())
      .max(200)
      .optional(),
    joints: z
      .array(
        z
          .object({ member: z.string(), end: z.enum(['i', 'j']), value: z.enum(['rigid', 'pin']) })
          .strict(),
      )
      .max(5000)
      .optional(),
    areaLoads: z
      .array(
        z
          .object({
            id: z.string().max(60),
            pattern: z.enum(['D', 'L']),
            polygon_m: z.array(point).min(3).max(200),
            value_kPa: z.number().finite(),
            spanDirection: z.enum(['X', 'Y']).optional(),
          })
          .strict(),
      )
      .max(200)
      .optional(),
    combinations: z
      .array(
        z
          .object({
            id: z.string().max(60),
            terms: z
              .array(
                z.object({ pattern: z.enum(['D', 'L']), factor: z.number().finite() }).strict(),
              )
              .min(1),
            limitState: z.enum(['strength', 'service']),
          })
          .strict(),
      )
      .min(1)
      .max(30)
      .optional(),
  })
  .strict();
export type DraftEdits = z.infer<typeof draftEditsSchema>;

const SUPPORTS = {
  pin: { dx: true, dy: true, dz: true, rz: true },
  fixed: { dx: true, dy: true, dz: true, rx: true, ry: true, rz: true },
};

/** Apply user edits to a draft; edited items become `by: 'user'`, not assumed. */
export function applyEdits(model: StructureModelInput, edits: DraftEdits): StructureModelInput {
  const out = structuredClone(model);
  const user = { by: 'user' as const, assumed: false };
  for (const edit of edits.sections ?? []) {
    const parsed = parseSectionName(edit.name);
    if (!parsed)
      throw Object.assign(new Error(`section name ${edit.name}`), { code: 'INVALID_INPUT' });
    const id = parsed.shape === 'BH' ? `B${hId(parsed.dims)}` : hId(parsed.dims);
    if (!out.sections.some((s) => s.id === id))
      out.sections.push({
        id,
        name: (parsed.shape === 'BH' ? 'B' : '') + hName(parsed.dims),
        shape: parsed.shape,
        dims_mm: parsed.dims.r
          ? { ...parsed.dims }
          : { h: parsed.dims.h, b: parsed.dims.b, tw: parsed.dims.tw, tf: parsed.dims.tf },
        source: 'user',
        provenance: user,
      });
    const set = new Set(edit.members);
    for (const m of out.members) if (set.has(m.id)) m.section = id;
  }
  for (const edit of edits.roles ?? []) {
    const set = new Set(edit.members);
    for (const m of out.members)
      if (set.has(m.id)) {
        m.role = edit.role;
        m.kind = edit.role === 'brace' ? 'truss' : 'frame';
        m.provenance = { ...user, note: '사용자가 역할 지정' };
      }
  }
  for (const edit of edits.supports ?? []) {
    const set = new Set(edit.nodes);
    for (const n of out.nodes)
      if (set.has(n.id)) {
        if (edit.fixity === 'free') delete n.support;
        else n.support = SUPPORTS[edit.fixity];
        n.provenance = user;
      }
  }
  for (const joint of edits.joints ?? []) {
    const m = out.members.find((x) => x.id === joint.member);
    if (!m) continue;
    const releases = { ...(m.releases ?? {}) } as Record<string, Record<string, boolean>>;
    if (joint.value === 'pin') releases[joint.end] = { ry: true, rz: true };
    else delete releases[joint.end];
    m.releases = Object.keys(releases).length ? releases : undefined;
  }
  if (edits.areaLoads) out.areaLoads = edits.areaLoads.map((a) => ({ ...a, provenance: user }));
  if (edits.combinations) out.combinations = edits.combinations;
  // Drop the placeholder section once nothing uses it.
  if (!out.members.some((m) => m.section === 'UNASSIGNED'))
    out.sections = out.sections.filter((s) => s.id !== 'UNASSIGNED');
  return out;
}

/** One JSON file per project under the data folder (in memory for ':memory:' stores). */
export class StructureStore {
  private readonly directory: string | null;
  private readonly memory = new Map<
    string,
    { draft?: StructureDraftRecord; confirmed?: StructureRecord }
  >();

  constructor(directory: string | null) {
    this.directory = directory;
  }
  private file(projectId: string) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(projectId))
      throw Object.assign(new Error('bad project id'), { code: 'INVALID_INPUT' });
    return join(this.directory!, `${projectId}.json`);
  }
  get(projectId: string): { draft?: StructureDraftRecord; confirmed?: StructureRecord } {
    if (!this.directory) return this.memory.get(projectId) ?? {};
    const path = this.file(projectId);
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  save(projectId: string, value: { draft?: StructureDraftRecord; confirmed?: StructureRecord }) {
    if (!this.directory) {
      this.memory.set(projectId, value);
      return;
    }
    mkdirSync(this.directory, { recursive: true });
    const path = this.file(projectId);
    writeFileSync(path + '.tmp', JSON.stringify(value));
    renameSync(path + '.tmp', path);
  }
}
