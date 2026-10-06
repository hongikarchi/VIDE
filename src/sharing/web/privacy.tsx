// 개인정보 처리 안내 for opt-in error/performance reports (ADR-036, SPEC-05.9): the page the PC's
// consent card links to (/privacy), readable without signing in. The text is a draft shared with
// the PC program's card (src/contracts/telemetry-notice.ts); a legal check comes before wide release.
import {
  PRIVACY_DRAFT_NOTE,
  PRIVACY_SECTIONS,
  TELEMETRY_INTRO,
} from '../../contracts/telemetry-notice.ts';

export function Privacy() {
  return (
    <main className="privacy-page">
      <a className="wordmark" href="/">
        VIDE
      </a>
      <h1>개인정보 처리 안내 · 오류·성능 정보</h1>
      <p className="privacy-draft" role="note">
        {PRIVACY_DRAFT_NOTE}
      </p>
      <p>{TELEMETRY_INTRO}</p>
      {PRIVACY_SECTIONS.map((section) => (
        <section key={section.title}>
          <h2>{section.title}</h2>
          <ul>
            {section.body.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
