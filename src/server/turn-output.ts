// Structured turn output (SPEC-02.19 6, PLAN-24 T-062): a conversation turn without the host ends
// as done, progress or a question, with at most three question cards. The CLI enforces the shape
// (Claude `--json-schema`, Codex `--output-schema`, both from the `turn-output` packet item); this
// module checks it again, strictly, because the provider output is untrusted data. A question that
// the ledger already holds (asked or answered) is not asked again.

import { z } from 'zod';
import {
  REFERENCE_OUTPUT_JSON_SCHEMA,
  referenceOutputSchema,
  type ReferenceOutput,
} from '../contracts/reference-board.ts';

export const TURN_OUTPUT_ITEM = 'turn-output';
export const MAX_QUESTIONS = 3;
const MAX_OPTIONS = 5;

/**
 * The JSON Schema the CLIs get. Strict-mode compatible for both services: every property is
 * required and optional values are nullable, no additional properties anywhere.
 */
const nullableString = (maxLength: number) => ({
  type: ['string', 'null'],
  maxLength,
});
export const TURN_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'text', 'questions'],
  properties: {
    status: { type: 'string', enum: ['question', 'progress', 'done'] },
    text: { type: 'string', maxLength: 4000 },
    questions: {
      type: 'array',
      maxItems: MAX_QUESTIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'options', 'blocks', 'allowFree'],
        properties: {
          id: { type: 'string', maxLength: 40 },
          title: { type: 'string', maxLength: 200 },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: MAX_OPTIONS,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'label', 'hint', 'recommended'],
              properties: {
                id: { type: 'string', maxLength: 40 },
                label: { type: 'string', maxLength: 80 },
                hint: nullableString(200),
                recommended: { type: 'boolean' },
              },
            },
          },
          blocks: nullableString(200),
          allowFree: { type: 'boolean' },
        },
      },
    },
  },
} as const;

const RULES =
  'Answer with the JSON object of the output schema. status: "done" when the request is answered, ' +
  '"progress" when you report partial work, "question" only when the result would differ a lot ' +
  'and nothing in the supplied data decides it. At most 3 questions; never ask again what the ' +
  'ledger item holds as a question, answer or decision. Each question: an id naming what it ' +
  'decides in ASCII words (e.g. "span-limit"; never a counter like q1, because an id already in ' +
  'the ledger counts as asked), the question ' +
  'in plain practical Korean, 2-5 options with exactly one recommended, "blocks" naming what ' +
  'waits on it, allowFree when a free answer makes sense. text: the answer or the report, in Korean.';

/**
 * The schema of a reference-image turn (SPEC-09.4, T-090): the turn output plus the board's
 * interpretation, required (the board asked) or nullable (a chat turn that may correct it).
 */
export function referenceTurnSchema(reference: 'required' | 'optional') {
  return {
    ...TURN_OUTPUT_JSON_SCHEMA,
    required: [...TURN_OUTPUT_JSON_SCHEMA.required, 'reference'],
    properties: {
      ...TURN_OUTPUT_JSON_SCHEMA.properties,
      reference:
        reference === 'required'
          ? REFERENCE_OUTPUT_JSON_SCHEMA
          : { anyOf: [REFERENCE_OUTPUT_JSON_SCHEMA, { type: 'null' }] },
    },
  };
}

/** The packet item that asks a turn for structured output; the CLIs turn it into their flag. */
export function turnOutputItem(reference?: 'required' | 'optional') {
  return {
    id: TURN_OUTPUT_ITEM,
    type: TURN_OUTPUT_ITEM,
    data: {
      rules: RULES,
      schema: reference ? referenceTurnSchema(reference) : TURN_OUTPUT_JSON_SCHEMA,
    },
  };
}

const key = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/);
const words = (max: number) => z.string().trim().min(1).max(max);
const optional = <T extends z.ZodType>(schema: T) =>
  schema
    .nullable()
    .optional()
    .transform((value) => value ?? undefined);
const optionSchema = z
  .object({
    id: key,
    label: words(80),
    hint: optional(words(200)),
    recommended: optional(z.boolean()),
  })
  .strict();
const questionSchema = z
  .object({
    id: key,
    title: words(200),
    options: z.array(optionSchema).min(2).max(MAX_OPTIONS),
    blocks: optional(words(200)),
    allowFree: optional(z.boolean()),
  })
  .strict()
  .refine((question) => new Set(question.options.map((o) => o.id)).size === question.options.length)
  .refine((question) => question.options.filter((o) => o.recommended).length <= 1);
export const turnOutputSchema = z
  .object({
    status: z.enum(['question', 'progress', 'done']),
    text: z.string().max(4000),
    questions: z.array(questionSchema).max(MAX_QUESTIONS).default([]),
    // A Codex make turn's files (T-063): make-routes.ts checks and writes them; never kept here.
    files: z.array(z.unknown()).max(50).nullable().optional(),
    // A reference-image turn's interpretation (T-090): checked by `turnOutputResult`.
    reference: z.unknown().optional(),
  })
  .strict()
  .refine((output) => new Set(output.questions.map((q) => q.id)).size === output.questions.length);

export type TurnOption = z.infer<typeof optionSchema>;
export type TurnQuestion = z.infer<typeof questionSchema>;
export type TurnOutput = z.infer<typeof turnOutputSchema>;

/** The recommended option first (SCR question card); without a mark, the first one is it. */
function ordered(question: TurnQuestion): TurnQuestion {
  const index = Math.max(
    0,
    question.options.findIndex((option) => option.recommended),
  );
  const options = question.options.map((option, i) => ({ ...option, recommended: i === index }));
  return { ...question, options: [options[index], ...options.filter((_, i) => i !== index)] };
}

/**
 * Parses one turn's output: Claude's `structured_output` (as `structured`) or the final text as
 * JSON (Codex). Invalid output is not guessed at: the text stays as it came and the code says why.
 */
export function parseTurnOutput(
  result: { text?: unknown; structured?: unknown },
  known: ReadonlySet<string> = new Set(),
): { output: TurnOutput } | { code: 'TURN_OUTPUT_INVALID' } {
  let value = result.structured;
  if (value === undefined && typeof result.text === 'string') {
    try {
      value = JSON.parse(result.text);
    } catch {
      return { code: 'TURN_OUTPUT_INVALID' };
    }
  }
  const parsed = turnOutputSchema.safeParse(value);
  if (!parsed.success) return { code: 'TURN_OUTPUT_INVALID' };
  const questions = parsed.data.questions.filter((q) => !known.has(q.id)).map(ordered);
  // Every question was asked before: the turn reports, it does not wait on a card.
  const status =
    parsed.data.status === 'question' && !questions.length ? 'progress' : parsed.data.status;
  return { output: { ...parsed.data, status, questions } };
}

/**
 * The result fields of a structured turn (the one call in execution.ts): the answer text replaces
 * the JSON, `turnOutput` carries status and questions. A turn that did not ask for it is unchanged.
 */
export function turnOutputResult(
  turn:
    | {
        structured?: boolean;
        askedQuestions?: ReadonlySet<string>;
        reference?: 'required' | 'optional';
        referenceBoard?: string;
      }
    | undefined,
  result: { text?: unknown; structured?: unknown },
): Record<string, unknown> {
  if (!turn?.structured) return {};
  const parsed = parseTurnOutput(result, turn.askedQuestions);
  // The provider's raw object is not kept: only the checked fields below are stored.
  if ('code' in parsed)
    return {
      structured: undefined,
      turnOutputError: parsed.code,
      ...(turn.reference === 'required' ? { referenceError: 'REFERENCE_OUTPUT_INVALID' } : {}),
    };
  const { output } = parsed;
  return {
    structured: undefined,
    text: output.text,
    turnOutput: { status: output.status, questions: output.questions },
    ...(turn.reference ? referenceResult(turn.reference, output.reference) : {}),
    // A chat turn's correction names the board it was shown (T-090).
    ...(turn.referenceBoard && output.reference ? { referenceBoard: turn.referenceBoard } : {}),
  };
}
/** The checked interpretation of a reference turn, or why there is none (SPEC-09.4). */
function referenceResult(kind: 'required' | 'optional', value: unknown) {
  if (value === null || value === undefined)
    return kind === 'required' ? { referenceError: 'REFERENCE_OUTPUT_MISSING' } : {};
  const parsed = referenceOutputSchema.safeParse(value);
  return parsed.success
    ? { reference: parsed.data }
    : { referenceError: 'REFERENCE_OUTPUT_INVALID' };
}

/**
 * A board correction written as a fenced block at the end of a reply (a host or jig turn, which
 * has no structured output: CHAT_BLOCK_RULES). Returns the text without the block and the checked
 * interpretation (or why it is not one); undefined when the reply has no such block.
 */
export function takeReferenceBlock(
  text: unknown,
): { text: string; reference?: ReferenceOutput; referenceError?: string } | undefined {
  if (typeof text !== 'string') return;
  let found: { start: number; end: number; value: unknown } | undefined;
  for (const match of text.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)) {
    try {
      const block = JSON.parse(match[1]) as unknown;
      if (block && typeof block === 'object' && 'reference' in block)
        found = {
          start: match.index,
          end: match.index + match[0].length,
          value: (block as { reference: unknown }).reference,
        };
    } catch {
      /* Not this block. */
    }
  }
  if (!found) return;
  const rest = (text.slice(0, found.start) + text.slice(found.end)).trim();
  if (found.value === null || found.value === undefined) return { text: rest };
  const parsed = referenceOutputSchema.safeParse(found.value);
  return parsed.success
    ? { text: rest, reference: parsed.data }
    : { text: rest, referenceError: 'REFERENCE_OUTPUT_INVALID' };
}

/** One answer to a question card: an option, a free answer (when allowed), or both. */
export interface TurnAnswer {
  question: TurnQuestion;
  option?: TurnOption;
  text?: string;
  recommended: boolean;
}
/** The next turn's request text from the answers. */
export function formatAnswers(answers: TurnAnswer[]) {
  return [
    '질문 카드 답변:',
    ...answers.map(({ question, option, text }) => {
      const choice = [option ? option.label : undefined, text ? `"${text}"` : undefined]
        .filter(Boolean)
        .join(' · ');
      return `- ${question.title} → ${choice} [${question.id}${option ? '=' + option.id : ''}]`;
    }),
    '이 답을 결정으로 받아 이어서 진행하세요.',
  ].join('\n');
}
