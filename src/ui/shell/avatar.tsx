import type { CSSProperties } from 'react';
import { AVATAR_COLORS, avatarIndex, avatarInitial } from '../../contracts/account-avatar.ts';

// The account circle (Design SCR-34): the ID's first letter in white on the account's color, the
// same on the PC and the site. 28px in the rail, 40px in the account panel, 16px on 할 일 rows and
// forms (SPEC-01.14 12). No name: the signed-out circle, a neutral person mark. Inline styles only,
// so the site's pages use it without the work screen's style sheets.

// lucide `user` (ISC licence).
const PERSON = 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2';

export function Avatar({
  name,
  id,
  size = 16,
  title,
  className,
}: {
  /** The account ID; null or empty: signed out. */
  name: string | null | undefined;
  /** The site account id (not shown; kept for callers that key by it). */
  id?: string | null;
  size?: number;
  /** The tooltip; the accessible name stays '계정 <ID>'. */
  title?: string;
  className?: string;
}) {
  const base: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 'none',
    width: size,
    height: size,
    borderRadius: '50%',
    lineHeight: 1,
    userSelect: 'none',
  };
  if (!name?.trim())
    return (
      <span
        className={className}
        role="img"
        aria-label="로그인 안 됨"
        title={title ?? '로그인 안 됨'}
        style={{ ...base, background: 'var(--bg-active, #e5e4e0)', color: 'var(--text-3, #888)' }}
      >
        <svg
          width={Math.round(size * 0.6)}
          height={Math.round(size * 0.6)}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d={PERSON} />
          <circle cx="12" cy="7" r="4" />
        </svg>
      </span>
    );
  const index = avatarIndex(name.trim());
  return (
    <span
      className={className}
      role="img"
      aria-label={`계정 ${name.trim()}`}
      title={title}
      data-account={id ?? undefined}
      style={{
        ...base,
        background: `var(--avatar-${index + 1}, ${AVATAR_COLORS[index]})`,
        color: '#fff',
        fontFamily: 'Inter, var(--font-sans, system-ui), sans-serif',
        fontWeight: 600,
        fontSize: size <= 16 ? 9 : Math.round(size * 0.45),
      }}
    >
      {avatarInitial(name)}
    </span>
  );
}
