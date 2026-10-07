import { useEffect, useState } from 'react';
import { api } from './gateway.ts';
import { LegalAnswerCard, type LegalAnswerView } from './legal-answer-card.tsx';
import './legal-jig.css';

// 법규 답 in a conversation (SPEC-13.2·13.5, PLAN-46 T-223): the answers the legal tools returned in
// the turn go above the AI's reply as the same answer cards as the legal panel (the verdict, articles
// and verified prose are the service's). The reply under them is the AI's own 'AI 해석'.

/** The legal gate's record on a turn result (server: legal-tools.ts LegalCheck). */
export interface LegalCheckView {
  cited?: string[];
  unknown?: string[];
  estimate?: boolean;
  answers?: number[];
}

export function legalCheckOf(result: unknown): LegalCheckView | undefined {
  const check = (result as { legalCheck?: unknown } | null | undefined)?.legalCheck;
  return check && typeof check === 'object' ? (check as LegalCheckView) : undefined;
}

export function LegalTurnCards({
  projectId,
  numbers,
}: {
  projectId: string;
  numbers: readonly number[];
}) {
  const [views, setViews] = useState<LegalAnswerView[]>([]);
  const key = numbers.join(',');
  useEffect(() => {
    let live = true;
    void Promise.all(
      key
        .split(',')
        .filter(Boolean)
        .slice(0, 6)
        .map((number) =>
          api(
            `/projects/${encodeURIComponent(projectId)}/legal/answers?number=${number}`,
            'GET',
            undefined,
            { quiet: ['NOT_FOUND', 'FORBIDDEN'] },
          )
            .then((data) => (data as { answer: LegalAnswerView }).answer)
            .catch(() => undefined),
        ),
    ).then((found) => {
      if (live) setViews(found.filter((view): view is LegalAnswerView => !!view));
    });
    return () => {
      live = false;
    };
  }, [projectId, key]);
  if (!views.length) return null;
  return (
    <div className="legal-turn-cards" aria-label="법규 답">
      {views.map((view) => (
        <LegalAnswerCard key={view.number} view={view} />
      ))}
    </div>
  );
}
