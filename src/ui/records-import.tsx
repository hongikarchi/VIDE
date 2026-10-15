// 기록 탭의 가져오기 (PLAN-53 T-329·T-330, Design SCR-45 「구현 기준」 가져오기): the [가져오기]
// button and its hidden file input (.txt 카카오톡, .eml·.mbox 메일), and the 1차 거르기 도우미 on
// screen — imported candidates that ask, decide or name a part come first, with small '질문'·
// '결정'·'부위: …' words after the row. Nothing is stored and nothing is marked O/X here
// (src/core/record-triage.ts).
import { useRef, useState } from 'react';
import { triageHints, triageScore, type TriageHints } from '../core/record-triage.ts';
import {
  importKindOf,
  importRecordFile,
  type ImportKind,
  type ImportResult,
  type RecordFilters,
  type RecordRow,
} from './records-api.ts';
import './records-import.css';

const IMPORTED = new Set(['kakao', 'mail']);

/** Whether the list is ordered by the hints: only 카카오톡·메일 shown, and candidates among them. */
export function triageApplies(filters: RecordFilters) {
  return Boolean(
    filters.source?.length &&
    filters.source.every((source) => IMPORTED.has(source)) &&
    filters.state?.includes('candidate'),
  );
}
/** The rows with hinted candidates first (stable: the server's order within a score). */
export function triageOrder(
  rows: readonly RecordRow[],
  filters: RecordFilters,
  partNames: readonly string[],
): RecordRow[] {
  if (!triageApplies(filters)) return rows as RecordRow[];
  const score = (row: RecordRow) =>
    row.state === 'candidate' ? triageScore(triageHints(row.text, partNames)) : -1;
  return rows
    .map((row, index) => ({ row, index, score: score(row) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.row);
}
/** The hints of an imported candidate row, or undefined. */
export function rowHints(row: RecordRow, partNames: readonly string[]): TriageHints | undefined {
  if (row.state !== 'candidate' || !IMPORTED.has(row.source)) return undefined;
  const hints = triageHints(row.text, partNames);
  return triageScore(hints) ? hints : undefined;
}
export function HintWords({ hints }: { hints: TriageHints | undefined }) {
  if (!hints) return null;
  return (
    <span className="records-hints">
      {hints.question ? <span>질문</span> : null}
      {hints.decision ? <span>결정</span> : null}
      {hints.parts.length ? <span>부위: {hints.parts.join(', ')}</span> : null}
    </span>
  );
}

/** The notice after an import ('후보 N건 · 중복 M건'; no '중복' part when nothing was a duplicate). */
export function importNotice(result: ImportResult) {
  return (
    `후보 ${result.added}건` +
    (result.skipped ? ` · 중복 ${result.skipped}건` : '') +
    (result.copied ? '' : ' · 원문은 폴더에 아직 안 씀')
  );
}

/**
 * [가져오기]: picks a file, sends its text, then tells the tab (`onDone` with the kind and the
 * answer, or the first record of a file already in).
 */
export function ImportButton({
  projectId,
  onDone,
  onDuplicate,
  onError,
}: {
  projectId: string;
  onDone: (kind: ImportKind, result: ImportResult) => void;
  onDuplicate: (existingId: string) => void;
  onError: (text: string) => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (file: File) => {
    const kind = importKindOf(file.name);
    if (!kind) {
      onError('카카오톡 대화(.txt)나 메일(.eml·.mbox)만 들일 수 있습니다.');
      return;
    }
    setBusy(true);
    try {
      const answer = await importRecordFile(projectId, kind, file.name, await file.text());
      if ('duplicate' in answer) onDuplicate(answer.duplicate);
      else onDone(kind, answer);
    } catch (error) {
      onError(error instanceof Error ? error.message : '가져오지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="link-button"
        disabled={busy}
        title="카카오톡 대화(.txt)나 메일(.eml·.mbox)을 후보로 들입니다"
        onClick={() => input.current?.click()}
      >
        {busy ? '들이는 중…' : '가져오기'}
      </button>
      <input
        ref={input}
        type="file"
        accept=".txt,.eml,.mbox"
        hidden
        aria-label="가져올 파일"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void pick(file);
        }}
      />
    </>
  );
}
