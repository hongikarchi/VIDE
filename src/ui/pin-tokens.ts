// Inline pins: "[고정1 · 6개]" tokens written into the message, each naming a set of pinned objects.
// The textarea stays a plain textarea (IME-safe); a backdrop behind it paints tokens as chips and a
// translucent ghost chip at the caret inserts the current viewport selection.

const TOKEN = /\[고정(\d+) · (\d+)개\]/g;

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

/** The token range containing or touching `offset` (end-inclusive), if any. */
export function tokenAt(text: string, offset: number) {
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index!,
      end = start + match[0].length;
    if (offset >= start && offset <= end) return { start, end, label: `고정${match[1]}` };
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
}

export function attachPinTokens(textarea: HTMLTextAreaElement, options: Options) {
  const field = document.createElement('div');
  field.className = 'body-field';
  textarea.replaceWith(field);
  const backdrop = document.createElement('div');
  backdrop.className = 'body-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  const ghost = document.createElement('button');
  ghost.type = 'button';
  ghost.className = 'pin-ghost';
  ghost.hidden = true;
  ghost.title = '선택한 객체를 이 위치에 고정합니다';
  field.append(backdrop, textarea, ghost);
  let caret = textarea.value.length;

  const paint = () => {
    backdrop.innerHTML =
      escape(textarea.value).replace(
        /\[고정(\d+) · (\d+)개\]/g,
        (token) => `<mark class="pin-token">${token}</mark>`,
      ) + '\n';
    backdrop.scrollTop = textarea.scrollTop;
  };
  // Caret coordinates via a mirror with the textarea's text metrics.
  const caretPoint = () => {
    const style = getComputedStyle(textarea);
    const mirror = document.createElement('div');
    for (const key of [
      'boxSizing',
      'width',
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
    ] as const)
      mirror.style[key] = style[key];
    Object.assign(mirror.style, {
      position: 'absolute',
      visibility: 'hidden',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'break-word',
      top: '0',
      left: '0',
    });
    mirror.textContent = textarea.value.slice(0, caret);
    const marker = document.createElement('span');
    marker.textContent = '​';
    mirror.append(marker);
    field.append(mirror);
    const point = { left: marker.offsetLeft, top: marker.offsetTop - textarea.scrollTop };
    mirror.remove();
    return point;
  };
  const place = () => {
    const { count } = options.selection();
    ghost.hidden = count === 0 || textarea.disabled;
    if (ghost.hidden) return;
    ghost.textContent = `📌 고정 · ${count}개`;
    const point = caretPoint();
    const maxLeft = Math.max(0, field.clientWidth - ghost.offsetWidth - 4);
    // Mid-sentence the chip drops one line so it does not cover the words after the caret.
    const midLine = caret < textarea.value.length && textarea.value[caret] !== '\n';
    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
    ghost.style.left = `${Math.min(point.left + 2, maxLeft)}px`;
    ghost.style.top = `${Math.max(0, point.top + (midLine ? lineHeight : 0))}px`;
  };
  const remember = () => {
    caret = textarea.selectionEnd ?? textarea.value.length;
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
    if (token && textarea.selectionStart > token.start && textarea.selectionStart < token.end)
      options.focusToken(token.label);
  });
  new ResizeObserver(() => {
    paint();
    place();
  }).observe(textarea);
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
