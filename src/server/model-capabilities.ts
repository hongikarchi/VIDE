// Explicit model IDs only: moving aliases and unknown models use the provider default.
// https://code.claude.com/docs/en/model-config#adjust-effort-level (checked 2026-09-24).
export function claudeEfforts(id: string): string[] {
  const model = id.replace(/\[1m\]$/, '');
  if (
    [
      'claude-fable-5',
      'claude-fable-5-1',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-opus-5-5',
      'claude-sonnet-5',
    ].includes(model)
  )
    return ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (['claude-opus-4-6', 'claude-sonnet-4-6'].includes(model))
    return ['default', 'low', 'medium', 'high', 'max'];
  return ['default'];
}

/** Current Claude family for the model menu (the Claude Code CLI keeps no model catalog). */
export const CLAUDE_MODELS = [
  ['claude-opus-5-5', 'Claude Opus 5.5'],
  ['claude-fable-5-1', 'Claude Fable 5.1'],
  ['claude-sonnet-5', 'Claude Sonnet 5'],
  ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5'],
] as const;

/** "claude-opus-5-5" → "Claude Opus 5.5" for IDs outside the list. */
export function modelName(id: string) {
  const known = CLAUDE_MODELS.find(([model]) => model === id);
  if (known) return known[1];
  const [, family, version] = /^claude-([a-z]+)-([\d-]+?)(?:-\d{8})?(\[1m\])?$/.exec(id) ?? [];
  if (!family) return id;
  return `Claude ${family[0].toUpperCase()}${family.slice(1)} ${version.replace(/-/g, '.')}`;
}
