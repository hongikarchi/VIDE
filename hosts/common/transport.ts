import { createConnection } from 'node:net';

/**
 * The one host transport cap kept (ADR-031 7): a frame either way is at most 16 MB, so a corrupt
 * length never allocates gigabytes. Reads are paged below it; one object larger than a frame comes
 * back as its bounding box (`oversized`), never as a failed Sync.
 */
export const HOST_FRAME_BYTES = 16 * 1024 * 1024;
/** Long host work (a Sync page, an execution): generous, it only ends a lost call (ADR-031 7). */
export const HOST_CALL_MS = 600_000;

export interface HostTransportOptions {
  port: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  beforeSend?: () => unknown | Promise<unknown>;
}

/** Shared framed loopback transport. Never retry writes after an ambiguous disconnect. */
export function sendHostCommand(
  type: string,
  params: Record<string, unknown>,
  {
    port,
    timeoutMs = 30000,
    maxResponseBytes = HOST_FRAME_BYTES,
    beforeSend,
  }: HostTransportOptions,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const responseHeader = Buffer.alloc(4);
    let headerBytes = 0,
      bodyBytes = 0,
      body: Buffer | undefined,
      finished = false,
      sent = false;
    const finish = (error: unknown, value?: unknown) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const fail = (code: string) => finish(Object.assign(new Error(code), { code }));
    socket.setTimeout(timeoutMs, () => fail(sent ? 'HOST_RESULT_UNKNOWN' : 'HOST_UNAVAILABLE'));
    socket.on('error', () => fail(sent ? 'HOST_RESULT_UNKNOWN' : 'HOST_UNAVAILABLE'));
    socket.on('end', () => {
      if (!finished) fail('HOST_RESULT_UNKNOWN');
    });
    socket.on('connect', async () => {
      // New execution paths verify ownership on this connection before sending any bytes.
      try {
        await beforeSend?.();
      } catch (error) {
        finish(error);
        return;
      }
      if (finished) return;
      const data = Buffer.from(JSON.stringify({ type, params })),
        header = Buffer.alloc(4);
      // Nothing was sent yet, so this fails cleanly instead of leaving the result unknown.
      if (data.length > HOST_FRAME_BYTES) return fail('HOST_REQUEST_TOO_LARGE');
      header.writeUInt32BE(data.length);
      sent = true;
      socket.write(Buffer.concat([header, data]));
    });
    socket.on('data', (chunk) => {
      if (finished) return;
      if (!sent) return fail('HOST_INVALID_RESPONSE');
      let offset = 0;
      if (headerBytes < 4) {
        const count = Math.min(4 - headerBytes, chunk.length);
        chunk.copy(responseHeader, headerBytes, 0, count);
        headerBytes += count;
        offset += count;
        if (headerBytes < 4) return;
        const length = responseHeader.readUInt32BE();
        if (length < 1) return fail('HOST_INVALID_RESPONSE');
        if (length > maxResponseBytes)
          return finish(
            Object.assign(new Error('HOST_RESPONSE_TOO_LARGE'), {
              code: 'HOST_RESPONSE_TOO_LARGE',
              responseBytes: length,
            }),
          );
        body = Buffer.allocUnsafe(length);
      }
      const buffer = body!;
      const count = Math.min(buffer.length - bodyBytes, chunk.length - offset);
      chunk.copy(buffer, bodyBytes, offset, offset + count);
      bodyBytes += count;
      if (bodyBytes < buffer.length) return;
      try {
        const response = JSON.parse(buffer.toString('utf8'));
        if (response.status === 'error') return fail('HOST_REJECTED');
        finish(null, response.result ?? response);
      } catch {
        fail('HOST_INVALID_RESPONSE');
      }
    });
  });
}
