import { z } from 'zod';

// Jig review gates (RESEARCH-05 standard gates, SPEC-06.9, SPEC-07): an AI review of a jig table may
// cite only what the table holds. Ids the answer cites that the table does not have are reported
// with the answer (gate `ref-whitelist`) instead of being passed silently.

export interface JigGateResult {
  jigCheck?: { gate: 'ref-whitelist'; kind: string; cited: number; unknown: string[] };
  /** The answer with a warning line appended when it cites unknown ids. */
  text?: string;
}

interface RefGate {
  /** Ids of this kind of table as they appear in an answer. */
  pattern: RegExp;
  /** The table's ids, or undefined when the request carries no table to check against. */
  known: (jig: Record<string, unknown>, input: Record<string, unknown>) => string[] | undefined;
  /** What an unknown id is, in the warning. */
  noun: string;
}

const ids = z.array(z.string()).max(20000);
/** Text of the files attached to the request (the jig table goes as an attachment). */
function attachedText(input: Record<string, unknown>) {
  const files = z
    .array(z.object({ text: z.string().optional() }).passthrough())
    .safeParse(input.files);
  return files.success ? files.data.map((file) => file.text ?? '').join('\n') : '';
}

const GATES: Record<string, RefGate> = {
  // Sync jig table: rows R1…Rn, listed with the request.
  'sync-review': {
    pattern: /\bR\d+\b/g,
    known: (jig) => {
      const rows = ids.safeParse(jig.rows);
      return rows.success ? rows.data : undefined;
    },
    noun: '행',
  },
  // Structure draft (SPEC-06.9): members M1… and nodes N1…, listed with the request (`refs`) or else
  // exactly those the attached draft summary holds.
  'structure-draft-review': {
    pattern: /\b[MN]\d+\b/g,
    known: (jig, input) => {
      const refs = ids.safeParse(jig.refs);
      if (refs.success) return refs.data;
      const text = attachedText(input);
      return text ? (text.match(/\b[MN]\d+\b/g) ?? []) : undefined;
    },
    noun: '부재·절점',
  },
};

/** Apply the review gate of the request's jig kind to an AI answer; {} for other requests. */
export function jigCheck(input: Record<string, unknown>, text: string): JigGateResult {
  const jig = z.object({ kind: z.string() }).passthrough().safeParse(input.jig);
  if (!jig.success) return {};
  const gate = GATES[jig.data.kind];
  if (!gate) return {};
  const table = gate.known(jig.data, input);
  if (!table) return {};
  const known = new Set(table);
  const cited = [...new Set(text.match(gate.pattern) ?? [])];
  const unknown = cited.filter((ref) => !known.has(ref));
  return {
    jigCheck: { gate: 'ref-whitelist', kind: jig.data.kind, cited: cited.length, unknown },
    ...(unknown.length
      ? {
          text:
            text +
            `\n\n⚠ 검증: 표에 없는 ${gate.noun} ${unknown.join(', ')}을(를) 인용했습니다. 해당 부분은 근거가 없는 내용이니 확인하세요.`,
        }
      : {}),
  };
}
