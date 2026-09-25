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
