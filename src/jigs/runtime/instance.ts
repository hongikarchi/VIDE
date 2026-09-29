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
  };
}
