// Rules that keep numbers and data out of the AI stages of the collector (SPEC-08.9 2·3, PLAN-42
// T-261). A real run sent ~26,000 excerpts to the filter model, 94% of them slices of multi-MB
// coordinate and number dumps that the model then judged 'none'. Here, without any AI call:
// an excerpt that is mostly digits and symbols is 'none' (`isDataFragment`), a .txt/.csv file whose
// content is a number dump keeps only its first lines (`dataFile`), and a file gives at most a
// fixed number of excerpts (`capExcerpts`). Tables with labels on their rows (`1층`, `B1`, `RF`,
// `D10`, dates) and excerpts with a sentence in them stay text and go to the AI.
import type { Excerpt } from './documents.ts';

/** An excerpt whose letters are fewer than this share of its visible characters may be data. */
export const DATA_MIN_LETTER_RATIO = 0.12;
/**
 * ...unless at least this share of its lines carry a label: a token with a letter that is not a
 * number ('1층', 'B1', 'RF', 'D10', '101호', '근린생활시설') or a date or time ('10/15',
 * '2026-03-02', '14:00'). A table whose rows are labelled is a document, not a dump.
 */
export const DATA_MIN_LABELLED_LINES = 0.5;
/** A dump that repeats a label or two ('POINT 1 2 3') is data when this share of tokens are numbers. */
export const DATA_REPEAT_MIN_NUMERIC = 0.7;
/** ...with at most this many different labels... */
export const DATA_REPEAT_MAX_WORDS = 2;
/** ...over at least this many tokens. */
export const DATA_REPEAT_MIN_TOKENS = 12;
/**
 * A line with a sentence in it keeps the whole excerpt for the AI (a decision written above a
 * coordinate list): at least this many letters, at least this share of its visible characters,
 * and not a table row (no '|' or tab, fewer than two commas without a space after them).
 */
export const DATA_PROSE_MIN_LETTERS = 10;
export const DATA_PROSE_MIN_LETTER_RATIO = 0.5;

/** A .txt/.csv file shorter than this (characters) is never a data file: it is read whole. */
export const DATA_FILE_MIN_CHARS = 4 * 1024;
/** The part of a .txt/.csv file judged for a data file (characters from the start). */
export const DATA_FILE_SAMPLE_CHARS = 64 * 1024;
/** A line longer than this (characters) in a .txt/.csv file... */
export const DATA_FILE_LONG_LINE = 32 * 1024;
/** ...makes it a data file when its sample's letters are under this share (prose is ~0.8). */
export const DATA_FILE_LONG_LINE_MAX_LETTERS = 0.5;
/**
 * A data file keeps this many first lines, each cut to this many characters, as one excerpt, and
 * the parts of it with a sentence (`isDataFragment` false), which go to the AI.
 */
export const DATA_FILE_HEAD_LINES = 5;
export const DATA_FILE_HEAD_LINE_CHARS = 200;
/** The extensions judged for data files. */
export const DATA_FILE_EXTENSIONS = new Set(['txt', 'csv']);
/**
 * The version of the .txt/.csv reader. A file read by an older one (before data files, or with the
 * first T-261 rules) is read again at the next run even when it did not change.
 */
export const TEXT_READER_VERSION = 2;

/**
 * At most this many excerpts per plain-text file (txt·md·csv·eml); the rest are counted. Which end
 * stays follows the file's dates (`capExcerpts`).
 */
export const TEXT_EXCERPT_CAP = 200;
/** At most this many per other document (PDF·Office·HWP; ~500 pages of text). */
export const DOCUMENT_EXCERPT_CAP = 1000;
const TEXT_KINDS = new Set(['txt', 'md', 'csv', 'eml']);
export const excerptCap = (ext: string) =>
  TEXT_KINDS.has(ext) ? TEXT_EXCERPT_CAP : DOCUMENT_EXCERPT_CAP;

const LETTER = /\p{L}/gu;
const NUMBER = /^[-+(]?[\d][\d.,:/%eE+\-)]*$/;
/** Dates and times: '10/15', '2026-03-02', '26.10.05', '(10/15)', '14:00'. */
const DATE =
  /^\(?(?:\d{4}[-./]\d{1,2}[-./]\d{1,2}\.?|\d{2}[-./]\d{1,2}[-./]\d{1,2}\.?|\d{1,2}\/\d{1,2}|\d{1,2}:\d{2}(?::\d{2})?)\)?$/;
/** A row label: a token with a letter that is not a number, or a date or time. */
export const isLabel = (token: string) =>
  DATE.test(token) || (/\p{L}/u.test(token) && !NUMBER.test(token));
const tokensOf = (text: string) => text.split(/[\s|,;\t]+/).filter(Boolean);
/** A line with a sentence in it, not a table row (`DATA_PROSE_*`). */
export function proseLine(line: string) {
  if (/[|\t]/.test(line) || (line.match(/,(?=\S)/g)?.length ?? 0) >= 2) return false;
  const letters = line.match(LETTER)?.length ?? 0;
  const chars = line.replace(/\s/g, '').length;
  return letters >= DATA_PROSE_MIN_LETTERS && letters / chars >= DATA_PROSE_MIN_LETTER_RATIO;
}

export interface TextShape {
  /** Visible characters (no whitespace). */
  chars: number;
  letters: number;
  lines: number;
  labelledLines: number;
  /** Lines with a sentence in them (`proseLine`). */
  proseLines: number;
  tokens: number;
  numericTokens: number;
  /** Different labels (`isLabel`), case-folded. */
  words: number;
}
export function textShape(text: string): TextShape {
  const lines = text.split('\n').filter((line) => line.trim());
  const tokens = tokensOf(text);
  const labels = tokens.filter(isLabel);
  return {
    chars: text.replace(/\s/g, '').length,
    letters: text.match(LETTER)?.length ?? 0,
    lines: lines.length,
    labelledLines: lines.filter((line) => tokensOf(line).some(isLabel)).length,
    proseLines: lines.filter(proseLine).length,
    tokens: tokens.length,
    numericTokens: tokens.filter((token) => !DATE.test(token) && NUMBER.test(token)).length,
    words: new Set(labels.map((w) => w.toLowerCase())).size,
  };
}

/**
 * Mostly digits, symbols and whitespace, or a number dump with a repeated label — and no sentence
 * anywhere in it.
 */
export function isDataFragment(text: string) {
  const s = textShape(text);
  if (!s.chars || s.proseLines) return false;
  if (
    s.letters / s.chars < DATA_MIN_LETTER_RATIO &&
    s.labelledLines / Math.max(1, s.lines) < DATA_MIN_LABELLED_LINES
  )
    return true;
  return (
    s.tokens >= DATA_REPEAT_MIN_TOKENS &&
    s.words <= DATA_REPEAT_MAX_WORDS &&
    s.numericTokens / s.tokens >= DATA_REPEAT_MIN_NUMERIC
  );
}

/** Why a .txt/.csv file is a data file ('long-line' or 'numeric'), or null for a document. */
export function dataFile(text: string): 'long-line' | 'numeric' | null {
  if (text.length < DATA_FILE_MIN_CHARS) return null;
  const sample = text.slice(0, DATA_FILE_SAMPLE_CHARS);
  let start = 0,
    longest = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    longest = Math.max(longest, end - start);
    if (longest > DATA_FILE_LONG_LINE) break;
    start = end + 1;
  }
  if (longest > DATA_FILE_LONG_LINE) {
    const s = textShape(sample);
    if (s.chars && s.letters / s.chars < DATA_FILE_LONG_LINE_MAX_LETTERS) return 'long-line';
  }
  return isDataFragment(sample) ? 'numeric' : null;
}

/** A data file's first lines (its header and a few rows) as its one excerpt. */
export function dataHead(text: string): Excerpt {
  const lines = text
    .slice(0, DATA_FILE_SAMPLE_CHARS)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, DATA_FILE_HEAD_LINES)
    .map((line) =>
      line.length > DATA_FILE_HEAD_LINE_CHARS
        ? line.slice(0, DATA_FILE_HEAD_LINE_CHARS) + '…'
        : line,
    );
  return { locator: 'head', text: lines.join('\n'), kind: 'data' };
}

/** The first date in a text as yyyymmdd ('2026-10-05', '2026.10.5', '26.10.05', '2026년 10월 5일'). */
const DATED_TEXT = /(?<!\d)(\d{4}|\d{2})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})(?!\d)/;
export function dateOf(text: string) {
  const m = DATED_TEXT.exec(text);
  if (!m) return null;
  const year = m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1]);
  const month = Number(m[2]),
    day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return year * 10000 + month * 100 + day;
}
/**
 * The order of a file's dated excerpts: 'ascending' (a log written downward, newest last),
 * 'descending' (newest first), or null (too few dates, or no clear order).
 */
export function dateOrder(excerpts: readonly Excerpt[]): 'ascending' | 'descending' | null {
  const dates = excerpts.map((e) => dateOf(e.text)).filter((d): d is number => d !== null);
  let up = 0,
    down = 0;
  for (let i = 1; i < dates.length; i++)
    if (dates[i] > dates[i - 1]) up++;
    else if (dates[i] < dates[i - 1]) down++;
  if (up + down < 3) return null;
  return up >= 2 * down ? 'ascending' : down >= 2 * up ? 'descending' : null;
}
/**
 * At most `excerptCap(ext)` excerpts and how many were left out. The newest part stays: the last
 * ones when the file's dates go down the page (minutes added at the end), the first ones when they
 * go up; without a clear order, the first and the last halves (the middle is left out).
 */
export function capExcerpts(excerpts: Excerpt[], ext: string) {
  const cap = excerptCap(ext);
  if (excerpts.length <= cap) return { excerpts, overflow: 0 };
  const order = dateOrder(excerpts);
  const first = order === 'ascending' ? 0 : order === 'descending' ? cap : Math.ceil(cap / 2);
  const kept = [...excerpts.slice(0, first), ...excerpts.slice(excerpts.length - (cap - first))];
  return { excerpts: kept, overflow: excerpts.length - cap };
}

/** Rule reasons recorded on `selection.reason` for texts judged without AI. */
export const RULE_SHORT = '짧은 글(규칙)';
export const RULE_DATA = '숫자·데이터 조각(규칙)';
/** The rule verdict of one excerpt text, or null when it goes to the AI. */
export function ruleOf(text: string) {
  if (text.replace(/\s/g, '').length < 8) return RULE_SHORT;
  return isDataFragment(text) ? RULE_DATA : null;
}
