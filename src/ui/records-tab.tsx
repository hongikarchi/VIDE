// 기록 tab (PLAN-53 T-323·T-325, Design SCR-44): the project's records to sort. [목록] · [차트]
// chips choose the view (차트 is wave 2: one line for now). The left column counts the records by
// chapter (or by source when no chapter is used) with a thin 남김/뺌 bar, and holds the filter
// chips; the list is one row per record; the 자세히 column edits the chosen one. Keys: J/K move,
// O 남김, X 뺌, Backspace 표시 지움, E/Enter 자세히. The 부위 사전 screen replaces the centre.
// A remote session reads only (SPEC-17.6): every button that writes is hidden. Data: the engine's
// records routes (src/ui/records-api.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  REFUSAL,
  SOURCE_NAME,
  STATE_NAME,
  STATE_ORDER,
  TYPE_HINT,
  TYPE_NAME,
  TYPE_ORDER,
  addMilestone,
  addPart,
  correctRecord,
  exportLines,
  getRecord,
  importMarks,
  linkLayers,
  linkRecords,
  listLinks,
  listMilestones,
  listParts,
  listRecords,
  partsStatus,
  patchRecord,
  removeMilestone,
  removePart,
  setPart,
  setRecordState,
  setRecordStates,
  unlinkRecords,
  type LinkSummary,
  type MilestoneRow,
  type PartMapping,
  type PartRow,
  type PartBreak,
  type PartStatus,
  type RecordFilters,
  type RecordRow,
  type RecordSource,
  type RecordState,
  type RecordType,
} from './records-api.ts';
import { remoteSession } from './remote-panel.ts';
import { setWorkspace } from './workspaces.ts';
import './records-tab.css';

type View = 'list' | 'chart';
type Panel = 'records' | 'parts';
const DEFAULT_STATES: RecordState[] = ['candidate', 'kept'];
const PERSON_TYPES = TYPE_ORDER.filter((type) => type !== '?') as Exclude<RecordType, '?'>[];

function readView(projectId: string): View {
  try {
    return localStorage.getItem(`vide:records-view:${projectId}`) === 'chart' ? 'chart' : 'list';
  } catch {
    return 'list';
  }
}
function saveView(projectId: string, view: View) {
  try {
    localStorage.setItem(`vide:records-view:${projectId}`, view);
  } catch {
    /* a viewer convenience only */
  }
}
/** A key typed into a field is text, not a shortcut (as src/ui/app/shortcuts.ts isTyping). */
function typing(event: KeyboardEvent) {
  const target = event.target;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
const codeOf = (error: unknown) => String((error as { code?: unknown } | null)?.code ?? '');
const textOf = (error: unknown) =>
  REFUSAL[codeOf(error)] ?? (error instanceof Error ? error.message : '처리하지 못했습니다.');
const shortDate = (date: string) => date.slice(5);
/** An ISO instant as local `YYYY-MM-DD HH:MM` (records' date·time are local too). */
const localStamp = (iso: string) => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const two = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
};
const MARK_OF: Record<RecordState, string> = { kept: 'o', dropped: 'x', candidate: '.' };
const BREAK_TEXT: Record<PartBreak, string> = {
  'layer-missing': '끊김 — 레이어 없음',
  'link-missing': '끊김 — 연결 파일 없음',
  'instance-missing': '끊김 — jig 결과 없음',
};
const today = () => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};
const toggle = <T,>(list: T[] | undefined, value: T) =>
  list?.includes(value) ? list.filter((item) => item !== value) : [...(list ?? []), value];

// ---- The left column: counts with a 남김/뺌 bar, and the filters ----

function Summary({
  all,
  filters,
  onFilters,
}: {
  all: RecordRow[];
  filters: RecordFilters;
  onFilters: (next: RecordFilters) => void;
}) {
  const byChapter = all.some((row) => row.chapter);
  const groups = useMemo(() => {
    const out = new Map<string, { total: number; kept: number; dropped: number }>();
    for (const row of all) {
      const key = byChapter ? (row.chapter ?? '') : row.source;
      const group = out.get(key) ?? { total: 0, kept: 0, dropped: 0 };
      group.total++;
      if (row.state === 'kept') group.kept++;
      if (row.state === 'dropped') group.dropped++;
      out.set(key, group);
    }
    return [...out.entries()].sort((a, b) => b[1].total - a[1].total);
  }, [all, byChapter]);
  const label = (key: string) =>
    byChapter ? key || '장 없음' : (SOURCE_NAME[key as RecordSource] ?? key);
  const chosen = (key: string) =>
    byChapter ? filters.chapter === (key || '-') : filters.source?.includes(key as RecordSource);
  return (
    <ul className="records-summary" aria-label={byChapter ? '장별 건수' : '출처별 건수'}>
      {groups.map(([key, group]) => (
        <li key={key}>
          <button
            type="button"
            className="records-summary-row"
            aria-pressed={chosen(key)}
            title={`남김 ${group.kept} · 뺌 ${group.dropped} · 후보 ${group.total - group.kept - group.dropped}`}
            onClick={() =>
              onFilters(
                byChapter
                  ? { ...filters, chapter: chosen(key) ? undefined : key || '-' }
                  : { ...filters, source: toggle(filters.source, key as RecordSource) },
              )
            }
          >
            <span className="records-summary-name">{label(key)}</span>
            <span className="records-count">{group.total}</span>
            <span className="records-ratio" aria-hidden="true">
              <span
                className="records-ratio-kept"
                style={{ width: `${(group.kept / group.total) * 100}%` }}
              />
              <span
                className="records-ratio-dropped"
                style={{ width: `${(group.dropped / group.total) * 100}%` }}
              />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Chip({
  pressed,
  onClick,
  title,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="records-chip"
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Filters({
  all,
  parts,
  filters,
  onFilters,
}: {
  all: RecordRow[];
  parts: PartRow[];
  filters: RecordFilters;
  onFilters: (next: RecordFilters) => void;
}) {
  const counted = <K extends 'state' | 'type' | 'source'>(key: K) => {
    const out = new Map<string, number>();
    for (const row of all) out.set(row[key], (out.get(row[key]) ?? 0) + 1);
    return out;
  };
  const states = counted('state');
  const types = counted('type');
  const sources = counted('source');
  return (
    <div className="records-filters">
      <fieldset aria-label="상태">
        <legend>상태</legend>
        {STATE_ORDER.map((state) => (
          <Chip
            key={state}
            pressed={Boolean(filters.state?.includes(state))}
            onClick={() => onFilters({ ...filters, state: toggle(filters.state, state) })}
          >
            {STATE_NAME[state]} <span className="records-count">{states.get(state) ?? 0}</span>
          </Chip>
        ))}
      </fieldset>
      <fieldset aria-label="유형">
        <legend>유형</legend>
        {TYPE_ORDER.map((type) => (
          <Chip
            key={type}
            pressed={Boolean(filters.type?.includes(type))}
            title={TYPE_HINT[type]}
            onClick={() => onFilters({ ...filters, type: toggle(filters.type, type) })}
          >
            {type === '?' ? '미정' : `${type} ${TYPE_NAME[type]}`}{' '}
            <span className="records-count">{types.get(type) ?? 0}</span>
          </Chip>
        ))}
      </fieldset>
      <fieldset aria-label="출처">
        <legend>출처</legend>
        {[...sources.keys()].map((source) => (
          <Chip
            key={source}
            pressed={Boolean(filters.source?.includes(source as RecordSource))}
            onClick={() =>
              onFilters({ ...filters, source: toggle(filters.source, source as RecordSource) })
            }
          >
            {SOURCE_NAME[source as RecordSource] ?? source}{' '}
            <span className="records-count">{sources.get(source)}</span>
          </Chip>
        ))}
      </fieldset>
      <label className="records-field">
        부위
        <select
          value={filters.part ?? ''}
          onChange={(event) => onFilters({ ...filters, part: event.target.value || undefined })}
        >
          <option value="">전체</option>
          <option value="-">부위 없음</option>
          {parts.map((part) => (
            <option key={part.id} value={part.id}>
              {part.name}
            </option>
          ))}
        </select>
      </label>
      <div className="records-period" aria-label="기간">
        <label className="records-field">
          부터
          <input
            type="date"
            value={filters.from ?? ''}
            onChange={(event) => onFilters({ ...filters, from: event.target.value || undefined })}
          />
        </label>
        <label className="records-field">
          까지
          <input
            type="date"
            value={filters.to ?? ''}
            onChange={(event) => onFilters({ ...filters, to: event.target.value || undefined })}
          />
        </label>
      </div>
    </div>
  );
}

// ---- One row of the list ----

function Row({
  row,
  current,
  open,
  partName,
  correctedOn,
  onPick,
  rowRef,
}: {
  row: RecordRow;
  current: boolean;
  open: boolean;
  partName: (id: string) => string;
  correctedOn: string | undefined;
  onPick: () => void;
  rowRef: ((element: HTMLLIElement | null) => void) | undefined;
}) {
  const suggested = row.by === 'ai' && row.state !== 'kept';
  return (
    <li
      ref={rowRef}
      role="option"
      aria-selected={current}
      aria-expanded={open}
      data-state={row.state}
      data-record-type={row.type}
      className="records-row"
      onClick={onPick}
    >
      <span className="records-when">
        {row.date}
        {row.time ? ` ${row.time}` : ''}
      </span>
      <span className="records-source">{SOURCE_NAME[row.source] ?? row.source}</span>
      <span className="records-type" title={TYPE_HINT[row.type]}>
        {row.type}
      </span>
      <span className="records-text">{row.text}</span>
      <span className="records-parts">
        {row.parts.length ? (
          row.parts.map((id) => (
            <span key={id} className="records-part">
              {partName(id)}
            </span>
          ))
        ) : (
          <span className="records-part records-part-none">부위 없음</span>
        )}
      </span>
      <span className="records-marks">
        {suggested ? (
          <span className="records-suggested" title="AI가 만든 후보입니다">
            제안
          </span>
        ) : null}
        {row.undone ? <span className="records-flag">되돌림</span> : null}
        {row.supersededBy ? (
          <span className="records-flag">정정됨{correctedOn ? ` → ${correctedOn}` : ''}</span>
        ) : null}
        <span className="records-state" aria-label={STATE_NAME[row.state]} />
      </span>
    </li>
  );
}

// ---- The 자세히 column ----

function Detail({
  projectId,
  row,
  rows,
  parts,
  remote,
  onChanged,
  onCorrected,
  onClose,
}: {
  projectId: string;
  row: RecordRow;
  rows: Map<string, RecordRow>;
  parts: PartRow[];
  remote: boolean;
  onChanged: (rows: RecordRow[]) => void;
  onCorrected: (fresh: RecordRow) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<string | undefined>();
  const [correcting, setCorrecting] = useState<string | undefined>();
  const [partQuery, setPartQuery] = useState('');
  const [joining, setJoining] = useState<'before' | 'after' | undefined>();
  const [joinQuery, setJoinQuery] = useState('');
  const [notice, setNotice] = useState<string | undefined>();
  useEffect(() => {
    setEditing(undefined);
    setCorrecting(undefined);
    setJoining(undefined);
    setNotice(undefined);
  }, [row.id]);
  const run = async (work: () => Promise<void>) => {
    setNotice(undefined);
    try {
      await work();
    } catch (error) {
      setNotice(textOf(error));
    }
  };
  const fresh = async (...ids: string[]) =>
    onChanged(await Promise.all(ids.map((id) => getRecord(projectId, id))));
  const partName = (id: string) => parts.find((part) => part.id === id)?.name ?? '지운 부위';
  const line = (id: string) => {
    const other = rows.get(id);
    return (
      <>
        <span className="records-type">{other?.type ?? '?'}</span>
        <span className="records-text">{other?.text ?? '목록 밖의 기록'}</span>
      </>
    );
  };
  const sourceTarget = row.attachments.requestId
    ? '요청'
    : row.attachments.note
      ? '노트'
      : row.attachments.jig
        ? 'jig'
        : row.attachments.reviewId
          ? '검토본'
          : undefined;
  const goToSource = () => {
    const { requestId, note, jig, reviewId } = row.attachments;
    if (requestId) {
      setWorkspace('model');
      requestAnimationFrame(() => {
        const open = document.querySelector<HTMLButtonElement>(
          `#task-list [data-task-id="${CSS.escape(requestId)}"] .task-open`,
        );
        if (open) open.click();
        else setNotice('작업 이력에서 이 요청을 찾지 못했습니다.');
      });
    } else if (note) setWorkspace('notes');
    else if (jig) setWorkspace('', { instanceId: jig.instanceId });
    else if (reviewId) setWorkspace('output', { outputView: 'review' });
  };
  const matches = (query: string) =>
    [...rows.values()]
      .filter((other) => other.id !== row.id && other.text.includes(query.trim()))
      .slice(0, 8);
  const corrected = row.supersededBy ? rows.get(row.supersededBy) : undefined;
  return (
    <aside className="records-detail" aria-label="자세히">
      <div className="records-detail-head">
        <span className="records-type" title={TYPE_HINT[row.type]}>
          {row.type}
        </span>
        <span>
          {TYPE_NAME[row.type]} · {SOURCE_NAME[row.source] ?? row.source} · {row.date}
          {row.time ? ` ${row.time}` : ''} · {STATE_NAME[row.state]}
        </span>
        <button type="button" className="link-button" onClick={onClose}>
          닫기
        </button>
      </div>
      {row.supersededBy ? (
        <p className="records-flag">정정됨{corrected ? ` → ${shortDate(corrected.date)}` : ''}</p>
      ) : null}
      {editing !== undefined ? (
        <div className="records-edit">
          <textarea
            aria-label="본문"
            value={editing}
            onChange={(event) => setEditing(event.target.value)}
          />
          <div className="records-actions">
            <button
              type="button"
              className="link-button"
              disabled={!editing.trim()}
              onClick={() =>
                void run(async () => {
                  onChanged([await patchRecord(projectId, row.id, { text: editing })]);
                  setEditing(undefined);
                })
              }
            >
              저장
            </button>
            <button type="button" className="link-button" onClick={() => setEditing(undefined)}>
              취소
            </button>
          </div>
        </div>
      ) : (
        <p className="records-body">{row.text}</p>
      )}
      {row.updatedBy ? (
        <p className="records-muted">
          고친 사람 {row.updatedBy === 'ai' ? 'AI' : row.updatedBy} · {localStamp(row.updatedAt)}
        </p>
      ) : null}
      {remote ? null : (
        <div className="records-actions">
          <button
            type="button"
            className="link-button"
            onClick={() =>
              void run(async () => onChanged([await setRecordState(projectId, row.id, 'kept')]))
            }
          >
            남김 O
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() =>
              void run(async () => onChanged([await setRecordState(projectId, row.id, 'dropped')]))
            }
          >
            뺌 X
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() =>
              void run(async () =>
                onChanged([await setRecordState(projectId, row.id, 'candidate')]),
              )
            }
          >
            표시 지움
          </button>
          {row.state === 'kept' && !row.supersededBy && editing === undefined ? (
            <button type="button" className="link-button" onClick={() => setEditing(row.text)}>
              고치기
            </button>
          ) : null}
        </div>
      )}
      <section aria-label="유형">
        <h4>유형</h4>
        {remote || row.supersededBy ? (
          <p>{TYPE_HINT[row.type]}</p>
        ) : (
          <select
            aria-label="유형 고르기"
            value={row.type}
            onChange={(event) =>
              void run(async () =>
                onChanged([
                  await patchRecord(projectId, row.id, { type: event.target.value as RecordType }),
                ]),
              )
            }
          >
            {(row.type === '?' ? TYPE_ORDER : PERSON_TYPES).map((type) => (
              <option key={type} value={type}>
                {TYPE_HINT[type]}
              </option>
            ))}
          </select>
        )}
      </section>
      <section aria-label="부위">
        <h4>부위</h4>
        <div className="records-parts">
          {row.parts.length ? null : (
            <span className="records-part records-part-none">부위 없음</span>
          )}
          {row.parts.map((id) => (
            <span key={id} className="records-part">
              {partName(id)}
              {remote || row.supersededBy ? null : (
                <button
                  type="button"
                  className="records-x"
                  aria-label={`${partName(id)} 떼기`}
                  onClick={() =>
                    void run(async () =>
                      onChanged([
                        await patchRecord(projectId, row.id, {
                          parts: row.parts.filter((part) => part !== id),
                        }),
                      ]),
                    )
                  }
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
        {remote || row.supersededBy ? null : (
          <>
            <input
              aria-label="부위 찾기"
              placeholder="부위 찾기"
              value={partQuery}
              onChange={(event) => setPartQuery(event.target.value)}
            />
            {partQuery.trim() ? (
              <ul className="records-pick">
                {parts
                  .filter(
                    (part) => !row.parts.includes(part.id) && part.name.includes(partQuery.trim()),
                  )
                  .slice(0, 8)
                  .map((part) => (
                    <li key={part.id}>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() =>
                          void run(async () => {
                            onChanged([
                              await patchRecord(projectId, row.id, {
                                parts: [...row.parts, part.id],
                              }),
                            ]);
                            setPartQuery('');
                          })
                        }
                      >
                        {part.name}
                      </button>
                    </li>
                  ))}
              </ul>
            ) : null}
          </>
        )}
      </section>
      <section aria-label="이어진 기록">
        <h4>이어진 기록</h4>
        <ul className="records-chain">
          {row.followedBy.map((id) => (
            <li key={`before-${id}`} className="records-chain-row">
              <span className="records-muted">앞</span>
              {line(id)}
              {remote ? null : (
                <button
                  type="button"
                  className="records-x"
                  aria-label="앞 기록 떼기"
                  onClick={() =>
                    void run(async () => {
                      await unlinkRecords(projectId, id, row.id);
                      await fresh(row.id, id);
                    })
                  }
                >
                  ×
                </button>
              )}
            </li>
          ))}
          <li className="records-chain-row records-chain-self">
            <span className="records-muted">이 기록</span>
            <span className="records-type">{row.type}</span>
            <span className="records-text">{row.text}</span>
          </li>
          {row.follows.map((id) => (
            <li key={`after-${id}`} className="records-chain-row">
              <span className="records-muted">뒤</span>
              {line(id)}
              {remote ? null : (
                <button
                  type="button"
                  className="records-x"
                  aria-label="뒤 기록 떼기"
                  onClick={() =>
                    void run(async () => {
                      await unlinkRecords(projectId, row.id, id);
                      await fresh(row.id, id);
                    })
                  }
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
        {remote ? null : (
          <div className="records-actions">
            <button type="button" className="link-button" onClick={() => setJoining('before')}>
              앞 기록 잇기
            </button>
            <button type="button" className="link-button" onClick={() => setJoining('after')}>
              뒤 기록 잇기
            </button>
          </div>
        )}
        {joining ? (
          <div className="records-join">
            <input
              aria-label={joining === 'before' ? '앞 기록 찾기' : '뒤 기록 찾기'}
              placeholder="본문으로 찾기"
              value={joinQuery}
              autoFocus
              onChange={(event) => setJoinQuery(event.target.value)}
            />
            {joinQuery.trim() ? (
              <ul className="records-pick">
                {matches(joinQuery).map((other) => (
                  <li key={other.id}>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() =>
                        void run(async () => {
                          if (joining === 'before') await linkRecords(projectId, other.id, row.id);
                          else await linkRecords(projectId, row.id, other.id);
                          await fresh(row.id, other.id);
                          setJoining(undefined);
                          setJoinQuery('');
                        })
                      }
                    >
                      {other.date} · {other.text}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>
      <div className="records-actions">
        {sourceTarget ? (
          <button type="button" className="link-button" onClick={goToSource}>
            출처로 가기 ({sourceTarget})
          </button>
        ) : null}
        {remote || row.supersededBy || correcting !== undefined ? null : (
          <button type="button" className="link-button" onClick={() => setCorrecting(row.text)}>
            정정 기록 만들기
          </button>
        )}
      </div>
      {correcting !== undefined ? (
        <div className="records-edit">
          <textarea
            aria-label="정정한 본문"
            value={correcting}
            onChange={(event) => setCorrecting(event.target.value)}
          />
          <div className="records-actions">
            <button
              type="button"
              className="link-button"
              disabled={!correcting.trim() || correcting.trim() === row.text.trim()}
              onClick={() =>
                void run(async () => {
                  const made = await correctRecord(projectId, row.id, { text: correcting });
                  setCorrecting(undefined);
                  onCorrected(made);
                })
              }
            >
              정정 기록으로 남기기
            </button>
            <button type="button" className="link-button" onClick={() => setCorrecting(undefined)}>
              취소
            </button>
          </div>
          <p className="records-muted">옛 기록은 지우지 않고 '정정됨'으로 남습니다.</p>
        </div>
      ) : null}
      {notice ? (
        <p className="records-notice" role="status">
          {notice}
        </p>
      ) : null}
    </aside>
  );
}

// ---- The 부위 사전 screen ----

function MappingEditor({
  projectId,
  links,
  initial,
  onSave,
  onCancel,
}: {
  projectId: string;
  links: LinkSummary[];
  initial?: PartMapping;
  onSave: (mapping: PartMapping) => void;
  onCancel: () => void;
}) {
  const [linkId, setLinkId] = useState(
    initial && 'linkId' in initial ? initial.linkId : (links[0]?.id ?? ''),
  );
  const [layers, setLayers] = useState<string[] | undefined>();
  const [layer, setLayer] = useState('');
  useEffect(() => {
    setLayers(undefined);
    const link = links.find((entry) => entry.id === linkId);
    if (!link) {
      setLayers([]);
      return;
    }
    let live = true;
    void linkLayers(projectId, link).then((names) => {
      if (live) setLayers(names);
    });
    return () => {
      live = false;
    };
  }, [projectId, links, linkId]);
  const save = () => {
    if (linkId && layer.trim()) onSave({ kind: 'layer', linkId, layer: layer.trim() });
  };
  return (
    <div className="records-mapping-editor" role="group" aria-label="레이어 잇기">
      {links.length ? (
        <label className="records-field">
          연결 파일
          <select value={linkId} onChange={(event) => setLinkId(event.target.value)}>
            {links.map((link) => (
              <option key={link.id} value={link.id}>
                {link.name}
              </option>
            ))}
          </select>
        </label>
      ) : linkId ? (
        <p className="records-muted">같은 연결 파일에 다시 잇습니다.</p>
      ) : (
        <p className="records-muted">연결 파일을 먼저 이어 두세요.</p>
      )}
      {layers?.length ? (
        <label className="records-field">
          레이어
          <select value={layer} onChange={(event) => setLayer(event.target.value)}>
            <option value="">고르기</option>
            {layers.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="records-field">
          레이어 이름
          <input value={layer} onChange={(event) => setLayer(event.target.value)} />
        </label>
      )}
      <button
        type="button"
        className="link-button"
        disabled={!linkId || !layer.trim()}
        onClick={save}
      >
        잇기
      </button>
      <button type="button" className="link-button" onClick={onCancel}>
        취소
      </button>
    </div>
  );
}

function PartsScreen({
  projectId,
  parts,
  all,
  remote,
  onParts,
  onBack,
}: {
  projectId: string;
  parts: PartRow[];
  all: RecordRow[];
  remote: boolean;
  onParts: (parts: PartRow[]) => void;
  onBack: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', grp: '', roleFrom: '', roleTo: '', chapter: '' });
  const [status, setStatus] = useState<Map<string, PartStatus>>(new Map());
  const [links, setLinks] = useState<LinkSummary[]>([]);
  const [mapping, setMapping] = useState<{ partId: string; index?: number } | undefined>();
  const [milestones, setMilestones] = useState<MilestoneRow[]>([]);
  const [milestone, setMilestone] = useState({ label: '', date: '' });
  const [notice, setNotice] = useState<string | undefined>();
  const readStatus = useCallback(async () => {
    const answer = await partsStatus(projectId);
    setStatus(new Map((answer ?? []).map((entry) => [entry.partId, entry])));
  }, [projectId]);
  useEffect(() => {
    void readStatus();
    listLinks(projectId).then(
      (list) => setLinks(Array.isArray(list) ? list : []),
      () => setLinks([]),
    );
    listMilestones(projectId).then(setMilestones, () => setMilestones([]));
  }, [projectId, readStatus]);
  const run = async (work: () => Promise<void>) => {
    setNotice(undefined);
    try {
      await work();
    } catch (error) {
      setNotice(textOf(error));
    }
  };
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const row of all) for (const id of row.parts) out.set(id, (out.get(id) ?? 0) + 1);
    return out;
  }, [all]);
  const linkName = (id: string) => links.find((link) => link.id === id)?.name ?? '연결 파일';
  const mappingText = (entry: PartMapping) =>
    entry.kind === 'layer'
      ? `${linkName(entry.linkId)} · ${entry.layer}`
      : entry.kind === 'objects'
        ? `${linkName(entry.linkId)} · 객체 ${entry.ids.length}개`
        : 'jig 결과';
  const replacePart = (next: PartRow) =>
    onParts(parts.map((part) => (part.id === next.id ? next : part)));
  const saveMapping = (part: PartRow, entry: PartMapping, index?: number) =>
    void run(async () => {
      const list =
        index === undefined
          ? [...part.mapping, entry]
          : part.mapping.map((old, k) => (k === index ? entry : old));
      replacePart(await setPart(projectId, part.id, { mapping: list }));
      setMapping(undefined);
      await readStatus();
    });
  const grpText = (value: string | null) => value ?? '—';
  const optional = (value: string) => (value.trim() ? value.trim() : null);
  return (
    <div className="records-parts-screen" role="region" aria-label="부위 사전">
      <div className="records-head">
        <button type="button" className="link-button" onClick={onBack}>
          기록으로
        </button>
        <h3>부위 사전</h3>
        {remote ? null : (
          <button type="button" className="link-button" onClick={() => setAdding(!adding)}>
            부위 추가
          </button>
        )}
      </div>
      {adding && !remote ? (
        <form
          className="records-part-form"
          aria-label="부위 추가"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const part = await addPart(projectId, {
                name: form.name.trim(),
                grp: optional(form.grp),
                roleFrom: optional(form.roleFrom),
                roleTo: optional(form.roleTo),
                chapter: optional(form.chapter),
              });
              onParts([...parts, part]);
              setForm({ name: '', grp: '', roleFrom: '', roleTo: '', chapter: '' });
              setAdding(false);
            });
          }}
        >
          <label className="records-field">
            이름
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </label>
          <label className="records-field">
            그룹
            <select
              value={form.grp}
              onChange={(event) => setForm({ ...form, grp: event.target.value })}
            >
              <option value="">없음</option>
              <option value="신설">신설</option>
              <option value="기존">기존</option>
            </select>
          </label>
          <label className="records-field">
            역할(시작)
            <input
              value={form.roleFrom}
              onChange={(event) => setForm({ ...form, roleFrom: event.target.value })}
            />
          </label>
          <label className="records-field">
            역할(끝)
            <input
              value={form.roleTo}
              onChange={(event) => setForm({ ...form, roleTo: event.target.value })}
            />
          </label>
          <label className="records-field">
            장
            <input
              value={form.chapter}
              onChange={(event) => setForm({ ...form, chapter: event.target.value })}
            />
          </label>
          <button type="submit" className="link-button" disabled={!form.name.trim()}>
            저장
          </button>
        </form>
      ) : null}
      {parts.length ? (
        <table className="records-parts-table">
          <thead>
            <tr>
              <th>이름</th>
              <th>그룹</th>
              <th>장</th>
              <th>역할 문장</th>
              <th>이어진 레이어</th>
              <th>기록 수</th>
              {remote ? null : <th aria-label="고치기" />}
            </tr>
          </thead>
          <tbody>
            {parts.map((part) => {
              const state = status.get(part.id);
              const unknown = (index: number) => state?.unknownIndexes?.includes(index) ?? false;
              const brokenText = (index: number) =>
                BREAK_TEXT[state?.reasons?.[state.broken.indexOf(index)] ?? 'layer-missing'];
              return (
                <tr key={part.id} data-part-id={part.id}>
                  <td>{part.name}</td>
                  <td>{grpText(part.grp)}</td>
                  <td>{grpText(part.chapter)}</td>
                  <td>
                    {part.roleFrom || part.roleTo
                      ? `${part.roleFrom ?? '—'} → ${part.roleTo ?? '—'}`
                      : '—'}
                  </td>
                  <td>
                    <ul className="records-mappings">
                      {part.mapping.map((entry, index) => (
                        <li key={index}>
                          <span title={entry.kind === 'jig-output' ? entry.outputId : undefined}>
                            {mappingText(entry)}
                          </span>
                          {state?.broken.includes(index) ? (
                            <>
                              <span className="records-broken">{brokenText(index)}</span>
                              {remote ? null : (
                                <button
                                  type="button"
                                  className="link-button"
                                  onClick={() => setMapping({ partId: part.id, index })}
                                >
                                  다시 잇기
                                </button>
                              )}
                            </>
                          ) : unknown(index) ? (
                            <span className="records-muted">연결이 닫혀 있어 확인 못 함</span>
                          ) : null}
                          {remote ? null : (
                            <button
                              type="button"
                              className="records-x"
                              aria-label="레이어 떼기"
                              onClick={() =>
                                void run(async () => {
                                  replacePart(
                                    await setPart(projectId, part.id, {
                                      mapping: part.mapping.filter((_, k) => k !== index),
                                    }),
                                  );
                                  await readStatus();
                                })
                              }
                            >
                              ×
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                    {mapping?.partId === part.id ? (
                      <MappingEditor
                        projectId={projectId}
                        links={links}
                        initial={
                          mapping.index === undefined ? undefined : part.mapping[mapping.index]
                        }
                        onSave={(entry) => saveMapping(part, entry, mapping.index)}
                        onCancel={() => setMapping(undefined)}
                      />
                    ) : remote ? null : (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => setMapping({ partId: part.id })}
                      >
                        레이어 잇기
                      </button>
                    )}
                  </td>
                  <td className="records-count-cell">{counts.get(part.id) ?? 0}</td>
                  {remote ? null : (
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() =>
                          void run(async () => {
                            await removePart(projectId, part.id);
                            onParts(parts.filter((entry) => entry.id !== part.id));
                          })
                        }
                      >
                        지우기
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="records-empty">
          아직 부위가 없습니다. 이름과 그룹(신설·기존)을 적어 부위를 만들고 레이어를 이으세요.
        </p>
      )}
      <section className="records-milestones" aria-label="마일스톤">
        <h4>마일스톤</h4>
        <ul>
          {milestones.map((entry) => (
            <li key={entry.id}>
              <span className="records-when">{entry.date}</span> {entry.label}
              {remote ? null : (
                <button
                  type="button"
                  className="records-x"
                  aria-label={`${entry.label} 지우기`}
                  onClick={() =>
                    void run(async () => {
                      await removeMilestone(projectId, entry.id);
                      setMilestones(milestones.filter((item) => item.id !== entry.id));
                    })
                  }
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
        {remote ? null : (
          <form
            className="records-part-form"
            aria-label="마일스톤 추가"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const made = await addMilestone(projectId, {
                  label: milestone.label.trim(),
                  date: milestone.date,
                });
                setMilestones([...milestones, made].sort((a, b) => a.date.localeCompare(b.date)));
                setMilestone({ label: '', date: '' });
              });
            }}
          >
            <label className="records-field">
              이름
              <input
                value={milestone.label}
                placeholder="당선 · 납품 · 착공"
                onChange={(event) => setMilestone({ ...milestone, label: event.target.value })}
              />
            </label>
            <label className="records-field">
              날짜
              <input
                type="date"
                value={milestone.date}
                onChange={(event) => setMilestone({ ...milestone, date: event.target.value })}
              />
            </label>
            <button
              type="submit"
              className="link-button"
              disabled={!milestone.label.trim() || !milestone.date}
            >
              마일스톤 추가
            </button>
          </form>
        )}
      </section>
      {notice ? (
        <p className="records-notice" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

// ---- The tab ----

function RecordsTab({ projectId }: { projectId: string }) {
  const remote = remoteSession();
  const [view, setView] = useState<View>(() => readView(projectId));
  const [panel, setPanel] = useState<Panel>('records');
  const [filters, setFilters] = useState<RecordFilters>({ state: DEFAULT_STATES });
  const [rows, setRows] = useState<RecordRow[] | undefined>();
  const [all, setAll] = useState<RecordRow[]>([]);
  const [parts, setParts] = useState<PartRow[]>([]);
  const [error, setError] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [openId, setOpenId] = useState<string | undefined>();
  const [confirm, setConfirm] = useState<RecordState | undefined>();
  const [menu, setMenu] = useState(false);
  const [marks, setMarks] = useState<string | undefined>();
  const [pasting, setPasting] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const current = useRef<HTMLLIElement | null>(null);

  const loadAll = useCallback(async () => {
    const [everything, partList] = await Promise.all([
      listRecords(projectId),
      listParts(projectId).catch(() => [] as PartRow[]),
    ]);
    setAll(everything.records);
    setParts(partList);
  }, [projectId]);
  const listSeq = useRef(0);
  const loadList = useCallback(
    async (keep = false) => {
      setError(false);
      const seq = ++listSeq.current;
      try {
        const answer = await listRecords(projectId, filters);
        // A late answer for an older filter is dropped.
        if (seq !== listSeq.current) return;
        setRows(answer.records);
        if (!keep) {
          const first = answer.records.findIndex((row) => row.state === 'candidate');
          setCursor(Math.max(0, first));
        }
      } catch {
        setError(true);
      }
    },
    [projectId, filters],
  );
  const reload = useCallback(async () => {
    try {
      await loadAll();
    } catch {
      setError(true);
    }
    await loadList();
  }, [loadAll, loadList]);
  useEffect(() => {
    void loadAll().catch(() => setError(true));
  }, [loadAll]);
  useEffect(() => {
    void loadList();
  }, [loadList]);
  // Shown again (the rail): read what changed meanwhile, keeping the place in the list.
  useEffect(() => {
    const again = () => {
      void loadAll()
        .then(() => loadList(true))
        .catch(() => setError(true));
    };
    addEventListener(SHOWN, again);
    return () => removeEventListener(SHOWN, again);
  }, [loadAll, loadList]);

  const byId = useMemo(() => new Map(all.map((row) => [row.id, row])), [all]);
  const partName = useCallback(
    (id: string) => parts.find((part) => part.id === id)?.name ?? '지운 부위',
    [parts],
  );
  /** Rows the server answered after a change: they take their old places in both lists. */
  const changed = useCallback((fresh: RecordRow[]) => {
    const map = new Map(fresh.map((row) => [row.id, row]));
    const swap = (list: RecordRow[]) => list.map((row) => map.get(row.id) ?? row);
    setRows((list) => (list ? swap(list) : list));
    setAll((list) => swap(list));
  }, []);
  const visible = rows ?? [];
  const opened = openId
    ? (byId.get(openId) ?? visible.find((row) => row.id === openId))
    : undefined;

  const mark = useCallback(
    async (row: RecordRow, state: RecordState) => {
      setNotice(undefined);
      try {
        changed([await setRecordState(projectId, row.id, state)]);
      } catch (error) {
        setNotice(textOf(error));
      }
    },
    [projectId, changed],
  );

  // Keys: J/K move, O 남김, X 뺌, Backspace 표시 지움, E/Enter 자세히, Esc closes 자세히.
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (document.body.dataset.workspace !== 'records' || panel !== 'records' || view !== 'list')
        return;
      if (typing(event) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (!visible.length) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const index = Math.min(cursor, visible.length - 1);
      const row = visible[index]!;
      const next = () => setCursor(Math.min(visible.length - 1, index + 1));
      if (key === 'j' || key === 'ArrowDown') {
        event.preventDefault();
        next();
      } else if (key === 'k' || key === 'ArrowUp') {
        event.preventDefault();
        setCursor(Math.max(0, index - 1));
      } else if (!remote && (key === 'o' || key === 'x' || key === 'Backspace')) {
        event.preventDefault();
        void mark(row, key === 'o' ? 'kept' : key === 'x' ? 'dropped' : 'candidate');
        next();
      } else if (key === 'e' || (key === 'Enter' && !(event.target instanceof HTMLButtonElement))) {
        event.preventDefault();
        setOpenId(row.id);
      } else if (key === 'Escape' && openId) setOpenId(undefined);
    };
    addEventListener('keydown', keys);
    return () => removeEventListener('keydown', keys);
  }, [visible, cursor, panel, view, remote, mark, openId]);
  // Braces: scrollIntoView may return a promise, which must not be taken for a cleanup.
  useEffect(() => {
    void current.current?.scrollIntoView({ block: 'nearest' });
  }, [cursor, rows]);

  const chooseView = (next: View) => {
    setView(next);
    saveView(projectId, next);
  };
  const markAll = async (state: RecordState) => {
    setConfirm(undefined);
    setNotice(undefined);
    try {
      const ids = visible.map((row) => row.id);
      await setRecordStates(projectId, ids, state);
      changed(visible.map((row) => ({ ...row, state })));
    } catch (error) {
      setNotice(textOf(error));
    }
  };
  const showMarks = async () => {
    setNotice(undefined);
    try {
      const marks = visible.map((row) => MARK_OF[row.state]).join('');
      setMarks(marks);
      setPasting(undefined);
      try {
        await navigator.clipboard?.writeText(marks);
        setNotice(`표시 ${marks.length}자를 복사했습니다.`);
      } catch {
        setNotice('아래 표시를 골라 복사하세요.');
      }
    } catch (error) {
      setNotice(textOf(error));
    }
  };
  const download = async () => {
    setNotice(undefined);
    try {
      const text = await exportLines(projectId, filters);
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `기록-${today()}.jsonl`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setNotice(textOf(error));
    }
  };
  const bringIn = async (text: string) => {
    setNotice(undefined);
    try {
      const value = text.trim();
      // The rows on screen are the list (marked rows stay in place until the next read).
      const ids = visible.map((row) => row.id);
      if (value.length !== ids.length) {
        setNotice(
          `표시 ${value.length}자와 지금 보이는 기록 ${ids.length}건이 다릅니다. 같은 거르기에서 불러오세요.`,
        );
        return;
      }
      const count = await importMarks(projectId, ids, value);
      setPasting(undefined);
      setNotice(`${count}건의 표시를 바꿨습니다.`);
      await loadAll();
      await loadList(true);
    } catch (error) {
      setNotice(textOf(error));
    }
  };

  const views = (
    <div className="records-views" role="tablist" aria-label="기록 보기">
      {(
        [
          ['list', '목록'],
          ['chart', '차트'],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={view === id}
          className="records-view-chip"
          onClick={() => chooseView(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (panel === 'parts')
    return (
      <div className="records-tab records-tab-parts">
        <PartsScreen
          projectId={projectId}
          parts={parts}
          all={all}
          remote={remote}
          onParts={setParts}
          onBack={() => setPanel('records')}
        />
      </div>
    );

  return (
    <div className={`records-tab${opened ? ' records-tab-detail' : ''}`}>
      <div className="records-left">
        <Summary all={all} filters={filters} onFilters={setFilters} />
        <Filters all={all} parts={parts} filters={filters} onFilters={setFilters} />
        <div className="records-left-foot">
          <button
            type="button"
            className="link-button"
            onClick={() => setFilters({ state: ['candidate'] })}
          >
            후보 모두 보기
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => setFilters({ state: ['kept'] })}
          >
            남긴 것만
          </button>
          <button type="button" className="link-button" onClick={() => setPanel('parts')}>
            부위 사전
          </button>
        </div>
      </div>
      <div className="records-centre">
        <div className="records-head">
          {views}
          {view === 'list' && rows ? (
            <span className="records-total">{visible.length}건</span>
          ) : null}
          <span className="records-spacer" />
          {view === 'list' && !remote && visible.length ? (
            <>
              <button type="button" className="link-button" onClick={() => setConfirm('kept')}>
                보이는 것 모두 O
              </button>
              <button type="button" className="link-button" onClick={() => setConfirm('dropped')}>
                모두 X
              </button>
            </>
          ) : null}
          <button type="button" className="link-button" onClick={() => void reload()}>
            다시 읽기
          </button>
          <div className="records-menu">
            <button
              type="button"
              className="link-button"
              aria-label="내보내기·불러오기"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              ⋯
            </button>
            {menu ? (
              <div className="records-menu-list" role="menu" aria-label="내보내기·불러오기">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    void showMarks();
                  }}
                >
                  표시 문자열 복사(o/x/.)
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    void download();
                  }}
                >
                  보이는 기록 내려받기(한 줄에 한 건)
                </button>
                {remote ? null : (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      setMarks(undefined);
                      setPasting('');
                    }}
                  >
                    표시 불러오기
                  </button>
                )}
              </div>
            ) : null}
          </div>
        </div>
        {confirm ? (
          <div className="records-confirm" role="group" aria-label="모두 바꾸기 확인">
            <span>
              {visible.length}건을 {confirm === 'kept' ? '남깁니다' : '뺍니다'}
            </span>
            <button type="button" className="link-button" onClick={() => void markAll(confirm)}>
              확인
            </button>
            <button type="button" className="link-button" onClick={() => setConfirm(undefined)}>
              취소
            </button>
          </div>
        ) : null}
        {marks !== undefined ? (
          <div className="records-marks-box">
            <textarea readOnly aria-label="표시 문자열" value={marks} rows={2} />
            <button type="button" className="link-button" onClick={() => setMarks(undefined)}>
              닫기
            </button>
          </div>
        ) : null}
        {pasting !== undefined ? (
          <div className="records-marks-box">
            <textarea
              aria-label="불러올 표시"
              placeholder="o · x · . 한 글자가 한 건입니다 (지금 보이는 순서)"
              value={pasting}
              rows={2}
              onChange={(event) => setPasting(event.target.value)}
            />
            <button
              type="button"
              className="link-button"
              disabled={!pasting.trim()}
              onClick={() => void bringIn(pasting)}
            >
              불러오기
            </button>
            <button type="button" className="link-button" onClick={() => setPasting(undefined)}>
              취소
            </button>
          </div>
        ) : null}
        {notice ? (
          <p className="records-notice" role="status">
            {notice}
          </p>
        ) : null}
        {view === 'chart' ? (
          <p className="records-empty">
            차트는 다음 업데이트에서 열립니다. 지금은 [목록]에서 거르세요.
          </p>
        ) : error ? (
          <p className="records-empty">기록을 읽지 못했습니다. [다시 읽기]로 다시 시도하세요.</p>
        ) : !rows ? (
          <p className="records-empty">읽는 중…</p>
        ) : !all.length ? (
          <div className="records-empty">
            <p>아직 기록이 없습니다.</p>
            <p>요청을 실행하거나 노트를 저장하면 후보가 여기 쌓입니다.</p>
          </div>
        ) : !visible.length ? (
          <p className="records-empty">거르기에 맞는 기록이 없습니다.</p>
        ) : (
          <ul className="records-list" role="listbox" aria-label="기록 목록">
            {visible.map((row, index) => {
              const on = index === Math.min(cursor, visible.length - 1);
              const corrected = row.supersededBy ? byId.get(row.supersededBy) : undefined;
              return (
                <Row
                  key={row.id}
                  row={row}
                  current={on}
                  open={openId === row.id}
                  partName={partName}
                  correctedOn={corrected ? shortDate(corrected.date) : undefined}
                  rowRef={
                    on
                      ? (element) => {
                          current.current = element;
                        }
                      : undefined
                  }
                  onPick={() => {
                    setCursor(index);
                    setOpenId(row.id);
                  }}
                />
              );
            })}
          </ul>
        )}
      </div>
      {opened && view === 'list' ? (
        <Detail
          projectId={projectId}
          row={opened}
          rows={byId}
          parts={parts}
          remote={remote}
          onChanged={changed}
          onCorrected={(made) => {
            setOpenId(made.id);
            void loadAll().then(() => loadList(true));
          }}
          onClose={() => setOpenId(undefined)}
        />
      ) : null}
    </div>
  );
}

const SHOWN = 'vide:records-shown';
let root: Root | undefined;
let shownFor: string | undefined;

/** Show the 기록 tab of a project (mounts once; later calls keep what is open). */
export function showRecords(projectId: string) {
  const workspace = document.querySelector<HTMLElement>('.workspace');
  if (!workspace) return;
  if (!root) {
    const host = document.createElement('section');
    host.className = 'records-workspace';
    host.setAttribute('aria-label', '기록');
    workspace.append(host);
    root = createRoot(host);
  }
  if (shownFor !== projectId) {
    shownFor = projectId;
    root.render(<RecordsTab key={projectId} projectId={projectId} />);
  } else dispatchEvent(new CustomEvent(SHOWN));
}
