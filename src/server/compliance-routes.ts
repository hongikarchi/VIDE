// 법규 체크의 모델 읽기와 분류 경로 (SPEC-15.3·15.4·15.16, ARCH-03 §8.6, PLAN-48 T-237). The engine reads
// the linked Rhino document whole (jig input read, purpose 'check'), classifies its objects with the
// project's records and keeps the `ClassifiedModel` as the instance's `host-document` input; people
// set or remove records and take AI proposals one at a time. Remote sessions only read.
//
//   GET  /api/v1/projects/:id/compliance/roles?documentKey=      → {records, version, proposals}
//   PUT  …/compliance/roles {documentKey, set[], remove[], instanceId?} → same
//   POST …/compliance/read {instanceId, linkId?, key?, includeHidden?} → what the read classified
//   POST …/compliance/proposals {instanceId, key?}               → {proposals, rejected}
//   POST …/compliance/proposals/:pid {action, role?, floor?, use?, exclude?} → {proposal, …view}

import { z } from 'zod';
import {
  COMPLIANCE_ROLES,
  UNCLASSIFIED_REASONS,
  complianceLimitsSchema,
  complianceRoleSchema,
  floorLabelSchema,
  type ClassifiedModel,
  type ComplianceLimits,
} from '../contracts/compliance.ts';
import { DomainError } from '../core/store.ts';
import type { DocumentLinks } from '../core/document-links.ts';
import type { Workspace } from '../core/workspace.ts';
import { JigStore } from '../core/jig-store.ts';
import { layersOf, type ReadModel } from '../jigs/runtime/runtime.ts';
import { readClassifiedModel } from '../jigs/official/compliance-kit/read-model.ts';
import {
  checkComplianceRoles,
  complianceRolesRequest,
  unroledGroups,
} from '../jigs/official/compliance-kit/proposals.ts';
import type { ComplianceRoles } from '../services/compliance-roles.ts';
import { jigRuntimeFor, readForJig, type JigRouteContext } from './jig-routes.ts';

export const complianceStatuses: Record<string, number> = {
  HOST_NOT_CONNECTED: 409,
  COMPLIANCE_UNITS_UNKNOWN: 409,
  COMPLIANCE_NOT_READ: 409,
  AI_SEND_OFF: 409,
  COMPLIANCE_AI_UNAVAILABLE: 503,
};

export interface ComplianceRouteContext {
  workspace: Workspace;
  dataDirectory: string;
  body: () => Promise<Record<string, unknown>>;
  send: (status: number, data: unknown) => void;
  remote: boolean;
  roles: ComplianceRoles;
  links?: DocumentLinks;
  sdk?: JigRouteContext['sdk'];
  /**
   * Runs one AI prompt (the request body and its attached JSON) and returns the reply text; absent
   * when no AI is available on this PC. Never given coordinates (SPEC-15.4 1).
   */
  propose?: (request: ReturnType<typeof complianceRolesRequest>) => Promise<string>;
}

const id = z.string().min(1).max(200);
const key = z.string().min(1).max(800);
const floor = floorLabelSchema.nullable().optional();
const use = z.string().max(60).nullable().optional();
const putInput = z
  .object({
    documentKey: id,
    set: z
      .array(
        z
          .object({
            scope: z.enum(['layer', 'object']),
            key,
            role: complianceRoleSchema,
            floor,
            use,
          })
          .strict(),
      )
      .max(5000)
      .default([]),
    remove: z
      .array(z.object({ scope: z.enum(['layer', 'object']), key }).strict())
      .max(5000)
      .default([]),
    /** The instance whose last read gives object records their geometry fingerprint. */
    instanceId: id.optional(),
  })
  .strict();
const readInput = z
  .object({
    instanceId: id,
    linkId: id.optional(),
    key: z.string().max(100).optional(),
    includeHidden: z.boolean().optional(),
  })
  .strict();
const proposeInput = z.object({ instanceId: id, key: z.string().max(100).optional() }).strict();
const decideInput = z
  .object({
    action: z.enum(['accept', 'reject']),
    role: complianceRoleSchema.optional(),
    floor,
    use,
    exclude: z.array(z.string().uuid()).max(20000).optional(),
  })
  .strict();

/** The value a `jig-output` input gives (a producer's value, or `{source, value}`), as limits. */
export function limitsOf(value: unknown): ComplianceLimits | null {
  const direct = complianceLimitsSchema.safeParse(value);
  if (direct.success) return direct.data;
  const wrapped = value && typeof value === 'object' ? (value as { value?: unknown }).value : null;
  const inner = complianceLimitsSchema.safeParse(wrapped);
  return inner.success ? inner.data : null;
}

/** nativeId → geometryHash of every row of a read. */
function hashesOf(model: ReadModel | undefined): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const row of (model?.scene ?? []) as Record<string, unknown>[])
    if (typeof row.nativeId === 'string')
      out.set(
        row.nativeId.toLowerCase(),
        typeof row.geometryHash === 'string' ? row.geometryHash : null,
      );
  return out;
}

/** The counts the 분류 tab shows (same meaning as `ComplianceResult.classification`). */
export function classificationSummary(model: ClassifiedModel) {
  const byRole = Object.fromEntries(COMPLIANCE_ROLES.map((r) => [r, 0])) as Record<string, number>;
  for (const o of model.objects) byRole[o.role]++;
  const unusedByReason = Object.fromEntries(UNCLASSIFIED_REASONS.map((r) => [r, 0])) as Record<
    string,
    number
  >;
  for (const u of model.unclassified) unusedByReason[u.reason]++;
  return {
    byRole,
    unusedByReason,
    aiAccepted: model.objects.filter((o) => o.roleSource === 'ai-accepted').length,
    hiddenWithRole: model.objects.filter((o) => o.hidden).length,
    geometryChanged: model.objects.filter((o) => o.geometryChanged).length,
  };
}

export async function complianceRoutes(
  url: URL,
  method: string | undefined,
  ctx: ComplianceRouteContext,
) {
  const match =
    /^\/api\/v1\/projects\/([^/]+)\/compliance\/(roles|read|proposals)(?:\/([^/]+))?$/.exec(
      url.pathname,
    );
  if (!match) return false;
  const [, projectId, area, sub] = match;
  ctx.workspace.store.project(projectId);
  const { roles, send } = ctx;
  if (area === 'roles' && !sub && method === 'GET') {
    const documentKey = url.searchParams.get('documentKey');
    if (!documentKey) throw new DomainError('INVALID_INPUT');
    send(200, roles.view(projectId, documentKey));
    return true;
  }
  // Every other route changes the classification or reads the host: this PC only (SPEC-15.16).
  if (area === 'roles' && !sub && method === 'PUT') {
    if (ctx.remote) throw new DomainError('FORBIDDEN');
    const input = putInput.parse(await ctx.body());
    let hashes: Map<string, string | null> | undefined;
    if (input.instanceId) {
      const rt = runtimeOf(ctx);
      const kept = await keptDocument(ctx, projectId, input.instanceId);
      hashes = kept ? hashesOf(rt.readModel(input.instanceId, kept.readId).model) : undefined;
    }
    send(
      200,
      roles.setRecords(projectId, {
        documentKey: input.documentKey,
        set: input.set,
        remove: input.remove,
        hashes,
      }),
    );
    return true;
  }
  if (area === 'read' && !sub && method === 'POST') {
    if (ctx.remote) throw new DomainError('FORBIDDEN');
    send(200, await readForCheck(ctx, projectId, readInput.parse(await ctx.body())));
    return true;
  }
  if (area === 'proposals' && !sub && method === 'POST') {
    if (ctx.remote) throw new DomainError('FORBIDDEN');
    send(200, await propose(ctx, projectId, proposeInput.parse(await ctx.body())));
    return true;
  }
  if (area === 'proposals' && sub && method === 'POST') {
    if (ctx.remote) throw new DomainError('FORBIDDEN');
    const { proposal, view } = roles.decide(projectId, sub, decideInput.parse(await ctx.body()));
    send(200, { proposal, ...view });
    return true;
  }
  return false;
}

const runtimeOf = (ctx: ComplianceRouteContext) => jigRuntimeFor(ctx.workspace, ctx.dataDirectory);

async function documentInput(
  ctx: ComplianceRouteContext,
  projectId: string,
  instanceId: string,
  key?: string,
) {
  const inputs = await runtimeOf(ctx).inputsOf(projectId, instanceId);
  const input = inputs.find(
    (i) => i.kind === 'host-document' && (key === undefined || i.key === key),
  );
  if (!input) throw new DomainError('NOT_FOUND');
  return { input, inputs };
}
async function keptDocument(
  ctx: ComplianceRouteContext,
  projectId: string,
  instanceId: string,
  key?: string,
) {
  const { input } = await documentInput(ctx, projectId, instanceId, key);
  return runtimeOf(ctx).hostDocument(projectId, instanceId, input.key);
}

/**
 * [법규 체크]'s read (SPEC-15.3 1): the whole linked document (hidden objects too, to list the ones
 * that carry a role), a second read without hidden objects to know which are hidden, the records
 * of that document, and the massing frame and chosen alternative of the instance's limits input.
 * Unknown units never fail it (`toMeters: null`).
 */
export async function readForCheck(
  ctx: ComplianceRouteContext,
  projectId: string,
  input: z.infer<typeof readInput>,
) {
  const rt = runtimeOf(ctx);
  const { input: decl, inputs } = await documentInput(ctx, projectId, input.instanceId, input.key);
  // The massing work copy's limits: frame origin, the document it was read from, chosen alternative.
  const limitsDecl = inputs.find(
    (i) =>
      i.kind === 'jig-output' && i.from.jig === 'vide/buildable-mass' && i.from.output === 'limits',
  );
  const limits = limitsDecl
    ? limitsOf(await rt.jigOutputInput(projectId, input.instanceId, limitsDecl.key))
    : null;
  const instance = new JigStore(ctx.workspace.store).instance(projectId, input.instanceId);
  const params = ((instance.body as { params?: Record<string, { value?: unknown }> }).params ??
    {}) as Record<string, { value?: unknown }>;
  const includeHidden = input.includeHidden ?? params.includeHidden?.value === true;
  const previous = rt.hostDocument(projectId, input.instanceId, decl.key);
  const rhino = (ctx.links?.list(projectId) ?? []).filter((l) => l.host === 'rhino' && !l.hidden);
  const linkId =
    input.linkId ??
    limits?.frame.linkId ??
    previous?.linkId ??
    (rhino.length === 1 ? rhino[0].id : undefined);
  if (!linkId || !ctx.links || !ctx.sdk) throw new DomainError('HOST_NOT_CONNECTED');
  const link = ctx.links.get(projectId, linkId);
  if (link.host !== 'rhino') throw new DomainError('INVALID_INPUT');
  const reader = { workspace: ctx.workspace, links: ctx.links, sdk: ctx.sdk };
  const full = await readForJig(reader, projectId, { linkId, layers: [], includeHidden: true });
  const shown = await readForJig(reader, projectId, { linkId, layers: [], includeHidden: false });
  const visible = new Set(
    ((shown.model.scene ?? []) as Record<string, unknown>[]).map((row) =>
      String(row.nativeId).toLowerCase(),
    ),
  );
  const hiddenIds = ((full.model.scene ?? []) as Record<string, unknown>[])
    .map((row) => String(row.nativeId))
    .filter((nativeId) => !visible.has(nativeId.toLowerCase()));
  const record = rt.recordRead(projectId, input.instanceId, {
    linkId: full.linkId,
    revisionKey: full.revisionKey,
    layers: [],
    includeHidden: true,
    purpose: 'check',
    model: full.model,
  });
  const documentKey = full.linkId;
  const rolesVersion = ctx.roles.version(projectId);
  const source = (full.model.sourceDocument ?? {}) as { units?: unknown };
  const out = readClassifiedModel({
    rows: (full.model.scene ?? []) as Record<string, unknown>[],
    layers: Array.isArray(full.model.layers)
      ? (full.model.layers as { fullPath: string; visible: boolean }[])
      : undefined,
    hiddenIds,
    source: {
      linkId: full.linkId,
      documentKey,
      readId: record.id,
      revisionKey: full.revisionKey,
      readAt: record.at,
    },
    units: source.units,
    origin: limits?.frame.origin ?? [0, 0, 0],
    records: ctx.roles.records(projectId, documentKey),
    rolesVersion,
    chosenOption: limits?.plan.chosenOption ?? null,
    includeHidden,
  });
  await rt.setHostDocument(projectId, input.instanceId, decl.key, {
    model: out.model,
    readId: record.id,
    linkId: full.linkId,
    revisionKey: full.revisionKey,
    rolesVersion,
  });
  return {
    readId: record.id,
    linkId: full.linkId,
    documentKey,
    revisionKey: full.revisionKey,
    readAt: record.at,
    toMeters: out.model.source.toMeters,
    rolesVersion,
    objects: out.model.objects.length,
    unclassified: out.model.unclassified.length,
    ...classificationSummary(out.model),
    /** Object records whose object is no longer in the document ('모델에 없음'). */
    missingRecords: out.missingRecords,
    notes: [...out.notes, ...(limits ? [] : ['매스 작업본의 한계가 없어 문서 좌표 그대로 읽음'])],
    /** The objects with a role or why not (for the 분류 tab; shapes left out). */
    rows: [
      ...out.model.objects.map((o) => ({
        objectId: o.objectId,
        layer: o.layer,
        role: o.role,
        roleSource: o.roleSource,
        floor: o.floor,
        use: o.use,
        hidden: o.hidden,
        geometryChanged: o.geometryChanged,
        reason: null,
      })),
      ...out.model.unclassified.map((u) => ({
        objectId: u.objectId,
        layer: u.layer,
        role: u.role,
        roleSource: null,
        floor: null,
        use: null,
        hidden: false,
        geometryChanged: false,
        reason: u.reason,
      })),
    ],
  };
}

/** [역할 제안 받기] (SPEC-15.4 1~2): one AI run over the group summaries of the last read. */
async function propose(
  ctx: ComplianceRouteContext,
  projectId: string,
  input: z.infer<typeof proposeInput>,
) {
  const kept = await keptDocument(ctx, projectId, input.instanceId, input.key);
  if (!kept) throw new DomainError('COMPLIANCE_NOT_READ');
  const model = kept.model as ClassifiedModel;
  if (model.source.toMeters === null) throw new DomainError('COMPLIANCE_UNITS_UNKNOWN');
  const raw = runtimeOf(ctx).readModel(input.instanceId, kept.readId).model;
  const { facts } = readClassifiedModel({
    rows: (raw.scene ?? []) as Record<string, unknown>[],
    source: model.source,
    units: 'meters',
    records: [],
    rolesVersion: 0,
    chosenOption: null,
    includeHidden: true,
  });
  const groups = unroledGroups(model, facts);
  if (!groups.length) return { proposals: [], rejected: [] };
  if (!ctx.propose) throw new DomainError('COMPLIANCE_AI_UNAVAILABLE');
  const request = complianceRolesRequest({
    groups,
    layers: layersOf(raw).map((l) => ({ name: l.fullPath, count: l.objectCount })),
  });
  let text: string;
  try {
    text = await ctx.propose(request);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    // SPEC-15.14: no proposal, the person can still set roles.
    return {
      proposals: [],
      rejected: [
        { why: 'AI_FAILED', text: 'AI 제안을 받지 못했습니다. 역할은 직접 정할 수 있습니다' },
      ],
    };
  }
  const offered = new Set(request.jig.groups);
  const checked = checkComplianceRoles(
    text,
    groups.filter((g) => offered.has(g.id)),
  );
  const proposals = ctx.roles.addProposals(
    projectId,
    model.source.documentKey,
    checked.proposals,
    hashesOf(raw),
  );
  return { proposals, rejected: checked.rejected };
}
