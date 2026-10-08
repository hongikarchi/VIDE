import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from './gateway.ts';
import { layerOptions } from '../core/layer-tree.ts';
import { quantityTableSchema, tableViewSchema } from '../contracts/quantities.ts';
import type { QuantityQuery, QuantityTable, TableView } from '../contracts/quantities.ts';
const metrics = ['length', 'area', 'volume'] as const;
const number = (value: number | null) =>
  value === null ? '미상' : value.toLocaleString('ko-KR', { maximumFractionDigits: 3 });
const aggregate = (metric: QuantityTable['totals']['area']) =>
  `${metric.known ? number(metric.value) : '미상'}${metric.unknown ? ' · 미상 ' + metric.unknown + '개 제외' : ''}`;
interface Props {
  projectId: string;
  requestId: string;
  initial: QuantityTable;
  views: TableView[];
  onSelect: (id: string) => void;
  isCurrent: () => boolean;
}
export function QuantityView({
  projectId,
  requestId,
  initial,
  views: initialViews,
  onSelect,
  isCurrent,
}: Props) {
  const [table, setTable] = useState(initial),
    [query, setQuery] = useState(initial.query);
  const [views, setViews] = useState(initialViews),
    [selected, setSelected] = useState<TableView>();
  const [name, setName] = useState(''),
    [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false);
  const feedback = useRef(0);
  const generation = useRef(0),
    mounted = useRef(true),
    writing = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const current = () => mounted.current && isCurrent();
  const reload = async (next: QuantityQuery) => {
    const version = ++generation.current,
      notice = ++feedback.current;
    setLoading(true);
    setStatus('');
    try {
      const result = quantityTableSchema.parse(
        await api(
          `/projects/${projectId}/requests/${requestId}/quantities?${new URLSearchParams(next)}`,
        ),
      );
      if (version === generation.current && current()) {
        setTable(result);
      }
    } catch (error) {
      if (version === generation.current && notice === feedback.current && current())
        setStatus(
          (error instanceof Error ? error.message : '표를 읽지 못했습니다.') +
            ' 마지막 성공 표를 유지합니다.',
        );
    } finally {
      if (version === generation.current && current()) setLoading(false);
    }
  };
  const change = (next: QuantityQuery) => {
    setQuery(next);
    void reload(next);
  };
  const save = async () => {
    if (writing.current) return;
    writing.current = true;
    setSaving(true);
    const notice = ++feedback.current;
    try {
      const value = tableViewSchema.parse(
        await api(
          `/projects/${projectId}/table-views${selected ? '/' + selected.id : ''}`,
          selected ? 'PUT' : 'POST',
          { name, query, revision: selected?.revision },
        ),
      );
      if (!current()) return;
      setViews((previous) => [...previous.filter((view) => view.id !== value.id), value]);
      setSelected(value);
      if (notice === feedback.current) setStatus('표 구성을 저장했습니다.');
    } catch (error) {
      if (current() && notice === feedback.current)
        setStatus(error instanceof Error ? error.message : '저장하지 못했습니다.');
    } finally {
      writing.current = false;
      if (current()) setSaving(false);
    }
  };
  const remove = async () => {
    if (!selected || writing.current) return;
    writing.current = true;
    setSaving(true);
    const target = selected,
      notice = ++feedback.current;
    try {
      await api(`/projects/${projectId}/table-views/${target.id}/delete`, 'POST', {
        revision: target.revision,
      });
      if (!current()) return;
      setViews((previous) => previous.filter((view) => view.id !== target.id));
      setSelected(undefined);
      setName('');
      if (notice === feedback.current) setStatus('표 구성을 삭제했습니다.');
    } catch (error) {
      if (current() && notice === feedback.current)
        setStatus(error instanceof Error ? error.message : '삭제하지 못했습니다.');
    } finally {
      writing.current = false;
      if (current()) setSaving(false);
    }
  };
  const options = (items: [string, string][], value: string) =>
    items.some((item) => item[0] === value)
      ? items
      : [...items, [value, value + ' · 현재 기준에 없음']];
  const select = (
    label: string,
    key: 'objectId' | 'type' | 'layer' | 'groupBy',
    items: [string, string][],
  ) => (
    <select
      aria-label={label}
      value={query[key]}
      onChange={(event) => change({ ...query, [key]: event.target.value })}
    >
      {options(items, query[key]).map(([value, text]) => (
        <option key={value} value={value}>
          {text}
        </option>
      ))}
    </select>
  );
  const summary = (label: string, totals: QuantityTable['totals']) => (
    <tr className="quantity-summary">
      <th>{label}</th>
      <td>{totals.count}개</td>
      <td />
      {metrics.map((key) => (
        <td key={key}>{aggregate(totals[key])}</td>
      ))}
    </tr>
  );
  const row = (data: QuantityTable['rows'][number]) => (
    <tr key={data.id}>
      <td>
        <button onClick={() => onSelect(data.id)}>{data.name}</button>
      </td>
      <td>{data.type}</td>
      <td>{data.layer ?? '미상'}</td>
      {metrics.map((key) => (
        <td key={key}>{number(data[key])}</td>
      ))}
    </tr>
  );
  const byId = new Map(table.rows.map((row) => [row.id, row]));
  return (
    <>
      <div className="table-controls">
        <input
          placeholder="객체 검색"
          aria-label="객체 검색"
          maxLength={200}
          value={query.search}
          onChange={(event) => setQuery({ ...query, search: event.target.value })}
          onBlur={() => {
            void reload(query);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void reload(query);
            }
          }}
        />
        {select('집계 객체', 'objectId', [
          ['', '전체 객체'],
          ...initial.available.objects.map((item) => [item.id, item.name] as [string, string]),
        ])}
        {select('객체 유형', 'type', [
          ['', '전체 유형'],
          ...initial.available.types.map((value) => [value, value] as [string, string]),
        ])}
        {select('레이어 필터', 'layer', [
          ['', '전체 레이어'],
          // Rhino sublayers indent under their parent; a parent takes its sublayers.
          ...layerOptions([...initial.available.layers].sort((a, b) => a.localeCompare(b))).map(
            (option, index, all) =>
              [
                option.value,
                (all[index + 1]?.depth ?? -1) > option.depth
                  ? option.label + ' · 하위 포함'
                  : option.label,
              ] as [string, string],
          ),
        ])}
        {select('그룹 기준', 'groupBy', [
          ['none', '그룹 없음'],
          ['type', '유형별'],
          ['layer', '레이어별'],
        ])}
        <button
          disabled={loading}
          onClick={() => {
            void reload(query);
          }}
        >
          표 갱신
        </button>
      </div>
      <details>
        <summary>표 구성</summary>
        <div className="table-controls">
          <select
            aria-label="저장한 표 구성"
            disabled={saving}
            value={selected?.id ?? ''}
            onChange={(event) => {
              const value = views.find((view) => view.id === event.target.value);
              setSelected(value);
              setName(value?.name ?? '');
              if (value) change(value.query);
            }}
          >
            <option value="">새 구성</option>
            {views.map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
              </option>
            ))}
          </select>
          <input
            aria-label="표 구성 이름"
            placeholder="구성 이름"
            maxLength={80}
            disabled={saving}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            disabled={saving}
            onClick={() => {
              void save();
            }}
          >
            구성 저장
          </button>
          <button
            disabled={saving || !selected}
            onClick={() => {
              void remove();
            }}
          >
            구성 삭제
          </button>
        </div>
      </details>
      <p role="status">
        {status || `${table.rows.length} / ${table.totalCount}개 객체 · 선택한 저장 기준`}
      </p>
      <div className="quantity-scroll">
        <table>
          <thead>
            <tr>
              {['객체', '유형', '레이어', '길이 (m)', '기하 면적 (m²)', '체적 (m³)'].map(
                (title) => (
                  <th key={title}>{title}</th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {table.groups.length
              ? table.groups.map((group) => (
                  <Fragment key={group.key}>
                    {summary(group.key, group.totals)}
                    {group.ids.map((id) => {
                      const item = byId.get(id);
                      return item ? row(item) : null;
                    })}
                  </Fragment>
                ))
              : table.rows.map(row)}
            {summary('합계', table.totals)}
          </tbody>
        </table>
      </div>
      <a
        download="VIDE-quantities.csv"
        href={`api/v1/projects/${projectId}/requests/${requestId}/quantities.csv?${new URLSearchParams(table.query)}`}
      >
        CSV 내려받기
      </a>
    </>
  );
}
