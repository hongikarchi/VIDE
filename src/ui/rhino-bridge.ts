import { z } from 'zod';
import { api, labels } from './gateway.ts';
import { activityEntries } from './activity.tsx';
import type { UiMessage } from './workspace-data.ts';

export const bridgeMessageSchema = z.object({
  id: z.string().uuid(),
  body: z.string(),
  model: z.string(),
  effort: z.string(),
  permission: z.enum(['review', 'candidate', 'apply']),
  pinIds: z.array(z.string()),
  createdAt: z.string(),
});
export type BridgeMessage = z.infer<typeof bridgeMessageSchema>;
const replySchema = z.object({ outbox: z.array(bridgeMessageSchema) });
export interface BridgeTarget {
  instance: string;
  documentId: number;
}
const icons: Record<string, string> = {
  host: '▣',
  model: '◆',
  thinking: '…',
  message: '›',
  query: '⌕',
  execute: '⚙',
  result: '✓',
  error: '!',
};
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) + '…' : text);

/** Compact view of VIDE's chat for the Rhino panel. */
export function bridgeState(input: {
  project?: string;
  models: { id: string; name: string; efforts: string[] }[];
  model: string;
  effort: string;
  basis?: string;
  messages: UiMessage[];
  origins: Set<string>;
  notices: { id: string; text: string }[];
}) {
  const stateLabels: Record<string, string> = labels;
  return {
    project: input.project ?? '',
    models: input.models.map(({ id, name, efforts }) => ({ id, name, efforts })),
    model: input.model,
    effort: input.effort,
    basis: input.basis ?? '',
    recent: input.messages
      .filter((message) => (message.request?.input?.host || message.host || 'rhino') === 'rhino')
      .slice(-6)
      .map((message) => {
        const request = message.request,
          result = request?.result;
        return {
          id: message.id,
          body: clip(message.body || (message.source ? 'Rhino Sync' : ''), 300),
          state: request?.state ?? '',
          label:
            result?.applicationState === 'succeeded'
              ? '연결 Rhino에 반영됨'
              : stateLabels[request?.state ?? ''] || request?.state || '',
          origin: input.origins.has(message.id) ? 'rhino' : 'vide',
          text: clip(typeof result?.text === 'string' ? result.text : '', 500),
          activity: activityEntries(result?.activity)
            .slice(-5)
            .map((entry) => ({
              kind: entry.kind,
              icon: icons[entry.kind] ?? '·',
              text: clip(entry.text, 160),
            })),
        };
      }),
    notices: input.notices.slice(-3),
  };
}

/**
 * Poll the attached Rhino panel: deliver the current VIDE state and receive queued messages.
 * Each message id is acknowledged only after VIDE has handled it (submitted or reported).
 */
export function startRhinoBridge(options: {
  target: () => BridgeTarget | undefined;
  state: () => unknown;
  handle: (message: BridgeMessage, target: BridgeTarget) => Promise<void>;
}) {
  const handled = new Set<string>();
  const ack = new Set<string>();
  let busy = false;
  const tick = async () => {
    const target = options.target();
    if (busy || !target) return;
    busy = true;
    try {
      const reply = replySchema.parse(
        await api('/host/attached-bridge', 'POST', {
          ...target,
          ack: [...ack],
          state: options.state(),
        }),
      );
      ack.clear();
      for (const message of reply.outbox) {
        if (handled.has(message.id)) {
          ack.add(message.id);
          continue;
        }
        handled.add(message.id);
        try {
          await options.handle(message, target);
        } finally {
          ack.add(message.id);
        }
      }
    } catch {
      /* The panel keeps queued messages until the next successful exchange. */
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 1500);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  return { tick };
}
