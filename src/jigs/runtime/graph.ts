// Step graph (ARCH-03 §6.3, SPEC-07.7): the declared `needs` and `reads` of each step are its
// dependency edges. The graph gives the run order, the steps a changed setting or input touches
// (those reading it and everything after them) and cycle detection for the validator.

import type { JigManifest, StepDecl } from './manifest.ts';

export type ParsedRead =
  | { kind: 'input'; key: string; role?: string; text: string }
  | { kind: 'param'; key: string; text: string }
  | { kind: 'step'; id: string; text: string };

export function parseRead(text: string): ParsedRead | null {
  const parts = text.split('.');
  if (parts[0] === 'input' && parts.length >= 2 && parts.length <= 3 && parts[1])
    return { kind: 'input', key: parts[1], ...(parts[2] ? { role: parts[2] } : {}), text };
  if (parts[0] === 'param' && parts.length === 2 && parts[1])
    return { kind: 'param', key: parts[1], text };
  if (parts[0] === 'step' && parts.length === 2 && parts[1])
    return { kind: 'step', id: parts[1], text };
  return null;
}

export interface StepGraph {
  order: string[];
  steps: Map<string, StepDecl>;
  /** Direct predecessors (needs + step reads). */
  needs: Map<string, Set<string>>;
  /** The given steps and every step after them. */
  downstream(ids: Iterable<string>): string[];
  /** Steps reading a setting (declared `affects` included) and everything after them. */
  affectedByParams(keys: Iterable<string>): string[];
  /** Steps reading an input key (optionally one role) and everything after them. */
  affectedByInputs(keys: Iterable<string>): string[];
  readsOf(id: string): ParsedRead[];
}

/** Build the graph; `cycle` names the steps left in a cycle when there is one. */
export function buildGraph(manifest: Pick<JigManifest, 'steps' | 'params'>): {
  graph: StepGraph;
  cycle: string[];
} {
  const steps = new Map(manifest.steps.map((step) => [step.id, step]));
  const needs = new Map<string, Set<string>>();
  const reads = new Map<string, ParsedRead[]>();
  for (const step of manifest.steps) {
    const parsed = step.reads.map(parseRead).filter((r): r is ParsedRead => !!r);
    reads.set(step.id, parsed);
    const before = new Set(step.needs ?? []);
    for (const read of parsed) if (read.kind === 'step') before.add(read.id);
    before.delete(step.id);
    needs.set(step.id, before);
  }
  // Kahn's order, keeping declaration order among ready steps.
  const remaining = new Map(
    [...needs].map(([id, set]) => [id, new Set([...set].filter((n) => steps.has(n)))]),
  );
  const order: string[] = [];
  while (remaining.size) {
    const ready = manifest.steps.map((s) => s.id).filter((id) => remaining.get(id)?.size === 0);
    if (!ready.length) break;
    for (const id of ready) {
      order.push(id);
      remaining.delete(id);
      for (const set of remaining.values()) set.delete(id);
    }
  }
  const cycle = [...remaining.keys()];
  const successors = new Map<string, Set<string>>();
  for (const [id, before] of needs)
    for (const n of before) {
      if (!successors.has(n)) successors.set(n, new Set());
      successors.get(n)!.add(id);
    }
  const downstream = (ids: Iterable<string>) => {
    const seen = new Set<string>();
    const stack = [...ids].filter((id) => steps.has(id));
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of successors.get(id) ?? []) stack.push(next);
    }
    return order.filter((id) => seen.has(id));
  };
  const affects = new Map(manifest.params.map((p) => [p.key, p.affects]));
  const graph: StepGraph = {
    order,
    steps,
    needs,
    downstream,
    affectedByParams: (keys) => {
      const start = new Set<string>();
      for (const key of keys) {
        for (const id of affects.get(key) ?? []) start.add(id);
        for (const [id, list] of reads)
          if (list.some((r) => r.kind === 'param' && r.key === key)) start.add(id);
      }
      return downstream(start);
    },
    affectedByInputs: (keys) => {
      const wanted = new Set(keys);
      const start = new Set<string>();
      for (const [id, list] of reads)
        if (
          list.some(
            (r) =>
              r.kind === 'input' &&
              (wanted.has(r.key) || (r.role !== undefined && wanted.has(`${r.key}.${r.role}`))),
          )
        )
          start.add(id);
      return downstream(start);
    },
    readsOf: (id) => reads.get(id) ?? [],
  };
  return { graph, cycle };
}
