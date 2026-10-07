import { DomainError } from '../contracts/errors.ts';
import {
  legalAskInputSchema,
  legalChecklistQuerySchema,
  legalConfirmInputSchema,
  legalProfileUpdateSchema,
} from '../contracts/legal.ts';
import type { ClawdeChecklist, ClawdeStageId } from '../contracts/clawde.ts';
import type { ClawdeClient } from './clawde.ts';
import { LegalAnswers, type LegalAnswerView, type LegalSent } from './legal-answers.ts';
import { LegalContributions } from './legal-contribute.ts';
import { LegalProfile, type LegalChecklistCache, type LegalSendItem } from './legal-profile.ts';
import { writerKey, type LegalWriter } from './legal-writer.ts';
import type { ServiceSettings } from './settings.ts';
import type { Store } from '../core/store.ts';

/**
 * Asking cLAWde for a project (SPEC-13.9·13.12, PLAN-46 T-218). A cached answer for the same
 * question, stage and sent information is shown without a call. Otherwise the service is asked
 * once: a project switched off or a service not connected asks nothing; an unreachable service
 * (timeout, 5xx) refuses the new question and leaves the cached ones shown as offline; a response
 * outside the contract is not stored. Nothing is queued to send later.
 */
export const legalStatuses: Record<string, number> = {
  LEGAL_PROJECT_OFF: 409,
  LEGAL_NO_RECIPE: 409,
  LEGAL_CERT_RUNNING: 409,
  LEGAL_WRITER_UNAVAILABLE: 503,
  LEGAL_NOT_CONTRIBUTABLE: 400,
};

export interface LegalAskResult {
  answer: LegalAnswerView;
  cached: boolean;
}

/** The '보낼 정보' card (SPEC-13.3): nothing was sent. */
export interface LegalNeedsConfirm {
  needsConfirm: { items: LegalSendItem[]; hash: string; stage: string };
}

/** `POST …/legal/ask`: the answer with its number, or the '보낼 정보' card to confirm first. */
export type LegalProjectAskResult = (LegalAskResult & { number: number }) | LegalNeedsConfirm;

/** `GET …/legal/checklist` (SPEC-13.6): every stage's items; the screen folds the other stages. */
export interface LegalChecklistView {
  stage: ClawdeStageId;
  items: ClawdeChecklist['items'];
  lawDbDate: string;
  fetchedAt: string;
  /** Shown from the project's record without a call. */
  cached: boolean;
  /** The last service call found it unreachable: '오프라인 · n일 전 조회'. */
  offline: boolean;
  /** Received with other sent information than the profile now gives (or a newer law DB). */
  stale: boolean;
}

export class LegalService {
  readonly answers: LegalAnswers;
  readonly profile: LegalProfile;
  /** 되돌려 보내기 (SPEC-13.10, T-224): the user's ticked items to cLAWde. */
  readonly contributions: LegalContributions;
  private readonly client: ClawdeClient;
  private readonly settings: ServiceSettings;
  /** The answer prose writer (T-236); without one only the deterministic fields are shown. */
  readonly writer: LegalWriter | undefined;
  private readonly now: (() => Date) | undefined;
  constructor({
    store,
    client,
    settings,
    writer,
    now,
  }: {
    store: Store;
    client: ClawdeClient;
    settings: ServiceSettings;
    writer?: LegalWriter;
    now?: () => Date;
  }) {
    this.answers = new LegalAnswers(store, { now });
    this.profile = new LegalProfile(store, { now });
    this.client = client;
    this.settings = settings;
    this.writer = writer;
    this.now = now;
    this.contributions = new LegalContributions({
      store,
      client,
      settings,
      profile: this.profile,
      labels: () => this.labels(),
      now,
    });
  }
  /** Refused before anything is sent: the project is off, or the service is not connected. */
  async assertCanSend(projectId: string) {
    if (await this.settings.projectOff(projectId)) throw new DomainError('LEGAL_PROJECT_OFF');
    if (!(await this.settings.ready())) throw new DomainError('SERVICE_NOT_CONNECTED');
  }
  /** Asks with exactly `sent` (the caller decided and confirmed what goes out). */
  async ask(
    projectId: string,
    question: string,
    sent: LegalSent,
    { refresh = false }: { refresh?: boolean } = {},
  ): Promise<LegalAskResult> {
    const latest = await this.settings.lawDbDate();
    if (!refresh) {
      const hit = this.answers.cached(projectId, question, sent, latest);
      if (hit) return { answer: hit, cached: true };
    }
    await this.assertCanSend(projectId);
    const answer = await this.client.ask({
      question,
      stage: sent.stage,
      profile: sent.profile,
      ...(sent.model ? { model: sent.model } : {}),
      locale: 'ko',
    });
    const withFigures = await this.client.inlineFigures(answer);
    const stored = this.answers.add(projectId, question, sent, withFigures, latest);
    return { answer: await this.writeProse(projectId, stored, latest), cached: false };
  }
  /**
   * Writes a new answer's prose once (SPEC-13.13). An answer the engine downgraded, or one without
   * a recipe, gets none; a failure is stored and shown as '문장 생성 검증 실패', never retried.
   */
  private async writeProse(projectId: string, stored: LegalAnswerView, latest: string | null) {
    if (!this.writer || stored.downgraded) return stored;
    let record;
    try {
      record = await this.writer.write(stored.answer, stored.question);
    } catch {
      // Finding the writer failed (the CLI status check): the answer stays with its own fields.
      return stored;
    }
    return this.answers.setProse(projectId, stored.number, record, latest);
  }
  /** [다시 쓰기]: the stored answer's prose written again, once, on the user's request. */
  async rewrite(projectId: string, number: number): Promise<LegalAnswerView> {
    const latest = await this.settings.lawDbDate();
    const stored = this.answers.get(projectId, number, latest);
    if (!this.writer) throw new DomainError('LEGAL_WRITER_UNAVAILABLE');
    if (stored.downgraded || !stored.answer.recipe) throw new DomainError('LEGAL_NO_RECIPE');
    await this.assertCanSend(projectId);
    return this.writeProse(projectId, stored, latest);
  }
  /**
   * The project's answers, newest first, with the service state for the offline mark: while the
   * last call found the service unreachable every cached answer shows '오프라인 · 조회 시각'.
   */
  async list(projectId: string) {
    const latest = await this.settings.lawDbDate();
    return {
      answers: this.answers.list(projectId, latest),
      offline: this.settings.status === 'unreachable',
      status: (await this.settings.view()).clawde.status,
      projectOff: await this.settings.projectOff(projectId),
    };
  }
  async get(projectId: string, number: number) {
    return this.answers.get(projectId, number, await this.settings.lawDbDate());
  }

  /**
   * 설정 › cLAWde [모델 인증] (ARCH-01 「모델 인증」): the qualifying writers the service announces
   * (`meta.answerModels`) with each one's last certification.
   */
  async certView() {
    if (!this.writer) throw new DomainError('LEGAL_WRITER_UNAVAILABLE');
    let meta = this.client.lastMeta;
    if (!meta && (await this.settings.ready()))
      meta = await this.client.meta().catch(() => undefined);
    const certs = await this.writer.certs.all();
    const models = (meta?.answerModels ?? []).flatMap((group) =>
      group.models.map((model) => ({ provider: group.provider, model, effort: group.effort })),
    );
    return {
      models: models.map((writer) => ({ ...writer, cert: certs[writerKey(writer)] ?? null })),
      running: this.writer.running,
    };
  }
  /** Runs the golden set with one writer; only when the user presses [모델 인증]. */
  async certify(input: unknown) {
    if (!this.writer) throw new DomainError('LEGAL_WRITER_UNAVAILABLE');
    if (!(await this.settings.ready())) throw new DomainError('SERVICE_NOT_CONNECTED');
    return this.writer.certify(input);
  }

  /** Labels of profile keys and stages from the last `meta` this engine saw. */
  private labels() {
    return Object.fromEntries(
      (this.client.lastMeta?.profileKeys ?? []).map((k) => [k.key, k.label] as const),
    );
  }
  /** `GET …/legal/profile`. */
  profileView(projectId: string) {
    return {
      stage: this.profile.stage(projectId),
      items: this.profile.items(projectId, this.labels()),
      stages: this.client.lastMeta?.stages ?? [],
      permitPhases: this.client.lastMeta?.permitPhases ?? [],
      profileKeys: this.client.lastMeta?.profileKeys ?? [],
    };
  }
  /** Reads `meta` once when this engine has not seen it (labels of stages, phases and keys). */
  async ensureMeta() {
    if (this.client.lastMeta || !(await this.settings.ready())) return;
    await this.client.meta().catch(() => undefined);
  }
  /**
   * `PUT …/legal/profile`: the answers that used a changed value become '다시 확인 필요'. With
   * `answered` (back-question answers, SPEC-13.7) the answer is the confirmation: a send list that
   * was confirmed before stays confirmed with the answered values.
   */
  updateProfile(projectId: string, input: unknown) {
    const { answered } = legalProfileUpdateSchema.parse(input);
    const confirmedBefore =
      answered && this.profile.payload(projectId).hash === this.profile.confirmedHash(projectId);
    const changed = this.profile.update(projectId, input);
    if (confirmedBefore) this.profile.setConfirmed(projectId, this.profile.payload(projectId).hash);
    const stale = this.answers.profileChanged(projectId, changed);
    return { ...this.profileView(projectId), changed, stale };
  }

  /**
   * `POST …/legal/confirm`: the card's [보내기] outside an ask (the stage checklist). The hash must
   * be the card's; otherwise the new card comes back and nothing is confirmed.
   */
  confirm(projectId: string, input: unknown): { confirmed: true } | LegalNeedsConfirm {
    const { hash, exclude, stage } = legalConfirmInputSchema.parse(input);
    const card = this.profile.candidates(projectId, this.labels());
    if (hash !== card.hash)
      return {
        needsConfirm: {
          items: card.items,
          hash: card.hash,
          stage: stage ?? this.profile.stage(projectId),
        },
      };
    if (exclude) this.profile.applyExclusions(projectId, exclude);
    this.profile.setConfirmed(projectId, this.profile.payload(projectId).hash);
    return { confirmed: true };
  }

  /**
   * `GET …/legal/checklist?stage=` (SPEC-13.6·13.9): the stage checklist for the confirmed send
   * information. A checklist kept for the same stage and sent information is shown without a call
   * (`refresh` asks again). A project switched off, a service not connected or unreachable shows
   * the kept list with its time; with nothing kept the error stands. The send list is confirmed as
   * for a question: a changed list returns the card and sends nothing.
   */
  async checklist(
    projectId: string,
    input: unknown,
  ): Promise<LegalChecklistView | LegalNeedsConfirm> {
    const { stage, refresh } = legalChecklistQuerySchema.parse(input);
    const chosen = stage ?? this.profile.stage(projectId);
    const payload = this.profile.payload(projectId);
    const kept = this.profile.checklist(projectId, chosen);
    const latest = await this.settings.lawDbDate();
    const view = (cache: LegalChecklistCache, cached: boolean): LegalChecklistView => ({
      stage: chosen,
      items: cache.items,
      lawDbDate: cache.lawDbDate,
      fetchedAt: cache.fetchedAt,
      cached,
      offline: cached && this.settings.status === 'unreachable',
      stale: cache.sentHash !== payload.hash || (!!latest && latest > cache.lawDbDate),
    });
    if (kept && !refresh && kept.sentHash === payload.hash) return view(kept, true);
    // Unreachable at the last call: the kept list (stale if the profile changed), no new card.
    if (kept && !refresh && this.settings.status === 'unreachable') return view(kept, true);
    try {
      await this.assertCanSend(projectId);
    } catch (error) {
      if (kept) return view(kept, true);
      throw error;
    }
    if (payload.hash !== this.profile.confirmedHash(projectId)) {
      const card = this.profile.candidates(projectId, this.labels());
      return { needsConfirm: { items: card.items, hash: card.hash, stage: chosen } };
    }
    let list: ClawdeChecklist;
    try {
      list = await this.client.checklist({ stage: chosen, profile: payload.profile });
    } catch (error) {
      if (kept && error instanceof DomainError && error.code === 'SERVICE_UNAVAILABLE')
        return view(kept, true);
      throw error;
    }
    const cache: LegalChecklistCache = {
      sentHash: payload.hash,
      fetchedAt: (this.now?.() ?? new Date()).toISOString(),
      lawDbDate: list.lawDbDate,
      items: list.items,
    };
    this.profile.saveChecklist(projectId, chosen, cache);
    return view(cache, false);
  }

  /**
   * A question from the project (SPEC-13.3): the profile decides what goes out. The first send of
   * a project, and every send whose information differs from the last confirmed one, returns the
   * card (`needsConfirm`) and sends nothing; the card's [보내기] comes back with its `hash` and the
   * final `exclude` list, which stays for the project. A cache hit sends nothing and needs no card.
   */
  async askProject(projectId: string, input: unknown): Promise<LegalProjectAskResult> {
    const { question, stage, confirmSendHash, exclude, refresh } = legalAskInputSchema.parse(input);
    const chosen = stage ?? this.profile.stage(projectId);
    let payload = this.profile.payload(projectId);
    const sentOf = (): LegalSent => ({ stage: chosen, profile: payload.profile });
    const latest = await this.settings.lawDbDate();
    if (!refresh) {
      const hit = this.answers.cached(projectId, question, sentOf(), latest);
      if (hit) return { answer: hit, number: hit.number, cached: true };
    }
    await this.assertCanSend(projectId);
    if (payload.hash !== this.profile.confirmedHash(projectId)) {
      const card = this.profile.candidates(projectId, this.labels());
      if (confirmSendHash !== card.hash)
        return { needsConfirm: { items: card.items, hash: card.hash, stage: chosen } };
      if (exclude) this.profile.applyExclusions(projectId, exclude);
      payload = this.profile.payload(projectId);
      this.profile.setConfirmed(projectId, payload.hash);
    }
    const result = await this.ask(projectId, question, sentOf(), { refresh });
    return { ...result, number: result.answer.number };
  }

  // --- the conversation tools (SPEC-13.9, PLAN-46 T-223) -----------------------------------------

  /**
   * Whether a conversation turn gets the legal tools: the service is connected (an unreachable one
   * still counts: the tools then give cached answers or SERVICE_UNAVAILABLE) and the project is on.
   */
  async toolsOn(projectId: string) {
    return !(await this.settings.projectOff(projectId)) && (await this.settings.ready());
  }
  /** The last service call found it unreachable: cached results are shown as '오프라인'. */
  get offline() {
    return this.settings.status === 'unreachable';
  }
  /**
   * One article's text (SPEC-13.9 `legal_article`): the project's cached copy first, else the
   * service, kept for the project. Only the article id is sent.
   */
  async article(projectId: string, ref: string) {
    const cached = this.answers.article(projectId, ref);
    if (cached) return { ...cached, cached: true };
    await this.assertCanSend(projectId);
    const article = await this.client.article(ref);
    return { ...this.answers.saveArticle(projectId, article), cached: false };
  }
}
