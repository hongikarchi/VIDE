/** Short, user-facing trace of what the AI and host did while a request runs. */
export interface ActivityEntry {
  at: string;
  kind: 'model' | 'thinking' | 'message' | 'query' | 'execute' | 'result' | 'error' | 'host';
  text: string;
  detail?: string;
}
const clip = (value: string, max: number) =>
  value.length > max ? value.slice(0, max) + '…' : value;
export function activityLog(initial: ActivityEntry[] = [], limit = 80) {
  const entries = [...initial];
  return {
    entries,
    add(kind: ActivityEntry['kind'], text: string, detail?: string) {
      const trimmed = text.trim();
      if (!trimmed) return;
      const last = entries.at(-1);
      if (last && last.kind === kind && last.text === clip(trimmed, 600) && !detail) return;
      entries.push({
        at: new Date().toISOString(),
        kind,
        text: clip(trimmed, 600),
        ...(detail ? { detail: clip(detail, 4000) } : {}),
      });
      if (entries.length > limit) entries.splice(0, entries.length - limit);
    },
  };
}
