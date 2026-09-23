import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { QuantityView } from './quantity-view.tsx';
import { ComparisonResult } from './comparison-result.tsx';
import { api } from './gateway.ts';
import { comparisonSchema } from '../contracts/comparison.ts';
import type { Comparison } from '../contracts/comparison.ts';
import { quantityTableSchema, tableViewsSchema } from '../contracts/quantities.ts';
import type { QuantityTable, TableView } from '../contracts/quantities.ts';
const candidateSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  input: z.object({ body: z.string().optional() }).passthrough(),
  result: z.object({ hostExecuted: z.boolean().optional() }).passthrough().nullish(),
});
type Candidate = z.infer<typeof candidateSchema>;
const dialog = document.createElement('dialog');
dialog.className = 'quantity-dialog';
dialog.setAttribute('aria-label', '후보 수량표');
document.body.append(dialog);
const root = createRoot(dialog);
let opening = 0;
interface Props {
  projectId: string;
  requestId: string;
  table: QuantityTable;
  views: TableView[];
  requests: Candidate[];
  onSelect: (id: string) => void;
}
function Quantities({ projectId, requestId, table, views, requests, onSelect }: Props) {
  const [before, setBefore] = useState(''),
    [result, setResult] = useState<Comparison | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const alive = useRef(true),
    locked = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function compare() {
    if (locked.current || !before) return;
    locked.current = true;
    setPending(true);
    setError('');
    try {
      const value = comparisonSchema.parse(
        await api(
          `/projects/${projectId}/comparison?${new URLSearchParams({ before, after: requestId })}`,
        ),
      );
      if (value.before !== before || value.after !== requestId)
        throw new Error('비교 기준이 일치하지 않습니다.');
      if (alive.current) setResult(value);
    } catch (reason) {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : '비교 자료를 읽지 못했습니다.');
    } finally {
      locked.current = false;
      if (alive.current) setPending(false);
    }
  }
  return (
    <>
      <div className="quantity-head">
        <h2>후보 수량표</h2>
        <button onClick={() => dialog.close()}>닫기</button>
      </div>
      <p>
        {table.host === 'rhino' ? 'Rhino' : 'ZWCAD'} · {table.rows.length}개 객체 · 저장된 후보 기준
      </p>
      <div className="comparison-controls">
        <select
          aria-label="비교할 이전 후보"
          disabled={pending}
          value={before}
          onChange={(event) => {
            setBefore(event.target.value);
            setResult(null);
            setError('');
          }}
        >
          <option value="">비교할 후보 선택</option>
          {requests
            .filter((candidate) => candidate.result?.hostExecuted && candidate.id !== requestId)
            .map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {new Date(candidate.createdAt).toLocaleString('ko-KR')} ·{' '}
                {candidate.input.body || '파일 가져오기'}
              </option>
            ))}
        </select>
        <button disabled={pending || !before} onClick={compare}>
          현재 후보와 비교
        </button>
      </div>
      <div className="comparison-result" role="status">
        {error || null}
        {result ? <ComparisonResult result={result} /> : null}
      </div>
      <QuantityView
        projectId={projectId}
        requestId={requestId}
        initial={table}
        views={views}
        onSelect={(id) => {
          onSelect(id);
          dialog.close();
        }}
        isCurrent={() => alive.current && dialog.open}
      />
      <small>기하 면적은 연면적·법정 면적이 아닙니다. 미상 값은 합계에서 제외합니다.</small>
    </>
  );
}
dialog.addEventListener('close', () => {
  opening++;
  root.render(null);
});
export async function showQuantities(
  projectId: string,
  requestId: string,
  onSelect: Props['onSelect'],
  objectId = '',
): Promise<void> {
  const current = ++opening;
  const [rawTable, rawRequests, rawViews] = await Promise.all([
    api(
      `/projects/${projectId}/requests/${requestId}/quantities?${new URLSearchParams({ objectId })}`,
    ),
    api(`/projects/${projectId}/requests`),
    api(`/projects/${projectId}/table-views`),
  ]);
  if (current !== opening) return;
  const table = quantityTableSchema.parse(rawTable),
    requests = z.array(candidateSchema).parse(rawRequests),
    views = tableViewsSchema.parse(rawViews);
  root.render(
    <Quantities key={current} {...{ projectId, requestId, onSelect, table, requests, views }} />,
  );
  if (!dialog.open) dialog.showModal();
}
