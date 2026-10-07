import type { ClawdeArticle, ClawdeStageId, ClawdeVerdict } from '../contracts/clawde.ts';
import { DomainError } from '../contracts/errors.ts';
import type { LegalService } from '../services/legal.ts';
import type { LegalAnswerView } from '../services/legal-answers.ts';
import type { LegalSendItem } from '../services/legal-profile.ts';

/**
 * The conversation's legal tools (SPEC-13.2·13.5·13.9, ARCH-01 「대화 도구」, PLAN-46 T-223):
 * `legal_ask`, `legal_checklist`, `legal_article` and `legal_answers`, read-only on this project.
 * They are given only while the service is connected and the project is on. `legal_ask` returns the
 * service's deterministic answer with the verified prose (T-236); the chat AI never writes the
 * answer card's text, and what it adds is shown as 'AI 해석'. Anything that carries the profile
 * passes the '보낼 정보' rule: when it needs the user's confirmation, the tool shows the card on the
 * running request and waits; a refusal is SEND_NOT_CONFIRMED.
 *
 * The citation gate (SPEC-13.5, after SPEC-08.7): `[L<n>]` and article numbers in the turn's answer
 * must be among what these tools returned in this turn; others are '확인되지 않은 인용'. A legal
 * answer written without any legal tool result is 'AI 추정 · 서비스 근거 없음'.
 */

/** What the legal tools returned in one turn, for the citation gate. */
export interface LegalTurn {
  /** Answer numbers (L<n>) with the verdict shown. */
  answers: Map<number, ClawdeVerdict>;
  /** Articles: ref → law name and article label. */
  articles: Map<string, { lawName: string; article: string }>;
  /** Some legal tool returned a result this turn. */
  used: boolean;
}
export const legalTurn = (): LegalTurn => ({
  answers: new Map(),
  articles: new Map(),
  used: false,
});

export interface LegalToolSource {
  service: LegalService;
  /**
   * Shows the '보낼 정보' card on the running request and waits for the person: true = [보내기].
   * Undefined when the turn has no request to show it on (the tool then refuses).
   */
  confirm?: (items: LegalSendItem[], signal: AbortSignal) => Promise<boolean>;
  turn: LegalTurn;
}

export const VERDICT_LABELS: Record<ClawdeVerdict, string> = {
  applies: '적용',
  'not-applies': '적용 안 됨',
  conditional: '조건부',
  unknown: '판단 불가',
};
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) + '…' : text);

function seeArticle(turn: LegalTurn, article: Pick<ClawdeArticle, 'ref' | 'lawName' | 'article'>) {
  turn.articles.set(article.ref, { lawName: article.lawName, article: article.article });
}
function seeAnswer(turn: LegalTurn, view: LegalAnswerView) {
  turn.used = true;
  turn.answers.set(view.number, view.verdict);
  for (const cited of view.answer.citations) seeArticle(turn, cited);
}

/** One answer as the AI reads it: the card's content, never something to rewrite. */
export function answerForTool(view: LegalAnswerView, { offline = false } = {}) {
  const answer = view.answer;
  const unverified = new Set(view.unverifiedReasons);
  return {
    ref: view.ref,
    question: view.question,
    stage: view.stage,
    verdict: view.verdict,
    verdictLabel: VERDICT_LABELS[view.verdict] + (view.downgraded ? '(근거 없음)' : ''),
    ...(view.downgraded ? { downgraded: true } : {}),
    // The service's deterministic sentence; shown in the card when no verified prose exists.
    conclusion: answer.conclusion,
    prose: view.prose
      ? {
          label: 'AI 문장(검증됨)',
          conclusion: view.prose.conclusion,
          reasons: view.prose.reasons,
          interpretation: view.prose.interpretation,
          recipe: `${view.prose.recipe.id}@${view.prose.recipe.version}`,
          writer: `${view.prose.writer.provider}/${view.prose.writer.model}`,
          ...(view.prose.verify === 'local-only' ? { verify: 'local-only' } : {}),
        }
      : null,
    proseStatus: view.proseStatus,
    reasons: answer.reasons.map((reason, index) => ({
      text: reason.text,
      refs: reason.refs,
      ...(unverified.has(index) ? { unverifiedRef: true } : {}),
    })),
    interpretation: answer.interpretation.map((entry) => ({
      text: entry.text,
      refs: entry.refs,
      label: entry.basis === 'verified' ? '서비스 확정' : '서비스 해석',
    })),
    citations: answer.citations.map((cited) => ({
      ref: cited.ref,
      lawName: cited.lawName,
      article: cited.article,
      title: cited.title,
      excerpt: cited.excerpt === null ? null : clip(cited.excerpt, 600),
      effectiveDate: cited.effectiveDate,
      sourceUrl: cited.sourceUrl,
      ...(view.noExcerpt.includes(cited.ref) ? { noExcerpt: true } : {}),
    })),
    checks: answer.checks,
    needs: answer.needs,
    constraints: view.constraints,
    usedProfile: answer.usedProfile,
    lawDbDate: view.lawDbDate,
    fetchedAt: view.fetchedAt,
    ...(view.stale ? { stale: true, staleReasons: view.staleReasons } : {}),
    ...(offline ? { offline: true } : {}),
  };
}

const ANSWER_RULE =
  "VIDE shows this answer as a card above your reply (verdict, articles, prose). Do not rewrite or restate the card's conclusion in other words and never change its verdict (conditional/unknown stay so). Cite it as [" +
  'L<n>] and only articles listed here. Anything you add is shown as AI 해석.';

/**
 * Runs `call` and, when it answers with the '보낼 정보' card, shows the card and calls again with
 * the card's hash and the exclusions as shown (SPEC-13.3). The person's refusal, a closed card or
 * a turn without a card is SEND_NOT_CONFIRMED; nothing was sent.
 */
type NeedsConfirm = { needsConfirm: { items: LegalSendItem[]; hash: string } };
async function confirmed<R extends object>(
  source: LegalToolSource,
  signal: AbortSignal,
  call: (confirm?: { confirmSendHash: string; exclude: string[] }) => Promise<R>,
): Promise<Exclude<R, NeedsConfirm>> {
  const first = await call();
  if (!('needsConfirm' in first)) return first as Exclude<R, NeedsConfirm>;
  const card = (first as unknown as NeedsConfirm).needsConfirm;
  if (!source.confirm || !(await source.confirm(card.items, signal)))
    throw new DomainError('SEND_NOT_CONFIRMED');
  const again = await call({
    confirmSendHash: card.hash,
    exclude: card.items.filter((item) => item.selectable && item.excluded).map((item) => item.key),
  });
  // The send list changed while the card was open: the person confirmed something else.
  if ('needsConfirm' in again) throw new DomainError('SEND_NOT_CONFIRMED');
  return again as Exclude<R, NeedsConfirm>;
}

/** The four handlers, bound to the conversation's project. */
export function legalToolHandlers(projectId: string, source: LegalToolSource) {
  const { service, turn } = source;
  return {
    legal_ask: async (
      args: { question: string; stage?: ClawdeStageId; refresh?: boolean },
      { signal }: { signal: AbortSignal },
    ) => {
      const result = await confirmed(source, signal, (confirm) =>
        service.askProject(projectId, {
          question: args.question,
          ...(args.stage ? { stage: args.stage } : {}),
          ...(args.refresh ? { refresh: true } : {}),
          ...confirm,
        }),
      );
      seeAnswer(turn, result.answer);
      return {
        ...answerForTool(result.answer, { offline: result.cached && service.offline }),
        cached: result.cached,
        rule: ANSWER_RULE,
      };
    },
    legal_checklist: async (
      args: { stage?: ClawdeStageId },
      { signal }: { signal: AbortSignal },
    ) => {
      const stage = args.stage ? { stage: args.stage } : {};
      const result = await confirmed(source, signal, async (confirm) => {
        if (confirm) {
          const done = service.confirm(projectId, {
            hash: confirm.confirmSendHash,
            exclude: confirm.exclude,
            ...stage,
          });
          if ('needsConfirm' in done) return done;
        }
        return service.checklist(projectId, stage);
      });
      turn.used = true;
      const here = result.items.filter((item) => item.stage === result.stage);
      return {
        stage: result.stage,
        lawDbDate: result.lawDbDate,
        fetchedAt: result.fetchedAt,
        ...(result.offline ? { offline: true } : {}),
        ...(result.stale ? { stale: true } : {}),
        items: here.map((item) => ({
          topic: item.topic,
          status: item.status,
          statusLabel: item.status === 'unknown' ? '확인 필요' : VERDICT_LABELS[item.status],
          reason: item.reason,
          refs: item.refs,
          ...(item.permitPhases?.length ? { permitPhases: item.permitPhases } : {}),
        })),
        otherStages: result.items.length - here.length,
        rule: 'Each item can be asked with legal_ask for its answer card. The stage placement is the service’s; do not move items between stages.',
      };
    },
    legal_article: async ({ ref }: { ref: string }) => {
      const found = await service.article(projectId, ref);
      turn.used = true;
      seeArticle(turn, found.article);
      return {
        ...found.article,
        fetchedAt: found.fetchedAt,
        ...(found.cached && service.offline ? { offline: true } : {}),
      };
    },
    legal_answers: async ({
      number,
      offset = 0,
      limit = 20,
    }: {
      number?: number;
      offset?: number;
      limit?: number;
    }) => {
      if (number !== undefined) {
        const view = await service.get(projectId, number);
        seeAnswer(turn, view);
        return { ...answerForTool(view, { offline: service.offline }), rule: ANSWER_RULE };
      }
      const listed = await service.list(projectId);
      const page = listed.answers.slice(offset, offset + limit);
      for (const view of page) seeAnswer(turn, view);
      return {
        answers: page.map((view) => ({
          ref: view.ref,
          question: view.question,
          stage: view.stage,
          verdict: view.verdict,
          verdictLabel: VERDICT_LABELS[view.verdict],
          conclusion: view.prose?.conclusion ?? view.answer.conclusion,
          proseStatus: view.proseStatus,
          fetchedAt: view.fetchedAt,
          ...(view.stale ? { stale: true } : {}),
        })),
        total: listed.answers.length,
        offset,
        ...(offset + page.length < listed.answers.length
          ? { nextOffset: offset + page.length }
          : {}),
        ...(listed.offline ? { offline: true } : {}),
      };
    },
  };
}

// --- the citation gate (SPEC-13.5) ----------------------------------------------------------------

/** `[L3]` citations of the turn's answer. */
const ANSWER_CITE = /\[L(\d+)\]/g;
/**
 * An article mention: an optional law name right before `제N조` (and `의M`). The law name is the
 * last words ending in 법·령·규칙·조례 before the article.
 */
const ARTICLE_MENTION =
  /((?:[가-힣]+\s)?[가-힣]*(?:법|령|규칙|조례))?\s*제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/g;
/** Words that make a reply a legal answer in a 법규 conversation. */
const LEGAL_WORDS =
  /건축법|주차장법|국토의\s*계획|시행령|시행규칙|조례|법규|법령|용적률|건폐율|일조|사선\s*제한|이격\s*거리|인허가|건축선/;

const fold = (text: string) => text.replace(/\s+/g, '');
/**
 * The law name of a mention: its last word, with the law before it when that word is only
 * 시행령·시행규칙 ("건축법 시행령"); a word before it that is not a law name ("사선은") is dropped.
 */
const lawName = (words: string) => {
  const parts = words.trim().split(/\s+/);
  const last = parts.at(-1)!;
  const before = parts.at(-2);
  return /^(시행령|시행규칙)$/.test(last) && before && /법$/.test(before)
    ? `${before} ${last}`
    : last;
};
const articleKey = (label: string) => {
  const match = /제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/.exec(label);
  return match ? `${match[1]}${match[2] ? '-' + match[2] : ''}` : undefined;
};

export interface LegalCheck {
  /** `L<n>` cited in the answer. */
  cited: string[];
  /** Answer refs and article mentions no legal tool returned in this turn. */
  unknown: string[];
  /** A legal answer without any legal tool result: 'AI 추정 · 서비스 근거 없음'. */
  estimate: boolean;
  /** The answers the tools returned this turn (their cards go with the reply). */
  answers: number[];
}

/**
 * The legal citation gate on a turn's answer. Returns {} when the reply is not about law and no
 * legal tool ran; otherwise `legalCheck` and, when something is unverified or the answer is an
 * estimate, the text with the warning appended (the same way as the facts gate).
 */
export function legalCitations(
  text: string,
  turn: LegalTurn | undefined,
  { legalConversation = false }: { legalConversation?: boolean } = {},
): { legalCheck?: LegalCheck; text?: string } {
  const returned = turn ?? legalTurn();
  const cited = [...new Set([...text.matchAll(ANSWER_CITE)].map((m) => Number(m[1])))];
  const mentions = [...text.matchAll(ARTICLE_MENTION)].map((m) => {
    const law = m[1] ? lawName(m[1]) : undefined;
    const article = `제${m[2]}조${m[3] ? '의' + m[3] : ''}`;
    return {
      text: law ? `${law} ${article}` : article,
      law: law ? fold(law) : undefined,
      key: `${m[2]}${m[3] ? '-' + m[3] : ''}`,
    };
  });
  const legal =
    returned.used ||
    cited.length > 0 ||
    mentions.some((m) => m.law) ||
    (legalConversation && (mentions.length > 0 || LEGAL_WORDS.test(text)));
  if (!legal) return {};
  const known = [...returned.articles.values()].map((a) => ({
    law: fold(a.lawName),
    key: articleKey(a.article),
  }));
  const unknownAnswers = cited.filter((n) => !returned.answers.has(n)).map((n) => `L${n}`);
  const unknownArticles = [
    ...new Set(
      mentions
        .filter(
          (m) =>
            !known.some(
              (a) => a.key === m.key && (!m.law || a.law === m.law || a.law.endsWith(m.law)),
            ),
        )
        .map((m) => m.text),
    ),
  ];
  const estimate = !returned.used;
  const check: LegalCheck = {
    cited: cited.map((n) => `L${n}`),
    unknown: [...unknownAnswers, ...unknownArticles],
    estimate,
    answers: [...returned.answers.keys()],
  };
  const notes: string[] = [];
  if (estimate)
    notes.push(
      '⚠ AI 추정 · 서비스 근거 없음: 이 답은 법규 서비스(cLAWde)의 답 없이 AI가 쓴 내용입니다. 법규 판단의 근거로 쓰지 마세요.',
    );
  else if (check.unknown.length)
    notes.push(
      `⚠ 확인되지 않은 인용: ${check.unknown.join(', ')}. 이번 답에서 법규 도구가 돌려주지 않은 답·조문입니다.`,
    );
  return {
    legalCheck: check,
    ...(notes.length ? { text: text + '\n\n' + notes.join('\n') } : {}),
  };
}
