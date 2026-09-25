import { DomainError } from '../core/store.ts';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  realpathSync,
  lstatSync,
  existsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { providers } from '../contracts/ai-settings.ts';
import type { Provider } from '../contracts/ai-settings.ts';
const profile = z
  .object({
    id: z.string().uuid(),
    provider: z.enum(providers),
    label: z.string().trim().min(1).max(80),
  })
  .strict();
const schema = z
  .object({
    version: z.literal(1),
    profiles: z.array(profile).max(30),
    active: z.object({ 'claude-cli': z.string(), 'codex-cli': z.string() }).strict(),
    pending: z
      .object({ 'claude-cli': z.string().nullable(), 'codex-cli': z.string().nullable() })
      .strict(),
  })
  .strict();
type Data = z.infer<typeof schema>;
const fail = (code: string): never => {
  throw new DomainError(code);
};
/** Local-only metadata. Credentials remain in CLI-owned child directories, never in this manifest. */
export class AccountProfiles {
  private root: string;
  private data: Data;
  private busy: (provider: Provider) => boolean;
  constructor(root: string, busy: (provider: Provider) => boolean) {
    this.busy = busy;
    mkdirSync(root, { recursive: true });
    if (lstatSync(root).isSymbolicLink()) fail('PROFILE_PATH_INVALID');
    this.root = realpathSync(root);
    const file = join(this.root, 'profiles.json');
    this.data = existsSync(file)
      ? schema.parse(JSON.parse(readFileSync(file, 'utf8')))
      : {
          version: 1,
          profiles: [],
          active: { 'claude-cli': 'default', 'codex-cli': 'default' },
          pending: { 'claude-cli': null, 'codex-cli': null },
        };
    for (const provider of providers)
      for (const id of [this.data.active[provider], this.data.pending[provider]])
        if (id && id !== 'default') this.find(provider, id);
  }
  private save() {
    const temporary = join(this.root, 'profiles.json.tmp');
    writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(temporary, join(this.root, 'profiles.json'));
  }
  private find(provider: Provider, id: string) {
    return (
      this.data.profiles.find((p) => p.provider === provider && p.id === id) ??
      fail('PROFILE_NOT_FOUND')
    );
  }
  list() {
    for (const provider of providers)
      if (this.data.pending[provider] && !this.busy(provider)) {
        this.data.active[provider] = this.data.pending[provider]!;
        this.data.pending[provider] = null;
        this.save();
      }
    return structuredClone(this.data);
  }
  add(provider: Provider, label: string) {
    if (this.data.profiles.length >= 30) fail('PROFILE_LIMIT');
    const row = profile.parse({ id: randomUUID(), provider, label });
    mkdirSync(join(this.root, row.id));
    this.data.profiles.push(row);
    this.save();
    return row;
  }
  select(provider: Provider, id: string) {
    if (id !== 'default') this.find(provider, id);
    if (this.data.active[provider] === id) this.data.pending[provider] = null;
    else if (this.busy(provider)) this.data.pending[provider] = id;
    else {
      this.data.active[provider] = id;
      this.data.pending[provider] = null;
    }
    this.save();
    return this.list();
  }
  selected(provider: Provider) {
    const data = this.list();
    if (data.pending[provider]) fail('PROFILE_SWITCH_PENDING');
    return data.active[provider];
  }
  directory(provider: Provider, id: string) {
    if (id === 'default') return undefined;
    this.find(provider, id);
    const path = join(this.root, id);
    if (
      lstatSync(path).isSymbolicLink() ||
      realpathSync(path).toLowerCase() !== resolve(path).toLowerCase()
    )
      fail('PROFILE_PATH_INVALID');
    return path;
  }
}
