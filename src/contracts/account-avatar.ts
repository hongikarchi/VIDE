// The account circle's colour (Design SCR-34, SPEC-05.10 1, ARCH-01 §8): a VIDE account always gets
// the same letter and colour on every PC and on the site. The colour is the FNV-1a 32-bit hash of
// the username's UTF-8 bytes, mod 8, picking `--avatar-1` … `--avatar-8`. The colours hold white
// text at 4.5:1 or more in both themes. The app and the site both use this one definition.

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

/** 0…7: which avatar colour the username gets. */
export function avatarIndex(username: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(username)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % AVATAR_COLORS.length;
}

/** The letter in the circle: the username's first character, upper-case ('' for an empty name). */
export function avatarInitial(username: string): string {
  const first = [...username.trim()][0] ?? '';
  return first.toUpperCase();
}

/**
 * The byline of a 할 일 item (SPEC-01.14 12): '작성 kim', or '작성 kim · 고침 lee' when someone
 * else changed it last. An item without an author (made before authors were kept) always says
 * '작성자 정보 없음', followed by '· 고침 lee' once someone has changed it, so the editor is never
 * read as the author.
 */
export function authorLine(
  createdBy: { name: string } | null | undefined,
  updatedBy: { name: string } | null | undefined,
) {
  const parts = [createdBy ? `작성 ${createdBy.name}` : '작성자 정보 없음'];
  if (updatedBy && updatedBy.name !== createdBy?.name) parts.push(`고침 ${updatedBy.name}`);
  return parts.join(' · ');
}
