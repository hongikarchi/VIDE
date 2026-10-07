import type { ClawdeAnswer, ClawdeArticle, ClawdeVerdict } from '../contracts/clawde.ts';

/**
 * The engine's checks on a cLAWde answer (ARCH-01 「엔진 검사」, SPEC-13.5·13.12, PLAN-46 T-218).
 * The service's verdict is never raised: an answer whose citations are all missing (or have no
 * text or link, '원문 없음') is lowered to `unknown` ('판단 불가(근거 없음)'); a reason or a
 * constraint whose refs are not among the cited articles gets `unverifiedRef`, and such a constraint
 * is left out of what a jig may receive.
 */
export interface CheckedAnswer {
  answer: ClawdeAnswer;
  /** The verdict to show: the service's, or `unknown` when it had no usable citation. */
  verdict: ClawdeVerdict;
  /** True when the service's verdict was lowered for lack of citations. */
  downgraded: boolean;
  /** Cited articles without excerpt or link ('원문 없음'); not counted as citations. */
  noExcerpt: string[];
  /** Indexes of reasons whose refs are not all among the citations ('근거 미확인'). */
  unverifiedReasons: number[];
  /** Constraints with every ref cited: the only ones a jig may receive (SPEC-13.8). */
  constraints: NonNullable<ClawdeAnswer['constraints']>;
  /** Constraint keys left out for an unverified ref. */
  unverifiedConstraints: string[];
}

const usable = (article: ClawdeArticle) => !!article.excerpt && !!article.sourceUrl;

export function checkAnswer(answer: ClawdeAnswer): CheckedAnswer {
  const cited = new Set(answer.citations.map((c) => c.ref));
  const noExcerpt = answer.citations.filter((c) => !usable(c)).map((c) => c.ref);
  const downgraded = answer.verdict !== 'unknown' && !answer.citations.some((c) => usable(c));
  const verified = (refs: string[]) => refs.length > 0 && refs.every((ref) => cited.has(ref));
  const unverifiedReasons = answer.reasons.flatMap((reason, index) =>
    reason.refs.length && !verified(reason.refs) ? [index] : [],
  );
  const constraints = (answer.constraints ?? []).filter((c) => verified(c.refs));
  const unverifiedConstraints = (answer.constraints ?? [])
    .filter((c) => !verified(c.refs))
    .map((c) => c.key);
  return {
    answer,
    verdict: downgraded ? 'unknown' : answer.verdict,
    downgraded,
    noExcerpt,
    unverifiedReasons,
    constraints,
    unverifiedConstraints,
  };
}

/**
 * An SVG figure made safe to draw as an image (ARCH-01: `<img>` only; scripts and outside
 * references removed): no script or foreignObject elements, no `on*` attributes, and only `#`
 * fragment links. A string that is not one SVG document is refused (undefined).
 */
export function sanitizeSvg(text: string): string | undefined {
  let svg = text.replace(/<\?xml[^>]*\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) return undefined;
  svg = svg.trim();
  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>$/i.test(svg)) return undefined;
  svg = svg
    .replace(/<(script|foreignObject|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|foreignObject|iframe|object|embed)\b[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // Links: keep in-document fragments only.
    .replace(/\s+(xlink:)?href\s*=\s*("([^"]*)"|'([^']*)')/gi, (whole, _x, _q, a, b) =>
      String(a ?? b ?? '').startsWith('#') ? whole : '',
    )
    // CSS url() pointing outside the document.
    .replace(/url\(\s*(['"]?)(?!#)[^)]*\1\s*\)/gi, 'none');
  if (/<script|javascript:|\bon[a-z]+\s*=/i.test(svg)) return undefined;
  return svg;
}
