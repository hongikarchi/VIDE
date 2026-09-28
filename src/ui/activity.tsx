import { useLayoutEffect, useRef } from 'react';

export interface ActivityEntry {
  at: string;
  kind: string;
  text: string;
  detail?: string;
}
const icons: Record<string, string> = {
  host: '▣',
  model: '◆',
  thinking: '…',
  message: '💬',
  query: '⌕',
  execute: '⚙',
  result: '✓',
  error: '!',
};
export function activityEntries(value: unknown): ActivityEntry[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is ActivityEntry =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          typeof entry.text === 'string' &&
          typeof entry.kind === 'string',
      )
    : [];
}
/** What the AI understood and what it is doing: reasoning notes, queries, code runs, results. */
export function ActivityLog({
  entries,
  live = false,
}: {
  entries: ActivityEntry[];
  live?: boolean;
}) {
  const list = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    if (live && list.current) list.current.scrollTop = list.current.scrollHeight;
  });
  if (!entries.length) return null;
  return (
    <ol className="activity-log" ref={list} data-live={String(live)}>
      {entries.map((entry, index) => (
        <li key={index} data-kind={entry.kind}>
          <span className="activity-icon" aria-hidden="true">
            {icons[entry.kind] ?? '·'}
          </span>
          <div>
            <p>{entry.text}</p>
            {entry.detail ? (
              <details>
                <summary>{entry.kind === 'execute' ? '실행한 코드' : '세부 내용'}</summary>
                <pre>{entry.detail}</pre>
              </details>
            ) : null}
          </div>
          <time dateTime={entry.at}>
            {new Date(entry.at).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </time>
        </li>
      ))}
    </ol>
  );
}
