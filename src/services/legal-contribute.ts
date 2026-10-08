import { createHash } from 'node:crypto';
import type { ClawdeContributionRequest } from '../contracts/clawde.ts';
import { DomainError } from '../contracts/errors.ts';
import { legalContributeInputSchema, type LegalProfileSource } from '../contracts/legal.ts';
import type { Store } from '../core/store.ts';
import type { ClawdeClient } from './clawde.ts';
import type { LegalProfile } from './legal-profile.ts';
import type { ServiceSettings } from './settings.ts';

/**
 * 되돌려 보내기 VIDE → cLAWde (SPEC-13.10, OQ-17, ARCH-01 `POST /v1/contributions`, PLAN-46
 * T-224). Only what the user confirmed may go, item by item: user-confirmed profile values (the
 * answers to 되묻기 are stored as such). Assumptions, AI estimates, service and model values are
 * listed greyed and refused when asked for. Nothing is ticked by default: the caller names every
 * key. The idempotency key is derived from the project and the exact items, so sending the same
 * selection again is received once. Accepted items are recorded with the receipt
 * (`legal_contributions`) and show '보냄' until their value changes; rejected ones come back with
 * the service's reason. An unreachable service records nothing and nothing is queued to resend.
 */

type Scalar = string | number | boolean;
/** Why an item cannot be chosen; absent when it can. */
export type ContributeBlock = 'assumed' | 'ai' | 'service' | 'model' | 'excluded' | 'sent';

export interface ContributeItem {
  key: string;
  label?: string;
  value: Scalar;
  unit?: string;
  source: LegalProfileSource;
  selectable: boolean;
  blocked?: ContributeBlock;
  /** The same value already went: when and under which receipt. */
  sent: { receiptId: string; sentAt: string } | null;
}

export interface ContributeResult {
  receiptId: string;
  accepted: string[];
  rejected: { key: string; label?: string; reason: string }[];
  items: ContributeItem[];
}

const blockOf: Partial<Record<LegalProfileSource, ContributeBlock>> = {
  assumed: 'assumed',
  ai: 'ai',
  service: 'service',
  model: 'model',
};

const valueHash = (value: Scalar, unit: string | undefined) =>
  createHash('sha256')
    .update(JSON.stringify({ value, unit: unit ?? null }))
    .digest('hex');

export class LegalContributions {
  private readonly store: Store;
  private readonly client: ClawdeClient;
  private readonly settings: ServiceSettings;
  private readonly profile: LegalProfile;
  private readonly labels: () => Record<string, string>;
  private readonly now: () => Date;
  constructor({
    store,
    client,
    settings,
    profile,
    labels = () => ({}),
    now = () => new Date(),
  }: {
    store: Store;
    client: ClawdeClient;
    settings: ServiceSettings;
    profile: LegalProfile;
    labels?: () => Record<string, string>;
    now?: () => Date;
  }) {
    this.store = store;
    this.client = client;
    this.settings = settings;
    this.profile = profile;
    this.labels = labels;
    this.now = now;
  }
  private sentRows(projectId: string) {
    this.store.project(projectId);
    const rows = this.store
      .db(projectId)
      .prepare(
        'SELECT key, value_hash, receipt_id, sent_at FROM legal_contributions WHERE projectId=?',
      )
      .all(projectId) as { key: string; value_hash: string; receipt_id: string; sent_at: string }[];
    return new Map(rows.map((row) => [`${row.key}\n${row.value_hash}`, row]));
  }
  /** The [cLAWde로 보내기] list: every profile value with whether it may be chosen and why not. */
  view(projectId: string): ContributeItem[] {
    const sent = this.sentRows(projectId);
    return this.profile.items(projectId, this.labels()).map((item) => {
      const row = sent.get(`${item.key}\n${valueHash(item.value, item.unit)}`);
      const blocked: ContributeBlock | undefined =
        blockOf[item.source] ?? (item.excluded ? 'excluded' : row ? 'sent' : undefined);
      return {
        key: item.key,
        ...(item.label ? { label: item.label } : {}),
        value: item.value,
        ...(item.unit ? { unit: item.unit } : {}),
        source: item.source,
        selectable: !blocked,
        ...(blocked ? { blocked } : {}),
        sent: row ? { receiptId: row.receipt_id, sentAt: row.sent_at } : null,
      };
    });
  }
  /**
   * [보내기]: exactly the ticked keys, in one request. A key that cannot be chosen (assumption, AI
   * estimate, service or model value, left out, already sent, unknown) refuses the whole send
   * with LEGAL_NOT_CONTRIBUTABLE before anything goes.
   */
  async send(projectId: string, input: unknown): Promise<ContributeResult> {
    const { keys } = legalContributeInputSchema.parse(input);
    if (await this.settings.projectOff(projectId)) throw new DomainError('LEGAL_PROJECT_OFF');
    if (!(await this.settings.ready())) throw new DomainError('SERVICE_NOT_CONNECTED');
    // The service does not take contributions yet (PLAN-48 T-240): nothing goes.
    if (!this.settings.features().contribute) throw new DomainError('SERVICE_NOT_IMPLEMENTED');
    const listed = new Map(this.view(projectId).map((item) => [item.key, item]));
    const chosen = [...new Set(keys)].map((key) => listed.get(key));
    if (chosen.some((item) => !item?.selectable)) throw new DomainError('LEGAL_NOT_CONTRIBUTABLE');
    const updated = new Map(
      this.profile.items(projectId).map((item) => [item.key, item.updatedAt]),
    );
    const items = (chosen as ContributeItem[])
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((item) => ({
        key: item.key,
        value: item.value,
        ...(item.unit ? { unit: item.unit } : {}),
        basis: 'user',
        confirmedAt: updated.get(item.key)!,
      }));
    const request: ClawdeContributionRequest = {
      projectRef: projectRef(projectId),
      idempotencyKey: createHash('sha256')
        .update(JSON.stringify({ projectId, items }))
        .digest('hex'),
      items,
    };
    const receipt = await this.client.contribute(request);
    const at = this.now().toISOString();
    const db = this.store.db(projectId);
    const record = db.prepare(
      'INSERT INTO legal_contributions(projectId,key,value_hash,receipt_id,sent_at) VALUES(?,?,?,?,?) ON CONFLICT(projectId,key,value_hash) DO NOTHING',
    );
    const asked = new Map(items.map((item) => [item.key, item]));
    const accepted = receipt.accepted.filter((key) => asked.has(key));
    this.store.tx(db, () => {
      for (const key of accepted) {
        const item = asked.get(key)!;
        record.run(projectId, key, valueHash(item.value, item.unit), receipt.receiptId, at);
      }
    });
    const labels = this.labels();
    return {
      receiptId: receipt.receiptId,
      accepted,
      rejected: receipt.rejected
        .filter((entry) => asked.has(entry.key))
        .map((entry) => ({
          key: entry.key,
          ...(labels[entry.key] ? { label: labels[entry.key] } : {}),
          reason: entry.reason,
        })),
      items: this.view(projectId),
    };
  }
}

/** The project as the service knows it: a hash of the id, never its name or folder. */
export const projectRef = (projectId: string) =>
  'vide:' + createHash('sha256').update(projectId).digest('hex').slice(0, 32);
