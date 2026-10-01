// The order of a jig's versions (SPEC-07.3·07.4, PLAN-26 T-101), shared by the engine (the next
// patch of a copy, [올리기]) and the JIG list (which instance rows offer [올리기]).

/** `a.b.c` as numbers (a pre-release tag is ignored); for ordering versions of one jig. */
export const versionParts = (version: string): number[] =>
  version
    .split('-')[0]
    .split('.')
    .map((part) => Number(part) || 0);

/** Whether version `a` is newer than `b`. */
export function isNewerVersion(a: string, b: string): boolean {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}
