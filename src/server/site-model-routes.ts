// The `site-data` input of a jig instance (PLAN-45 T-207, SPEC-12.3·12.4·12.16, ARCH-03 §7·§8.3):
// the engine asks the public services through `vide/site-data` with this PC's keys and keeps each
// answer as a read-copy of the instance; the jig steps only read the copies.
// - `POST …/jig-instances/:iid/site-data/:key/lookup {query}` — the address asked; candidates.
// - `PUT  …/site-data/:key/targets {pnus}` — the parcels a person chose (합필: several).
// - `POST …/site-data/:key/collect` — the targets and their surroundings (setting `radius`). With a
//   collection of the same targets already in use the new copy waits as `pending` with what
//   changed; `POST …/site-data/:key/pending {take}` takes it or keeps the old one. Neither copy is
//   overwritten (earlier ones stay in `previous`).
// - `POST …/site-data/:key/shp {files: [{name, data}]}` or `{clear: true}` — SHP files (base64)
//   put in for this instance only, imported into EPSG:5186 together with the ones put in before.
// Nothing is sent before the project confirmed the FR-18 notice (`{needsConfirm}`); a project that
// turned public data off sends nothing and uses the SHP put in (`{off: true}`).

import { z } from 'zod';
import { DomainError } from '../contracts/errors.ts';
import { SITE_DATA_NOTICE } from '../contracts/site-data.ts';
import type { Workspace } from '../core/workspace.ts';
import {
  collectSite,
  collectionChanges,
  lookupParcel,
  type LookupResult,
  type SiteCollection,
  type SiteDataContext,
} from '../jigs/official/site-data/index.ts';
import { importShapefiles } from '../jigs/official/site-data/shp/index.ts';
import type { SiteCollectionRef, SiteDataState } from '../jigs/runtime/instance.ts';
import { jigRuntimeFor } from './jig-routes.ts';
import type { PublicDataKeyStore } from './public-data-keys.ts';
import { noticeState, type SiteDataSettings } from './site-data-routes.ts';

const pnu = z.string().regex(/^\d{10}[12]\d{8}$/);
const lookupInput = z.object({ query: z.string().trim().min(1).max(200) }).strict();
const targetsInput = z.object({ pnus: z.array(pnu).max(20) }).strict();
const pendingInput = z.object({ take: z.boolean() }).strict();
const shpInput = z.union([
  z
    .object({
      files: z
        .array(
          z
            .object({
              name: z.string().min(1).max(260),
              data: z.string().max(48 * 1024 * 1024),
            })
            .strict(),
        )
        .min(1)
        .max(60),
    })
    .strict(),
  z.object({ clear: z.literal(true) }).strict(),
]);

/** Earlier collections kept for a person to compare (never overwritten). */
const KEEP_PREVIOUS = 5;

export interface SiteModelRouteOptions {
  workspace: Workspace;
  dataDirectory: string;
  keys: PublicDataKeyStore;
  settings: SiteDataSettings;
  body: () => Promise<Record<string, unknown>>;
  send: (status: number, value: unknown) => void;
  /** Test seam: the fetch and clock the library uses. */
  context?: Omit<SiteDataContext, 'keys'>;
  /** Diagnostics without keys, addresses or PNUs. */
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** What the steps keep of an SHP import: geometry, roles and the decoded building/parcel fields. */
export function shpCopy(
  imported: Awaited<ReturnType<typeof importShapefiles>>,
  files: string[],
  at: string,
) {
  return {
    frame: imported.frame,
    layers: imported.layers.map((layer) => ({
      file: layer.file,
      name: layer.name,
      role: layer.role,
      code: layer.code,
      sourceCrs: layer.sourceCrs,
      reprojected: layer.reprojected,
      encoding: layer.encoding,
      counts: layer.counts,
      warnings: layer.warnings,
      features: layer.features.map((f) => ({
        index: f.index,
        geometry: f.geometry,
        ...(f.building ? { building: f.building } : {}),
        ...(f.elevation !== undefined ? { elevation: f.elevation } : {}),
        ...(f.parcel ? { parcel: f.parcel } : {}),
      })),
    })),
    ignored: imported.ignored,
    rejected: imported.rejected,
    files,
    importedAt: at,
  };
}

const samePnus = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((p) => b.includes(p));

/** What the screen sees of a state: references without file paths. */
function stateView(state: SiteDataState) {
  return {
    query: state.query ?? null,
    targets: state.targets ?? null,
    collection: state.collection
      ? { fetchedAt: state.collection.fetchedAt, pnus: state.collection.pnus }
      : null,
    pending: state.pending
      ? { fetchedAt: state.pending.fetchedAt, changes: state.pending.changes }
      : null,
    previous: (state.previous ?? []).map((p) => ({ fetchedAt: p.fetchedAt, pnus: p.pnus })),
    shp: state.shp ? { files: state.shp.files, at: state.shp.at } : null,
  };
}

export async function siteModelRoutes(
  url: URL,
  method: string | undefined,
  options: SiteModelRouteOptions,
): Promise<boolean> {
  const match =
    /^\/api\/v1\/projects\/([^/]+)\/jig-instances\/([^/]+)\/site-data\/([A-Za-z][\w-]{0,63})\/(lookup|targets|collect|pending|shp)$/.exec(
      url.pathname,
    );
  if (!match) return false;
  const [, projectId, instanceId, key, part] = match;
  const expected = part === 'targets' ? 'PUT' : 'POST';
  if (method !== expected) throw new DomainError('NOT_FOUND');
  const runtime = jigRuntimeFor(options.workspace, options.dataDirectory);
  const current = await runtime.siteData(projectId, instanceId, key);
  const notice = noticeState(options.settings.choice(projectId));
  const context = (): SiteDataContext => ({ ...options.context, keys: options.keys.read() });
  const reply = (state: SiteDataState, extra: Record<string, unknown> = {}) =>
    options.send(200, { ...extra, state: stateView(state) });
  const update = (change: Parameters<typeof runtime.updateSiteData>[3]): Promise<SiteDataState> =>
    runtime.updateSiteData(projectId, instanceId, key, change);

  if (part === 'lookup') {
    const { query } = lookupInput.parse(await options.body());
    const changedQuery = (current.state.query ?? '') !== query;
    // Off or not yet confirmed: keep the address (the SHP put in may answer it), send nothing.
    if (notice.off || !notice.confirmed) {
      const state = await update((state) => ({
        state: { ...state, query, lookup: undefined },
        parts: changedQuery || state.lookup ? ['query', 'lookup'] : [],
      }));
      reply(state, notice.off ? { off: true } : { needsConfirm: SITE_DATA_NOTICE });
      return true;
    }
    const started = Date.now();
    const result = await lookupParcel(context(), query);
    options.log?.('site-model', {
      op: 'lookup',
      status: result.status,
      candidates: result.candidates.length,
      ms: Date.now() - started,
    });
    const state = await update((state, keep) => {
      // A proposal replaces parcels proposed before; a person's own choice stays until changed.
      const keepTargets = state.targets?.by === 'user' && state.targets.pnus.length > 0;
      const targets = keepTargets
        ? state.targets
        : result.proposal
          ? { pnus: [result.proposal], by: 'proposal' as const, at: result.fetchedAt }
          : undefined;
      return {
        state: { ...state, query, lookup: keep('lookup', result), targets },
        parts: ['query', 'lookup', 'targets'],
      };
    });
    reply(state, { status: result.status });
    return true;
  }

  if (part === 'targets') {
    const { pnus } = targetsInput.parse(await options.body());
    const unique = [...new Set(pnus)];
    const state = await update((state) => ({
      state: {
        ...state,
        targets: unique.length
          ? { pnus: unique, by: 'user', at: new Date().toISOString() }
          : undefined,
      },
      parts: samePnus(state.targets?.pnus ?? [], unique) ? [] : ['targets'],
    }));
    reply(state);
    return true;
  }

  if (part === 'collect') {
    const pnus = current.state.targets?.pnus ?? [];
    if (!pnus.length) throw new DomainError('SITE_TARGETS_MISSING');
    if (notice.off) throw new DomainError('SITE_DATA_OFF');
    if (!notice.confirmed) {
      reply(current.state, { needsConfirm: SITE_DATA_NOTICE });
      return true;
    }
    const radiusValue = current.params.radius?.value;
    const radius = typeof radiusValue === 'number' ? radiusValue : 200;
    const started = Date.now();
    const result = await collectSite(context(), { pnus, radius });
    options.log?.('site-model', {
      op: 'collect',
      blocked: result.blocked,
      parcels: result.parcels.items.length,
      buildings: result.buildings.items.length,
      ms: Date.now() - started,
    });
    const before =
      current.state.collection && samePnus(current.state.collection.pnus, pnus)
        ? current.read<SiteCollection>(current.state.collection)
        : undefined;
    const changes = before ? collectionChanges(before, result) : [];
    const state = await update((state, keep) => {
      const copy: SiteCollectionRef = {
        ...keep('collection', result),
        fetchedAt: result.fetchedAt,
        pnus,
        radius,
      };
      // Same targets and something changed: the new copy waits for the person (SPEC-12.4).
      if (before && changes.length)
        return { state: { ...state, pending: { ...copy, changes } }, parts: [] };
      return {
        state: {
          ...state,
          collection: copy,
          pending: undefined,
          previous: state.collection
            ? [state.collection, ...(state.previous ?? [])].slice(0, KEEP_PREVIOUS)
            : state.previous,
        },
        parts: ['collection'],
      };
    });
    reply(state, {
      blocked: result.blocked,
      changes,
      waiting: !!(before && changes.length),
      unchanged: !!before && !changes.length,
    });
    return true;
  }

  if (part === 'pending') {
    const { take } = pendingInput.parse(await options.body());
    if (!current.state.pending) throw new DomainError('NOT_FOUND');
    const state = await update((state) => {
      const pending = state.pending!;
      if (!take) return { state: { ...state, pending: undefined }, parts: [] };
      const { changes: _changes, ...copy } = pending;
      return {
        state: {
          ...state,
          collection: copy,
          pending: undefined,
          previous: state.collection
            ? [state.collection, ...(state.previous ?? [])].slice(0, KEEP_PREVIOUS)
            : state.previous,
        },
        parts: ['collection'],
      };
    });
    reply(state);
    return true;
  }

  // part === 'shp'
  const input = shpInput.parse(await options.body());
  if ('clear' in input) {
    const state = await update((state) => ({
      state: { ...state, shp: undefined },
      parts: state.shp ? ['shp'] : [],
    }));
    reply(state);
    return true;
  }
  const earlier =
    current.read<{ files: { name: string; data: string }[] }>(current.state.shp?.raw)?.files ?? [];
  const byName = new Map(earlier.map((f) => [f.name.toLowerCase(), f]));
  for (const file of input.files) byName.set(file.name.toLowerCase(), file);
  const files = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  const imported = await importShapefiles(
    files.map((f) => ({ name: f.name, bytes: new Uint8Array(Buffer.from(f.data, 'base64')) })),
    { target: 5186 },
  );
  const copy = shpCopy(
    imported,
    files.map((f) => f.name),
    new Date().toISOString(),
  );
  const state = await update((state, keep) => ({
    state: {
      ...state,
      shp: {
        ...keep('shp', copy),
        files: copy.files,
        raw: keep('shp-files', { files }),
      },
    },
    parts: ['shp'],
  }));
  options.log?.('site-model', {
    op: 'shp',
    files: files.length,
    layers: copy.layers.length,
    rejected: copy.rejected.length,
  });
  reply(state, {
    layers: copy.layers.map((l) => ({
      file: l.file,
      name: l.name,
      role: l.role,
      features: l.features.length,
      warnings: l.warnings,
    })),
    ignored: copy.ignored,
    rejected: copy.rejected,
  });
  return true;
}

export type { LookupResult };
