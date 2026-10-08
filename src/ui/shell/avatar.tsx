// The account circle (Design SCR-34, SPEC-05.10 1, SPEC-01.14 12): the username's first letter on
// the account's own colour, the same on every PC and on the site (src/contracts/account-avatar.ts).
// No name draws the signed-out mark (a neutral person). Sizes: 28 rail, 40 account panel, 20 narrow
// menu, 16 할 일 rows and forms. `Avatar` is the React component (the site's pages use it too);
// `avatarNode` draws the same circle for the imperative panels.
import { memo } from 'react';
import { avatarIndex, avatarInitial } from '../../contracts/account-avatar.ts';
import { iconSvg } from '../icons.ts';
import '../avatar.css';

export interface AvatarProps {
  /** The VIDE username; empty or missing draws the signed-out mark. */
  name?: string | null;
  /** The site's account id (kept for callers that have it; the colour follows the username). */
  id?: string | null;
  /** Diameter in px (default 28). */
  size?: number;
  /** The tooltip; the accessible name stays '계정 <아이디>'. */
  title?: string;
  /** Extra class names next to `avatar`. */
  className?: string;
}

const fontSize = (size: number) => (size <= 16 ? 9 : Math.round(size * 0.45));

export const Avatar = memo(function Avatar({ name, id, size = 28, title, className }: AvatarProps) {
  const style = { width: size, height: size, fontSize: fontSize(size) };
  const classes = className ? `avatar ${className}` : 'avatar';
  const username = name?.trim();
  if (!username)
    return (
      <span
        className={classes}
        data-avatar="none"
        role="img"
        aria-label="로그인 안 됨"
        title={title ?? '로그인 안 됨'}
        style={style}
        dangerouslySetInnerHTML={{ __html: iconSvg('user') }}
      />
    );
  return (
    <span
      className={classes}
      data-avatar={avatarIndex(username) + 1}
      data-account-id={id ?? undefined}
      role="img"
      aria-label={`계정 ${username}`}
      title={title}
      style={style}
    >
      {avatarInitial(username)}
    </span>
  );
});

/** The same circle as a DOM node (for panels drawn without React). */
export function avatarNode(name: string | null | undefined, size = 28): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = 'avatar';
  node.setAttribute('role', 'img');
  node.style.width = node.style.height = `${size}px`;
  node.style.fontSize = `${fontSize(size)}px`;
  const username = name?.trim();
  if (!username) {
    node.dataset.avatar = 'none';
    node.setAttribute('aria-label', '로그인 안 됨');
    node.innerHTML = iconSvg('user');
  } else {
    node.dataset.avatar = String(avatarIndex(username) + 1);
    node.setAttribute('aria-label', `계정 ${username}`);
    node.textContent = avatarInitial(username);
  }
  return node;
}
