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
