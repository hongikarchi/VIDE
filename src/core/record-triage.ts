/**
 * 1차 거르기 도우미 (PLAN-53 T-329·T-330, ARCH-01 §5 「프로젝트 기록」 '가져오기'): what makes an
 * imported line worth a first look — it asks something, it states a decision, or it names a part
 * of the 부위 사전. Never stored: the 기록 tab computes it when it reads the list, and only orders
 * by it (no automatic O/X). Pure, no node imports (the page imports it); the decision words are
 * shared with the automatic candidates (`record-candidates.ts`).
 */

/** Words that say a matter was settled (the user's own sentence). */
export const DECIDED =
  /결정|확정|(?:으?로|걸로|것으로)\s*(?:가자|갑시다|가요|간다|하자|합시다|하기로|해요|한다|정(?:하|했|함|합|해|한|할))/;
/** A question mark (full or half width). */
export const QUESTION_MARK = /[?？]/;
/** A question without a mark ("…갈까", "…할까요"). */
export const QUESTION_ENDING = /(?:갈|할|될|정할|둘)까/;
/** Words that say it was not (yet): open, pending, conditional or asked. */
export const UNDECIDED = [
  QUESTION_MARK,
  QUESTION_ENDING,
  /결정\s*(?:을|이|은)?\s*(?:못|안\s|안$|하지|되지|해야|할지|하면|하기\s*전|전에|전|보류|미뤄|미루)/,
  /확정\s*(?:을|이|은)?\s*(?:못|안\s|안$|아직|하지|되지|해야|할지|하면|전에|전|보류|미뤄|미루|안\s*됐|안됐)/,
  /아직[^.!]*(?:결정|확정)|(?:결정|확정)[^.!]*아직/,
  /미정|보류|미결/,
  /(?:결정|확정)(?:은|이)?\s*(?:나중|다음)/,
];

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const sentencesOf = (text: string) =>
  text
    .split(/\n+|(?<=[.!?。？！])\s+/)
    .map((sentence) => oneLine(sentence))
    .filter(Boolean);

/** Whether one sentence states a decision: decision words and nothing open or asked. */
export function decides(sentence: string) {
  const line = oneLine(sentence);
  if (!DECIDED.test(line)) return false;
  return !UNDECIDED.some((rule) => rule.test(line));
}
/** Whether one sentence asks: ends with '?', or '…까요', '…할지', '…갈까'. */
export function asks(sentence: string) {
  const line = oneLine(sentence);
  return (
    /[?？]\s*["')\]]*$/.test(line) ||
    /까요/.test(line) ||
    /할지|될지|갈지|둘지/.test(line) ||
    QUESTION_ENDING.test(line)
  );
}

export interface TriageHints {
  question: boolean;
  decision: boolean;
  /** The part names found in the text (부위 사전), in the order given. */
  parts: string[];
}

/** The hints of one record's text. Part names shorter than two characters are not matched. */
export function triageHints(text: string, partNames: readonly string[] = []): TriageHints {
  const sentences = sentencesOf(text ?? '');
  const folded = oneLine(text ?? '');
  const parts: string[] = [];
  for (const name of partNames) {
    const word = name.trim();
    if (word.length >= 2 && folded.includes(word) && !parts.includes(word)) parts.push(word);
  }
  return {
    question: sentences.some(asks),
    decision: sentences.some(decides),
    parts,
  };
}

/** 0..3: one each for a question, a decision and a part word. */
export function triageScore(hints: TriageHints): number {
  return (hints.question ? 1 : 0) + (hints.decision ? 1 : 0) + (hints.parts.length ? 1 : 0);
}
