// Inline pins: "[고정1 · 6개]" tokens written into the message, each naming a set of pinned objects.
// The textarea stays a plain textarea (IME-safe) with transparent text; a backdrop behind it, laid
// out with the textarea's own metrics, paints the text and draws tokens as chips. A translucent
// ghost chip at the caret inserts the current viewport selection.

const TOKEN = /\[고정(\d+) · (\d+)개\]/g;
// Every chip that deletes whole: pins and pasted paths (SPEC-01.12 6, PLAN-31 T-140).
const CHIP = /\[고정(\d+) · \d+개\]|\[(?:파일|폴더) · [^\]\n]+\]/g;

export const pinToken = (label: number, count: number) => `[고정${label} · ${count}개]`;

/** Labels ("고정N") of the pin tokens present in a message. */
export function tokenLabels(text: string) {
  return new Set([...text.matchAll(TOKEN)].map((match) => `고정${match[1]}`));
}

/** Next unused token number in a message. */
export function nextTokenNumber(text: string) {
  let max = 0;
  for (const match of text.matchAll(TOKEN)) max = Math.max(max, Number(match[1]));
  return max + 1;
}

/**
 * The chip range containing or touching `offset` (end-inclusive), if any: `label` is "고정N" for a
 * pin token and the token text itself for a path chip.
 */
export function tokenAt(text: string, offset: number) {
  for (const match of text.matchAll(CHIP)) {
    const start = match.index!,
      end = start + match[0].length;
    if (offset >= start && offset <= end)
      return { start, end, label: match[1] ? `고정${match[1]}` : match[0], pin: !!match[1] };
  }
  return undefined;
}

const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Options {
  /** Objects that the ghost chip would pin now (empty hides it). */
  selection: () => { count: number };
  /** Called with the new label when the user inserts the current selection. */
  insert: (label: string) => void;
  /** Called when the caret lands on a token (e.g. to show its objects). */
  focusToken: (label: string) => void;
  /** The full path of a path chip, shown when the pointer is over it. */
  pathOf?: (label: string) => string | undefined;
}

/**
 * Attaches to the composer's `.body-field` (drawn by shell/composer.tsx: `.body-backdrop`, the
 * textarea, `.pin-ghost`); it does not wrap or move the textarea (PLAN-26 T-113).
 */
export function attachPinTokens(textarea: HTMLTextAreaElement, options: Options) {
  const field = textarea.parentElement!;
  const backdrop = field.querySelector<HTMLElement>(':scope > .body-backdrop')!;
  const ghost = field.querySelector<HTMLButtonElement>(':scope > .pin-ghost')!;
  let caret = textarea.value.length;

  // Same box and text metrics as the textarea, so painted glyphs sit exactly under its caret.
  const METRICS = [
    'boxSizing',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'letterSpacing',
    'wordSpacing',
  ] as const;
  const align = () => {
    const style = getComputedStyle(textarea);
    for (const key of METRICS) backdrop.style[key] = style[key];
    backdrop.style.borderStyle = 'solid';
    backdrop.style.borderColor = 'transparent';
    backdrop.style.width = textarea.offsetWidth + 'px';
    backdrop.style.height = textarea.offsetHeight + 'px';
    // A textarea scrollbar narrows its text column; narrow the backdrop's the same way.
    const borders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    const scrollbar = textarea.offsetWidth - textarea.clientWidth - borders;
    backdrop.style.paddingRight = parseFloat(style.paddingRight) + scrollbar + 'px';
  };
  const render = (text: string) =>
    escape(text)
      .replace(
        /\[(고정\d+ · \d+개)\]/g,
        (_token, inner) =>
          `<mark class="pin-token"><span class="pin-bracket">[</span>${inner}<span class="pin-bracket">]</span></mark>`,
      )
      .replace(
        /\[((?:파일|폴더) · [^\]\n]+)\]/g,
        (_token, inner) =>
          `<mark class="pin-token path-token"><span class="pin-bracket">[</span>${inner}<span class="pin-bracket">]</span></mark>`,
      );
  // The backdrop draws the text and carries a zero-width anchor at the caret: the chip is placed
  // from the same layout the user sees, so it sits in the sentence exactly where it would go.
  const paint = () => {
    const text = textarea.value;
    let at = Math.min(caret, text.length);
    const token = tokenAt(text, at);
    if (token && at > token.start && at < token.end) at = token.end;
    backdrop.innerHTML =
      render(text.slice(0, at)) + '<span class="pin-caret"></span>' + render(text.slice(at)) + '\n';
    backdrop.scrollTop = textarea.scrollTop;
  };
  const caretPoint = () => {
    const anchor = backdrop.querySelector<HTMLElement>('.pin-caret');
    return anchor
      ? { left: anchor.offsetLeft, top: anchor.offsetTop - backdrop.scrollTop }
      : { left: 0, top: 0 };
  };
  const place = () => {
    const { count } = options.selection();
    ghost.hidden = count === 0 || textarea.disabled;
    // With nothing typed yet, the chip takes the sentence's first place (placeholder hidden).
    field.dataset.ghost = String(!ghost.hidden && !textarea.value);
    if (ghost.hidden) return;
    ghost.textContent = `📌 고정 · ${count}개`;
    const style = getComputedStyle(textarea);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    ghost.style.fontSize = style.fontSize;
    ghost.style.height = `${lineHeight}px`;
    ghost.style.lineHeight = `${lineHeight - 2}px`;
    const maxLeft = Math.max(0, field.clientWidth - ghost.offsetWidth - 4);
    const point = caretPoint();
    // Mid-sentence the chip drops one line so it does not cover the words after the caret.
    const midLine = caret < textarea.value.length && textarea.value[caret] !== '\n';
    const room = !midLine && point.left + 4 + ghost.offsetWidth <= field.clientWidth;
    ghost.style.left = `${Math.min(point.left + (textarea.value ? 4 : 0), maxLeft)}px`;
    ghost.style.top = `${Math.max(0, point.top + (midLine || !room ? lineHeight : 0))}px`;
  };
  const remember = () => {
    caret = textarea.selectionEnd ?? textarea.value.length;
    paint();
    place();
  };
  const commit = () => {
    paint();
    remember();
  };

  // Keep the caret: mousedown on the ghost must not blur the textarea.
  ghost.addEventListener('mousedown', (event) => event.preventDefault());
  const insertSelection = () => {
    const { count } = options.selection();
    if (!count) return;
    const number = nextTokenNumber(textarea.value);
    const at = Math.min(caret, textarea.value.length);
    const before = textarea.value.slice(0, at),
      after = textarea.value.slice(at);
    const token = pinToken(number, count);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    const tail = after && !/^\s/.test(after) ? ' ' : '';
    textarea.value = before + pad + token + tail + after;
    caret = (before + pad + token + tail).length;
    options.insert(`고정${number}`);
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  };
  ghost.addEventListener('click', insertSelection);
  // Tokens are atomic: Backspace/Delete next to or inside one removes the whole token.
  textarea.addEventListener('keydown', (event) => {
    if ((event.key !== 'Backspace' && event.key !== 'Delete') || event.isComposing) return;
    if (textarea.selectionStart !== textarea.selectionEnd) return;
    const offset = textarea.selectionStart + (event.key === 'Delete' ? 1 : 0);
    const token = tokenAt(textarea.value, event.key === 'Backspace' ? offset : offset - 1);
    if (
      !token ||
      (event.key === 'Backspace' && offset === token.start) ||
      (event.key === 'Delete' && offset - 1 === token.end)
    )
      return;
    event.preventDefault();
    textarea.value = textarea.value.slice(0, token.start) + textarea.value.slice(token.end);
    textarea.setSelectionRange(token.start, token.start);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  textarea.addEventListener('input', commit);
  textarea.addEventListener('scroll', () => {
    backdrop.scrollTop = textarea.scrollTop;
    place();
  });
  for (const type of ['keyup', 'focus'] as const) textarea.addEventListener(type, remember);
  textarea.addEventListener('click', () => {
    remember();
    const token = tokenAt(textarea.value, textarea.selectionStart);
    if (token?.pin && textarea.selectionStart > token.start && textarea.selectionStart < token.end)
      options.focusToken(token.label);
  });
  // The backdrop takes no pointer: the path under the pointer is found from the chips' boxes.
  textarea.addEventListener('mousemove', (event) => {
    let title = '';
    for (const chip of backdrop.querySelectorAll<HTMLElement>('.path-token'))
      for (const rect of chip.getClientRects())
        if (
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom
        )
          title = options.pathOf?.(chip.textContent ?? '') ?? '';
    if (textarea.title !== title) textarea.title = title;
  });
  new ResizeObserver(() => {
    align();
    paint();
    place();
  }).observe(textarea);
  align();
  paint();
  return {
    /** Insert the current selection as a token at the last caret position. */
    insertSelection,
    /** Re-read the text (after programmatic value changes) and reposition the ghost. */
    refresh() {
      caret = Math.min(caret, textarea.value.length);
      paint();
      place();
    },
  };
}
