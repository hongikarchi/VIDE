// 대화로 정한 입력 역할 (SPEC-07.18 9, SPEC-07.5 3, T-293): a layer a person named in a jig
// conversation — a question card's answer or the conversation's text — goes into an assembly role
// the way the role card's [레이어 고르기] does (src/ui/jig-panel/instance.ts pickLayer): only that
// layer is read from the linked file's last Sync, the role is confirmed as 'user-chat', and the
// steps run again up to the next human step (SPEC-07.18 3.6). The AI tool jig_set_input and the
// answer route of an input question card (jig_ask_input) both come here.

import type { JigRuntime, ReadModel } from '../jigs/runtime/runtime.ts';

/** A linked file with its last Sync's layer table. */
export interface JigInputDocument {
  linkId: string;
  name: string;
  syncId: string;
  layers: readonly { fullPath: string; objectCount: number }[];
  /**
   * The file is not open now (SPEC-07.5 7, T-298): its last Sync is read only for a layer no open
   * file holds, and the result says so.
   */
  closed?: boolean;
}
export interface JigInputDeps {
  runtime: Pick<JigRuntime, 'view' | 'recordRead' | 'setAssembly' | 'run'>;
  /** The project's linked files that have a stored Sync (open ones first, SPEC-07.5 7). */
  documents: () => JigInputDocument[] | Promise<JigInputDocument[]>;
  /**
   * The linked file a stored Sync belongs to: a role picked on the role card holds its read as
   * `sync:<syncId>` (src/server/jig-routes.ts), compared by that file (SPEC-07.18 9.6, T-293).
   */
  syncLink?: (syncId: string) => string | undefined;
  /** Reads only these layers of the document's last Sync (a jig input read, SPEC-07.5 5). */
  read: (
    document: JigInputDocument,
    layers: string[],
  ) => Promise<{ linkId: string; revisionKey: string; model: ReadModel }>;
}
/** Who confirmed a role through the conversation (SPEC-07.18 9.1): a person, in the chat. */
export const CHAT_CONFIRMED_BY = 'user-chat';

type View = Awaited<ReturnType<JigRuntime['view']>>;
export interface InputRole {
  /** `<input>.<role>` as the role card and `PUT …/assembly/:role` name it. */
  key: string;
  title: string;
  required: boolean;
  confirmed: boolean;
  layers: string[];
  /** The linked file and layer of each held source (`<linkId>\n<layer>`), to tell a no-op. */
  held: string[];
}
/** The assembly roles a jig declares, with what the instance holds for each. */
export function inputRoles(view: Pick<View, 'inputs' | 'body'>): InputRole[] {
  const roles: InputRole[] = [];
  for (const input of view.inputs)
    if (input.kind === 'assembly')
      for (const role of input.roles) {
        const key = `${input.key}.${role.role}`;
        const held = view.body.assembly[key];
        roles.push({
          key,
          title: role.title,
          required: role.required,
          confirmed: !!held?.confirmed,
          layers: held ? held.sources.flatMap((source) => source.layers) : [],
          held: held
            ? held.sources.flatMap((source) =>
                source.layers.map((layer) => `${source.linkId}\n${layer}`),
              )
            : [],
        });
      }
  return roles;
}
const squash = (text: string) => text.replace(/\s+/g, '').toLowerCase();
/** A role by its key (`site.slab`), its role name (`slab`) or its title (`슬래브 경계`). */
export function findRole(roles: readonly InputRole[], name: string): InputRole | undefined {
  const wanted = squash(name);
  return (
    roles.find((role) => squash(role.key) === wanted) ??
    roles.find((role) => squash(role.key.split('.').at(-1) ?? '') === wanted) ??
    roles.find((role) => squash(role.title) === wanted)
  );
}

/**
 * The layers the person did not name (SPEC-07.18 9): each layer's full path or last name part
 * must appear in the person's words — this turn's text or their own answers in the ledger (case
 * and spaces ignored). An AI's own choice is a proposal, never the person's confirmation.
 */
export function unnamedLayers(words: readonly string[], layers: readonly string[]): string[] {
  const said = squash(words.join(' '));
  if (!said) return [...layers];
  return layers.filter((layer) => {
    const whole = squash(layer);
    const last = squash(leaf(layer));
    return !(whole && said.includes(whole)) && !(last && said.includes(last));
  });
}
export const notNamedText = (layers: readonly string[]) =>
  `사람이 말하지 않은 레이어라 넣지 않았습니다: ${layers.join(', ')} — 제안으로 말하고 사람에게 확인받으세요`;

export type LayerPick = { document: JigInputDocument; layer: string; objectCount: number };
/** The closed-file note a role read from a closed linked file carries (SPEC-07.5 7). */
export const CLOSED_SOURCE_NOTE = '닫힌 연결 기준';
export type LayerProblem =
  | { error: 'UNKNOWN_LAYER'; layer: string; suggestions: string[] }
  | { error: 'AMBIGUOUS_LAYER'; layer: string; links: { linkId: string; name: string }[] }
  | { error: 'EMPTY_LAYER'; layer: string };
const leaf = (path: string) => path.split('::').at(-1) ?? path;
/**
 * Each named layer in the linked files: its full path, else its last name part (case and spaces
 * ignored). `linkId` keeps one file. A name found in several files is a question, not a guess.
 * Open files are looked in first; a closed file only when no open file holds the name (SPEC-07.5 7).
 */
export function resolveLayers(
  documents: readonly JigInputDocument[],
  names: readonly string[],
  linkId?: string,
): { picks: LayerPick[]; problems: LayerProblem[] } {
  const scope = linkId ? documents.filter((d) => d.linkId === linkId) : documents;
  const picks: LayerPick[] = [];
  const problems: LayerProblem[] = [];
  for (const name of names) {
    const wanted = squash(name);
    const within = (docs: readonly JigInputDocument[], test: (path: string) => boolean) =>
      docs.flatMap((document) =>
        document.layers
          .filter((layer) => test(layer.fullPath))
          .map((layer) => ({ document, layer: layer.fullPath, objectCount: layer.objectCount })),
      );
    const opened = scope.filter((document) => !document.closed);
    const closed = scope.filter((document) => document.closed);
    const match = (test: (path: string) => boolean) => {
      const found = within(opened, test);
      return found.length ? found : within(closed, test);
    };
    let found = match((path) => squash(path) === wanted);
    if (!found.length) found = match((path) => squash(leaf(path)) === wanted);
    if (!found.length) {
      const near = scope
        .flatMap((document) => document.layers.map((layer) => layer.fullPath))
        .filter((path) => {
          const a = squash(leaf(path));
          const b = squash(leaf(name));
          return a.includes(b) || b.includes(a);
        });
      problems.push({
        error: 'UNKNOWN_LAYER',
        layer: name,
        suggestions: [...new Set(near)].slice(0, 10),
      });
      continue;
    }
    const files = [...new Map(found.map((f) => [f.document.linkId, f.document])).values()];
    if (files.length > 1) {
      problems.push({
        error: 'AMBIGUOUS_LAYER',
        layer: name,
        links: files.map((d) => ({ linkId: d.linkId, name: d.name })),
      });
      continue;
    }
    const held = found.filter((f) => f.objectCount > 0);
    if (!held.length) problems.push({ error: 'EMPTY_LAYER', layer: found[0].layer });
    else
      for (const pick of held)
        if (
          !picks.some((p) => p.document.linkId === pick.document.linkId && p.layer === pick.layer)
        )
          picks.push(pick);
  }
  return { picks, problems };
}

export type JigInputResult =
  | {
      ok: true;
      /** The workbook (작업본) that changed: the instance on screen (SPEC-07.18 9.6). */
      workbook: { id: string; title: string };
      role: { key: string; title: string };
      layers: {
        linkId: string;
        file: string;
        layer: string;
        objectCount: number;
        /** Read from a closed linked file's last Sync (SPEC-07.5 7). */
        closed?: true;
        note?: typeof CLOSED_SOURCE_NOTE;
      }[];
      confirmedBy: typeof CHAT_CONFIRMED_BY;
      status: string;
      steps: { id: string; title: string; status: string }[];
      /** The steps whose status moved or that computed again (SPEC-07.18 9.6). */
      changedSteps: { id: string; title: string; from: string | null; to: string }[];
      /** The human step the run stopped before (SPEC-07.18 3.6), when one waits. */
      waitingFor?: { id: string; title: string };
      /** Required roles still without layers. */
      missing: { key: string; title: string }[];
    }
  | {
      ok: false;
      error: 'UNKNOWN_INPUT' | 'NO_LAYERS' | 'NOT_NAMED' | 'UNCHANGED' | LayerProblem['error'];
      message: string;
      /** NOT_NAMED: the layers the person did not name. */
      layers?: string[];
      /** UNCHANGED: what the role already holds. */
      role?: { key: string; title: string; layers: string[] };
      inputs?: { key: string; title: string; required: boolean; confirmed: boolean }[];
      problems?: LayerProblem[];
    };

const problemText = (problem: LayerProblem) =>
  problem.error === 'UNKNOWN_LAYER'
    ? `연결 파일에 '${problem.layer}' 레이어가 없습니다${problem.suggestions.length ? ` (비슷한 레이어: ${problem.suggestions.join(', ')})` : ''}`
    : problem.error === 'AMBIGUOUS_LAYER'
      ? `'${problem.layer}' 레이어가 여러 파일에 있습니다: ${problem.links.map((l) => l.name).join(', ')} — 어느 파일인지 정하세요`
      : `'${problem.layer}' 레이어에 객체가 없습니다`;

/**
 * Sets one input role to the layers a person named (SPEC-07.18 9): checked against the declared
 * roles and the linked files' layers, read and confirmed like [레이어 고르기], then the steps run
 * up to the next human step. Nothing is changed when a check fails.
 */
export async function assignJigInput(
  deps: JigInputDeps,
  projectId: string,
  instanceId: string,
  request: {
    input: string;
    layers: readonly string[];
    linkId?: string;
    reason?: string;
    /**
     * The layers the person did not name (SPEC-07.18 9): the AI tool passes it, a question card's
     * answer (the person's own pick) does not. Checked after the role and the layers resolve, so a
     * role already holding these layers says so instead.
     */
    unnamed?: (layers: readonly string[]) => string[];
  },
): Promise<JigInputResult> {
  const { runtime } = deps;
  const before = await runtime.view(projectId, instanceId);
  const roles = inputRoles(before);
  const role = findRole(roles, request.input);
  if (!role)
    return {
      ok: false,
      error: 'UNKNOWN_INPUT',
      message: `이 jig에 '${request.input}' 입력 역할이 없습니다`,
      inputs: roles.map(({ key, title, required, confirmed }) => ({
        key,
        title,
        required,
        confirmed,
      })),
    };
  const names = request.layers.map((layer) => layer.trim()).filter(Boolean);
  if (!names.length) return { ok: false, error: 'NO_LAYERS', message: '레이어를 하나 이상 주세요' };
  const documents = await deps.documents();
  const { picks, problems } = resolveLayers(documents, names, request.linkId);
  if (problems.length)
    return {
      ok: false,
      error: problems[0].error,
      message: problems.map(problemText).join(' · '),
      problems,
    };
  // Already these layers of these files, confirmed: nothing would change (SPEC-07.18 9.6) — the
  // person may have picked them on the role card first (held as `sync:<syncId>`, compared by the
  // Sync's linked file). Told, never reported as applied.
  const fileOf = (key: string) => {
    const [linkId, ...layer] = key.split('\n');
    if (!linkId.startsWith('sync:')) return key;
    const syncId = linkId.slice(5);
    const owner =
      documents.find((document) => document.syncId === syncId)?.linkId ?? deps.syncLink?.(syncId);
    return owner ? [owner, ...layer].join('\n') : key;
  };
  const held = role.held.map(fileOf);
  const wanted = new Set(picks.map((p) => `${p.document.linkId}\n${p.layer}`));
  if (role.confirmed && held.length === wanted.size && held.every((key) => wanted.has(key)))
    return {
      ok: false,
      error: 'UNCHANGED',
      message: `${role.title}은(는) 이미 ${role.layers.join(', ')}(으)로 확인돼 있어 바꾼 것이 없습니다`,
      role: { key: role.key, title: role.title, layers: role.layers },
    };
  const unnamed = request.unnamed?.(names) ?? [];
  if (unnamed.length)
    return { ok: false, error: 'NOT_NAMED', message: notNamedText(unnamed), layers: unnamed };
  // One read per file, of only the picked layers (SPEC-07.5 5).
  const sources: { readId: string; layers: string[] }[] = [];
  for (const document of [...new Set(picks.map((p) => p.document))]) {
    const layers = picks.filter((p) => p.document === document).map((p) => p.layer);
    const read = await deps.read(document, layers);
    const record = runtime.recordRead(projectId, instanceId, {
      linkId: read.linkId,
      revisionKey: read.revisionKey,
      layers,
      includeHidden: false,
      purpose: 'assembly',
      model: read.model,
    });
    sources.push({ readId: record.id, layers });
  }
  await runtime.setAssembly(projectId, instanceId, role.key, {
    sources,
    confirm: true,
    by: CHAT_CONFIRMED_BY,
    reason: request.reason ?? '대화에서 사람이 확인',
  });
  // Up to the next human step that waits (SPEC-07.18 3.6); none waits → every step (Rhino에
  // 만들기 stays the person's press).
  const steps = (await runtime.view(projectId, instanceId)).steps;
  const waiting = steps.find((step) => step.kind === 'human' && step.status !== 'confirmed');
  const report = await runtime.run(projectId, instanceId, {
    ...(waiting ? { until: waiting.id } : {}),
    mode: 'geometry',
  });
  const after = await runtime.view(projectId, instanceId);
  const titles = new Map(after.steps.map((step) => [step.id, step.title]));
  const was = new Map(before.steps.map((step) => [step.id, step.status as string]));
  const ran = new Set(
    report.steps
      .filter((step) => !step.cached && (step.status === 'done' || step.status === 'failed'))
      .map((step) => step.id),
  );
  return {
    ok: true,
    workbook: { id: instanceId, title: after.title },
    role: { key: role.key, title: role.title },
    layers: picks.map((p) => ({
      linkId: p.document.linkId,
      file: p.document.name,
      layer: p.layer,
      objectCount: p.objectCount,
      ...(p.document.closed ? { closed: true, note: CLOSED_SOURCE_NOTE } : {}),
    })),
    confirmedBy: CHAT_CONFIRMED_BY,
    status: report.status,
    steps: report.steps.map((step) => ({
      id: step.id,
      title: titles.get(step.id) ?? step.id,
      status: step.status,
    })),
    changedSteps: after.steps
      .filter((step) => ran.has(step.id) || was.get(step.id) !== step.status)
      .map((step) => ({
        id: step.id,
        title: step.title,
        from: was.get(step.id) ?? null,
        to: step.status,
      })),
    ...(waiting ? { waitingFor: { id: waiting.id, title: waiting.title } } : {}),
    missing: inputRoles(after)
      .filter((r) => r.required && !r.layers.length)
      .map(({ key, title }) => ({ key, title })),
  };
}
