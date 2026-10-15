import { createHash } from 'node:crypto';
import { DomainError } from '../contracts/errors.ts';
import { RecordRefusal, type Records } from '../core/records.ts';
import { parseKakao } from '../core/import/kakao.ts';
import { parseMail } from '../core/import/mail.ts';
import {
  kakaoCandidates,
  mailCandidates,
  type ImportCandidate,
} from '../core/import/candidates.ts';

/**
 * 카카오톡·메일 가져오기 (PLAN-53 T-329·T-330, ARCH-01 §5 「프로젝트 기록」 '가져오기'):
 * `POST …/records/import-file {kind, name, text}` → candidate records (`type '?'`, by the
 * session's person), the original copied to `<ops>/기록/원문/` when the project has a work
 * folder. A file whose candidates are all held already changes nothing (RECORD_SOURCE_DUPLICATE
 * with the first one's record). The route itself is `records-routes.ts` (remote sessions read
 * only).
 */

export const RECORD_IMPORT_BYTES = 20 * 1024 * 1024;
export const RECORD_IMPORT_MAX = 20_000;
const EXTENSIONS = /\.(txt|eml|mbox)$/i;

export interface RecordsImportDeps {
  records: Records;
  /** `WorkspaceOutputs.writeRawCopy`; absent or null = not copied. */
  writeRawCopy?: (
    projectId: string,
    name: string,
    text: string,
  ) => Promise<{ path: string } | null>;
  now?: () => Date;
}

export interface RecordsImportResult {
  added: number;
  skipped: number;
  total: number;
  recordIds: string[];
  copied: boolean;
  path?: string;
}

/** The function the route calls: (project, request body, the person) → the answer. */
export function recordsImportOf(deps: RecordsImportDeps) {
  return async (projectId: string, input: unknown, by: string): Promise<RecordsImportResult> => {
    const body = (input ?? {}) as { kind?: unknown; name?: unknown; text?: unknown };
    const { kind, name, text } = body;
    if (kind !== 'kakao' && kind !== 'mail') throw new DomainError('INVALID_INPUT');
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || !EXTENSIONS.test(name))
      throw new DomainError('INVALID_INPUT');
    if (typeof text !== 'string') throw new DomainError('INVALID_INPUT');
    if (Buffer.byteLength(text, 'utf8') > RECORD_IMPORT_BYTES)
      throw new RecordRefusal('INPUT_TOO_LARGE', { limit: RECORD_IMPORT_BYTES });
    const clean = text.replace(/^\uFEFF/, '');
    const h16 = createHash('sha256').update(clean, 'utf8').digest('hex').slice(0, 16);
    const now = deps.now?.() ?? new Date();
    const parsed = kind === 'kakao' ? parseKakao(clean) : parseMail(clean, name.trim(), now);
    const make = (copyPath: string | null): ImportCandidate[] =>
      kind === 'kakao'
        ? kakaoCandidates(parsed as ReturnType<typeof parseKakao>, h16, copyPath)
        : mailCandidates(parsed as ReturnType<typeof parseMail>, h16, copyPath);
    let candidates = make(null);
    if (!candidates.length) throw new DomainError('INVALID_INPUT');
    if (candidates.length > RECORD_IMPORT_MAX)
      throw new RecordRefusal('INPUT_TOO_LARGE', { limit: RECORD_IMPORT_MAX });
    const held = deps.records.heldSourceKeys(
      projectId,
      candidates.map((candidate) => candidate.sourceKey),
    );
    if (candidates.every((candidate) => held.has(candidate.sourceKey)))
      throw new RecordRefusal('RECORD_SOURCE_DUPLICATE', {
        existingId: held.get(candidates[0]!.sourceKey)!,
      });
    const copy = deps.writeRawCopy
      ? await deps.writeRawCopy(projectId, name.trim(), clean).catch(() => null)
      : null;
    if (copy) candidates = make(copy.path);
    const { added, skipped } = deps.records.addMany(
      projectId,
      candidates.map(({ input: record, sourceKey }) => ({ input: record, sourceKey })),
      { by, state: 'candidate', source: kind },
    );
    return {
      added: added.length,
      skipped: skipped.length,
      total: candidates.length,
      recordIds: added,
      copied: Boolean(copy),
      ...(copy ? { path: copy.path } : {}),
    };
  };
}
