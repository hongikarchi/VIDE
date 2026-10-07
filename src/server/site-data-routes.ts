// 공공 자료 수집 routes (PLAN-45 T-205, SPEC-12.3·12.4, FR-18, ARCH-01 「공공 자료 수집」):
// - `GET/PUT /api/v1/settings/public-data` — which keys this PC has (present/absent only) and
//   putting or removing one. This PC only.
// - `GET/PUT /api/v1/projects/:id/site-data/notice` — the send notice and the project's choice
//   (confirmed version, off). Confirming and turning off are this PC's decisions.
// - `POST …/site-data/lookup {query}` → `LookupResult`, `POST …/site-data/collect {pnus, radius?}`
//   → `SiteCollection`. Before the notice is confirmed they answer `{needsConfirm: notice}` and send
//   nothing; a project that turned public data off answers SITE_DATA_OFF.
// The PC-wide choices live in `<data>/site-data-settings.json {projects: {[id]: {confirmed?, off?}}}`.

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  SITE_DATA_NOTICE,
  publicDataKeyInput,
  siteCollectInput,
  siteLookupInput,
  siteNoticeInput,
} from '../contracts/site-data.ts';
import { DomainError } from '../contracts/errors.ts';
import {
  collectSite,
  lookupParcel,
  type SiteDataContext,
} from '../jigs/official/site-data/index.ts';
import type { PublicDataKeyStore } from './public-data-keys.ts';

export const siteDataStatuses: Record<string, number> = {
  SITE_DATA_OFF: 409,
  // A collect for a site-model instance with no target parcel chosen (T-207).
  SITE_TARGETS_MISSING: 422,
};

interface ProjectChoice {
  /** The notice version the person confirmed, and when. */
  confirmed?: { version: string; at: string };
  off?: boolean;
}

export class SiteDataSettings {
  readonly file: string | undefined;
  constructor(file: string | undefined) {
    this.file = file;
  }
  private load(): Record<string, ProjectChoice> {
    if (!this.file || !existsSync(this.file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { projects?: unknown };
      return parsed.projects && typeof parsed.projects === 'object'
        ? (parsed.projects as Record<string, ProjectChoice>)
        : {};
    } catch {
      return {};
    }
  }
  choice(projectId: string): ProjectChoice {
    return this.load()[projectId] ?? {};
  }
  async update(projectId: string, change: (choice: ProjectChoice) => ProjectChoice) {
    const projects = this.load();
    projects[projectId] = change(projects[projectId] ?? {});
    if (this.file) {
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ projects }, null, 1));
      await rename(temporary, this.file);
    }
    return projects[projectId];
  }
}

export function noticeState(choice: ProjectChoice) {
  return {
    notice: SITE_DATA_NOTICE,
    confirmed: choice.confirmed?.version === SITE_DATA_NOTICE.version,
    confirmedAt: choice.confirmed?.at ?? null,
    off: !!choice.off,
  };
}

export interface SiteDataRouteOptions {
  remote: boolean;
  keys: PublicDataKeyStore;
  settings: SiteDataSettings;
  /** Throws NOT_FOUND for an unknown project. */
  requireProject: (id: string) => void;
  body: () => Promise<Record<string, unknown>>;
  send: (status: number, value: unknown) => void;
  /** Test seam: the fetch and clock the library uses. */
  context?: Omit<SiteDataContext, 'keys'>;
  /** Diagnostics without keys, addresses or PNUs: what ran and how each copy ended. */
  log?: (event: string, fields: Record<string, unknown>) => void;
  now?: () => Date;
}

export async function siteDataRoutes(
  url: URL,
  method: string | undefined,
  options: SiteDataRouteOptions,
) {
  const { remote, keys, settings, body, send } = options;
  if (url.pathname === '/api/v1/settings/public-data') {
    if (remote) throw new DomainError('FORBIDDEN');
    if (method === 'GET') send(200, keys.view());
    else if (method === 'PUT') {
      const { name, value } = publicDataKeyInput.parse(await body());
      send(200, await keys.set(name, value));
      options.log?.('public-data-key', { name, present: !!value.trim() });
    } else throw new DomainError('NOT_FOUND');
    return true;
  }
  const match = /^\/api\/v1\/projects\/([^/]+)\/site-data\/(notice|lookup|collect)$/.exec(
    url.pathname,
  );
  if (!match) return false;
  const [, projectId, part] = match;
  options.requireProject(projectId);
  if (part === 'notice') {
    if (method === 'GET') send(200, noticeState(settings.choice(projectId)));
    else if (method === 'PUT') {
      if (remote) throw new DomainError('FORBIDDEN');
      const input = siteNoticeInput.parse(await body());
      const at = (options.now ?? (() => new Date()))().toISOString();
      const choice = await settings.update(projectId, (current) => ({
        ...current,
        ...(input.confirm ? { confirmed: { version: SITE_DATA_NOTICE.version, at } } : {}),
        ...(input.off !== undefined ? { off: input.off } : {}),
      }));
      send(200, noticeState(choice));
    } else throw new DomainError('NOT_FOUND');
    return true;
  }
  if (method !== 'POST') throw new DomainError('NOT_FOUND');
  const input =
    part === 'lookup' ? siteLookupInput.parse(await body()) : siteCollectInput.parse(await body());
  const state = noticeState(settings.choice(projectId));
  if (state.off) throw new DomainError('SITE_DATA_OFF');
  if (!state.confirmed) {
    send(200, { needsConfirm: state.notice });
    return true;
  }
  const context: SiteDataContext = { ...options.context, keys: keys.read() };
  const started = Date.now();
  if ('query' in input) {
    const result = await lookupParcel(context, input.query);
    options.log?.('site-data', {
      op: 'lookup',
      status: result.status,
      candidates: result.candidates.length,
      ...(result.reason ? { reason: result.reason } : {}),
      ms: Date.now() - started,
    });
    send(200, result);
  } else {
    const result = await collectSite(context, input);
    options.log?.('site-data', {
      op: 'collect',
      blocked: result.blocked,
      copies: Object.fromEntries(
        (
          [
            'target',
            'landCharacteristics',
            'landUse',
            'parcels',
            'buildings',
            'buildingInfo',
            'register',
          ] as const
        ).map((name) => [name, `${result[name].status}:${result[name].items.length}`]),
      ),
      ms: Date.now() - started,
    });
    send(200, result);
  }
  return true;
}
