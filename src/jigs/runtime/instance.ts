// Instance body (작업본, ARCH-03 §4, SPEC-07.4): what one project keeps for one jig version —
// output layer, assembled input roles, settings, zones and overrides — as one JSON value in
// `jig_instances.body`. Zod schemas guard what the routes accept.

import { z } from 'zod';
import type { ParamValue } from './params.ts';

export interface AssembledSource {
  linkId: string;
  readId: string;
  layers: string[];
  objectIds?: string[];
  revisionKey: string;
}
export interface AssembledRole {
  role: string;
  sources: AssembledSource[];
  transform?: { matrix: number[]; method: 'sync-align'; pairs: number; residual_m: number };
  proposedBy: 'rule' | 'ai';
  reason?: string;
  confirmed?: { by: string; at: string };
  /** The extracted role geometry (ARCH-03 §2.3 입력 역할 사본). */
  snapshot: { ref: string; hash: string };
}
export interface Zone {
  id: string;
  shape: [number, number][];
  source: ParamValue;
}
export interface Override {
  id: string;
  target: { kind: string; identity: Record<string, string | number> };
  op: 'move' | 'add' | 'remove' | 'set' | 'pin';
  fields: Record<string, unknown>;
  origin: 'pen' | 'chat' | 'table' | 'host-edit';
  by: 'user' | 'ai';
  at: string;
  note?: string;
}
export interface InstanceBody {
  layerRoot: string;
  /** Assembly roles by `<inputKey>.<role>`. */
  assembly: Record<string, AssembledRole>;
  params: Record<string, ParamValue>;
  zones: Record<string, Zone[]>;
  overrides: Override[];
  conversationId?: string;
  bakeStale?: boolean;
  /** `site-data` inputs by key (ARCH-03 §8.3): references to the kept read-copies. */
  siteData?: Record<string, SiteDataState>;
  /**
   * `jig-output` inputs by key (ARCH-03 §8.5): the earlier instance the person chose. Absent = the
   * project's latest instance of that jig whose output is computed.
   */
  jigOutputs?: Record<string, JigOutputBinding>;
  /** The source each `jig-output` input had at the last kept run ('다시 계산 필요' when it moved). */
  jigOutputsUsed?: Record<string, JigOutputUse>;
  /**
   * `host-document` inputs by key (ARCH-03 §8.6): the last read the engine classified for this
   * instance (the kept model and what it was read from).
   */
  hostDocuments?: Record<string, HostDocumentRef>;
  /**
   * `host-surface` inputs by key (SPEC-16.3·16.12, PLAN-49 T-251): the picked faces and the kept
   * sample of their last read (an input copy that [다시 읽기] replaces).
   */
  hostSurfaces?: Record<string, HostSurfaceRef>;
  /**
   * `host-curves` inputs by key (SPEC-16.13, PLAN-49 T-260): the picked points and curves and the
   * kept copy of their last read.
   */
  hostCurves?: Record<string, HostCurvesRef>;
}
export interface HostCurvesRef {
  /** The kept `CurveSet` under `<data>/jigs/` and the hash of its content. */
  ref: string;
  hash: string;
  linkId: string;
  objectIds: string[];
  /** Points and polylines read, for the card. */
  count: number;
  readAt: string;
}
export interface HostSurfaceRef {
  /** The kept `SurfaceSample` under `<data>/jigs/` and the hash of its content. */
  ref: string;
  hash: string;
  linkId: string;
  documentKey: string;
  objectId: string;
  /** Face indexes read (Rhino Brep face index). */
  faces: number[];
  /** `geometryHash` of each face as the read template computed it (same order as `faces`). */
  faceHashes: string[];
  revisionKey: string;
  /** Sample grid per face (nu = nv). */
  grid: number;
  readAt: string;
  /**
   * The object's display `geometryHash` in the link's Live Sync model at read time (null when
   * that model did not have it): a later Sync row with another hash means '기준 면이 바뀜'.
   */
  syncHash: string | null;
}
export interface HostDocumentRef {
  /** The kept model under `<data>/jigs/` and the hash of its read (`revisionKey` + `rolesVersion`). */
  ref: string;
  hash: string;
  readId: string;
  linkId: string;
  revisionKey: string;
  rolesVersion: number;
  at: string;
}
export interface JigOutputBinding {
  instanceId: string;
  at: string;
}
export interface JigOutputUse {
  instanceId: string;
  hash: string;
  at: string;
}

/** A kept copy under `<data>/jigs/` (gzip JSON) and the hash of its content. */
export interface SiteCopyRef {
  ref: string;
  hash: string;
  at: string;
}
export interface SiteCollectionRef extends SiteCopyRef {
  fetchedAt: string;
  pnus: string[];
  radius: number;
}
/**
 * One `site-data` input (SPEC-12.3·12.4): the address asked, the candidate lookup, the chosen
 * parcels, the collection in use, a newer collection waiting to be taken ([다시 가져오기]) with
 * what changed, earlier collections (never overwritten) and the SHP files put in.
 */
export interface SiteDataState {
  query?: string;
  lookup?: SiteCopyRef;
  targets?: { pnus: string[]; by: 'proposal' | 'user'; at: string };
  collection?: SiteCollectionRef;
  pending?: SiteCollectionRef & { changes: string[] };
  previous?: SiteCollectionRef[];
  /** The SHP import (`ref`) and the files put in (`raw`, re-imported together when more come). */
  shp?: SiteCopyRef & { files: string[]; raw: SiteCopyRef };
}

const identity = z.record(z.string(), z.union([z.string(), z.number()]));
export const overrideSchema = z
  .object({
    id: z.string().min(1).max(100).optional(),
    target: z.object({ kind: z.string().min(1).max(50), identity }).strict(),
    op: z.enum(['move', 'add', 'remove', 'set', 'pin']),
    fields: z.record(z.string(), z.unknown()),
    origin: z.enum(['pen', 'chat', 'table', 'host-edit']),
    by: z.enum(['user', 'ai']),
    note: z.string().max(500).optional(),
  })
  .strict();
export const zoneSchema = z
  .object({
    id: z.string().min(1).max(100),
    shape: z
      .array(z.tuple([z.number(), z.number()]))
      .min(2)
      .max(10000),
    source: z
      .object({
        value: z.union([z.number(), z.string(), z.boolean()]),
        by: z.enum(['default', 'user', 'decision', 'fact', 'ai', 'rhino', 'sketch']),
        ref: z.string().max(200).optional(),
        at: z.string(),
        note: z.string().max(500).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const transformSchema = z
  .object({
    matrix: z.array(z.number()).length(16),
    method: z.literal('sync-align'),
    pairs: z.number().int().nonnegative(),
    residual_m: z.number().nonnegative(),
  })
  .strict();

export function emptyBody(layerRoot: string, params: Record<string, ParamValue>): InstanceBody {
  return { layerRoot, assembly: {}, params, zones: {}, overrides: [] };
}
export function bodyOf(value: unknown): InstanceBody {
  const body = (value ?? {}) as Partial<InstanceBody>;
  return {
    layerRoot: body.layerRoot ?? '',
    assembly: body.assembly ?? {},
    params: body.params ?? {},
    zones: body.zones ?? {},
    overrides: body.overrides ?? [],
    ...(body.conversationId ? { conversationId: body.conversationId } : {}),
    ...(body.bakeStale ? { bakeStale: true } : {}),
    ...(body.siteData ? { siteData: body.siteData } : {}),
    ...(body.jigOutputs ? { jigOutputs: body.jigOutputs } : {}),
    ...(body.jigOutputsUsed ? { jigOutputsUsed: body.jigOutputsUsed } : {}),
    ...(body.hostDocuments ? { hostDocuments: body.hostDocuments } : {}),
    ...(body.hostSurfaces ? { hostSurfaces: body.hostSurfaces } : {}),
    ...(body.hostCurves ? { hostCurves: body.hostCurves } : {}),
  };
}
