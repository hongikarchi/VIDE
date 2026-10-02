import type { z } from 'zod';
import type { workspaceResultSchema } from '../contracts/workspace-result.ts';

type Model = z.infer<typeof workspaceResultSchema>;

/** Initial orientation only. Native queries and write protection retain the full model. */
export function modelContext(model: Model | undefined, priorityIds: string[]) {
  const objects = model?.objects ?? [];
  const scene = new Map((model?.scene ?? []).map((item) => [item.id, item]));
  const priority = new Set(priorityIds);
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
        total: objects.length,
        included: selected.length,
        omitted: objects.length - selected.length,
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
