import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  clawdeProseSchema,
  clawdeWriterSchema,
  type ClawdeAnswer,
  type ClawdeProse,
  type ClawdeRecipe,
  type ClawdeVerifyResult,
  type ClawdeWriter,
} from '../contracts/clawde.ts';
import { DomainError } from '../contracts/errors.ts';
import { checkSchema } from '../jigs/runtime/schema.ts';
import { CliRunner, replyJson, type CollectProvider } from '../knowledge/collect/ai.ts';
import type { ClawdeClient } from './clawde.ts';

/**
 * Answer prose and its quality control (SPEC-13.13, ARCH-01 「답 문장」·「모델 인증」, PLAN-46
 * T-236). cLAWde decides the verdict and the evidence; the prose is written here by the user's own
 * CLI, once, with the recipe's model and effort (never the conversation's model), the recipe's
 * prompt filled with the evidence pack and nothing else: no VIDE instruction bundle, no MCP servers,
 * no file tools. The output passes only when ① it has the recipe's shape ② every ref is in the
 * evidence pack ③ every number is in the cited text or the computed values ④ the verdict is the
 * service's (a conditional or unknown answer is never upgraded) ⑤ it is within the length limit,
 * and then `POST /v1/verify` agrees. An unreachable service leaves it '로컬 검증만'. A failed prose
 * is kept for the audit but never shown; nothing is rewritten by itself (only [다시 쓰기]).
 */

export type ProseStatus = 'verified' | 'local-only' | 'failed' | 'no-model' | 'none';

/** A check failure: the service's codes, and the engine's own for what never reached a check. */
export interface ProseFailure {
  code:
    | ClawdeVerifyResult['failures'][number]['code']
    | 'WRITER_FAILED'
    | 'RECIPE_UNAVAILABLE'
    | 'VERIFY_FAILED';
  path: string;
  message: string;
}

/** What one writing left: stored in the answer's audit columns (ARCH-01 「저장」). */
export interface ProseRecord {
  status: ProseStatus;
  /** The parsed output (also when it failed); undefined when nothing came back or none was run. */
  output?: unknown;
  /** The reply text when it was not JSON. */
  raw?: string;
  recipe?: { id: string; version: string };
  writer?: ClawdeWriter;
  failures: ProseFailure[];
  /** The service's verify answer; null when it was not reached or not asked. */
  server: { pass: boolean; recipeCurrent: boolean } | null;
  at: string;
}

/** Runs one prompt with the given writer and returns the reply text. Tests inject a fake. */
export interface ProseRunner {
  run(call: { writer: ClawdeWriter; prompt: string; signal?: AbortSignal }): Promise<string>;
}

/**
 * The CLI runner of the writer: the collector's single-run process (an empty temporary folder, no
 * tools, no MCP servers, no settings sources) with no system text of VIDE's own.
 */
export function cliProseRunner(
  executable: (provider: CollectProvider) => string | undefined,
  timeoutMs = 5 * 60_000,
): ProseRunner {
  const runner = new CliRunner(executable, timeoutMs, null);
  return {
    async run({ writer, prompt, signal }) {
      const reply = await runner.run({
        role: 'propose',
        choice: {
          provider: writer.provider === 'claude' ? 'claude-cli' : 'codex-cli',
          model: writer.model,
          effort: writer.effort,
        },
        prompt,
        signal,
      });
      return reply.text;
    },
  };
}

/** Which writers this PC can run: the signed-in CLIs and the Codex model catalog. */
export interface WriterAvailability {
  signedIn: ('claude' | 'codex')[];
  /** Empty when the Codex CLI keeps no catalog (any model name is then tried). */
  codexModels: string[];
}

export const writerKey = (w: ClawdeWriter) => `${w.provider}/${w.model}/${w.effort}`;

/**
 * The recipe's prompt with its five slots filled and nothing added. The evidence lines carry the
 * ref and the effective date; computed values carry their unit and refs.
 */
export function fillPrompt(recipe: ClawdeRecipe, answer: ClawdeAnswer, question: string) {
  const slots: Record<string, string> = {
    question,
    verdict: answer.verdict,
    evidence: (answer.evidence ?? [])
      .map((e) => `[${e.ref}] (시행 ${e.effectiveDate}) ${e.text}`)
      .join('\n'),
    computed: (answer.computed ?? [])
      .map((c) => `${c.key} = ${c.value}${c.unit ? ` ${c.unit}` : ''} (${c.refs.join(', ')})`)
      .join('\n'),
    checks: answer.checks.map((c) => `- ${c.text}`).join('\n'),
  };
  return recipe.promptTemplate.replace(
    /\{\{(question|verdict|evidence|computed|checks)\}\}/g,
    (_, slot: string) => slots[slot],
  );
}

const UNIT_ALIASES: [RegExp, string][] = [
  [/^(%|퍼센트|프로)$/, '%'],
  [/^(㎡|m2|m²|제곱미터|평방미터)$/i, '㎡'],
  [/^(m|미터)$/i, 'm'],
];
const normalizeUnit = (unit: string | undefined) => {
  if (!unit) return undefined;
  const trimmed = unit.trim();
  return UNIT_ALIASES.find(([pattern]) => pattern.test(trimmed))?.[1] ?? trimmed;
};

/**
 * The numbers of a sentence with the unit right after them, if one is known. Names are not
 * values: article and paragraph numbers (제61조, 제2종, 별표1, 3항·4호) are skipped.
 */
export function proseNumbers(text: string) {
  const out: { value: number; unit?: string; text: string }[] = [];
  const pattern =
    /(?<![제\d.,]|별표\s?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?!\d|,\d|\.\d)(?!\s*[조종항호목])(\s*(?:%|퍼센트|프로|㎡|m²|m2|제곱미터|평방미터|미터|m(?![a-z])))?/giu;
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1].replace(/,/g, '') + (match[2] ? `.${match[2]}` : ''));
    out.push({ value, unit: normalizeUnit(match[3]), text: match[0].trim() });
  }
  return out;
}

const textParts = (output: ClawdeProse) => [
  { path: 'conclusion', text: output.conclusion, refs: [] as string[] },
  ...output.reasons.map((r, i) => ({ path: `reasons.${i}`, ...r })),
  ...output.interpretation.map((r, i) => ({ path: `interpretation.${i}`, ...r })),
];

/**
 * The engine's checks ①~⑤ of one output against the answer and its recipe. Returns the failures;
 * none means the output may go to `/v1/verify`.
 */
export function checkProse(
  output: unknown,
  answer: ClawdeAnswer,
  recipe: ClawdeRecipe,
): ProseFailure[] {
  const failures: ProseFailure[] = [];
  // ① the recipe's own JSON Schema and the one output shape every recipe shares.
  for (const problem of checkSchema(recipe.outputSchema, output))
    failures.push({ code: 'SCHEMA', path: problem.path, message: problem.message });
  const parsed = clawdeProseSchema.safeParse(output);
  if (!parsed.success) {
    if (!failures.length)
      failures.push({ code: 'SCHEMA', path: 'output', message: 'not the prose output shape' });
    return failures;
  }
  const prose = parsed.data;
  // ⑤ the length limit.
  const length = JSON.stringify(prose).length;
  if (length > recipe.maxOutputChars)
    failures.push({
      code: 'SCHEMA',
      path: 'output',
      message: `${length} characters, over ${recipe.maxOutputChars}`,
    });
  // ④ the verdict is locked: never changed, so a conditional or unknown answer is never upgraded.
  if (prose.verdict !== answer.verdict)
    failures.push({
      code: 'VERDICT_CHANGED',
      path: 'verdict',
      message: `${prose.verdict} instead of ${answer.verdict}`,
    });
  // ② refs only from the evidence pack (the recipe's allowed refs that the pack carries).
  const evidence = new Set((answer.evidence ?? []).map((e) => e.ref));
  const allowed = new Set((answer.recipe?.allowedRefs ?? []).filter((ref) => evidence.has(ref)));
  // ③ numbers only from the cited text or the computed values.
  const computed = new Set((answer.computed ?? []).map((c) => `computed:${c.key}`));
  const numbers = (answer.recipe?.numbers ?? []).filter(
    (n) => evidence.has(n.from) || computed.has(n.from),
  );
  for (const part of textParts(prose)) {
    for (const ref of part.refs)
      if (!allowed.has(ref))
        failures.push({ code: 'REF_OUTSIDE', path: part.path, message: `ref ${ref}` });
    for (const found of proseNumbers(part.text)) {
      const same = numbers.filter((n) => Math.abs(n.value - found.value) < 1e-9);
      const unitOk =
        !found.unit || same.some((n) => !n.unit || normalizeUnit(n.unit) === found.unit);
      if (!same.length || !unitOk)
        failures.push({
          code: 'NUMBER_UNSUPPORTED',
          path: part.path,
          message: `number ${found.text}`,
        });
    }
  }
  return failures;
}

/** The refs an output cites (for the golden set's required refs). */
const citedRefs = (output: ClawdeProse) => new Set(textParts(output).flatMap((p) => p.refs));

export interface ModelCert {
  goldenVersion: string;
  recipe: { id: string; version: string };
  passed: number;
  total: number;
  at: string;
  items?: { goldenId: string; pass: boolean; status: ProseStatus; reason?: string }[];
}

/**
 * `<data>/legal-model-cert.json {[provider/model/effort]: ModelCert}`: the last certification of
 * each writer. A writer whose last run did not pass every question writes no prose until it passes.
 */
export class ModelCerts {
  private readonly file: string | undefined;
  private data: Record<string, ModelCert> | undefined;
  constructor(directory: string | undefined) {
    this.file = directory ? join(directory, 'legal-model-cert.json') : undefined;
  }
  async all(): Promise<Record<string, ModelCert>> {
    if (this.data) return this.data;
    let data: Record<string, ModelCert> = {};
    if (this.file)
      try {
        data = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, ModelCert>;
      } catch {
        /* None yet, or unreadable: no certification recorded. */
      }
    this.data = data;
    return data;
  }
  async failed(writer: ClawdeWriter) {
    const cert = (await this.all())[writerKey(writer)];
    return !!cert && cert.passed < cert.total;
  }
  async record(writer: ClawdeWriter, cert: ModelCert) {
    const data = { ...(await this.all()), [writerKey(writer)]: cert };
    this.data = data;
    if (!this.file) return;
    const directory = join(this.file, '..');
    await mkdir(directory, { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(data, null, 2));
    await rename(temporary, this.file);
  }
}

export class LegalWriter {
  private readonly client: ClawdeClient;
  private readonly runner: ProseRunner;
  private readonly availability: () => Promise<WriterAvailability>;
  readonly certs: ModelCerts;
  private readonly now: () => Date;
  private certifying = false;
  /** Whether a certification is running (one at a time). */
  get running() {
    return this.certifying;
  }
  constructor({
    client,
    runner,
    availability,
    certs,
    now = () => new Date(),
  }: {
    client: ClawdeClient;
    runner: ProseRunner;
    availability: () => Promise<WriterAvailability>;
    certs: ModelCerts;
    now?: () => Date;
  }) {
    this.client = client;
    this.runner = runner;
    this.availability = availability;
    this.certs = certs;
    this.now = now;
  }

  /** The first of `models` this PC can run whose last certification did not fail. */
  async chooseWriter(models: readonly ClawdeWriter[]): Promise<ClawdeWriter | undefined> {
    const here = await this.availability();
    for (const writer of models) {
      if (!here.signedIn.includes(writer.provider)) continue;
      if (
        writer.provider === 'codex' &&
        here.codexModels.length &&
        !here.codexModels.includes(writer.model)
      )
        continue;
      if (await this.certs.failed(writer)) continue;
      return writer;
    }
    return undefined;
  }

  /** Whether an answer carries what a prose needs: a recipe, an evidence pack and computed values. */
  static writable(answer: ClawdeAnswer) {
    return !!answer.recipe && !!answer.evidence?.length && !!answer.computed;
  }

  /**
   * Writes the prose of one answer once and checks it. `writer` forces the model (certification);
   * otherwise the recipe's first qualifying model is used, and none means no CLI run at all.
   */
  async write(
    answer: ClawdeAnswer,
    question: string,
    { writer: forced, signal }: { writer?: ClawdeWriter; signal?: AbortSignal } = {},
  ): Promise<ProseRecord> {
    const at = () => this.now().toISOString();
    const plan = answer.recipe;
    if (!plan || !LegalWriter.writable(answer))
      return { status: 'none', failures: [], server: null, at: at() };
    const writer = forced ?? (await this.chooseWriter(plan.models));
    if (!writer) return { status: 'no-model', failures: [], server: null, at: at() };
    const failed = (failures: ProseFailure[], extra: Partial<ProseRecord> = {}): ProseRecord => ({
      status: 'failed',
      writer,
      failures,
      server: null,
      at: at(),
      ...extra,
    });

    let recipe: ClawdeRecipe;
    try {
      recipe = await this.client.recipe(plan.id, plan.version);
    } catch (error) {
      return failed([recipeUnavailable(error)], { recipe: { id: plan.id, version: plan.version } });
    }
    let refreshed = false;
    for (;;) {
      const used = { id: recipe.id, version: recipe.version };
      let text: string;
      try {
        text = await this.runner.run({
          writer,
          prompt: fillPrompt(recipe, answer, question),
          signal,
        });
      } catch (error) {
        return failed(
          [{ code: 'WRITER_FAILED', path: 'writer', message: messageOf(error).slice(0, 300) }],
          { recipe: used },
        );
      }
      let output: unknown;
      try {
        output = replyJson<unknown>(text);
      } catch {
        return failed([{ code: 'SCHEMA', path: 'output', message: 'the reply is not JSON' }], {
          recipe: used,
          raw: text.slice(0, 4000),
        });
      }
      const local = checkProse(output, answer, recipe);
      if (local.length) return failed(local, { recipe: used, output });

      let result: ClawdeVerifyResult;
      try {
        result = await this.client.verify({
          answerId: answer.answerId,
          recipe: used,
          writer,
          output,
        });
      } catch (error) {
        // An unreachable service, or one without /v1/verify yet (PLAN-48 T-240), leaves the local
        // pass shown as '로컬 검증만'.
        if (error instanceof DomainError && LOCAL_ONLY_ON.has(error.code))
          return {
            status: 'local-only',
            output,
            recipe: used,
            writer,
            failures: [],
            server: null,
            at: at(),
          };
        return failed([{ code: 'VERIFY_FAILED', path: 'verify', message: messageOf(error) }], {
          recipe: used,
          output,
        });
      }
      const server = { pass: result.pass, recipeCurrent: result.recipeCurrent };
      if (result.pass && result.recipeCurrent)
        return { status: 'verified', output, recipe: used, writer, failures: [], server, at: at() };
      // A stale recipe: the current version is fetched and the prose written again with it, once.
      // That is the recipe's rule, not a retry of a failed prose; anything else stays failed.
      const stale = !result.recipeCurrent || result.failures.some((f) => f.code === 'RECIPE_STALE');
      const others = result.failures.filter((f) => f.code !== 'RECIPE_STALE');
      if (!stale || refreshed || others.length)
        return failed(result.failures.length ? result.failures : [staleFailure()], {
          recipe: used,
          output,
          server,
        });
      refreshed = true;
      try {
        const current = (await this.client.meta()).recipes.find((r) => r.id === recipe.id);
        if (!current || current.version === recipe.version) throw new DomainError('NOT_FOUND');
        recipe = await this.client.recipe(current.id, current.version);
      } catch (error) {
        return failed([staleFailure(), recipeUnavailable(error)], { recipe: used, output, server });
      }
      if (!recipe.models.some((m) => writerKey(m) === writerKey(writer)))
        return failed(
          [{ code: 'MODEL_NOT_QUALIFIED', path: 'writer', message: 'not in the current recipe' }],
          { recipe: { id: recipe.id, version: recipe.version }, output, server },
        );
    }
  }

  /**
   * Model certification (ARCH-01 「모델 인증」): the golden questions asked, written with `writer`
   * and checked; a question passes when its prose passes the checks, keeps the expected verdict and
   * cites every required ref. Runs only when the user asks; one at a time.
   */
  async certify(input: unknown, recipeId?: string): Promise<ModelCert & { writer: ClawdeWriter }> {
    const writer = clawdeWriterSchema.parse(input);
    if (this.certifying) throw new DomainError('LEGAL_CERT_RUNNING');
    this.certifying = true;
    try {
      const id = recipeId ?? (await this.client.meta()).recipes[0]?.id;
      if (!id) throw new DomainError('NOT_FOUND');
      const golden = await this.client.golden(id);
      const items: NonNullable<ModelCert['items']> = [];
      for (const item of golden.items) {
        const answer = await this.client.ask({
          question: item.question,
          stage: item.stage,
          profile: item.profile,
          locale: 'ko',
        });
        const record = await this.write(answer, item.question, { writer });
        const prose = clawdeProseSchema.safeParse(record.output);
        let reason: string | undefined;
        if (record.status !== 'verified' && record.status !== 'local-only')
          reason = record.failures.map((f) => f.code).join(', ') || record.status;
        else if (!prose.success || prose.data.verdict !== item.expectVerdict)
          reason = 'EXPECTED_VERDICT';
        else if (item.requiredRefs.some((ref) => !citedRefs(prose.data).has(ref)))
          reason = 'REQUIRED_REF';
        items.push({
          goldenId: item.goldenId,
          pass: !reason,
          status: record.status,
          ...(reason ? { reason } : {}),
        });
      }
      const cert: ModelCert = {
        goldenVersion: golden.version,
        recipe: golden.recipe,
        passed: items.filter((i) => i.pass).length,
        total: items.length,
        at: this.now().toISOString(),
        items,
      };
      await this.certs.record(writer, cert);
      return { writer, ...cert };
    } finally {
      this.certifying = false;
    }
  }
}

const messageOf = (error: unknown) =>
  error instanceof DomainError
    ? error.code
    : error instanceof Error
      ? error.message
      : String(error);
const staleFailure = (): ProseFailure => ({
  code: 'RECIPE_STALE',
  path: 'recipe',
  message: 'not the current recipe version',
});
const recipeUnavailable = (error: unknown): ProseFailure => ({
  code: 'RECIPE_UNAVAILABLE',
  path: 'recipe',
  message: messageOf(error),
});

/** Service failures of `/v1/verify` that leave a local pass as '로컬 검증만'. */
const LOCAL_ONLY_ON = new Set([
  'SERVICE_UNAVAILABLE',
  'SERVICE_NOT_IMPLEMENTED',
  'SERVICE_NOT_READY',
]);
