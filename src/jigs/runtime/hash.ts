// Deterministic hashing for cache keys, snapshots and package digests (ARCH-03 §6.3, §12).

import { createHash } from 'node:crypto';

/** JSON with sorted object keys, so equal values hash equal. Non-finite numbers become null. */
export function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => JSON.stringify(key) + ':' + canonical(record[key]))
        .join(',') +
      '}'
    );
  }
  return 'null';
}
export const sha256 = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
export const hashValue = (value: unknown) => sha256(canonical(value));
/**
 * `hashValue` of a large value (a kept model with meshes) without holding the event loop: the same
 * canonical text fed to the hash part by part, giving the loop back every ~`sliceMs` (T-274). The
 * digest is identical to `hashValue(value)`.
 */
export async function hashValueAsync(value: unknown, sliceMs = 50): Promise<string> {
  const hash = createHash('sha256');
  let start = performance.now();
  const pace = async () => {
    if (performance.now() - start < sliceMs) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    start = performance.now();
  };
  // Containers down to depth 3 (model → objects → object → field) are walked; below that each
  // part is one `canonical` call.
  const walk = async (part: unknown, depth: number): Promise<void> => {
    if (depth >= 3 || part === null || typeof part !== 'object') {
      hash.update(canonical(part));
      return pace();
    }
    if (Array.isArray(part)) {
      hash.update('[');
      for (let i = 0; i < part.length; i++) {
        if (i) hash.update(',');
        await walk(part[i], depth + 1);
      }
      hash.update(']');
      return;
    }
    const record = part as Record<string, unknown>;
    hash.update('{');
    let first = true;
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) continue;
      if (!first) hash.update(',');
      first = false;
      hash.update(JSON.stringify(key) + ':');
      await walk(record[key], depth + 1);
    }
    hash.update('}');
  };
  await walk(value, 0);
  return hash.digest('hex');
}
