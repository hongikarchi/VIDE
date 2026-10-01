// What the reference tab (src/ui/reference-tab.tsx) needs from the main page (app.ts): the AI the
// next turn goes to, a capture of the 3D view, and sending a turn the way the composer does (so it
// shows in the AI column and follows the composer's document). app.ts sets it once and calls
// `notifyReference()` when the composer's model or conversation changes.
import type { ReferenceRequest } from '../contracts/reference-board.ts';

export interface ReferenceAi {
  provider: string;
  model: string;
  name: string;
  /** The model reads images (SPEC-09.3 6). */
  images: boolean;
}
export interface ReferenceSend {
  reference: ReferenceRequest;
  /** Images the turn shows the model (PNG/JPEG data URLs of at most 1 MB). */
  images?: { kind: 'reference'; name: string; dataUrl: string }[];
  /** Stored attachments the turn may read (`attachment_read`). */
  files?: { id: string; name: string }[];
}
export interface ReferenceBridge {
  /** The composer's AI (the chosen conversation's fixed one); undefined before models load. */
  ai(): ReferenceAi | undefined;
  /** The 3D view as a JPEG data URL, or undefined when nothing is shown. */
  capture(): string | undefined;
  /** Sends a reference turn; resolves with the stored request. */
  send(turn: ReferenceSend): Promise<{ id: string; input: Record<string, unknown> }>;
}

let bridge: ReferenceBridge | undefined;
const listeners = new Set<() => void>();
export function setReferenceBridge(value: ReferenceBridge) {
  bridge = value;
  notifyReference();
}
export const referenceBridge = () => bridge;
export function notifyReference() {
  for (const listener of listeners) listener();
}
export function onReferenceBridge(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
