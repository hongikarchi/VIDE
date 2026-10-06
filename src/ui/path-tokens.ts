// Pasted paths become chips (SPEC-01.12 6, PLAN-31 T-140): "[파일 · 도면.dwg]" / "[폴더 · 2601 자료]"
// tokens in the message, each naming one path of this PC. This module holds the word rules only
// (no DOM): which spans of the text may be absolute paths, and the token text.

export type PathKind = 'file' | 'folder';
/** One path chip of a draft: its token text in the message and the path it stands for. */
export interface DraftPath {
  label: string;
  kind: PathKind;
  path: string;
  /** The attachment a file chip was copied to on sending (copied once). */
  attached?: string;
}

export const PATH_TOKEN = /\[(파일|폴더) · ([^\]\n]+)\]/g;
const KIND_WORD: Record<PathKind, string> = { file: '파일', folder: '폴더' };

/** The path tokens present in a message. */
export function pathTokenLabels(text: string) {
  return new Set([...text.matchAll(PATH_TOKEN)].map((match) => match[0]));
}

/** The last name of a path ("C:\a\b\" → "b"; "\\server\share" → "share"). */
export function pathName(path: string) {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? path;
}

/** A token for `path`, numbered when the message already holds the same token for another path. */
export function pathToken(kind: PathKind, path: string, taken: readonly DraftPath[]) {
  const name =
    pathName(path)
      .replace(/[[\]\n]/g, '')
      .trim() || path;
  for (let n = 1; ; n++) {
    const label = `[${KIND_WORD[kind]} · ${n === 1 ? name : `${name} (${n})`}]`;
    const same = taken.find((entry) => entry.label === label);
    if (!same || same.path === path) return label;
  }
}

/** Korean particles that may follow a path written in a sentence ("…\도면.dwg를"). */
const PARTICLE = /(에서|으로|처럼|에|의|을|를|은|는|이|가|로|와|과|도)$/;
const TRAILING = /[\s,.;:!?)\]}'"“”‘’」』>]+$/;
/** Where an absolute path starts: a drive (`C:\`, `C:/`) or a share (`\\server\`). */
const START = /(?:[A-Za-z]:[\\/](?!\s)|\\\\[^\\/\s"]+[\\/])/g;

export interface PathCandidate {
  path: string;
  /** Offset in the text just after the candidate (the token replaces start..end). */
  end: number;
}
export interface PathSpan {
  start: number;
  /** Where the span stops looking (end of line, the next path or a closing quote). */
  stop: number;
  /** Quoted ("…"): the one candidate covers the quotes. */
  quoted: boolean;
  /** Longest first. */
  candidates: PathCandidate[];
}

/**
 * The spans of `text` that may be absolute paths, each with its candidate readings longest first:
 * a quoted path is read whole (quotes included in the span); an unquoted one runs to the end of
 * its line or to the next path on it, and is cut at each space (a path may hold spaces), with
 * trailing punctuation and a Korean particle taken off. Text inside existing chips is skipped.
 */
export function pathSpans(text: string): PathSpan[] {
  const out: PathSpan[] = [];
  const chips = [...text.matchAll(PATH_TOKEN)].map((m) => [m.index!, m.index! + m[0].length]);
  const inChip = (at: number) => chips.some(([from, to]) => at >= from! && at < to!);
  const starts = [...text.matchAll(START)]
    .map((m) => m.index!)
    // A path starts a word: at the text start, after a space, a quote or an opening bracket.
    .filter((at) => (at === 0 || /[\s"'(“‘「『<]/.test(text[at - 1]!)) && !inChip(at));
  let after = 0;
  for (const [index, start] of starts.entries()) {
    if (start < after) continue;
    if (text[start - 1] === '"') {
      const close = text.indexOf('"', start);
      const line = text.indexOf('\n', start);
      if (close > 0 && (line < 0 || close < line)) {
        const path = text.slice(start, close).replace(/[\s]+$/, '');
        if (!isBare(path))
          out.push({
            start: start - 1,
            stop: close + 1,
            quoted: true,
            candidates: [{ path, end: close + 1 }],
          });
        after = close + 1;
        continue;
      }
    }
    const lineEnd = text.indexOf('\n', start);
    let stop = lineEnd < 0 ? text.length : lineEnd;
    const next = starts[index + 1];
    if (next !== undefined && next < stop) stop = next;
    const span = text.slice(start, stop);
    const cuts = [...span.matchAll(/\s/g)].map((space) => space.index!);
    const candidates: PathCandidate[] = [];
    for (const cut of [span.length, ...cuts.reverse()]) {
      const raw = span.slice(0, cut);
      const trimmed = raw.replace(TRAILING, '');
      for (const path of [trimmed, trimmed.replace(PARTICLE, '').replace(TRAILING, '')]) {
        if (!path || isBare(path) || candidates.some((c) => c.path === path)) continue;
        candidates.push({ path, end: start + path.length });
      }
      if (candidates.length >= 16) break;
    }
    if (candidates.length) out.push({ start, stop, quoted: false, candidates });
    after = stop;
  }
  return out;
}
/** A drive or share root alone ("C:\", "\\server\share") is never a chip. */
const isBare = (path: string) =>
  /^[A-Za-z]:[\\/]*$/.test(path) || /^\\\\[^\\/]+[\\/]?([^\\/]+[\\/]?)?$/.test(path);
