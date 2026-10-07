import { DomainError } from '../contracts/errors.ts';
import type { ClawdeClient } from './clawde.ts';
import { LegalAnswers, type LegalAnswerView, type LegalSent } from './legal-answers.ts';
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

export class LegalService {
  readonly answers: LegalAnswers;
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
}
