import type { z } from 'zod';
import type { workspaceResultSchema } from '../contracts/workspace-result.ts';

type Model = z.infer<typeof workspaceResultSchema>;

type Row = { id: string; [key: string]: unknown };
/** A stored model read lazily (`ModelView.entries`/`count`, T-123): the turn never loads it whole. */
export interface ModelEntries {
  count(): number;
  entries(options: { ids?: readonly string[]; limit?: number }): {
    object?: Record<string, unknown>;
    scene?: Record<string, unknown>;
  }[];
}

/**
 * Initial orientation only. Native queries and write protection retain the full model. `view`: a
 * display Sync stored per object; only the pinned objects and the first ones are read from it.
 */
export function modelContext(model: Model | undefined, priorityIds: string[], view?: ModelEntries) {
  const priority = new Set(priorityIds);
  let objects: Model['objects'] & Row[];
  let scene: Map<string, NonNullable<Model['scene']>[number]>;
  let total: number;
  if (view) {
    // The pinned objects, then the first ones in display order (an object row and its scene item
    // may be two manifest entries: twice the rows cover the first hundred objects).
    const read = [
      ...view.entries({ ids: [...priority] }),
      ...view.entries({ limit: 2 * (100 + priority.size) }),
    ];
    const seen = new Set<string>();
    objects = [] as unknown as typeof objects;
    scene = new Map();
    for (const entry of read) {
      const object = entry.object as Row | undefined;
      if (object && !seen.has(object.id)) {
        seen.add(object.id);
        objects.push(object);
      }
      const item = entry.scene as { id?: unknown } | undefined;
      if (item && typeof item.id === 'string' && !scene.has(item.id))
        scene.set(item.id, item as never);
    }
    total = view.count();
  } else {
    objects = (model?.objects ?? []) as typeof objects;
    scene = new Map((model?.scene ?? []).map((item) => [item.id, item]));
    total = objects.length;
  }
  const ordered = [
    ...objects.filter((item) => priority.has(item.id)),
    ...objects.filter((item) => !priority.has(item.id)),
  ];
  const selected: unknown[] = [];
  const measurements: unknown[] = [];
  // Include array delimiters and separators in the byte budget.
  let bytes = 4;
  for (const object of ordered) {
    if (selected.length === 100) break;
    const summary = {
      id: object.id,
      name: object.name,
      kind: object.kind,
      origin: object.origin,
      nativeId: object.nativeId,
      nativeSourceId: object.nativeSourceId,
    };
    const value = scene.get(object.id);
    const measurement = value
      ? {
          id: value.id,
          area: value.area,
          volume: value.volume,
          length: value.length,
          boundsSize: value.boundsSize,
          layer: value.layer64 ? Buffer.from(value.layer64, 'base64').toString('utf8') : null,
        }
      : undefined;
    const extra =
      Buffer.byteLength(JSON.stringify(summary)) +
      (measurement ? Buffer.byteLength(JSON.stringify(measurement)) : 0) +
      2;
    if (bytes + extra > 64 * 1024) continue;
    bytes += extra;
    selected.push(summary);
    if (measurement) measurements.push(measurement);
  }
  return [
    { id: 'working-model', type: 'geometry', data: selected },
    { id: 'measurements', type: 'native-measurements', data: measurements },
    {
      id: 'model-context-summary',
      type: 'model-summary',
      data: {
        total,
        included: selected.length,
        omitted: total - selected.length,
        geometryDetailsIncluded: false,
        instruction:
          'Initial metadata summary, not full geometry or a complete measurement report. Query the authorized target for required current data. Never infer omitted objects, dimensions or totals. Pins and protected IDs remain authoritative.',
      },
    },
  ];
}

/** Pins sent to the AI in full; the rest go as one summary (ADR-031 7: pins have no count cap). */
export const PIN_DETAILS = 200;
const PIN_SUMMARY_ID_BYTES = 32 * 1024;

/**
 * A turn's pins as context items: the first {@link PIN_DETAILS} each as an object reference, the
 * rest as one `object-reference-summary` with counts per role (and layer, when a pin names one)
 * and as many ids as fit a small budget. Write protection still uses every pin.
 */
export function pinContext(pins: Record<string, unknown>[]) {
  const items: { id: string; type: string; data: unknown }[] = pins
    .slice(0, PIN_DETAILS)
    .map((data, i) => ({ id: `pin-${i}`, type: 'object-reference', data }));
  const rest = pins.slice(PIN_DETAILS);
  if (!rest.length) return items;
  const byRole: Record<string, number> = {};
  const byLayer: Record<string, number> = {};
  const ids: string[] = [];
  let bytes = 0;
  for (const pin of rest) {
    const role = String(pin.role);
    byRole[role] = (byRole[role] ?? 0) + 1;
    if (typeof pin.layer === 'string') byLayer[pin.layer] = (byLayer[pin.layer] ?? 0) + 1;
    const id = String(pin.id);
    if (bytes + id.length + 3 > PIN_SUMMARY_ID_BYTES) continue;
    bytes += id.length + 3;
    ids.push(id);
  }
  items.push({
    id: 'pin-summary',
    type: 'object-reference-summary',
    data: {
      count: rest.length,
      byRole,
      ...(Object.keys(byLayer).length ? { byLayer } : {}),
      ids,
      idsOmitted: rest.length - ids.length,
      instruction: `${pins.length} objects are pinned; the first ${PIN_DETAILS} are listed one by one and the rest only here. Query the document for these ids when the task needs their details.`,
    },
  });
  return items;
}
