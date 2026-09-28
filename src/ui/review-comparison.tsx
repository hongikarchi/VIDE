import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { api } from './gateway.ts';
import { reviewRowSchema } from '../contracts/reviews.ts';
import type { ReviewRow } from '../contracts/reviews.ts';
import { comparisonSchema } from '../contracts/comparison.ts';
import type { Comparison } from '../contracts/comparison.ts';
import { ComparisonResult } from './comparison-result.tsx';
const dialog = document.createElement('dialog');
dialog.className = 'review-dialog review-compare';
dialog.setAttribute('aria-label', '검토본 비교');
document.body.append(dialog);
const root = createRoot(dialog);
let generation = 0;
function ReviewComparison({ projectId, rows }: { projectId: string; rows: ReviewRow[] }) {
  const [before, setBefore] = useState(rows.at(-1)?.id ?? ''),
    [after, setAfter] = useState(rows[0]?.id ?? '');
  const [result, setResult] = useState<Comparison | null>(null),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  const request = useRef(0),
    alive = useRef(true);
  async function compare(a: string, b: string) {
    const current = ++request.current;
    setPending(true);
    setError('');
    try {
      const value = comparisonSchema.parse(
        await api(
          `/projects/${projectId}/review-comparison?${new URLSearchParams({ before: a, after: b })}`,
        ),
      );
      if (value.before !== a || value.after !== b)
        throw new Error('비교 기준이 일치하지 않습니다.');
      if (alive.current && current === request.current) setResult(value);
    } catch (reason) {
      if (alive.current && current === request.current)
        setError(reason instanceof Error ? reason.message : '비교 자료를 읽지 못했습니다.');
    } finally {
      if (alive.current && current === request.current) setPending(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    if (rows.length >= 2) void compare(rows.at(-1)!.id, rows[0]!.id);
    return () => {
      alive.current = false;
      request.current++;
    };
  }, [projectId, rows]);
  return (
    <>
      <div className="quantity-head">
        <h2>검토본 비교</h2>
        <button onClick={() => dialog.close()}>닫기</button>
      </div>
      <div className="table-controls">
        {(
          [
            ['검토본 A', before, setBefore],
            ['검토본 B', after, setAfter],
          ] as const
        ).map(([label, value, change]) => (
          <select
            key={label}
            aria-label={label}
            value={value}
            disabled={pending}
            onChange={(event) => {
              change(event.target.value);
              setResult(null);
              setError('');
            }}
          >
            {rows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.title} · {new Date(row.createdAt).toLocaleString('ko-KR')}
              </option>
            ))}
          </select>
        ))}
        <button
          disabled={pending || rows.length < 2}
          onClick={() => {
            void compare(before, after);
          }}
        >
          비교
        </button>
      </div>
      <div className="review-differences" role="status">
        {error || null}
        {result ? <ComparisonResult result={result} review /> : null}
      </div>
      <div className="review-panels">
        {result
          ? [
              [result.before, '검토본 A 내용'],
              [result.after, '검토본 B 내용'],
            ].map(([id, label]) => (
              <iframe
                key={label}
                title={label}
                sandbox=""
                src={`api/v1/projects/${projectId}/reviews/${id}/preview`}
              />
            ))
          : null}
      </div>
    </>
  );
}
dialog.addEventListener('close', () => {
  generation++;
  root.render(null);
});
export async function showReviewComparison(projectId: string): Promise<void> {
  const current = ++generation,
    rows = z.array(reviewRowSchema).parse(await api(`/projects/${projectId}/reviews`));
  if (current !== generation) return;
  root.render(<ReviewComparison key={current} {...{ projectId, rows }} />);
  if (!dialog.open) dialog.showModal();
}
