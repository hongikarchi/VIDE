import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { SdkExecution } from '../../src/server/sdk-execution.ts';
import { ZwcadSdkExecution } from '../../src/server/zwcad-sdk-execution.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { runDirectory } from './run-directory.mjs';

const directory = runDirectory('native-query-pages');
await mkdir(directory, { recursive: true });
const evidence = [];
for (const host of ['rhino', 'zwcad']) {
  let handlers;
  const options = {
    ...sdkOptions(join(directory, host)),
    origin: () => '',
    tools: {
      issue: (scope) => {
        handlers = scope.handlers;
        return { token: 'test', revoke: () => {} };
      },
    },
  };
  // ZWCAD resolves its own installed executable/plugin rather than Rhino options.
  const sdk =
    host === 'rhino'
      ? new SdkExecution(options)
      : new ZwcadSdkExecution({
          directory: join(directory, host),
          origin: options.origin,
          tools: options.tools,
        });
  const result = await sdk.run({
    input: { body: 'Synthetic paging verification', permission: 'candidate', pins: [] },
    items: [],
    signal: new AbortController().signal,
    update: () => {},
    provider: () => ({
      run: async () => {
        const code =
          host === 'rhino'
            ? 'for(int i=0;i<120;i++)doc.Objects.AddPoint(new Point3d(i,0,0));'
            : 'var bt=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);var ms=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForWrite);for(int i=0;i<120;i++){var p=new Polyline();p.AddVertexAt(0,new Point2d(i*2000,0),0,0,0);p.AddVertexAt(1,new Point2d(i*2000+1000,0),0,0,0);ms.AppendEntity(p);tr.AddNewlyCreatedDBObject(p,true);}';
        const written = await handlers.execute({ code });
        assert.equal(written.ok, true);
        const summary = host === 'rhino' ? written.snapshot : written;
        assert.equal((summary.objects ?? summary.model.objects).length, 50);
        assert.equal(summary.page.total, 120);
        let offset = 0;
        const ids = [];
        do {
          const page = await handlers.query({ offset, expectedRevision: 1 });
          const objects = page.objects ?? page.model.objects;
          assert.equal(page.revision, 1);
          assert.equal(page.page.total, 120);
          assert.ok(objects.length <= 50);
          if (host === 'zwcad') assert.equal(page.model.sourceUnits, 4);
          ids.push(...objects.map((o) => o.id));
          offset = page.page.nextOffset;
        } while (offset !== null);
        assert.equal(new Set(ids).size, 120);
        const filtered = await handlers.query({ objectIds: [ids.at(-1)], expectedRevision: 1 });
        assert.equal(filtered.page.total, 1);
        assert.equal((filtered.objects ?? filtered.model.objects)[0].id, ids.at(-1));
        await assert.rejects(() => handlers.query({ offset: 50, expectedRevision: 0 }), {
          code: 'STALE_REFERENCE',
        });
        evidence.push({ host, objects: ids.length, pages: 3, filtered: true, staleRejected: true });
        return { text: 'Verified paginated reads' };
      },
    }),
  });
  assert.equal(result.objects.length, 120, 'Final native candidate must remain complete');
}
await writeFile(
  join(directory, 'result.json'),
  JSON.stringify({ passed: true, evidence }, null, 2),
);
console.log(JSON.stringify({ directory, passed: true, evidence }));
