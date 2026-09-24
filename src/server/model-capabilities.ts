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
