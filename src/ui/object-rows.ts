// Object rows the request list leaves out (PLAN-28 T-123): a display Sync is listed without its
// `objects` (`objectsOmitted`). The few screens that need rows of a Sync that is not drawn (the
// Rhino panel's pins, a CAD selection, follow-up drafts) read them from `GET …/requests/:r/objects`.
import { z } from 'zod';
import { api } from './gateway.ts';
import { draftState } from './store/draft.ts';

const rowsSchema = z.object({
  objects: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
});
type Row = z.infer<typeof rowsSchema>['objects'][number];
/** Rows fetched by id, per request (a Live Sync in place keeps the id: missing ids are asked). */
const fetched = new Map<string, Map<string, Row>>();

/** The row of an object of a request: from the request held in memory, else from the fetched ones. */
export function knownRow(requestId: string, id: string): Row | undefined {
  const result = draftState.state.messages.find((entry) => entry.id === requestId)?.request.result;
  const own = result?.objects?.find((object) => object.id === id);
  return (own as Row | undefined) ?? fetched.get(requestId)?.get(id);
}

/** Fetches the rows of these ids that are not known yet; resolves to how many were added. */
export async function fetchRows(projectId: string, requestId: string, ids: readonly string[]) {
  const missing = [...new Set(ids)].filter((id) => !knownRow(requestId, id));
  if (!missing.length) return 0;
  const reply = rowsSchema.parse(
    await api(
      `/projects/${projectId}/requests/${encodeURIComponent(requestId)}/objects?ids=${missing.map(encodeURIComponent).join(',')}`,
    ),
  );
  const rows = fetched.get(requestId) ?? new Map<string, Row>();
  for (const row of reply.objects) rows.set(row.id, row);
  fetched.set(requestId, rows);
  return reply.objects.length;
}

/**
 * Puts a request's whole object list back on its message (for checks that read `result.objects`);
 * nothing is fetched when the message already has it.
 */
export async function withObjects(projectId: string, requestId: string) {
  const entry = draftState.state.messages.find((item) => item.id === requestId);
  const result = entry?.request.result;
  if (!entry || !result || result.objects || !result.objectsOmitted) return;
  const reply = rowsSchema.parse(
    await api(`/projects/${projectId}/requests/${encodeURIComponent(requestId)}/objects`),
  );
  const index = draftState.state.messages.findIndex((item) => item.id === requestId);
  const current = draftState.state.messages[index];
  if (!current?.request.result || current.request.result.objects) return;
  const { objectsOmitted: _omitted, ...rest } = current.request.result;
  draftState.state.messages[index] = {
    ...current,
    request: {
      ...current.request,
      result: { ...rest, objects: reply.objects as typeof rest.objects },
    },
  };
}
