// Where a request goes before it is sent (SPEC-02.17): the VIDE screen only (hide, isolate,
// show, select, zoom — nothing in the file changes) or the file itself. Code rules come first; the
// user sees the result as a chip and can change it before sending. The model is chosen by the
// server's "자동 (Jev)" routing (src/ai/model-router.ts), not here.

export type ViewAction = 'hide' | 'isolate' | 'unhide' | 'select' | 'fit';
export interface RouteObject {
  id: string;
  type?: unknown;
  layer?: unknown;
  name?: unknown;
}
export interface Route {
  target: 'view' | 'document';
  view?: { action: ViewAction; ids: string[]; subject: string };
  /** The request uses screen-action words (worth showing where it goes, even to the file). */
  viewWords?: boolean;
  reason: string;
}

// Words that name the file itself or change it: these requests always go to the file.
const documentWords =
  /(원본|도면에서|도면을|cad\s*에서|캐드|zwcad|rhino\s*에서|라이노에서|파일에|삭제|지워|없애|레이어[^.]{0,12}(바꿔|변경|옮)|색(상|깔)?[을를]?\s*(바꿔|변경|바꾸)|수정|이동|옮겨|만들어|그려|생성|추가|복사|회전|늘려|줄여|저장)/i;
const viewActions: [ViewAction, RegExp][] = [
  [
    'unhide',
    /(모두|전부|다시|숨긴\s*(것|거|객체)?[을를]?)\s*(다\s*)?(보여|보이게|표시)|\bunhide\b|숨김\s*(해제|풀)/i,
  ],
  // English words only as whole words ("selected mass" is not a select request).
  ['isolate', /(만\s*남기고|만\s*(보여|보이게|표시)|격리|\bisolate\b)/i],
  ['hide', /(숨겨|숨기|안\s*보이게|가려|감춰|\bhide\b)/i],
  ['select', /(선택해|골라|\bselect\b(?!ed))/i],
  ['fit', /(확대해|줌|가까이\s*보여|맞춰\s*보여|\bfit\b|\bzoom\b)/i],
];
// Object kinds by the words people use; matched against the object's native type. Short Korean
// words must stand alone: "선" is not in "선택", "면" not in "도면", "점" not in "시점".
const alone = (word: string) => `(?<![가-힣])${word}(?=[만을를들은는이가도\\s]|$)`;
const kinds: [RegExp, RegExp, string][] = [
  [/(텍스트|문자|글자|글씨|주석|text)/i, /(text|annotation|leader)/i, '문자'],
  [/(치수|dimension)/i, /dim/i, '치수'],
  [/(해치|hatch)/i, /hatch/i, '해치'],
  [/(블록|block)/i, /(block|instance)/i, '블록'],
  [
    new RegExp(`(${alone('면')}|서피스|솔리드|메시|surface|solid|brep|mesh)`, 'i'),
    /(brep|surface|extrusion|mesh|subd)/i,
    '면',
  ],
  [
    new RegExp(`(곡선|직선|커브|${alone('선')}|라인|폴리라인|curve|line)`, 'i'),
    /(line|curve|polyline|arc|circle|spline)/i,
    '선',
  ],
  [new RegExp(`(${alone('점')}|point)`, 'i'), /point/i, '점'],
];
const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** Objects named by the request: by kind words, then layer names, then object names. */
function subjectOf(body: string, objects: readonly RouteObject[]) {
  const lower = body.toLowerCase();
  for (const [words, types, label] of kinds)
    if (words.test(body)) {
      const ids = objects.filter((o) => types.test(text(o.type))).map((o) => o.id);
      if (ids.length) return { ids, subject: label };
    }
  const layers = [...new Set(objects.map((o) => text(o.layer)).filter((l) => l.length >= 2))]
    // Longest first so "구조::보" wins over "보".
    .sort((a, b) => b.length - a.length);
  const layer = layers.find((name) => lower.includes(name.toLowerCase()));
  if (layer)
    return {
      ids: objects.filter((o) => text(o.layer) === layer).map((o) => o.id),
      subject: '레이어 ' + layer,
    };
  const named = objects.filter((o) => {
    const name = text(o.name);
    return name.length >= 2 && lower.includes(name.toLowerCase());
  });
  if (named.length) return { ids: named.map((o) => o.id), subject: '이름이 맞는 객체' };
  return undefined;
}

export function routeRequest(
  body: string,
  objects: readonly RouteObject[],
  selected: readonly string[] = [],
): Route {
  const found = viewActions.find(([, pattern]) => pattern.test(body));
  if (found && !documentWords.test(body)) {
    const [action] = found;
    if (action === 'unhide')
      return {
        target: 'view',
        view: { action, ids: [], subject: '숨긴 객체' },
        reason: '화면 표시만 바꿉니다',
      };
    const subject =
      subjectOf(body, objects) ??
      (selected.length && /(이것|이거|선택한|선택된|고른)/.test(body)
        ? { ids: [...selected], subject: '선택한 객체' }
        : undefined);
    if (subject)
      return {
        target: 'view',
        view: { action, ...subject },
        reason: '화면 표시만 바꿉니다 · 원본은 그대로',
      };
    return {
      target: 'view',
      view: { action, ids: [], subject: '' },
      reason: '화면에서 어떤 객체인지 찾지 못했습니다',
    };
  }
  return {
    target: 'document',
    ...(found ? { viewWords: true } : {}),
    reason: '파일 작업',
  };
}
