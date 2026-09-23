import { z } from 'zod';
import type { Store } from './store.ts';
import type { Workspace } from './workspace.ts';
import { candidateSchema } from './reviews.ts';
import manifest from '../../extensions/object-summary/manifest.json' with { type: 'json' };
import { run } from '../../extensions/object-summary/index.ts';
import { DomainError } from './store.ts';
const allowed = new Map([[manifest.id, { manifest, run }]]);
export function validateExtensionManifest(raw: unknown) {
  const parsed = z
    .object({
      contractVersion: z.number(),
      input: z.string(),
      output: z.string(),
      cancellation: z.boolean(),
      capabilities: z.array(z.string()),
      id: z.string(),
      version: z.string(),
      name: z.string(),
    })
    .safeParse(raw);
  if (!parsed.success) throw new DomainError('INVALID_EXTENSION_CONTRACT');
  const value = parsed.data;
  if (
    !value ||
    value.contractVersion !== 1 ||
    value.input !== 'saved-selection' ||
    value.output !== 'object-summary' ||
    value.cancellation !== false ||
    JSON.stringify(value.capabilities) !== '["model.read"]' ||
    !/^[a-z0-9-]{1,80}$/.test(value.id) ||
    !/^\d+\.\d+\.\d+$/.test(value.version) ||
    typeof value.name !== 'string'
  )
    throw new DomainError('INVALID_EXTENSION_CONTRACT');
}
export class Extensions {
  store: Store;
  workspace: Workspace;
  constructor(store: Store, workspace: Workspace) {
    for (const extension of allowed.values()) validateExtensionManifest(extension.manifest);
    this.store = store;
    this.workspace = workspace;
  }
  list() {
    return [...allowed.values()].map(({ manifest }) => ({
      ...manifest,
      ...this.registration(manifest.id),
    }));
  }
  registration(id: string) {
    if (!allowed.has(id)) throw new DomainError('NOT_FOUND');
    const row = this.store.db
      .prepare('SELECT enabled,revision,version FROM extension_registrations WHERE id=?')
      .get(id);
    return {
      enabled: !!row?.enabled && row.version === allowed.get(id)!.manifest.version,
      revision: row ? z.number().parse(row.revision) : 0,
    };
  }
  save(id: string, raw: unknown) {
    const parsed = z
      .object({ enabled: z.boolean(), revision: z.number().int() })
      .strict()
      .safeParse(raw);
    if (!parsed.success) throw new DomainError('INVALID_INPUT');
    const input = parsed.data;
    const extension = allowed.get(id);
    if (!extension) throw new DomainError('NOT_FOUND');
    if (
      !input ||
      Object.keys(input).some((key) => !['enabled', 'revision'].includes(key)) ||
      typeof input.enabled !== 'boolean' ||
      !Number.isSafeInteger(input.revision)
    )
      throw new DomainError('INVALID_INPUT');
    if (this.registration(id).revision !== input.revision)
      throw new DomainError('REVISION_CONFLICT');
    this.store.db
      .prepare(
        'INSERT INTO extension_registrations VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,enabled=excluded.enabled,revision=excluded.revision',
      )
      .run(id, extension.manifest.version, Number(input.enabled), input.revision + 1);
    return this.registration(id);
  }
  execute(projectId: string, id: string, raw: unknown) {
    const parsed = z
      .object({
        id: z.string(),
        requestId: z.string(),
        objectIds: z.array(z.string()).min(1).max(100),
      })
      .strict()
      .safeParse(raw);
    if (!parsed.success) throw new DomainError('INVALID_INPUT');
    const input = parsed.data;
    const extension = allowed.get(id);
    if (!extension) throw new DomainError('NOT_FOUND');
    if (
      !input ||
      Object.keys(input).some((key) => !['id', 'requestId', 'objectIds'].includes(key)) ||
      typeof input.id !== 'string' ||
      typeof input.requestId !== 'string' ||
      !Array.isArray(input.objectIds) ||
      !input.objectIds.length ||
      input.objectIds.length > 100 ||
      input.objectIds.some((value) => typeof value !== 'string') ||
      new Set(input.objectIds).size !== input.objectIds.length
    )
      throw new DomainError('INVALID_INPUT');
    const source = this.workspace.get(projectId, input.requestId);
    if (!source.result?.hostExecuted) throw new DomainError('STALE_REFERENCE');
    const objects = input.objectIds.map((id) =>
      source.result?.objects?.find((object) => object.id === id),
    );
    if (objects.some((object) => !object)) throw new DomainError('STALE_REFERENCE');
    const selected = objects.filter((object): object is NonNullable<typeof object> =>
      Boolean(object),
    );
    const command = {
      id: input.id,
      provider: 'extension',
      extension: id,
      extensionVersion: extension.manifest.version,
      permission: 'review',
      host: source.result.host || 'rhino',
      baseRequestId: source.id,
      body: extension.manifest.name,
      pins: selected.map((object) => ({
        id: object.id,
        name: object.name,
        basis: source.id,
        role: 'reference',
      })),
      files: [],
      sketches: [],
    };
    // A repeated submission retrieves its existing result even if the extension was disabled later.
    const existing = this.workspace.list(projectId).find((request) => request.id === input.id);
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(command))
        throw new DomainError('REVISION_CONFLICT');
      return existing;
    }
    if (!this.registration(id).enabled) throw new DomainError('EXTENSION_DISABLED');
    const { request } = this.workspace.submit(projectId, command);
    this.workspace.update(projectId, request.id, 'running', {
      phase: 'extension',
      hostExecuted: false,
    });
    try {
      const model = candidateSchema.parse(source).result;
      const context = {
        objects: selected.map((object) => {
          const native = model.scene.find((item) => item.id === object.id);
          return {
            id: object.id,
            type: native?.nativeType || model.objects.find((item) => item.id === object.id)!.kind,
            layer: native?.layer64 ? Buffer.from(native.layer64, 'base64').toString('utf8') : null,
          };
        }),
      };
      const output = extension.run(structuredClone(context));
      const resultIds = output?.rows?.flatMap((row) => row.objectIds) || [];
      if (
        output?.type !== 'object-summary' ||
        !Array.isArray(output.rows) ||
        output.rows.some(
          (row) =>
            typeof row.type !== 'string' ||
            !(row.layer === null || typeof row.layer === 'string') ||
            row.count !== row.objectIds.length,
        ) ||
        resultIds.length !== objects.length ||
        new Set(resultIds).size !== objects.length ||
        resultIds.some((id) => !input.objectIds.includes(id))
      )
        throw Error('Invalid extension result');
      return this.workspace.update(projectId, request.id, 'succeeded', {
        hostExecuted: false,
        extensionExecuted: true,
        extensionResult: output,
        text: objects.length + '개 객체를 유형·레이어별로 요약했습니다.',
        baseRequestId: source.id,
      });
    } catch {
      return this.workspace.update(projectId, request.id, 'failed', {
        code: 'EXTENSION_FAILED',
        hostExecuted: false,
        extensionExecuted: false,
      });
    }
  }
}
