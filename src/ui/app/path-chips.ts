// Pasted paths become chips (SPEC-01.12 6, PLAN-31 T-140): a path of this PC pasted into the
// composer (or typed and finished with a closing quote or a line break) is checked by the engine
// and replaced by a "[파일 · …]" / "[폴더 · …]" token; pin-tokens.ts draws and deletes it like a pin.
// On sending, file chips are copied as attachments; folder chips go as the request's `folders`.
import { addViewCopy } from '../attachments.ts';
import { element as $, readableError } from '../elements.ts';
import { api, errors } from '../gateway.ts';
import { requestBody } from '../model.ts';
import { pathSpans, pathToken, pathTokenLabels } from '../path-tokens.ts';
import { attachPath, pathKindsAt } from '../reference-check.ts';
import { remoteSession } from '../remote-panel.ts';
import { draftState } from '../store/draft.ts';
import { sessionState } from '../store/session.ts';
import { message } from './status.ts';
import { render } from './render.ts';

export const REMOTE_PATHS = '원격 세션에서는 이 PC의 경로를 칩으로 바꾸지 않습니다.';
const MAX_CANDIDATES = 64;

/** The full path of a chip in the draft (hover). */
export const chipPath = (label: string) =>
  draftState.state.paths?.find((entry) => entry.label === label)?.path;

/** Chips whose token left the message (and its queued requests) leave the draft. */
export function prunePathChips() {
  if (!draftState.state.paths?.length) return;
  const labels = pathTokenLabels(requestBody(draftState.state));
  draftState.state.paths = draftState.state.paths.filter((entry) => labels.has(entry.label));
}

/**
 * Replaces the path spans that `pick` chooses with chips: every span's candidates are checked in
 * one engine call; the longest one that exists wins. A path not on this PC stays text.
 */
async function chipPaths(pick: (span: { start: number; stop: number }) => boolean) {
  const textarea = $('body');
  const text = textarea.value;
  const spans = pathSpans(text).filter(pick);
  if (!spans.length || !sessionState.project) return;
  if (remoteSession()) {
    message(REMOTE_PATHS);
    return;
  }
  const projectId = sessionState.project.id,
    draft = draftState.state;
  const paths = [...new Set(spans.flatMap((span) => span.candidates.map((c) => c.path)))].slice(
    0,
    MAX_CANDIDATES,
  );
  let items: Awaited<ReturnType<typeof pathKindsAt>>;
  try {
    items = await pathKindsAt(api, projectId, paths);
  } catch {
    return;
  }
  if (sessionState.project?.id !== projectId || draftState.state !== draft) return;
  const kinds = new Map(items.map((item) => [item.path, item.kind]));
  const found = spans.flatMap((span) => {
    const hit = span.candidates.find((candidate) => kinds.get(candidate.path));
    return hit
      ? [{ written: text.slice(span.start, hit.end), path: hit.path, kind: kinds.get(hit.path)! }]
      : [];
  });
  if (!found.length) return;
  // The words may have changed while the engine looked: each path is found again by its text.
  let value = textarea.value;
  let caret = textarea.selectionEnd;
  const entries = (draftState.state.paths ??= []);
  let from = value.length;
  for (const hit of found.reverse()) {
    const at = value.lastIndexOf(hit.written, from);
    if (at < 0) continue;
    const label = pathToken(hit.kind, hit.path, entries);
    if (!entries.some((entry) => entry.label === label))
      entries.push({ label, kind: hit.kind, path: hit.path });
    value = value.slice(0, at) + label + value.slice(at + hit.written.length);
    if (caret >= at + hit.written.length) caret += label.length - hit.written.length;
    else if (caret > at) caret = at + label.length;
    from = at - 1;
  }
  if (value === textarea.value) return;
  textarea.value = value;
  textarea.setSelectionRange(caret, caret);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Pasted text: plain text goes in as typed, then its paths are checked. */
export function pastePaths(event: ClipboardEvent) {
  const pasted = event.clipboardData?.getData('text/plain');
  if (!pasted || !pathSpans(pasted).length) return;
  event.preventDefault();
  const textarea = $('body');
  const text = pasted.replace(/\r\n?/g, '\n');
  const start = textarea.selectionStart;
  textarea.focus();
  // insertText keeps the textarea's own undo; setRangeText where it is not supported.
  if (!document.execCommand('insertText', false, text)) {
    textarea.setRangeText(text, start, textarea.selectionEnd, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const end = start + text.length;
  void chipPaths((span) => span.start < end && span.stop > start);
}

/** Typed paths are checked once finished: a closing quote or a line break right before the caret. */
export function finishTypedPaths(event: Event) {
  const input = event as InputEvent;
  if (input.isComposing) return;
  if (
    input.inputType !== 'insertLineBreak' &&
    !(input.inputType === 'insertText' && input.data === '"')
  )
    return;
  const caret = $('body').selectionEnd;
  void chipPaths((span) => span.stop === caret || span.stop === caret - 1);
}

/** File chips in the message not yet copied as attachments. */
function pendingFileChips() {
  const labels = pathTokenLabels(requestBody(draftState.state));
  return (draftState.state.paths ?? []).filter(
    (entry) =>
      entry.kind === 'file' &&
      labels.has(entry.label) &&
      !draftState.state.files.some((file) => file.id && file.id === entry.attached),
  );
}
export const pendingFileChip = () => pendingFileChips().length > 0;

/**
 * Before sending: each file chip still in the message is copied into the project's attachments
 * (any type, SPEC-01.12 2·6) once. False when a copy failed (the message says why; nothing sent).
 */
export async function attachFileChips(refusals: Record<string, string>): Promise<boolean> {
  const pending = pendingFileChips();
  if (!pending.length || !sessionState.project) return true;
  const projectId = sessionState.project.id,
    draft = draftState.state;
  for (const entry of pending) {
    try {
      const kept = await attachPath(api, projectId, entry.path);
      if (draftState.state !== draft) return false;
      entry.attached = kept.id;
      if (!draftState.state.files.some((file) => file.id === kept.id))
        draftState.state.files.push(kept);
      void addViewCopy(projectId, kept);
    } catch (cause) {
      const error = readableError(cause);
      message(
        `${entry.label} · ` +
          (refusals[error.code ?? error.message] ||
            errors[error.code ?? error.message] ||
            error.message),
      );
      render();
      return false;
    }
  }
  render();
  return true;
}
