import { createHash } from 'node:crypto';
import type { Records } from '../core/records.ts';
import { RECORD_ORIGINALS, type RecordRow } from '../contracts/records.ts';

// 거른 기록 on the account site (PLAN-53 T-336, SPEC-17.6, ARCH-01 §5 「사이트 사본」). This is the
// one place that decides what leaves this PC: kept records that no correction replaced, minus what
// came from KakaoTalk or mail (kept or not, with its originals), and of each only the date, type,
// text, part names and chapter. Candidates, dropped records, attachments, authors, source keys and
// imported originals never go up (ADR-037 4).

/** One record as the site keeps it. */
export interface SharedRecord {
  id: string;
  date: string;
  type: string;
  text: string;
  /** Part names (부위 사전), not ids. */
  parts: string[];
  chapter: string | null;
  updatedAt: string;
}

const ORIGINALS = `${RECORD_ORIGINALS.join('/')}/`;

/** Whether a kept record may leave this PC. */
export function shareable(record: RecordRow): boolean {
  if (record.state !== 'kept' || record.supersededBy) return false;
  if (record.source === 'kakao' || record.source === 'mail') return false;
  const { mail, file } = record.attachments;
  if (mail) return false;
  // A correction of an import is 'manual' but keeps the original's file attachment.
  if (file && file.path.replaceAll('\\', '/').includes(ORIGINALS)) return false;
  return true;
}

/** The project's records for the site, and their fingerprint (SHA-256 of the list). */
export function recordsShare(
  records: Pick<Records, 'list' | 'parts'>,
  projectId: string,
): { key: string; items: SharedRecord[] } {
  const names = new Map(records.parts(projectId).map((part) => [part.id, part.name]));
  const items = records
    .list(projectId, { state: ['kept'] })
    .records.filter(shareable)
    .map((record) => ({
      id: record.id,
      date: record.date,
      type: record.type,
      text: record.text,
      parts: record.parts.flatMap((id) => {
        const name = names.get(id);
        return name ? [name] : [];
      }),
      chapter: record.chapter,
      updatedAt: record.updatedAt,
    }));
  const key = createHash('sha256').update(JSON.stringify(items)).digest('hex');
  return { key, items };
}

const BATCH_ITEMS = 500;
const BATCH_BYTES = 900 * 1024;

/** Parts of at most 500 records and about 900 KB of JSON; never empty (none is one empty part). */
export function recordBatches(items: SharedRecord[]): SharedRecord[][] {
  const batches: SharedRecord[][] = [];
  let current: SharedRecord[] = [],
    bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (current.length && (current.length >= BATCH_ITEMS || bytes + size > BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  batches.push(current);
  return batches;
}
