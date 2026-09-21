import type {CliOptions} from './claude-cli.ts';
import { ClaudeCli, ProviderError } from './claude-cli.ts';
import { CodexCli } from './codex-cli.ts';

export const providerCatalog = Object.freeze([
  Object.freeze({ id: 'claude-cli', label: 'Claude 구독 · Claude Code' }),
  Object.freeze({ id: 'codex-cli', label: 'ChatGPT 구독 · Codex' }),
]);

/** Caller chooses explicitly. No automatic provider/billing fallback. */
export function createProvider({ provider, ...options }:CliOptions & {provider:string}) {
  if (provider === 'claude-cli') return new ClaudeCli(options);
  if (provider === 'codex-cli') return new CodexCli(options);
  throw new ProviderError('UNKNOWN_PROVIDER');
}
