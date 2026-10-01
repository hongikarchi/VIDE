// Output layer paths (ARCH-03 §9.5): `A::B::C`, each level a Rhino layer name. A jig's output
// root may be several levels deep and need not exist yet — the bake template finds each level
// under its own parent and makes the missing ones there. Only the text is checked here.

export const LAYER_SEPARATOR = '::';
/** Levels in a whole output path (root and the bake's own level together). */
export const MAX_LAYER_DEPTH = 8;
const MAX_NAME = 100;
// Control characters, and ':' inside a name (a stray ':' next to '::' would shift the levels).
// eslint-disable-next-line no-control-regex
const BAD_NAME = /[\u0000-\u001f\u007f:]/;

/** The levels of a path, or why it is not a usable layer path (Korean, for the panel). */
export function layerPathProblem(path: string, maxDepth = MAX_LAYER_DEPTH): string | undefined {
  const names = path.split(LAYER_SEPARATOR);
  if (!path.trim()) return '레이어 이름이 비어 있습니다.';
  if (names.length > maxDepth) return `레이어는 ${maxDepth}단계까지 쓸 수 있습니다.`;
  for (const name of names) {
    if (!name.trim()) return "'::' 사이에 빈 이름이 있습니다.";
    if (name !== name.trim()) return '레이어 이름의 앞뒤에 빈칸이 있습니다.';
    if (name.length > MAX_NAME) return `레이어 이름은 ${MAX_NAME}자까지입니다.`;
    if (BAD_NAME.test(name)) return "레이어 이름에 ':'나 제어 문자를 쓸 수 없습니다.";
  }
  return undefined;
}

/** A root the bake can still put one level of its own under. */
export const layerRootProblem = (root: string) => layerPathProblem(root, MAX_LAYER_DEPTH - 1);
