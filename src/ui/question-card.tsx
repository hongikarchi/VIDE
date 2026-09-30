import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { z } from 'zod';
import './question-card.css';

// 질문 카드 (Design SCR-15, SPEC-02.19 6, PLAN-24 T-062): the cards of a conversation turn that
// ended with questions (`result.turnOutput`, src/server/turn-output.ts). Head '질문 i/n' with what
// waits on the answer, the question in bold, the options (recommended first, with its [권장] tag
// and one-line note), a free answer field when the card allows one, and at the bottom the main
// button (이 답으로 진행) and [권장값으로 진행 · 가정으로 기록]. The answers go to
// `POST …/conversations/:cid/answer`, which records them in the ledger and sends them as the next
// turn of the same conversation.
//
// Mount (app.ts `renderQuestionCards`, for the chosen conversation's latest turn):
//   const cards = mountQuestionCards(element, api, { projectId, conversationId, requestId,
//     turnOutput: request.result.turnOutput, onAnswered: (next) => select(next.id) });
//   cards.update({ ...same, turnOutput }) on refresh; cards.unmount() when the work changes.

export type ApiCall = (path: string, method?: string, data?: unknown) => Promise<unknown>;

const optionSchema = z.object({
  id: z.string(),
  label: z.string(),
  hint: z.string().optional(),
  recommended: z.boolean().optional(),
});
const questionSchema = z.object({
  id: z.string(),
  title: z.string(),
  options: z.array(optionSchema),
  blocks: z.string().optional(),
  allowFree: z.boolean().optional(),
});
export const turnOutputSchema = z.object({
  status: z.enum(['question', 'progress', 'done']),
  questions: z.array(questionSchema).default([]),
});
export type TurnQuestion = z.infer<typeof questionSchema>;

export interface QuestionCardsOptions {
  projectId: string;
  conversationId: string;
  /** The request whose turn asked. */
  requestId: string;
  /** `result.turnOutput` of that request (validated here; anything else shows nothing). */
  turnOutput: unknown;
  /** The questions are already answered (a later turn carries the answers). */
  answered?: boolean;
  /** Called with the answer turn the server created. */
  onAnswered?: (request: { id: string }) => void;
  /**
   * The questions a running turn asks with the provider's own tool (Claude AskUserQuestion,
   * ADR-026 4): the answers go to this path and the same turn goes on (no new turn).
   */
  answerPath?: string;
}

interface Choice {
  optionId?: string;
  text?: string;
}

function Card({
  question,
  index,
  count,
  choice,
  choose,
  disabled,
}: {
  question: TurnQuestion;
  index: number;
  count: number;
  choice: Choice;
  choose: (choice: Choice) => void;
  disabled: boolean;
}) {
  const recommended = question.options.find((option) => option.recommended)?.id;
  return (
    <section className="qcard" aria-label={`질문 ${index + 1}/${count}`}>
      <header className="qcard-head">
        <span>
          질문 {index + 1}/{count}
        </span>
        {question.blocks ? (
          <span className="qcard-blocks">답 전까지 {question.blocks} 대기</span>
        ) : null}
      </header>
      <p className="qcard-title">{question.title}</p>
      <div className="qcard-options" role="radiogroup">
        {question.options.map((option) => (
          <label
            key={option.id}
            className="qcard-option"
            data-selected={(choice.optionId ?? recommended) === option.id ? 'true' : undefined}
          >
            <input
              type="radio"
              name={`q-${question.id}`}
              value={option.id}
              disabled={disabled}
              checked={(choice.optionId ?? recommended) === option.id}
              onChange={() => choose({ ...choice, optionId: option.id })}
            />
            <span className="qcard-label">{option.label}</span>
            {option.recommended ? <span className="qcard-tag">권장</span> : null}
            {option.hint ? <span className="qcard-hint">{option.hint}</span> : null}
          </label>
        ))}
      </div>
      {question.allowFree ? (
        <input
          className="qcard-free"
          type="text"
          maxLength={500}
          disabled={disabled}
          placeholder="직접 적기 (선택)"
          value={choice.text ?? ''}
          onChange={(event) => choose({ ...choice, text: event.target.value })}
        />
      ) : null}
    </section>
  );
}

export function QuestionCards({ api, options }: { api: ApiCall; options: QuestionCardsOptions }) {
  const parsed = turnOutputSchema.safeParse(options.turnOutput);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  if (!parsed.success || parsed.data.status !== 'question' || !parsed.data.questions.length)
    return null;
  const questions = parsed.data.questions;
  const done = sent || !!options.answered;
  const send = async (recommended: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const answers = recommended
        ? // Free answers already written still go; the rest take the recommended option.
          questions
            .filter((q) => choices[q.id]?.text?.trim())
            .map((q) => ({ questionId: q.id, text: choices[q.id].text!.trim() }))
        : questions.map((q) => {
            const choice = choices[q.id] ?? {};
            const optionId = choice.optionId ?? q.options.find((option) => option.recommended)?.id;
            const text = choice.text?.trim();
            return {
              questionId: q.id,
              ...(optionId ? { optionId } : {}),
              ...(text ? { text } : {}),
            };
          });
      if (options.answerPath) {
        await api(options.answerPath, 'POST', {
          answers: answers.map(
            (answer: { questionId: string; optionId?: string; text?: string }) => ({
              id: answer.questionId,
              ...(answer.optionId ? { option: answer.optionId } : {}),
              ...(answer.text ? { text: answer.text } : {}),
            }),
          ),
        });
        setSent(true);
        options.onAnswered?.({ id: options.requestId });
        return;
      }
      const result = (await api(
        `/projects/${encodeURIComponent(options.projectId)}/conversations/${encodeURIComponent(options.conversationId)}/answer`,
        'POST',
        { requestId: options.requestId, answers, ...(recommended ? { recommended: true } : {}) },
      )) as { request?: { id: string } };
      setSent(true);
      if (result?.request) options.onAnswered?.(result.request);
    } catch {
      setError('답을 보내지 못했습니다. 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="qcards">
      {questions.map((question, index) => (
        <Card
          key={question.id}
          question={question}
          index={index}
          count={questions.length}
          choice={choices[question.id] ?? {}}
          choose={(choice) => setChoices((all) => ({ ...all, [question.id]: choice }))}
          disabled={busy || done}
        />
      ))}
      {done ? (
        <p className="qcard-note">답을 보냈습니다. 같은 대화에서 이어서 진행합니다.</p>
      ) : (
        <footer className="qcard-actions">
          {error ? <span className="qcard-error">{error}</span> : null}
          <button
            type="button"
            className="qcard-secondary"
            disabled={busy}
            onClick={() => send(true)}
          >
            권장값으로 진행 · 가정으로 기록
          </button>
          <button
            type="button"
            className="qcard-primary"
            disabled={busy}
            onClick={() => send(false)}
          >
            이 답으로 진행
          </button>
        </footer>
      )}
    </div>
  );
}

export interface QuestionCardsController {
  update: (options: QuestionCardsOptions) => void;
  unmount: () => void;
}
export function mountQuestionCards(
  container: HTMLElement,
  api: ApiCall,
  options: QuestionCardsOptions,
): QuestionCardsController {
  const root: Root = createRoot(container);
  const render = (value: QuestionCardsOptions) =>
    root.render(
      <QuestionCards
        key={value.requestId + (value.answerPath ? ':native' : '')}
        api={api}
        options={value}
      />,
    );
  render(options);
  return { update: render, unmount: () => root.unmount() };
}
