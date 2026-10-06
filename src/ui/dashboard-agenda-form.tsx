// 대시보드 › 일정 폼 (SPEC-01.14 3·4, Design §03 「대시보드의 일정」, PLAN-39 T-182): the fields of one
// 할 일 or 일정 — title, kind, 하루 종일, start and end day and time, 위치, 참석자. The calendar opens
// it over a day ([추가]) or an item ([저장]·[삭제]·[날짜 빼기]); a row of the 할 일 area edits in
// place with the same fields. The parent holds the fields (so a save refused by another screen's
// change can lay the user's changes over the newer item); this component only draws and checks.
import { useState, type FormEvent } from 'react';
import type { AgendaItem, AgendaKind } from '../contracts/agenda.ts';
import { KIND_LABELS } from './agenda-text.ts';

/** The fields as the form holds them ('' for none). */
export interface AgendaFields {
  text: string;
  date: string;
  time: string;
  endDate: string;
  endTime: string;
  kind: AgendaKind;
  location: string;
  attendees: string;
}
export const FIELD_KEYS = [
  'text',
  'date',
  'time',
  'endDate',
  'endTime',
  'kind',
  'location',
  'attendees',
] as const;
export const fieldsOf = (entry: AgendaItem): AgendaFields => ({
  text: entry.text,
  date: entry.date ?? '',
  time: entry.time ?? '',
  endDate: entry.endDate ?? '',
  endTime: entry.endTime ?? '',
  kind: entry.kind,
  location: entry.location ?? '',
  attendees: entry.attendees ?? '',
});
export const blankFields = (date = ''): AgendaFields => ({
  text: '',
  date,
  time: '',
  endDate: '',
  endTime: '',
  kind: 'task',
  location: '',
  attendees: '',
});
/** The day `days` after a 'YYYY-MM-DD'. */
function shiftDay(value: string, days: number) {
  const [y, m, d] = value.split('-').map(Number);
  const at = new Date(y, m - 1, d + days);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}
const dayNumber = (value: string) => {
  const [y, m, d] = value.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
};
/** Why the period cannot be saved, or ''. */
export function periodProblem(fields: AgendaFields) {
  if (fields.endDate && fields.date && fields.endDate < fields.date)
    return '끝 날짜가 시작보다 앞섭니다.';
  if (
    fields.time &&
    fields.endTime &&
    (!fields.endDate || fields.endDate === fields.date) &&
    fields.endTime <= fields.time
  )
    return '끝 시각이 시작보다 앞섭니다.';
  return '';
}
/** The request body of a new item: '' fields left out. */
export function createBody(fields: AgendaFields) {
  const body: Record<string, unknown> = { text: fields.text.trim(), kind: fields.kind };
  for (const key of ['date', 'time', 'endDate', 'endTime', 'location', 'attendees'] as const)
    if (fields[key].trim()) body[key] = fields[key].trim();
  return body;
}
/** What changed from `from` (sent with the revision read then): '' is null. */
export function changedFields(fields: AgendaFields, from: AgendaFields) {
  const changed: Record<string, unknown> = {};
  for (const key of FIELD_KEYS) {
    if (fields[key].trim() === from[key].trim()) continue;
    changed[key] =
      key === 'kind' || key === 'text' ? fields[key].trim() : fields[key].trim() || null;
  }
  return changed;
}

export function AgendaForm({
  fields,
  onChange,
  variant,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
  onRemove,
  onClearDate,
}: {
  fields: AgendaFields;
  onChange: (fields: AgendaFields) => void;
  /** 'row': in place of a 할 일 row; 'popover': over the calendar. */
  variant: 'row' | 'popover';
  busy: boolean;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
  onRemove?: () => void;
  onClearDate?: () => void;
}) {
  const [allDay, setAllDay] = useState(() => !fields.time);
  const [problem, setProblem] = useState('');
  const set = (patch: Partial<AgendaFields>) => {
    setProblem('');
    onChange({ ...fields, ...patch });
  };
  /** A new start day moves the end day with it (the period is kept). */
  const setStart = (date: string) => {
    if (date && fields.date && fields.endDate)
      set({ date, endDate: shiftDay(fields.endDate, dayNumber(date) - dayNumber(fields.date)) });
    else set({ date, ...(date ? {} : { time: '', endDate: '', endTime: '' }) });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const wrong = periodProblem(fields);
    if (wrong) return setProblem(wrong);
    onSubmit();
  };
  const row = variant === 'row';
  return (
    <form
      className={row ? 'dash-agenda-edit' : 'dash-event-form'}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <input
        type="text"
        className="dash-event-title"
        aria-label={row ? '할 일 고치기' : '일정 제목'}
        placeholder={row ? undefined : '제목'}
        autoFocus
        value={fields.text}
        maxLength={500}
        onChange={(event) => set({ text: event.target.value })}
      />
      <div className="dash-event-line">
        <select
          aria-label="종류"
          value={fields.kind}
          onChange={(event) => set({ kind: event.target.value as AgendaKind })}
        >
          {(Object.keys(KIND_LABELS) as AgendaKind[]).map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABELS[kind]}
            </option>
          ))}
        </select>
        <label className="dash-event-allday">
          <input
            type="checkbox"
            checked={allDay}
            onChange={(event) => {
              setAllDay(event.target.checked);
              if (event.target.checked) set({ time: '', endTime: '' });
            }}
          />
          하루 종일
        </label>
      </div>
      <div className="dash-event-line">
        <span className="dash-event-label">시작</span>
        <input
          type="date"
          aria-label="날짜"
          value={fields.date}
          onChange={(event) => setStart(event.target.value)}
        />
        {allDay ? null : (
          <input
            type="time"
            aria-label="시각"
            value={fields.time}
            onChange={(event) =>
              set({ time: event.target.value, ...(event.target.value ? {} : { endTime: '' }) })
            }
          />
        )}
      </div>
      <div className="dash-event-line">
        <span className="dash-event-label">끝</span>
        <input
          type="date"
          aria-label="끝 날짜"
          value={fields.endDate}
          min={fields.date || undefined}
          disabled={!fields.date}
          onChange={(event) => set({ endDate: event.target.value })}
        />
        {allDay ? null : (
          <input
            type="time"
            aria-label="끝 시각"
            value={fields.endTime}
            disabled={!fields.time}
            onChange={(event) => set({ endTime: event.target.value })}
          />
        )}
      </div>
      <input
        type="text"
        aria-label="위치"
        placeholder="위치"
        value={fields.location}
        maxLength={200}
        onChange={(event) => set({ location: event.target.value })}
      />
      <input
        type="text"
        aria-label="참석자"
        placeholder="참석자 — 예: 김 대리, 설비 업체"
        value={fields.attendees}
        maxLength={300}
        onChange={(event) => set({ attendees: event.target.value })}
      />
      {problem ? (
        <p className="dash-folder-reason" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="dash-event-actions">
        {onRemove ? (
          <button type="button" className="link-button dash-event-remove" onClick={onRemove}>
            삭제
          </button>
        ) : null}
        {onClearDate && fields.date ? (
          <button type="button" className="link-button" onClick={onClearDate}>
            날짜 빼기
          </button>
        ) : null}
        <span className="dash-event-gap" />
        <button type="button" className="link-button" onClick={onCancel}>
          취소
        </button>
        <button type="submit" className="primary-button" disabled={busy || !fields.text.trim()}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
