import { randomUUID } from 'node:crypto';
import {
  complianceRoleRecordSchema,
  complianceRoleSchema,
  floorLabelSchema,
  roleProposalSchema,
  type ComplianceRoleName,
  type ComplianceRoleRecord,
  type RoleProposal,
} from '../contracts/compliance.ts';
import { DomainError } from '../contracts/errors.ts';
import type { Store } from '../core/store.ts';
import type { CheckedProposal } from '../jigs/official/compliance-kit/proposals.ts';

/**
 * The project's 법규 체크 classification (SPEC-15.4 3·4, ARCH-03 §8.6 「저장」, PLAN-48 T-237, schema
 * 16): records a person made or accepted, per linked document (`documentKey` = the Link id) and per
 * layer path or object id; the AI proposals with their state; and the classification version, one
 * up per change of the records (results read with an older version are '다시 체크 필요'). An AI
 * proposal never becomes a record by itself: only `decide(…, 'accept')` writes one, as
 * 'ai-accepted' — or 'person' when the person changed the role.
 */

export interface RoleSet {
  scope: 'layer' | 'object';
  key: string;
  role: ComplianceRoleName;
  floor?: string | null;
  use?: string | null;
}
export interface RolesView {
  records: ComplianceRoleRecord[];
  version: number;
  proposals: RoleProposal[];
}

interface RecordRow {
  documentKey: string;
  scope: 'layer' | 'object';
  key: string;
  role: string;
  floor: string | null;
  use: string | null;
  by: 'person' | 'ai-accepted';
  at: string;
  geometry_hash: string | null;
}
interface ProposalRow {
  id: string;
  documentKey: string;
  scope: 'layer' | 'group';
  layer: string;
  object_ids_json: string;
  hashes_json: string;
  role: string;
  floor: string | null;
  use: string | null;
  reason: string;
  state: 'proposed' | 'accepted' | 'rejected';
}

const toRecord = (row: RecordRow): ComplianceRoleRecord =>
  complianceRoleRecordSchema.parse({
    documentKey: row.documentKey,
    scope: row.scope,
    key: row.key,
    role: row.role,
    floor: row.floor,
    use: row.use,
    by: row.by,
    at: row.at,
    geometryHash: row.geometry_hash,
  });
const toProposal = (row: ProposalRow): RoleProposal =>
  roleProposalSchema.parse({
    id: row.id,
    scope: row.scope,
    layer: row.layer,
    objectIds: JSON.parse(row.object_ids_json),
    role: row.role,
    floor: row.floor,
    use: row.use,
    reason: row.reason,
    state: row.state,
  });

export class ComplianceRoles {
  private readonly store: Store;
  private readonly now: () => Date;
  constructor(store: Store, { now = () => new Date() }: { now?: () => Date } = {}) {
    this.store = store;
    this.now = now;
  }

  version(projectId: string): number {
    this.store.project(projectId);
    const row = this.store
      .db(projectId)
      .prepare('SELECT version FROM compliance_roles_version WHERE projectId=?')
      .get(projectId) as { version: number } | undefined;
    return row?.version ?? 0;
  }
  private bump(projectId: string) {
    this.store
      .db(projectId)
      .prepare(
        `INSERT INTO compliance_roles_version(projectId, version) VALUES(?, 1)
         ON CONFLICT(projectId) DO UPDATE SET version = version + 1`,
      )
      .run(projectId);
  }

  /** The records of one document (all documents when `documentKey` is omitted). */
  records(projectId: string, documentKey?: string): ComplianceRoleRecord[] {
    this.store.project(projectId);
    const db = this.store.db(projectId);
    const rows = (documentKey === undefined
      ? db
          .prepare(
            'SELECT * FROM compliance_roles WHERE projectId=? ORDER BY documentKey, scope, key',
          )
          .all(projectId)
      : db
          .prepare(
            'SELECT * FROM compliance_roles WHERE projectId=? AND documentKey=? ORDER BY scope, key',
          )
          .all(projectId, documentKey)) as unknown as RecordRow[];
    return rows.map(toRecord);
  }
  proposals(projectId: string, documentKey: string): RoleProposal[] {
    this.store.project(projectId);
    return (
      this.store
        .db(projectId)
        .prepare(
          'SELECT * FROM compliance_proposals WHERE projectId=? AND documentKey=? ORDER BY seq',
        )
        .all(projectId, documentKey) as unknown as ProposalRow[]
    ).map(toProposal);
  }
  view(projectId: string, documentKey: string): RolesView {
    return {
      records: this.records(projectId, documentKey),
      version: this.version(projectId),
      proposals: this.proposals(projectId, documentKey),
    };
  }

  /**
   * A person's records: `set` replaces the record of that scope and key, `remove` deletes it. An
   * object record keeps the object's geometry fingerprint (`hashes`) to show a later change.
   */
  setRecords(
    projectId: string,
    input: {
      documentKey: string;
      set: readonly RoleSet[];
      remove: readonly { scope: 'layer' | 'object'; key: string }[];
      hashes?: ReadonlyMap<string, string | null>;
    },
  ): RolesView {
    this.store.project(projectId);
    const db = this.store.db(projectId);
    const at = this.now().toISOString();
    this.store.tx(db, () => {
      let changed = false;
      for (const item of input.remove)
        changed =
          db
            .prepare(
              'DELETE FROM compliance_roles WHERE projectId=? AND documentKey=? AND scope=? AND key=?',
            )
            .run(projectId, input.documentKey, item.scope, keyOf(item.scope, item.key)).changes >
            0 || changed;
      for (const item of input.set) {
        this.write(db, projectId, input.documentKey, item, 'person', at, input.hashes);
        changed = true;
      }
      if (changed) this.bump(projectId);
    });
    return this.view(projectId, input.documentKey);
  }
  private write(
    db: ReturnType<Store['db']>,
    projectId: string,
    documentKey: string,
    item: RoleSet,
    by: 'person' | 'ai-accepted',
    at: string,
    hashes?: ReadonlyMap<string, string | null>,
  ) {
    const role = complianceRoleSchema.parse(item.role);
    const floor = item.floor ?? null;
    if (floor !== null && !floorLabelSchema.safeParse(floor).success)
      throw new DomainError('INVALID_INPUT');
    const key = keyOf(item.scope, item.key);
    const hash = item.scope === 'object' ? (hashes?.get(key) ?? null) : null;
    const record = complianceRoleRecordSchema.parse({
      documentKey,
      scope: item.scope,
      key,
      role,
      floor,
      use: item.use?.trim() ? item.use.trim().slice(0, 60) : null,
      by,
      at,
      geometryHash: hash,
    });
    db.prepare(
      `INSERT INTO compliance_roles(projectId, documentKey, scope, key, role, floor, use, by, at, geometry_hash)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(projectId, documentKey, scope, key) DO UPDATE SET role=excluded.role,
         floor=excluded.floor, use=excluded.use, by=excluded.by, at=excluded.at,
         geometry_hash=excluded.geometry_hash`,
    ).run(
      projectId,
      documentKey,
      record.scope,
      record.key,
      record.role,
      record.floor,
      record.use,
      record.by,
      record.at,
      record.geometryHash,
    );
  }

  /** Keep the AI proposals of one [역할 제안 받기]; earlier open proposals of the document go. */
  addProposals(
    projectId: string,
    documentKey: string,
    proposals: readonly CheckedProposal[],
    hashes: ReadonlyMap<string, string | null>,
  ): RoleProposal[] {
    this.store.project(projectId);
    const db = this.store.db(projectId);
    const at = this.now().toISOString();
    const ids: string[] = [];
    this.store.tx(db, () => {
      db.prepare(
        "DELETE FROM compliance_proposals WHERE projectId=? AND documentKey=? AND state='proposed'",
      ).run(projectId, documentKey);
      let seq = (
        db
          .prepare(
            'SELECT COALESCE(MAX(seq), 0) AS seq FROM compliance_proposals WHERE projectId=?',
          )
          .get(projectId) as { seq: number }
      ).seq;
      for (const p of proposals) {
        const id = randomUUID();
        ids.push(id);
        const objectIds = p.objectIds.map((o) => o.toLowerCase());
        db.prepare(
          `INSERT INTO compliance_proposals(projectId, id, documentKey, scope, layer, object_ids_json,
             hashes_json, role, floor, use, reason, state, created_at, seq)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,'proposed',?,?)`,
        ).run(
          projectId,
          id,
          documentKey,
          p.scope,
          p.layer,
          JSON.stringify(objectIds),
          JSON.stringify(Object.fromEntries(objectIds.map((o) => [o, hashes.get(o) ?? null]))),
          p.role,
          p.floor,
          p.use,
          p.reason,
          at,
          ++seq,
        );
      }
    });
    const kept = new Set(ids);
    return this.proposals(projectId, documentKey).filter((p) => kept.has(p.id));
  }

  /**
   * [받기] / [역할 바꾸기] / [버리기] of one proposal (SPEC-15.4 3). Accepting writes object records
   * for the objects the proposal named, less the ones taken out — also for a whole-layer proposal.
   */
  decide(
    projectId: string,
    proposalId: string,
    input: {
      action: 'accept' | 'reject';
      role?: ComplianceRoleName;
      floor?: string | null;
      use?: string | null;
      exclude?: readonly string[];
    },
  ): { proposal: RoleProposal; view: RolesView } {
    this.store.project(projectId);
    const db = this.store.db(projectId);
    const row = db
      .prepare('SELECT * FROM compliance_proposals WHERE projectId=? AND id=?')
      .get(projectId, proposalId) as unknown as ProposalRow | undefined;
    if (!row) throw new DomainError('NOT_FOUND');
    if (row.state !== 'proposed') throw new DomainError('REVISION_CONFLICT');
    const at = this.now().toISOString();
    this.store.tx(db, () => {
      if (input.action === 'reject') {
        db.prepare(
          "UPDATE compliance_proposals SET state='rejected' WHERE projectId=? AND id=?",
        ).run(projectId, proposalId);
        return;
      }
      const role = input.role ?? (row.role as ComplianceRoleName);
      // A person who changed the role decided it; otherwise the AI proposal was accepted.
      const by = role !== row.role ? 'person' : 'ai-accepted';
      const floor = input.floor === undefined ? row.floor : input.floor;
      const use = input.use === undefined ? row.use : input.use;
      const exclude = new Set((input.exclude ?? []).map((id) => id.toLowerCase()));
      const objectIds = (JSON.parse(row.object_ids_json) as string[]).filter(
        (id) => !exclude.has(id),
      );
      const hashes = new Map(
        Object.entries(JSON.parse(row.hashes_json) as Record<string, string | null>),
      );
      // Only the objects the proposal named (and the person saw counted) get a role — also for a
      // whole-layer proposal: a layer record would reach objects the AI never looked at (the
      // layer's sub-layers, other jigs' objects on it, objects drawn later). A layer record is
      // written only when a person sets it directly (`setRecords`, SPEC-15.4 3·4).
      for (const id of objectIds)
        this.write(
          db,
          projectId,
          row.documentKey,
          { scope: 'object', key: id, role, floor, use },
          by,
          at,
          hashes,
        );
      db.prepare("UPDATE compliance_proposals SET state='accepted' WHERE projectId=? AND id=?").run(
        projectId,
        proposalId,
      );
      this.bump(projectId);
    });
    const proposal = this.proposals(projectId, row.documentKey).find((p) => p.id === proposalId)!;
    return { proposal, view: this.view(projectId, row.documentKey) };
  }
}

/** Object ids are kept lower-case (Rhino GUIDs compare case-insensitively). */
const keyOf = (scope: 'layer' | 'object', key: string) =>
  scope === 'object' ? key.toLowerCase() : key;
