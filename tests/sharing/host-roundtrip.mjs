import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { launchZwcadWorker } from '../../hosts/zwcad/worker-client.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';

// Deterministic agent replacement; the production controller, MCP and native SDK remain real.
export async function nativeSharingFixture(directory) {
  const worker = await launchZwcadWorker({
    directory: join(directory, 'zwcad-sdk-models', 'seed'),
  });
  let seed;
  try {
    seed = await worker.execute(
      randomUUID(),
      0,
      `var bt=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);
var space=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForWrite);
var p=new Polyline();p.AddVertexAt(0,new Point2d(0,0),0,0,0);p.AddVertexAt(1,new Point2d(24000,0),0,0,0);
p.AddVertexAt(2,new Point2d(24000,10000),0,0,0);p.AddVertexAt(3,new Point2d(0,10000),0,0,0);p.Closed=true;
space.AppendEntity(p);tr.AddNewlyCreatedDBObject(p,true);`,
    );
    assert.equal(seed.ok, true, JSON.stringify(seed));
  } finally {
    await worker.stop();
  }
  const result = {
    ...seed.model,
    filename: seed.filename,
    fileHash: seed.fileHash,
    verified: true,
    hostExecuted: true,
    host: 'zwcad',
    executionMode: 'sdk',
  };
  let calls = 0;
  const providerFactory = ({ agent }) => ({
    status: async () => ({ available: true }),
    run: async (context) => {
      calls++;
      assert.match(context.goal, /26/);
      assert.ok(context.items.some((item) => JSON.stringify(item).includes('Shared-feedback-')));
      const targetRef = context.goal.match(/work copy (zwcad:[a-f0-9-]+)/)?.[1];
      assert.ok(targetRef);
      const client = new Client({ name: 'deterministic-sharing-test', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(agent.url), {
          requestInit: { headers: { Authorization: 'Bearer ' + agent.token } },
        }),
      );
      try {
        const queried = await client.callTool({ name: 'query', arguments: { targetRef } });
        assert.equal(queried.isError, undefined);
        const changed = await client.callTool({
          name: 'execute',
          arguments: {
            targetRef,
            code: `var bt=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);
var space=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForRead);
foreach(ObjectId id in space){var p=(Polyline)tr.GetObject(id,OpenMode.ForWrite);p.SetPointAt(1,new Point2d(26000,0));p.SetPointAt(2,new Point2d(26000,10000));}`,
          },
        });
        assert.equal(changed.isError, undefined, JSON.stringify(changed));
        assert.equal(JSON.parse(changed.content[0].text).ok, true);
        return { text: '합성 검수: 폭 26 m 후보를 만들었습니다.' };
      } finally {
        await client.close();
      }
    },
  });
  return {
    result,
    options: { sdkOptions: sdkOptions(directory), providerFactory },
    async complete({ desktop, owner, local, draft, projectId, publication }) {
      const requestId = randomUUID();
      const call = async (path, body) => {
        const response = await desktop.evaluate(
          async ({ path, body }) => {
            const r = await fetch(
              '/api/v1' + path,
              body
                ? {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                  }
                : {},
            );
            return { status: r.status, value: await r.json() };
          },
          { path, body },
        );
        assert.ok(response.status < 300, JSON.stringify(response));
        return response.value;
      };
      assert.equal(calls, 0);
      await call(`/projects/${local.id}/requests`, {
        id: requestId,
        body: draft.instructions.join('\n'),
        host: 'zwcad',
        provider: 'codex-cli',
        permission: 'candidate',
        baseRequestId: draft.baseRequestId,
        pins: draft.pins,
        sketches: draft.sketches,
        files: draft.files,
      });
      let completed;
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        completed = await call(`/projects/${local.id}/requests/${requestId}`);
        if (!['queued', 'running'].includes(completed.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.equal(completed.state, 'succeeded', JSON.stringify(completed));
      assert.equal(calls, 1);
      assert.equal(completed.result.scene[0].area, 260);
      assert.equal(completed.result.objects[0].nativeId, result.objects[0].nativeId);
      assert.equal(
        createHash('sha256')
          .update(await readFile(seed.filename))
          .digest('hex'),
        seed.fileHash,
      );
      const file = await call(`/projects/${local.id}/requests/${requestId}/publication-export`, {
        title: '검토 반영 · 26 m',
        objectIds: [result.objects[0].id],
      });
      const published = await owner.evaluate(
        async ({ projectId, file }) => {
          const base = `/api/projects/${projectId}/publications`;
          const send = async (path, method, body) => {
            const r = await fetch(path, {
              method,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            if (!r.ok) throw Error(await r.text());
            return r.json();
          };
          const prepared = await send(base, 'POST', {
            requestId: file.requestId,
            manifest: file.manifest,
          });
          const uploaded = await fetch(base + '/' + prepared.id + '/assets/scene/0', {
            method: 'PUT',
            body: JSON.stringify(file.scene),
          });
          if (!uploaded.ok) throw Error(await uploaded.text());
          await send(base + '/' + prepared.id + '/finalize', 'POST', {});
          const current = await fetch(base + '/current');
          return current.json();
        },
        { projectId, file },
      );
      assert.notEqual(published.id, publication.id);
      assert.equal(published.manifest.title, '검토 반영 · 26 m');
      const prior = await owner.evaluate(
        async ({ projectId, id }) => {
          const r = await fetch(`/api/projects/${projectId}/publications/${id}/assets/scene/0`);
          return r.json();
        },
        { projectId, id: publication.id },
      );
      assert.notDeepEqual(prior, file.scene);
      await owner.reload();
      await owner.getByRole('heading', { name: '검토 반영 · 26 m', exact: true }).waitFor();
      await owner.locator('canvas').waitFor();
      await owner.getByLabel('객체 선택').selectOption(result.objects[0].id);
      await owner.getByRole('button', { name: '위', exact: true }).click();
      await owner.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await owner.screenshot({
        path: join(directory, 'host-feedback-republished.png'),
        fullPage: true,
      });
      return {
        actualZwcadFeedbackExecution: true,
        deterministicAgent: true,
        paidInferenceCalls: 0,
        originalUnchanged: true,
        priorPublicationRetained: true,
        feedbackRepublished: true,
      };
    },
  };
}
