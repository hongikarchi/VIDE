import { createHash } from 'node:crypto';
import {
  clawdeStageIdSchema,
  type ClawdeChecklist,
  type ClawdeProfile,
  type ClawdeStageId,
} from '../contracts/clawde.ts';
import { legalProfileUpdateSchema, type LegalProfileSource } from '../contracts/legal.ts';
import type { Store } from '../core/store.ts';
import { sentHash } from './legal-answers.ts';

/**
 * The project's legal profile (SPEC-13.3·13.4, ARCH-01 「저장」, PLAN-46 T-219): one value per key
 * with its source and version. A value the user set is '사용자 확정' and is never replaced by a
 * service or model value, which then only leaves a notice. AI-estimated values are never sent (they
 * show greyed in the send card). Items the user left out stay out for this project until put back.
 * The send list is what the next ask would carry; its hash is compared with the last confirmed one.
 */

type Scalar = string | number | boolean;
export interface LegalProfileItem {
  key: string;
  label?: string;
  value: Scalar;
  unit?: string;
  source: LegalProfileSource;
  version?: string;
  /** Left out of sending by the user (kept for the project). */
  excluded: boolean;
  /** A project statement the value rests on (shown, never sent). */
  basis?: string;
  /**
   * Another source's different value for a user-confirmed key: shown, not applied. With
   * `replaced`, the earlier value of the same source that a newer one replaced (the site model was
   * computed again, SPEC-13.8): shown once as '바뀐 값'.
   */
  notice?: {
    value: Scalar;
    unit?: string;
    source: LegalProfileSource;
    version?: string;
    at: string;
    replaced?: boolean;
  };
  updatedAt: string;
}

/** One row of the '보낼 정보' card. */
export interface LegalSendItem {
  key: string;
  label?: string;
  value: Scalar;
  unit?: string;
  source: LegalProfileSource;
  version?: string;
  /** False for AI-estimated values: shown greyed, never sent. */
  selectable: boolean;
  excluded: boolean;
}

interface Row {
  key: string;
  value_json: string | null;
  unit: string | null;
  source: string;
  version: string | null;
  excluded: number;
  basis: string | null;
  notice_json: string | null;
  updated_at: string;
}

/** A stage checklist as received, with what was sent for it. */
export interface LegalChecklistCache {
  sentHash: string;
  fetchedAt: string;
  lawDbDate: string;
  items: ClawdeChecklist['items'];
}

const STAGE_KEY = 'vide:stage';
/** `vide:checklist:<stage>`: the last checklist of that stage (an engine state row, not sent). */
const CHECKLIST_KEY = 'vide:checklist:';
const CONFIRMED_KEY = 'vide:confirmed';
export const DEFAULT_STAGE: ClawdeStageId = 'scale-review';

export class LegalProfile {
  private readonly store: Store;
  private readonly now: () => Date;
  constructor(store: Store, { now = () => new Date() }: { now?: () => Date } = {}) {
    this.store = store;
    this.now = now;
  }
  private rows(projectId: string): Row[] {
    this.store.project(projectId);
    return this.store
      .db(projectId)
      .prepare('SELECT * FROM legal_profile WHERE projectId=? ORDER BY key')
      .all(projectId) as unknown as Row[];
  }
  private state(projectId: string, key: string): string | undefined {
    const row = this.rows(projectId).find((r) => r.key === key);
    return row?.value_json ? (JSON.parse(row.value_json) as string) : undefined;
  }
  private setState(projectId: string, key: string, value: string) {
    this.store
      .db(projectId)
      .prepare(
        "INSERT INTO legal_profile(projectId,key,value_json,source,updated_at) VALUES(?,?,?,'vide',?) ON CONFLICT(projectId,key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
      )
      .run(projectId, key, JSON.stringify(value), this.now().toISOString());
  }
  items(projectId: string, labels: Record<string, string> = {}): LegalProfileItem[] {
    return this.rows(projectId)
      .filter((row) => !row.key.startsWith('vide:') && row.value_json !== null)
      .map((row) => ({
        key: row.key,
        ...(labels[row.key] ? { label: labels[row.key] } : {}),
        value: JSON.parse(row.value_json!) as Scalar,
        ...(row.unit ? { unit: row.unit } : {}),
        source: row.source as LegalProfileSource,
        ...(row.version ? { version: row.version } : {}),
        excluded: !!row.excluded,
        ...(row.basis ? { basis: row.basis } : {}),
        ...(row.notice_json ? { notice: JSON.parse(row.notice_json) } : {}),
        updatedAt: row.updated_at,
      }));
  }
  /** The chosen design stage (규모검토 by default). */
  stage(projectId: string): ClawdeStageId {
    const parsed = clawdeStageIdSchema.safeParse(this.state(projectId, STAGE_KEY));
    return parsed.success ? parsed.data : DEFAULT_STAGE;
  }
  confirmedHash(projectId: string) {
    return this.state(projectId, CONFIRMED_KEY);
  }
  setConfirmed(projectId: string, hash: string) {
    this.setState(projectId, CONFIRMED_KEY, hash);
  }
  /** The last stage checklist received for `stage` (SPEC-13.9: kept for offline display). */
  checklist(projectId: string, stage: ClawdeStageId): LegalChecklistCache | undefined {
    const raw = this.state(projectId, `${CHECKLIST_KEY}${stage}`);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as LegalChecklistCache;
    } catch {
      return undefined;
    }
  }
  saveChecklist(projectId: string, stage: ClawdeStageId, cache: LegalChecklistCache) {
    this.setState(projectId, `${CHECKLIST_KEY}${stage}`, JSON.stringify(cache));
  }

  /**
   * `PUT …/legal/profile`: the user's values (source 'user', a notice is cleared), removals,
   * exclusions and the stage. Returns the keys whose value changed (their answers go stale).
   */
  update(projectId: string, input: unknown): string[] {
    const { values = {}, exclude = {}, stage, answered } = legalProfileUpdateSchema.parse(input);
    this.store.project(projectId);
    const db = this.store.db(projectId);
    const at = this.now().toISOString();
    const existing = new Map(this.rows(projectId).map((r) => [r.key, r]));
    const changed: string[] = [];
    this.store.tx(db, () => {
      for (const [key, entry] of Object.entries(values)) {
        const old = existing.get(key);
        if (entry === null) {
          if (old) {
            db.prepare('DELETE FROM legal_profile WHERE projectId=? AND key=?').run(projectId, key);
            changed.push(key);
          }
          continue;
        }
        const valueJson = JSON.stringify(entry.value);
        const source = entry.assumed ? 'assumed' : 'user';
        if (
          old?.value_json !== valueJson ||
          (old?.unit ?? undefined) !== entry.unit ||
          old?.source !== source
        )
          changed.push(key);
        // An answer to a back-question goes out even if the key was left out before.
        db.prepare(
          'INSERT INTO legal_profile(projectId,key,value_json,unit,source,version,excluded,basis,notice_json,updated_at) VALUES(?,?,?,?,?,NULL,?,?,NULL,?) ON CONFLICT(projectId,key) DO UPDATE SET value_json=excluded.value_json, unit=excluded.unit, source=excluded.source, version=NULL, excluded=excluded.excluded, notice_json=NULL, updated_at=excluded.updated_at',
        ).run(
          projectId,
          key,
          valueJson,
          entry.unit ?? null,
          source,
          answered ? 0 : (old?.excluded ?? 0),
          old?.basis ?? null,
          at,
        );
      }
      const mark = db.prepare(
        'UPDATE legal_profile SET excluded=?, updated_at=? WHERE projectId=? AND key=?',
      );
      for (const [key, off] of Object.entries(exclude)) mark.run(off ? 1 : 0, at, projectId, key);
      if (stage) this.setState(projectId, STAGE_KEY, stage);
    });
    return changed;
  }

  /**
   * A value from the service, the model or an AI estimate (SPEC-13.4). A user-confirmed key keeps
   * its value and gets a notice when the offered value differs. Returns whether the value changed.
   */
  offer(
    projectId: string,
    key: string,
    offered: {
      value: Scalar;
      unit?: string;
      source: Exclude<LegalProfileSource, 'user'>;
      version?: string;
      basis?: string;
    },
  ): boolean {
    this.store.project(projectId);
    const db = this.store.db(projectId);
    const at = this.now().toISOString();
    const old = this.rows(projectId).find((r) => r.key === key);
    const valueJson = JSON.stringify(offered.value);
    if (old?.source === 'user') {
      const same = old.value_json === valueJson && (old.unit ?? undefined) === offered.unit;
      db.prepare('UPDATE legal_profile SET notice_json=? WHERE projectId=? AND key=?').run(
        same ? null : JSON.stringify({ ...offered, basis: undefined, at }),
        projectId,
        key,
      );
      return false;
    }
    const changed = old?.value_json !== valueJson || (old?.unit ?? undefined) !== offered.unit;
    // Nothing new: the row (and a notice it shows) stays as it is.
    if (
      old &&
      !changed &&
      old.source === offered.source &&
      old.version === (offered.version ?? null)
    )
      return false;
    // The same source gave another value before: that earlier value stays visible as '바뀐 값'.
    const replaced =
      old && changed && old.source === offered.source && old.value_json !== null
        ? JSON.stringify({
            value: JSON.parse(old.value_json),
            ...(old.unit ? { unit: old.unit } : {}),
            source: old.source,
            ...(old.version ? { version: old.version } : {}),
            at,
            replaced: true,
          })
        : null;
    db.prepare(
      'INSERT INTO legal_profile(projectId,key,value_json,unit,source,version,excluded,basis,notice_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(projectId,key) DO UPDATE SET value_json=excluded.value_json, unit=excluded.unit, source=excluded.source, version=excluded.version, basis=excluded.basis, notice_json=excluded.notice_json, updated_at=excluded.updated_at',
    ).run(
      projectId,
      key,
      valueJson,
      offered.unit ?? null,
      offered.source,
      offered.version ?? null,
      old?.excluded ?? 0,
      offered.basis ?? null,
      replaced,
      at,
    );
    return changed;
  }

  /** What the next ask carries: selectable, not excluded values, as the service's profile shape. */
  payload(projectId: string): { profile: ClawdeProfile; hash: string } {
    const profile: ClawdeProfile = {};
    for (const item of this.items(projectId)) {
      if (item.source === 'ai' || item.excluded) continue;
      profile[item.key] = {
        value: item.value,
        ...(item.unit ? { unit: item.unit } : {}),
        source: item.source,
        ...(item.version ? { version: item.version } : {}),
      };
    }
    return { profile, hash: sentHash({ profile }) };
  }

  /** The '보낼 정보' card: every item with what would be sent, and the hash that confirms it. */
  candidates(
    projectId: string,
    labels: Record<string, string> = {},
  ): { items: LegalSendItem[]; hash: string } {
    const items = this.items(projectId, labels).map((item) => ({
      key: item.key,
      ...(item.label ? { label: item.label } : {}),
      value: item.value,
      ...(item.unit ? { unit: item.unit } : {}),
      source: item.source,
      ...(item.version ? { version: item.version } : {}),
      selectable: item.source !== 'ai',
      excluded: item.source === 'ai' || item.excluded,
    }));
    const hash = createHash('sha256')
      .update(JSON.stringify(items.map(({ label: _label, ...rest }) => rest)))
      .digest('hex');
    return { items, hash };
  }

  /** The card's [보내기]: `exclude` is the final list of left-out keys among the selectable ones. */
  applyExclusions(projectId: string, exclude: string[]) {
    const off = new Set(exclude);
    const items = this.items(projectId).filter((item) => item.source !== 'ai');
    this.update(projectId, {
      exclude: Object.fromEntries(items.map((item) => [item.key, off.has(item.key)])),
    });
  }
}
