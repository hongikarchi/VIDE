import { randomUUID } from 'node:crypto';
import { executionLimits } from '../contracts/execution-limits.ts';
import type { QueryPageOptions } from './query-page.ts';
import type { StoredWork } from '../contracts/stored-work.ts';
import type { Workspace } from '../core/workspace.ts';
import type { AgentTools } from './agent-tools.ts';
import type { SdkExecution, Task, AgentConnection } from './sdk-execution.ts';
import type { ZwcadSdkExecution } from './zwcad-sdk-execution.ts';

type Context = Parameters<ReturnType<Task['provider']>['run']>[0];
type Ready = { connection: AgentConnection; context: Context };
type Response = Awaited<ReturnType<ReturnType<Task['provider']>['run']>>;
type Driver = Pick<SdkExecution | ZwcadSdkExecution, 'run'>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const errorCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'LINKED_EXECUTION_FAILED';

/** One agent with explicitly federated capabilities; each existing driver owns its receipts. */
export async function runLinked(options: {
  request: StoredWork;
  workspace: Workspace;
  tools: AgentTools;
  drivers: Record<'rhino' | 'zwcad', Driver>;
  items: Task['items'];
  signal: AbortSignal;
  provider: Task['provider'];
  /** The project read tools of the turn (T-062), offered beside the targets' query/execute. */
  projectTools?: Task['projectTools'];
}) {
  const { request, workspace, tools, drivers, items, signal, provider, projectTools } = options;
  const targets = request.input.linkedTargets!;
  const gate = deferred<Response>();
  const ready = targets.map(() => deferred<Ready | null>());
  const children = targets.map((_, index) =>
    workspace.createLinkedChild(request, randomUUID(), index),
  );
  const resultRows = () =>
    children.map((child) => {
      const current = workspace.get(child.projectId, child.id);
      return {
        requestId: child.id,
        host: child.input.host,
        state: current.state,
        candidate: current.result?.hostExecuted === true,
      };
    });
  const refresh = () =>
    workspace.update(request.projectId, request.id, 'running', {
      phase: 'linked',
      hostExecuted: false,
      targetResults: resultRows(),
    });
  refresh();
  const running = children.map(async (child, index) => {
    let intent: Record<string, unknown> | undefined;
    try {
      const basis = workspace.get(child.projectId, targets[index].baseRequestId);
      const result = await drivers[targets[index].host].run({
        input: child.input,
        previous: { id: basis.id, result: basis.result! },
        items,
        signal,
        update: (progress) => {
          if (progress.phase === 'host') intent = progress;
          workspace.update(child.projectId, child.id, 'running', progress);
          refresh();
        },
        provider: (connection) => ({
          run: async (context) => {
            if (!connection.targetRef) throw Error('Missing driver target');
            ready[index].resolve({ connection, context });
            return gate.promise;
          },
        }),
      });
      workspace.update(child.projectId, child.id, 'succeeded', result);
    } catch (error) {
      const code = errorCode(error);
      const extra = error && typeof error === 'object' && 'intent' in error ? error.intent : intent;
      workspace.update(
        child.projectId,
        child.id,
        code === 'HOST_RESULT_UNKNOWN' ? 'unknown' : code === 'CANCELLED' ? 'cancelled' : 'failed',
        { ...(extra && typeof extra === 'object' ? extra : {}), code, hostExecuted: false },
      );
    } finally {
      ready[index].resolve(null);
      refresh();
    }
  });
  let scope: ReturnType<AgentTools['issue']> | undefined;
  let response: Response = { text: '' };
  let failure: string | undefined;
  try {
    const contexts = await Promise.all(ready.map((item) => item.promise));
    if (contexts.some((item) => !item))
      throw Object.assign(Error('Target unavailable'), { code: 'LINKED_TARGET_UNAVAILABLE' });
    const connected = contexts.filter((item): item is Ready => item !== null);
    const byTarget = new Map(connected.map((item) => [item.connection.targetRef!, item]));
    const dispatch = async (
      name: 'query' | 'execute',
      args: { targetRef: string; code?: string },
    ) => {
      const route = byTarget.get(args.targetRef);
      if (!route) throw Object.assign(Error('Target mismatch'), { code: 'TARGET_MISMATCH' });
      const result = await tools.call(route.connection.token, name, args);
      const text = result.content.find((item) => item.type === 'text');
      const value = text?.type === 'text' ? JSON.parse(text.text) : null;
      if (result.isError)
        throw Object.assign(Error('Child tool failed'), {
          code: value?.code || 'AGENT_TOOL_FAILED',
        });
      return value;
    };
    const handlers = {
      ...projectTools,
      query: (args: { targetRef: string } & QueryPageOptions) => dispatch('query', args),
      ...(request.input.permission === 'candidate'
        ? { execute: (args: { targetRef: string; code: string }) => dispatch('execute', args) }
        : {}),
    };
    scope = tools.issue({
      targetRef: [...byTarget.keys()],
      handlers,
      isCurrent: () => !signal.aborted,
      maxCalls: executionLimits(request.input).maxToolCalls,
      ttlMs: Math.min(600000, (executionLimits(request.input).timeoutSeconds + 60) * 1000),
    });
    response = await provider({
      url: connected[0].connection.url,
      token: scope.token,
      tools: Object.keys(handlers),
    }).run(
      {
        goal: `The user explicitly selected BOTH targets below. ${
          request.input.coordinateBasis === 'shared-metre-axes'
            ? 'The user confirmed both share one origin and axes once converted to metres; still report any feature that does not match.'
            : 'Each target keeps its own coordinates and units: a CAD drawing and a Rhino model of one project often use different origins (offsets, sometimes rotation or scale, and small decimal drifts). Before comparing or transferring geometry, establish the relation from matching features (grid lines, column centres, outlines) and state it (translation, rotation, scale, residual error); never assume shared coordinates.'
        } Query the modified source candidate before constructing the dependent target. Preserve each target's protected objects. Do not infer original application permission. If one target fails, report it without replaying another target's successful writes.\n${connected.map((item, index) => `Target ${index + 1}, basis ${targets[index].baseRequestId}:\n${item.context.goal}`).join('\n\n')}`,
        revision: 1,
        items,
        includedIds: items.map((item) => item.id),
      },
      { signal, onProgress: () => refresh() },
    );
  } catch (error) {
    failure = errorCode(error);
    response = { text: '연계 실행을 완료하지 못했습니다. 확인된 대상별 결과를 보존했습니다.' };
  } finally {
    scope?.revoke();
    // Let each driver export its confirmed candidate even when a different target failed.
    gate.resolve(response);
    await Promise.all(running);
  }
  const rows = resultRows();
  const complete = !failure && rows.every((row) => row.state === 'succeeded');
  workspace.update(request.projectId, request.id, complete ? 'succeeded' : 'failed', {
    ...response,
    phase: 'linked',
    hostExecuted: false,
    targetResults: rows,
    ...(failure ? { code: failure } : {}),
  });
}
