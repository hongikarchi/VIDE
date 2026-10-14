// Run isolation for jigs (PLAN-51 T-280): a persona run that opens a jig must not land in the
// workbook and conversation an earlier run left. The product rule stays as it is: a start opens the
// jig's latest workbook of the project (SPEC-07.18 3.1, reuse 'last') and the open conversation
// bound to it (SPEC-02.19 1, src/ui/skill-start.ts bindConversation). So before a run, inside the
// loop project only, the driver
//   1. closes the open conversations bound to that jig's workbooks (POST …/conversations/<id>/close,
//      transcripts kept; the default conversation, which cannot close, is unbound instead), and
//   2. makes a new workbook the same way a start does (POST …/jig-instances, title '작업본 <n>',
//      layerRootLater) so it is the latest one and the start reuses it.
// There is no API that archives or removes a workbook: the older ones stay in the project (listed,
// and their confirmed site address is still the project's known address, SPEC-12.3 6).
//
// `api(path, body?)` is the driver's fetch helper: GET without body, POST with one; paths start
// with `/projects/<projectId>/`.

const JIG_ID = /^[A-Za-z0-9][\w.-]{0,99}(?:\/[A-Za-z0-9][\w.-]{0,99})?$/;

/**
 * The scenario's `jigs`: the jig ids the run is expected to open (e.g. ["project/s06-frame"]).
 * Absent → null (nothing to isolate); [] → none expected. A wrong shape throws.
 * @returns {string[] | null}
 */
export function scenarioJigs(scenario) {
  const value = scenario?.jigs;
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value))
    throw new Error(`scenario ${scenario?.id ?? '?'}: jigs must be an array of jig ids`);
  const out = [];
  for (const item of value) {
    const jig = typeof item === 'string' ? item.trim() : '';
    if (!JIG_ID.test(jig))
      throw new Error(`scenario ${scenario?.id ?? '?'}: bad jig id ${JSON.stringify(item)}`);
    if (!out.includes(jig)) out.push(jig);
  }
  return out;
}

const newestFirst = (rows) =>
  [...rows].sort((a, b) =>
    String(b.updatedAt ?? b.createdAt ?? '').localeCompare(
      String(a.updatedAt ?? a.createdAt ?? ''),
    ),
  );
const message = (error) => String(error?.message ?? error);

/**
 * Isolates each expected jig before a run (see the head comment).
 * @returns {Promise<{status: 'full'|'partial'|'none', jigs: object[], limits: string[]}>}
 *   per jig: { jig, kind: 'instance'|'legacy'|null, reuse?, previousWorkbooks[], freshWorkbook,
 *   latestIsFresh, closedConversations[], unboundConversations[], errors[] }
 */
export async function isolateJigs({ api, projectId, jigs }) {
  const result = { status: 'none', jigs: [], limits: [] };
  if (!jigs?.length) return result;
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const reply = await api(`${base}/skills`).catch((error) => ({ error }));
  const catalog = Array.isArray(reply?.skills) ? reply.skills : [];
  let partial = false;
  for (const jig of jigs) {
    const row = {
      jig,
      kind: null,
      previousWorkbooks: [],
      freshWorkbook: null,
      latestIsFresh: false,
      closedConversations: [],
      unboundConversations: [],
      errors: [],
    };
    result.jigs.push(row);
    const entry = catalog.find((skill) => skill.id === jig);
    if (!entry) {
      row.errors.push(reply?.error ? 'skills: ' + message(reply.error) : 'not in the catalog');
      partial = true;
      continue;
    }
    row.kind = entry.kind ?? null;
    row.reuse = entry.open?.reuse ?? 'last';
    // An older jig screen has no workbook or bound conversation: nothing carries over.
    if (entry.kind === 'legacy') continue;
    try {
      const listed = await api(`${base}/jig-instances`);
      const mine = (listed?.instances ?? []).filter((instance) => instance.jigId === jig);
      row.previousWorkbooks = mine.map((instance) => instance.id);
      // 1 End the open conversations bound to those workbooks.
      const ids = new Set(row.previousWorkbooks);
      const conversations = (await api(`${base}/conversations`)) ?? [];
      for (const conversation of Array.isArray(conversations) ? conversations : []) {
        if (conversation.state === 'closed' || !ids.has(conversation.jigInstanceId)) continue;
        const key = conversation.id ?? 'default';
        try {
          await api(`${base}/conversations/${encodeURIComponent(key)}/close`, {});
          row.closedConversations.push(key);
        } catch (error) {
          // The default conversation never closes (SPEC-02.19 1): take the jig off it instead.
          try {
            await api(`${base}/conversations/${encodeURIComponent(key)}/unbind`, {
              jigInstanceId: conversation.jigInstanceId,
            });
            row.unboundConversations.push(key);
          } catch (unbind) {
            row.errors.push(`conversation ${key}: ${message(error)} / ${message(unbind)}`);
          }
        }
      }
      // 2 A new workbook, made as a start makes one, so reuse 'last' opens it.
      if (row.reuse === 'last') {
        const made = await api(`${base}/jig-instances`, {
          jig,
          ...(entry.version ? { version: entry.version } : {}),
          title: `작업본 ${mine.length + 1}`,
          layerRootLater: true,
        });
        row.freshWorkbook = made?.id ?? null;
        const after = await api(`${base}/jig-instances`);
        const latest = newestFirst((after?.instances ?? []).filter((i) => i.jigId === jig))[0];
        row.latestIsFresh = !!row.freshWorkbook && latest?.id === row.freshWorkbook;
        if (!row.latestIsFresh) row.errors.push('the new workbook is not the latest one');
      } else row.latestIsFresh = true; // reuse 'new': every start makes its own workbook
    } catch (error) {
      row.errors.push(message(error));
    }
    if (row.errors.length) partial = true;
  }
  result.status = partial ? 'partial' : 'full';
  result.limits.push(
    'no archive API: older workbooks of the jig stay in the project (listed; a confirmed site address there is still the project address)',
    'the document is not isolated here: the operator links a fresh .vide/ copy per run',
  );
  return result;
}

/**
 * Per request of the run: the CLI starts in the engine log (`cli-start`, src/ai/cli-log.ts) with
 * `resume` (the session already had turns), provider and model. The CLI session id is not logged
 * (arguments never are), so it is not here. `linesOf(requestId)` returns that request's log lines.
 */
export function cliSessions(requestIds, linesOf) {
  return requestIds.map((requestId) => {
    const starts = (linesOf(requestId) ?? []).filter((line) => line?.event === 'cli-start');
    return {
      requestId,
      cliStarts: starts.length,
      resume: starts.length ? starts.some((line) => line.resume === true) : null,
      provider: starts[0]?.provider ?? null,
      model: starts[0]?.model ?? null,
    };
  });
}
