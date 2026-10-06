import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as sync from 'y-protocols/sync';

/**
 * The note sync protocol (ADR-034, ARCH-01 §6 「공유 노트」): the y-websocket message format.
 * A message is `varUint type` + body: 0 = Yjs sync (step 1 state vector, step 2 missing updates,
 * update), 1 = awareness (cursors and who is here). The same messages travel over the site's
 * WebSocket (browser ↔ Durable Object, PC engine ↔ Durable Object) and, base64-encoded, over the
 * PC's local stream (PC screen ↔ engine).
 */
export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;

export function syncStep1(doc: Y.Doc) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_SYNC);
  sync.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}
export function syncStep2(doc: Y.Doc, stateVector?: Uint8Array) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_SYNC);
  sync.writeSyncStep2(encoder, doc, stateVector);
  return encoding.toUint8Array(encoder);
}
export function updateMessage(update: Uint8Array) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_SYNC);
  sync.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}
export function awarenessMessage(update: Uint8Array) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_AWARENESS);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}
/**
 * Reads one message into `doc` (origin `origin`). Returns the reply to send (sync step 2 for a
 * step 1), whether it was a step 2, and the awareness update it carried.
 */
export function readMessage(doc: Y.Doc, message: Uint8Array, origin: unknown) {
  const decoder = decoding.createDecoder(message);
  const type = decoding.readVarUint(decoder);
  if (type === MSG_SYNC) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    const kind = sync.readSyncMessage(decoder, encoder, doc, origin);
    return {
      reply: encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : undefined,
      step2: kind === sync.messageYjsSyncStep2,
      step1: kind === sync.messageYjsSyncStep1,
    };
  }
  if (type === MSG_AWARENESS) return { awareness: decoding.readVarUint8Array(decoder) };
  return {};
}

export const toBase64 = (bytes: Uint8Array) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
export const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
