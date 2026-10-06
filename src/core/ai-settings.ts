import { statSync } from 'node:fs';
import { win32 } from 'node:path';
import { DomainError } from './store.ts';
import type { Store } from './store.ts';
import { providers, aiSettingsSchema, aiSettingsUpdateSchema } from '../contracts/ai-settings.ts';
import type { AiConfiguration } from '../contracts/ai-settings.ts';

export class AiSettings {
  private readonly store: Store;
  private readonly checkFile: (path: string) => boolean;
  constructor(
    store: Store,
    checkFile: (path: string) => boolean = (path) => statSync(path).isFile(),
  ) {
    this.store = store;
    this.checkFile = checkFile;
  }
  get(): AiConfiguration {
    const row = this.store.app.prepare('SELECT revision,paths FROM ai_settings WHERE id=1').get();
    if (!row) return { revision: 0, paths: { 'claude-cli': null, 'codex-cli': null } };
    try {
      if (typeof row.paths !== 'string') throw new Error('Invalid stored paths');
      return aiSettingsSchema.parse({ revision: row.revision, paths: JSON.parse(row.paths) });
    } catch {
      throw new DomainError('INVALID_INPUT');
    }
  }
  save(value: unknown): AiConfiguration {
    const parsed = aiSettingsUpdateSchema.safeParse(value);
    if (!parsed.success) throw new DomainError('INVALID_INPUT');
    const input = parsed.data;
    if (input.revision !== this.get().revision) throw new DomainError('REVISION_CONFLICT');
    const paths: AiConfiguration['paths'] = { 'claude-cli': null, 'codex-cli': null };
    for (const provider of providers) {
      const value = input.paths[provider];
      if (value === null || value === '') continue;
      if (
        typeof value !== 'string' ||
        value.length > 1024 ||
        !/^[A-Za-z]:[\\/]/.test(value) ||
        win32.basename(value).toLowerCase() !==
          (provider === 'claude-cli' ? 'claude.exe' : 'codex.exe')
      ) {
        throw new DomainError('INVALID_CLI_PATH');
      }
      const path = win32.normalize(value);
      try {
        if (!this.checkFile(path)) throw new Error('Not a file');
      } catch {
        throw new DomainError('CLI_FILE_MISSING');
      }
      paths[provider] = path;
    }
    this.store.app
      .prepare(
        'INSERT INTO ai_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,paths=excluded.paths',
      )
      .run(input.revision + 1, JSON.stringify(paths));
    return this.get();
  }
}
