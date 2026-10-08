/**
 * The account circle's color (Design SCR-34, ARCH-01 §8): one of eight, fixed by the account ID so
 * the same account always looks the same on the PC and on the site. FNV-1a 32-bit over the ID's
 * UTF-16 code units, modulo 8. The colors hold white text at 4.5:1 or more in both themes.
 */
export const AVATAR_COLORS = [
  '#4f6fa8',
  '#3b7d60',
  '#9a6a2f',
  '#85509a',
  '#a8504a',
  '#3c7f8c',
  '#6b7232',
  '#94506c',
] as const;

export function avatarIndex(username: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < username.length; index++) {
    hash ^= username.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % AVATAR_COLORS.length;
}

/** The letter in the circle: the ID's first character, upper case ('?' for an empty ID). */
export const avatarInitial = (username: string) =>
  (Array.from(username.trim())[0] ?? '?').toUpperCase();

/**
 * '작성 kim', or '작성 kim · 고침 lee' when someone else changed it last; '작성자 정보 없음' for an
 * item with neither (SPEC-01.14 12).
 */
export function authorLine(
  createdBy: { name: string } | null | undefined,
  updatedBy: { name: string } | null | undefined,
) {
  if (!createdBy && !updatedBy) return '작성자 정보 없음';
  const parts: string[] = [];
  if (createdBy) parts.push(`작성 ${createdBy.name}`);
  if (updatedBy && updatedBy.name !== createdBy?.name) parts.push(`고침 ${updatedBy.name}`);
  return parts.join(' · ');
}
