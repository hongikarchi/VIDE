import { useEffect, useState } from 'react';
import type { ApiCall } from './question-card.tsx';
import './workspace-schema-card.css';

// 연결 폴더 스키마 제안 카드의 행 (Design SCR-36, SPEC-01.13 8, PLAN-52 T-309). The question card
// (SCR-15) carries the three answers [이대로 기억]·[고쳐서 기억]·[나중에]; this part shows the rows the
// engine recorded when the AI read the folder: folder name (Mono, indented by level), the role chip
// and the evidence. A guessed chip has a dashed border and a small '추정'; one the person chose is
// solid without it. Two guessed roles: a warning border '둘 중 고르세요' until the person picks.
// No colour tells guess from choice, and there are no side bars.

export const isSchemaCard = (id: string) => id.startsWith('workspace-schema-');

export type RoleKey =
  | 'ops'
  | 'raw'
  | 'rhino'
  | 'cad'
  | 'review'
  | 'output'
  | 'snapshots'
  | 'references'
  | 'tools'
  | 'archive';
export interface SchemaRow {
  path: string;
  depth: number;
  guess: RoleKey | null;
  candidates: RoleKey[];
  reason: string;
}
export interface SchemaCardData {
  root: string;
  folders: SchemaRow[];
  missing: RoleKey[];
  roles: Record<RoleKey, string>;
  answer?: { option: string | null; roles: Record<string, RoleKey | null> | null };
  stored?: { text?: string };
}
/** The person's role per row: a role key, null for 역할 없음; absent rows keep the guess. */
export type SchemaRoles = Record<string, RoleKey | null>;

/** Rows whose two guesses the person has not settled yet ([이대로 기억] waits on them). */
export function unsettled(data: SchemaCardData | undefined, roles: SchemaRoles) {
  return (data?.folders ?? []).filter(
    (row) => row.candidates.length > 1 && !Object.hasOwn(roles, row.path),
  ).length;
}

const shortPath = (path: string, max = 48) =>
  path.length > max ? `…${path.slice(path.length - max + 1)}` : path;
/** 을/를 after a word (보고서를, 도면을). */
const object = (word: string) => {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return code >= 0 && code <= 11171 && code % 28 ? `${word}을` : `${word}를`;
};
const leaf = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export function WorkspaceSchemaRows({
  api,
  projectId,
  conversationId,
  questionId,
  editing,
  roles,
  setRoles,
  disabled,
  onData,
}: {
  api: ApiCall;
  projectId: string;
  conversationId: string;
  questionId: string;
  /** [고쳐서 기억] is chosen: every chip is open for a pick. */
  editing: boolean;
  roles: SchemaRoles;
  setRoles: (roles: SchemaRoles) => void;
  disabled: boolean;
  onData?: (data: SchemaCardData) => void;
}) {
  const [data, setData] = useState<SchemaCardData | undefined>();
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api(
      `/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/workspace-schema/${encodeURIComponent(questionId)}`,
    )
      .then((value) => {
        if (!live) return;
        const card = value as SchemaCardData;
        setData(card);
        onData?.(card);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
    // onData is a callback of the parent; the rows are read once per card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, projectId, conversationId, questionId]);
  if (failed) return <p className="wschema-blocked">폴더 역할 제안을 불러오지 못했습니다.</p>;
  if (!data)
    return (
      <div className="wschema" aria-busy="true">
        <p className="wschema-reading">
          폴더 구조를 읽는 중 <span className="wschema-mono">…</span>
        </p>
        <p className="wschema-note">
          위 두 단계 폴더와 파일 종류만 봅니다. 파일 내용은 열지 않습니다.
        </p>
      </div>
    );
  const answered = data.answer?.roles ?? null;
  const roleKeys = Object.keys(data.roles) as RoleKey[];
  const pick = (path: string, value: string) => {
    setRoles({ ...roles, [path]: value === '' ? null : (value as RoleKey) });
    setOpen(null);
  };
  return (
    <div className="wschema" aria-label="폴더 역할 제안">
      <p className="wschema-note">
        <span className="wschema-mono" title={data.root}>
          {shortPath(data.root)}
        </span>{' '}
        · 추정입니다. 확인한 것만 기억합니다.
      </p>
      <ul className="wschema-rows">
        {data.folders.map((row) => {
          const chosenHere = Object.hasOwn(roles, row.path)
            ? roles[row.path]
            : answered && Object.hasOwn(answered, row.path)
              ? answered[row.path]
              : undefined;
          const chosen = chosenHere !== undefined;
          const role = chosen ? chosenHere : row.guess;
          const conflict = !chosen && row.candidates.length > 1;
          const selecting = !disabled && (editing || open === row.path);
          return (
            <li key={row.path} className="wschema-row" data-depth={row.depth}>
              <span className="wschema-name wschema-mono" title={row.path}>
                {leaf(row.path)}
              </span>
              {selecting ? (
                <select
                  className="wschema-select"
                  aria-label={`${leaf(row.path)} 역할`}
                  value={role ?? ''}
                  onChange={(event) => pick(row.path, event.target.value)}
                >
                  {conflict ? <option value="">둘 중 고르세요</option> : null}
                  {roleKeys.map((key) => (
                    <option key={key} value={key}>
                      {data.roles[key]}
                    </option>
                  ))}
                  <option value="">역할 없음</option>
                </select>
              ) : (
                <button
                  type="button"
                  className="wschema-chip"
                  data-state={conflict ? 'conflict' : chosen ? 'chosen' : 'guess'}
                  disabled={disabled}
                  onClick={() => setOpen(row.path)}
                  aria-label={`${leaf(row.path)} 역할 고르기`}
                >
                  {conflict
                    ? `둘 중 고르세요 (${row.candidates.map((key) => data.roles[key]).join(' · ')})`
                    : role
                      ? data.roles[role]
                      : '역할 없음'}
                  {!chosen && !conflict ? <small className="wschema-guess">추정</small> : null}
                </button>
              )}
              <span className="wschema-reason">{row.reason}</span>
            </li>
          );
        })}
      </ul>
      {data.missing.map((key) => (
        <p key={key} className="wschema-note">
          {object(data.roles[key])} 둘 곳이 보이지 않습니다 — 반영할 때 물어보고 기억합니다.
        </p>
      ))}
      {data.stored?.text ? <p className="wschema-stored">{data.stored.text}</p> : null}
    </div>
  );
}
