import { DomainError } from '../contracts/errors.ts';
import { legalAskInputSchema } from '../contracts/legal.ts';
import type { ClawdeClient } from './clawde.ts';
import { LegalAnswers, type LegalAnswerView, type LegalSent } from './legal-answers.ts';
import { LegalProfile, type LegalSendItem } from './legal-profile.ts';
import type { ServiceSettings } from './settings.ts';
import type { Store } from '../core/store.ts';

/**
 * Asking cLAWde for a project (SPEC-13.9·13.12, PLAN-46 T-218). A cached answer for the same
 * question, stage and sent information is shown without a call. Otherwise the service is asked
 * once: a project switched off or a service not connected asks nothing; an unreachable service
 * (timeout, 5xx) refuses the new question and leaves the cached ones shown as offline; a response
 * outside the contract is not stored. Nothing is queued to send later.
 */
export const legalStatuses: Record<string, number> = { LEGAL_PROJECT_OFF: 409 };

export interface LegalAskResult {
  answer: LegalAnswerView;
  cached: boolean;
}

/** `POST …/legal/ask`: the answer with its number, or the '보낼 정보' card to confirm first. */
export type LegalProjectAskResult =
  | (LegalAskResult & { number: number })
  | { needsConfirm: { items: LegalSendItem[]; hash: string; stage: string } };

export class LegalService {
  readonly answers: LegalAnswers;
  readonly profile: LegalProfile;
  private readonly client: ClawdeClient;
  private readonly settings: ServiceSettings;
  constructor({
    store,
    client,
    settings,
    now,
  }: {
    store: Store;
    client: ClawdeClient;
    settings: ServiceSettings;
    now?: () => Date;
  }) {
    this.answers = new LegalAnswers(store, { now });
    this.profile = new LegalProfile(store, { now });
    this.client = client;
    this.settings = settings;
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
    return {
      answer: this.answers.add(projectId, question, sent, withFigures, latest),
      cached: false,
    };
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
    };
  }
  /** `PUT …/legal/profile`: the answers that used a changed value become '다시 확인 필요'. */
  updateProfile(projectId: string, input: unknown) {
    const changed = this.profile.update(projectId, input);
    const stale = this.answers.profileChanged(projectId, changed);
    return { ...this.profileView(projectId), changed, stale };
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
}
