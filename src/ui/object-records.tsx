// '이 객체의 기록' (PLAN-53 T-324, SPEC-17.1·17.5, SPEC-03.8 "대상에서 근거로"): under the inspector,
// the records of the picked object in time order — those pointing at a request that changed it and
// those of a part its layer is mapped to (`GET …/objects/:o/records?linkId=`, ARCH-01 §5). A row
// opens what it points at: the request's work card, the 검토본, or the notes tab. Fifteen seconds of
// reuse per object; a reply for an object no longer picked is dropped.
import { useEffect, useRef, useState } from 'react';
import type { PartRow, RecordRow } from '../contracts/records.ts';
import { api } from './gateway.ts';
import { SOURCE_NAME, TYPE_HINT } from './records-api.ts';
import { openReview, reviewRows } from './reviews.tsx';
import { setWorkspace } from './workspaces.ts';
import './object-records.css';

export interface ObjectRecordsTarget {
  projectId: string;
  /** The file's own id of the object (not the `layerKey::id` shown id). */
  objectId: string;
  /** The linked file the object came from; equal ids of different files stay apart (ADR-027). */
  linkId?: string;
  /** How many objects are picked: more than one shows the first one's records. */
  count: number;
  /** Its linked file has no connection now: the records show, the model cannot be marked. */
  closed?: boolean;
  /** Show a request's work card (the conversation tab it belongs to chosen). */
  openRequest: (requestId: string) => void;
}

interface ObjectRecordsReply {
  records: RecordRow[];
  via: { requestIds: string[]; partIds: string[] };
}
interface Loaded {
  records: RecordRow[];
  via: ObjectRecordsReply['via'];
  partNames: Record<string, string>;
}

const KEEP_MS = 15_000;
const cache = new Map<string, { at: number; value: Promise<Loaded> }>();
const keyOf = (target: Pick<ObjectRecordsTarget, 'projectId' | 'objectId' | 'linkId'>) =>
  `${target.projectId}\u0000${target.linkId ?? ''}\u0000${target.objectId}`;
const QUIET = ['NOT_FOUND', 'PROJECT_GONE', 'PART_NOT_FOUND', 'RECORD_NOT_FOUND'];
const notFound = (error: unknown) =>
  ['NOT_FOUND', 'PROJECT_GONE'].includes(String((error as { code?: unknown })?.code));

async function read(target: ObjectRecordsTarget): Promise<Loaded> {
  const query = target.linkId ? '?linkId=' + encodeURIComponent(target.linkId) : '';
  let reply: ObjectRecordsReply;
  try {
    reply = (await api(
      `/projects/${encodeURIComponent(target.projectId)}/objects/${encodeURIComponent(
        target.objectId,
      )}/records${query}`,
      'GET',
      undefined,
      { quiet: QUIET },
    )) as ObjectRecordsReply;
  } catch (error) {
    // No records route yet (an older engine) or the project is gone: nothing to show.
    if (notFound(error))
      return { records: [], via: { requestIds: [], partIds: [] }, partNames: {} };
    throw error;
  }
  const via = {
    requestIds: Array.isArray(reply?.via?.requestIds) ? reply.via.requestIds : [],
    partIds: Array.isArray(reply?.via?.partIds) ? reply.via.partIds : [],
  };
  const partNames: Record<string, string> = {};
  if (via.partIds.length)
    try {
      const { parts } = (await api(
        `/projects/${encodeURIComponent(target.projectId)}/parts`,
        'GET',
        undefined,
        { quiet: QUIET },
      )) as { parts: PartRow[] };
      for (const part of parts ?? []) partNames[part.id] = part.name;
    } catch {
      /* Part names are a label only: the rows show without them. */
    }
  const records = (Array.isArray(reply?.records) ? reply.records : [])
    // 뺌 is out of every count (SPEC-17.2): not shown here either.
    .filter((record) => record.state !== 'dropped')
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (a.time ?? '').localeCompare(b.time ?? '') ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  return { records, via, partNames };
}

/** The records of one object, reused for 15 s (a failed read is not kept). */
export function objectRecords(target: ObjectRecordsTarget): Promise<Loaded> {
  const key = keyOf(target);
  const now = Date.now();
  const kept = cache.get(key);
  if (kept && now - kept.at < KEEP_MS) return kept.value;
  const value = read(target);
  cache.set(key, { at: now, value });
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  for (const [other, entry] of cache) if (now - entry.at >= KEEP_MS) cache.delete(other);
  return value;
}

/** Why the record is in this list: the request that changed the object, else the mapped part. */
function originOf(record: RecordRow, loaded: Loaded) {
  const request = record.attachments?.requestId;
  if (request && loaded.via.requestIds.includes(request)) return '요청';
  const part = record.parts.find((id) => loaded.via.partIds.includes(id));
  if (part) return '부위 ' + (loaded.partNames[part] ?? '이름 없음');
  return SOURCE_NAME[record.source] ?? '기록';
}

/** Where a row leads: the request card, the 검토본, the notes tab; none when it points nowhere. */
function destinationOf(
  record: RecordRow,
  target: ObjectRecordsTarget,
): { label: string; go: () => void } | undefined {
  const { requestId, reviewId, note } = record.attachments ?? {};
  if (requestId) return { label: '요청 카드 열기', go: () => target.openRequest(requestId) };
  if (reviewId) {
    const row = reviewRows(target.projectId).find((entry) => entry.id === reviewId);
    if (row) return { label: '검토본 열기', go: () => openReview(target.projectId, row) };
  }
  if (note) return { label: '노트 열기', go: () => setWorkspace('notes') };
  return undefined;
}

let folded = false;

export function ObjectRecords({ target }: { target: ObjectRecordsTarget }) {
  const [open, setOpen] = useState(!folded);
  const key = keyOf(target);
  const [state, setState] = useState<
    | { key: string; status: 'loading' }
    | { key: string; status: 'error' }
    | { key: string; status: 'ready'; loaded: Loaded }
  >({ key, status: 'loading' });
  // The newest target: callbacks change identity on every inspector paint.
  const latest = useRef(target);
  latest.current = target;
  useEffect(() => {
    let current = true;
    setState({ key, status: 'loading' });
    objectRecords(latest.current).then(
      (loaded) => {
        // A reply for an object no longer picked is dropped.
        if (current && keyOf(latest.current) === key) setState({ key, status: 'ready', loaded });
      },
      () => {
        if (current && keyOf(latest.current) === key) setState({ key, status: 'error' });
      },
    );
    return () => {
      current = false;
    };
  }, [key]);
  const shown = state.key === key ? state : { key, status: 'loading' as const };
  return (
    <section className="object-records" aria-label="이 객체의 기록">
      <button
        type="button"
        className="object-records-head"
        aria-expanded={open}
        onClick={() => {
          folded = open;
          setOpen(!open);
        }}
      >
        <span>이 객체의 기록</span>
        {shown.status === 'ready' ? (
          <span className="object-records-count">{shown.loaded.records.length}건</span>
        ) : null}
        {target.count > 1 ? (
          <span className="object-records-note">
            {target.count.toLocaleString('ko-KR')}개 중 첫 번째
          </span>
        ) : null}
      </button>
      {open ? (
        <>
          {target.closed ? (
            <p className="object-records-note">연결이 닫혀 있어 모델에서 강조는 표시 못 함</p>
          ) : null}
          {shown.status === 'loading' ? (
            <p className="object-records-note">기록을 읽는 중…</p>
          ) : shown.status === 'error' ? (
            <p className="object-records-note">기록을 읽지 못했습니다. 잠시 뒤 다시 고르세요.</p>
          ) : !shown.loaded.records.length ? (
            <p className="object-records-note">이 객체를 바꾼 기록이 아직 없어요</p>
          ) : (
            <ol className="object-records-list">
              {shown.loaded.records.map((record) => {
                const destination = destinationOf(record, target);
                const suggested = record.by === 'ai' && record.state !== 'kept';
                const line = (
                  <>
                    <time className="object-records-date" dateTime={record.date}>
                      {record.date}
                    </time>
                    <abbr className="object-records-type" title={TYPE_HINT[record.type]}>
                      {record.type}
                    </abbr>
                    <span className="object-records-text">{record.text}</span>
                    <span className="object-records-chip">{originOf(record, shown.loaded)}</span>
                    {record.undone ? <span className="object-records-chip">되돌림</span> : null}
                    {suggested ? <span className="object-records-hint">AI 제안</span> : null}
                    {record.supersededBy ? (
                      <span className="object-records-hint">정정됨</span>
                    ) : null}
                  </>
                );
                return (
                  <li
                    key={record.id}
                    className={record.state === 'candidate' ? 'object-records-candidate' : ''}
                  >
                    {destination ? (
                      <button
                        type="button"
                        className="object-records-row"
                        title={`${destination.label} · ${record.text}`}
                        onClick={destination.go}
                      >
                        {line}
                      </button>
                    ) : (
                      <div className="object-records-row" title={record.text}>
                        {line}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </>
      ) : null}
    </section>
  );
}
