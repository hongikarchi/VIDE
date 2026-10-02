import { nativeModelSchema } from '../contracts/native-model.ts';
import { hostTargetSchema, type HostTarget } from '../contracts/host-documents.ts';
import type { StoredWork } from '../contracts/stored-work.ts';
import type { Workspace } from './workspace.ts';
import { z } from 'zod';

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

const measurementSchema = z.object({
  id: z.string(),
  geometryHash: z.string().min(1),
  area: z.number().nullable(),
  volume: z.number().nullable(),
  length: z.number().nullable(),
});
/**
 * `captureMeasurements` without decoding stored models (ARCH-01 §5 「읽기와 하위 호환」): the newest
 * matching Sync is found in SQL, and for a model stored per object only the measured fields of
 * its scene meta are read. A result still kept as JSON is read whole as before.
 */
export function previousMeasurements(
  workspace: Workspace,
  projectId: string,
  target: HostTarget,
): GeometryMeasurement[] {
  const db = workspace.store.db;
  const row = db
    .prepare(
      `SELECT id FROM workspace_requests WHERE projectId=? AND state='succeeded'
        AND json_extract(input,'$.source')='document' AND json_extract(result,'$.host')='rhino'
        AND json_extract(result,'$.executionMode')='sdk'
        AND json_extract(result,'$.sourceDocument.instance')=?
        AND json_extract(result,'$.sourceDocument.documentId')=?
        ORDER BY rowid DESC LIMIT 1`,
    )
    .get(projectId, target.instance, target.documentId) as { id: string } | undefined;
  if (!row) return [];
  if (!workspace.model(projectId, row.id))
    return captureMeasurements([workspace.get(projectId, row.id)], target);
  if (workspace.brief(projectId, row.id).result?.measurementVersion !== 1) return [];
  const out: GeometryMeasurement[] = [];
  for (const item of db
    .prepare(
      `SELECT json_extract(v.meta,'$.scene.id') AS id, json_extract(v.meta,'$.scene.geometryHash') AS geometryHash,
          json_extract(v.meta,'$.scene.area') AS area, json_extract(v.meta,'$.scene.volume') AS volume,
          json_extract(v.meta,'$.scene.length') AS length
        FROM sync_manifest_items i JOIN object_versions v ON v.projectId=i.projectId AND v.id=i.versionId
        WHERE i.requestId=? AND i.kind='object' ORDER BY i.position`,
    )
    .iterate(row.id)) {
    const parsed = measurementSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
    else if (item.geometryHash) return [];
  }
  return out;
}
