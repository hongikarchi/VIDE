import { requestInputSchema } from '../contracts/workspace.ts';
import type { RequestInput } from '../contracts/workspace.ts';
import { DomainError } from './store.ts';

export function interventionInput(original: RequestInput, value: unknown): RequestInput {
  const parsed = requestInputSchema.safeParse(value);
  if (!parsed.success) throw new DomainError('INVALID_INPUT');
  const next = parsed.data;
  if (
    next.supersedesRequestId !== undefined ||
    next.parentRequestId !== undefined ||
    next.provider === 'extension' ||
    next.accountProfileId !== undefined ||
    (original.accountProfileId !== undefined && next.provider !== original.provider)
  )
    throw new DomainError('INVALID_INPUT');
  if (
    (original.host || 'rhino') !== (next.host || 'rhino') ||
    original.permission !== next.permission ||
    (original.baseRequestId ?? null) !== (next.baseRequestId ?? null) ||
    JSON.stringify(original.linkedTargets) !== JSON.stringify(next.linkedTargets)
  )
    throw new DomainError('TARGET_MISMATCH');
  const merged = <T>(a: T[], b: T[]) => [
    ...new Map([...a, ...b].map((item) => [JSON.stringify(item), item])).values(),
  ];
  const pins = merged(original.pins, next.pins);
  const roles = new Map<string, unknown>();
  for (const pin of pins) {
    if (!pin || typeof pin !== 'object' || !('basis' in pin) || !('id' in pin) || !('role' in pin))
      throw new DomainError('STALE_REFERENCE');
    const key = JSON.stringify([pin.basis, pin.id]);
    if (roles.has(key) && roles.get(key) !== pin.role) throw new DomainError('REVISION_CONFLICT');
    roles.set(key, pin.role);
  }
  const result = requestInputSchema.safeParse({
    ...next,
    executionLimits: next.executionLimits ?? original.executionLimits,
    ...(original.accountProfileId ? { accountProfileId: original.accountProfileId } : {}),
    body: `${original.body}\n\n[추가 지시]\n${next.body}`,
    pins,
    sketches: merged(original.sketches, next.sketches),
    files: merged(original.files, next.files),
    supersedesRequestId: original.id,
    interventionInput: value,
  });
  if (!result.success) throw new DomainError('INPUT_TOO_LARGE');
  return result.data;
}
