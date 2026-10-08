import { quantityQuerySchema } from '../contracts/quantities.ts';
import type { QuantityQuery, QuantityTable } from '../contracts/quantities.ts';
import { DomainError } from './store.ts';
import { StoredList } from './model-store.ts';
import { sceneItems } from './scene-items.ts';
import { orderLayerPaths, type HostLayer } from './layer-tree.ts';
export interface SourceScene {
  id: string;
  nativeType?: string;
  layer64?: string;
  line?: ArrayLike<number>;
  length?: number | null;
  area?: number | null;
  volume?: number | null;
}
export interface SourceRequest {
  id: string;
  createdAt: string;
  result?: {
    hostExecuted?: boolean;
    host?: string;
    objects: { id: string; name: string; kind?: string }[];
    /** An array, or a stored list read (and checked) one item at a time (T-129). */
    scene: readonly SourceScene[] | StoredList;
    /** Rhino's layer table (nesting and panel order); the layer filter follows it. */
    layers?: unknown;
  };
}
type Metric = 'length' | 'area' | 'volume';
const metrics: Metric[] = ['length', 'area', 'volume'];
const known = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function lengthOf(line: ArrayLike<number> | undefined): number | null {
  if (
    !Array.isArray(line) ||
    line.length < 6 ||
    line.length % 3 ||
    line.some((n) => !Number.isFinite(n))
  )
    return null;
  let length = 0;
  for (let i = 3; i < line.length; i += 3)
    length += Math.hypot(
      line[i] - line[i - 3],
      line[i + 1] - line[i - 2],
      line[i + 2] - line[i - 1],
    );
  return length;
}
export function quantities(request: SourceRequest, rawQuery: unknown = {}): QuantityTable {
  const query = quantityQuery(rawQuery);
  const result = request.result;
  if (!result?.hostExecuted || !(Array.isArray(result.scene) || result.scene instanceof StoredList))
    throw new DomainError('NOT_FOUND');
  // One pass over the scene keeping the first item of each id (as `find` did), measured values
  // only: a stored scene is read one item at a time and no coordinate array is kept (T-129).
  const native = new Map<
    string,
    Pick<SourceScene, 'nativeType' | 'layer64'> & {
      length: number | null;
      area: number | null;
      volume: number | null;
      lineLength: number | null;
    }
  >();
  for (const item of sceneItems<SourceScene>(result.scene)) {
    if (native.has(item.id)) continue;
    const length = known(item.length);
    native.set(item.id, {
      nativeType: item.nativeType,
      layer64: item.layer64,
      length,
      area: known(item.area),
      volume: known(item.volume),
      lineLength: length === null ? lengthOf(item.line) : null,
    });
  }
  const rows = result.objects.map((object) => {
    const found = native.get(object.id);
    return {
      id: object.id,
      name: object.name,
      type: found?.nativeType || object.kind || '미상',
      layer:
        found?.layer64 !== undefined ? Buffer.from(found.layer64, 'base64').toString('utf8') : null,
      length: found?.length ?? (object.kind !== 'native' ? (found?.lineLength ?? null) : null),
      area: found?.area ?? null,
      volume: found?.volume ?? null,
    };
  });
  const filtered = rows.filter(
    (row) =>
      (!query.objectId || row.id === query.objectId) &&
      (!query.search || row.name.toLocaleLowerCase().includes(query.search.toLocaleLowerCase())) &&
      (!query.type || row.type === query.type) &&
      // A parent layer takes its sublayers too (Rhino `Parent::Child`, as the layer list's 선택).
      (!query.layer ||
        row.layer === query.layer ||
        (row.layer?.startsWith(query.layer + '::') ?? false)),
  );
  const groups: QuantityTable['groups'] = [];
  const groupBy = query.groupBy;
  if (groupBy !== 'none')
    for (const key of new Set(filtered.map((row) => row[groupBy]))) {
      const members = filtered.filter((row) => row[groupBy] === key);
      groups.push({
        key: key ?? '미상',
        totals: summarize(members),
        ids: members.map((row) => row.id),
      });
    }
  return {
    basis: request.id,
    host: result.host || 'rhino',
    createdAt: request.createdAt,
    scope: 'candidate',
    source: '저장·재열기한 호스트 형상',
    units: { length: 'm', area: 'm²', volume: 'm³' },
    query,
    available: {
      objects: rows.map(({ id, name }) => ({ id, name })),
      types: [...new Set(rows.map((row) => row.type))],
      // In Rhino's panel order (sublayers under their parent) when the Sync has its layer table,
      // otherwise by name; the picker indents sublayers either way (SPEC-01.9 4).
      layers: orderLayerPaths(
        [...new Set(rows.map((row) => row.layer).filter((value) => value !== null))].sort((a, b) =>
          a.localeCompare(b),
        ),
        Array.isArray(result.layers)
          ? (result.layers as Partial<HostLayer>[]).filter(
              (layer): layer is HostLayer =>
                typeof layer?.fullPath === 'string' && layer.fullPath !== '',
            )
          : undefined,
      ),
    },
    totalCount: rows.length,
    rows: filtered,
    groups,
    totals: summarize(filtered),
  };
}
function cell(value: unknown) {
  let text = value === null ? '미상' : String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function quantitiesCsv(table: QuantityTable) {
  const header = [
    '기준 후보',
    '호스트',
    '객체 ID',
    '이름',
    '유형',
    '레이어',
    '길이 (m)',
    '기하 면적 (m²)',
    '체적 (m³)',
    '출처',
    '객체 수',
    '길이 미상 수',
    '면적 미상 수',
    '체적 미상 수',
    '행 구분',
    '그룹 기준',
  ];
  const rows: unknown[][] = table.rows.map((row) => [
    table.basis,
    table.host,
    row.id,
    row.name,
    row.type,
    row.layer,
    row.length,
    row.area,
    row.volume,
    table.source,
    1,
    ...metrics.map((key) => (row[key] === null ? 1 : 0)),
    '객체',
    table.query.groupBy,
  ]);
  for (const group of table.groups) {
    const metric = (key: Metric) => (group.totals[key].known ? group.totals[key].value : null);
    rows.push([
      table.basis,
      table.host,
      '',
      group.key,
      table.query.groupBy === 'type' ? group.key : '',
      table.query.groupBy === 'layer' ? group.key : '',
      metric('length'),
      metric('area'),
      metric('volume'),
      table.source,
      group.totals.count,
      ...metrics.map((key) => group.totals[key].unknown),
      '그룹 합계',
      table.query.groupBy,
    ]);
  }
  return '\ufeff' + [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function quantityQuery(value: unknown = {}): QuantityQuery {
  const parsed = quantityQuerySchema.safeParse(value);
  if (!parsed.success) throw new DomainError('INVALID_INPUT');
  return parsed.data;
}
function summarize(rows: QuantityTable['rows']): QuantityTable['totals'] {
  const metric = (key: Metric) => ({
    value: rows.reduce((sum, row) => sum + (row[key] ?? 0), 0),
    known: rows.filter((row) => row[key] !== null).length,
    unknown: rows.filter((row) => row[key] === null).length,
  });
  return {
    count: rows.length,
    length: metric('length'),
    area: metric('area'),
    volume: metric('volume'),
  };
}
