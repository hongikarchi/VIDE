import { quantityQuerySchema } from '../contracts/quantities.ts';
import type { QuantityQuery, QuantityTable } from '../contracts/quantities.ts';
import { DomainError } from './store.ts';
export interface SourceScene {
  id: string;
  nativeType?: string;
  layer64?: string;
  line?: number[];
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
    scene: SourceScene[];
  };
}
type Metric = 'length' | 'area' | 'volume';
const metrics: Metric[] = ['length', 'area', 'volume'];
const known = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function lengthOf(line: number[] | undefined): number | null {
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
  if (!result?.hostExecuted || !Array.isArray(result.scene)) throw new DomainError('NOT_FOUND');
  const rows = result.objects.map((object) => {
    const native = result.scene.find((s) => s.id === object.id);
    return {
      id: object.id,
      name: object.name,
      type: native?.nativeType || object.kind || '미상',
      layer:
        native?.layer64 !== undefined
          ? Buffer.from(native.layer64, 'base64').toString('utf8')
          : null,
      length: known(native?.length) ?? (object.kind !== 'native' ? lengthOf(native?.line) : null),
      area: known(native?.area),
      volume: known(native?.volume),
    };
  });
  const filtered = rows.filter(
    (row) =>
      (!query.objectId || row.id === query.objectId) &&
      (!query.search || row.name.toLocaleLowerCase().includes(query.search.toLocaleLowerCase())) &&
      (!query.type || row.type === query.type) &&
      (!query.layer || row.layer === query.layer),
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
      layers: [...new Set(rows.map((row) => row.layer).filter((value) => value !== null))],
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
