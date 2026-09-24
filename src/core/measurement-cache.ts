import { nativeModelSchema } from '../contracts/native-model.ts';
import { hostTargetSchema, type HostTarget } from '../contracts/host-documents.ts';
import type { StoredWork } from '../contracts/stored-work.ts';

export interface GeometryMeasurement {
  id: string;
  geometryHash: string;
  area: number | null;
  volume: number | null;
  length: number | null;
}

// Caller supplies only the current project's persisted rows, never browser-supplied quantities.
export function captureMeasurements(rows: StoredWork[], target: HostTarget): GeometryMeasurement[] {
  const previous = [...rows].reverse().find((row) => {
    const result = row.result;
    const source = hostTargetSchema.safeParse(result?.sourceDocument);
    return (
      row.state === 'succeeded' &&
      row.input.source === 'document' &&
      result?.host === 'rhino' &&
      result.executionMode === 'sdk' &&
      source.success &&
      source.data.instance === target.instance &&
      source.data.documentId === target.documentId
    );
  });
  if (previous?.result?.measurementVersion !== 1) return [];
  const model = nativeModelSchema.safeParse(previous.result);
  if (!model.success) return [];
  return model.data.scene.flatMap(({ id, geometryHash, area, volume, length }) =>
    geometryHash ? [{ id, geometryHash, area, volume, length }] : [],
  );
}
