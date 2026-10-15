// Synthetic project for the 파일 지도 (PLAN-52 T-318·T-319): a work folder with role folders, a
// stand-in server folder with two remembered roles, two linked files, xref, a Sync pair, two jig
// results (one feeding the other), a checkout, a reference image, notes naming files — 12+ files,
// every relation kind and exactly 30 events. Host files are fake bytes; nothing opens them.
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { XrefStore } from '../../src/core/xref-store.ts';

export const MAP_EVENT_COUNT = 30;
export const INSTANCE_A = 'aaaaaaaa-1111-4111-8111-111111111111';
export const INSTANCE_B = 'bbbbbbbb-2222-4222-8222-222222222222';
export const ATTACHMENT = 'abcdefabcdefabcdefabcdef';

const at = (day, hour = 9, minute = 0) =>
  new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString();

async function put(path, text = 'x') {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
  return path;
}

/**
 * Lays out the folders under `directory` and the records in `db` for `projectId`. Returns the
 * paths. `addFolder(path)` registers the work folder as the project's first project folder.
 */
export async function seedWorkspaceMap({ db, projectId, directory, dataDirectory, addFolder }) {
  const root = join(directory, '2603 합성 작업');
  const server = join(directory, '서버', '2603');
  const paths = {
    ops: '01_운영',
    raw: '02_자료',
    rhino: '03_모델',
    cad: '04_도면',
    review: '05_검토',
    output: '06_산출물',
    references: '08_레퍼런스',
  };
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'project.config.json'),
    JSON.stringify({
      schema: 'vide-workspace/1',
      title: '합성 작업',
      paths,
      server: {
        root: server,
        paths: { rhino: '모델', cad: '도면' },
        targets: {},
        checkout: { rhino: 'local', cad: 'server' },
      },
      vide: { projectId, createdAt: at(1) },
    }),
  );
  const file = {
    model: await put(join(root, '03_모델', 'main.3dm'), 'not a real model'),
    serverModel: await put(join(server, '모델', 'main.3dm'), 'not a real model'),
    plan: await put(join(root, '04_도면', 'A-평면.dwg'), 'not a real drawing'),
    base: await put(join(root, '04_도면', 'X-기준.dwg'), 'not a real drawing'),
    elevation: await put(join(server, '도면', 'B-입면.dwg'), 'not a real drawing'),
    dataA: await put(
      join(root, '05_검토', 'massing', '2026-10-02-1000-aaaaaaaa', 'data.json'),
      '{"vide":{"copy":"VIDE 사본 · vide-copy:jig-run"},"outputs":{}}',
    ),
    reportA: await put(
      join(root, '05_검토', 'massing', '2026-10-02-1000-aaaaaaaa', 'report.html'),
      '<!doctype html><p>개요 보고서</p>',
    ),
    dataB: await put(
      join(root, '05_검토', 'structure', '2026-10-03-0900-bbbbbbbb', 'data.json'),
      '{"outputs":{}}',
    ),
    minutes: await put(
      join(root, '01_운영', '회의록', '2026-10-04-협의.md'),
      '# 협의\n\nA-평면.dwg의 코어를 옮기기로 함. [파일 · B-입면.dwg] 도 맞출 것.\n',
    ),
    journal: await put(
      join(root, '01_운영', '일지', '2026-10-05.md'),
      '# 일지\n\n특이 사항 없음\n',
    ),
    picture: await put(join(root, '08_레퍼런스', '참고.png'), 'png'),
    brief: await put(join(root, '02_자료', '개요.pdf'), 'pdf'),
    other: await put(join(server, '기타', '메모.txt'), 'memo'),
    attachment: await put(
      join(dataDirectory, 'attachments', projectId, ATTACHMENT + '.png'),
      'png',
    ),
  };
  await utimes(file.serverModel, new Date(at(6, 8)), new Date(at(6, 8)));
  await utimes(file.elevation, new Date(at(7, 8)), new Date(at(7, 8)));
  await addFolder(root);

  const linkModel = 'link-model',
    linkPlan = 'link-plan';
  const insertLink = db.prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,?,?,?)');
  insertLink.run(
    linkModel,
    projectId,
    'rhino',
    'main.3dm',
    file.model,
    'rhino-1',
    1,
    0,
    at(1),
    at(1),
  );
  insertLink.run(
    linkPlan,
    projectId,
    'zwcad',
    'A-평면.dwg',
    file.plan,
    'zwcad-1',
    2,
    0,
    at(1),
    at(1),
  );

  const request = db.prepare(
    'INSERT INTO workspace_requests(id, projectId, input, state, result, createdAt) VALUES(?,?,?,?,?,?)',
  );
  const input = (extra) =>
    JSON.stringify({
      body: '요청',
      provider: 'codex-cli',
      pins: [],
      sketches: [],
      files: [],
      ...extra,
    });
  // 12 Syncs (6 per linked file), each with its manifest.
  const manifest = db.prepare('INSERT INTO sync_manifests VALUES(?,?,?,?,?,?,?,?)');
  const syncIds = [];
  for (let k = 0; k < 12; k++) {
    const id = `sync-${k}`;
    const linkId = k % 2 ? linkPlan : linkModel;
    request.run(id, projectId, input({ linkId, source: 'host' }), 'succeeded', '{}', at(2 + k, 10));
    manifest.run(id, projectId, null, 1, 1, 1, 0, at(2 + k, 10));
    syncIds.push(id);
  }
  // The model's Sync holds the object paired in the plan's baseline.
  db.prepare('INSERT INTO object_versions VALUES(?,?,?,?,?,?)').run(
    projectId,
    'v-obj-1',
    'object',
    '{}',
    null,
    0,
  );
  db.prepare('INSERT INTO sync_manifest_items VALUES(?,?,?,?,?,?,?)').run(
    'sync-0',
    projectId,
    'object',
    'obj-1',
    0,
    'v-obj-1',
    1,
  );
  db.prepare('INSERT INTO drawing_backflow_baselines VALUES(?,?,?,?,?,?)').run(
    projectId,
    file.plan.toLowerCase(),
    file.plan,
    JSON.stringify({
      path: file.plan,
      sha256: '0',
      handles: { '1A': 'd' },
      pairs: [
        {
          sourceId: 'obj-1',
          handle: '1A',
          via: 'sync',
          sourceLayer: '벽',
          source: null,
          sourceDigest: 's',
          entityDigest: 'e',
        },
      ],
      updatedAt: at(3),
    }),
    1,
    at(3),
  );
  // 9 requests that changed a file: own link, or through their basis Sync.
  for (let k = 0; k < 9; k++) {
    const own = k % 3 === 0;
    request.run(
      `edit-${k}`,
      projectId,
      input(own ? { linkId: linkModel } : { baseRequestId: syncIds[k] }),
      'succeeded',
      JSON.stringify({ changes: { added: ['a'], removed: [], modified: k % 2 ? ['m'] : [] } }),
      at(3 + k, 15),
    );
  }
  // A request that changed nothing: no event.
  request.run(
    'ask-0',
    projectId,
    input({ linkId: linkPlan }),
    'succeeded',
    JSON.stringify({ changes: { added: [], removed: [], modified: [] } }),
    at(4, 16),
  );
  // The reference image: attached to a request on the model, confirmed on its board.
  request.run(
    'ref-0',
    projectId,
    input({
      baseRequestId: 'sync-0',
      files: [
        {
          id: ATTACHMENT,
          name: '참고.png',
          size: 3,
          type: 'image/png',
          kind: 'image',
          path: file.attachment,
          copied: true,
        },
      ],
    }),
    'succeeded',
    '{}',
    at(5, 11),
  );
  await put(
    join(dataDirectory, 'reference-boards', projectId, ATTACHMENT + '.json'),
    JSON.stringify({
      attachmentId: ATTACHMENT,
      versions: [{ number: 1, confirmed: { at: at(5, 12), requestId: 'ref-0' } }],
    }),
  );

  // Two jig results: A reads the model, B takes A's output.
  const instance = db.prepare('INSERT INTO jig_instances VALUES(?,?,?,?,?,?,?,?,?)');
  instance.run(
    INSTANCE_A,
    projectId,
    'vide/massing',
    '1.0.0',
    '매스 검토',
    JSON.stringify({
      layerRoot: 'VIDE',
      assembly: {
        'site.mass': {
          role: 'mass',
          sources: [{ linkId: linkModel, readId: 'r', layers: [], revisionKey: 'k' }],
        },
      },
      params: {},
      zones: {},
      overrides: [],
    }),
    'computed',
    at(2, 9),
    at(4, 9),
  );
  instance.run(
    INSTANCE_B,
    projectId,
    'vide/structure',
    '1.0.0',
    '구조 검토',
    JSON.stringify({
      layerRoot: 'VIDE',
      assembly: {},
      params: {},
      zones: {},
      overrides: [],
      jigOutputs: { mass: { instanceId: INSTANCE_A, at: at(3) } },
    }),
    'computed',
    at(3, 9),
    at(5, 9),
  );
  const run = db.prepare('INSERT INTO jig_runs VALUES(?,?,?,?,?,?,?,?)');
  run.run(INSTANCE_A, 'read', 'h', null, 1, 'ok', null, at(2, 10, 0));
  run.run(INSTANCE_A, 'mass', 'h', null, 1, 'ok', null, at(3, 10, 0));
  run.run(INSTANCE_A, 'check', 'h', null, 1, 'ok', null, at(4, 10, 0));
  run.run(INSTANCE_A, 'report', 'h', null, 1, 'ok', null, at(4, 10, 0)); // same minute: one event
  run.run(INSTANCE_B, 'read', 'h', null, 1, 'ok', null, at(3, 11, 0));
  run.run(INSTANCE_B, 'check', 'h', null, 1, 'ok', null, at(5, 11, 0));

  // xref: the plan refers to the base drawing next to it.
  new XrefStore(db).replaceFiles(projectId, [
    {
      path: file.plan,
      size: 1,
      mtime: at(1),
      sha256: '0',
      readAt: at(2, 8),
      inFolders: true,
      read: {
        error: null,
        units: 4,
        scale: 0.001,
        unitsAssumed: false,
        xrefs: [{ name: 'X-기준', path: 'X-기준.dwg', overlay: false, status: 'resolved' }],
        inserts: [],
      },
    },
  ]);

  // One checkout of the server model, released later.
  db.exec(`CREATE TABLE IF NOT EXISTS checkouts(projectId TEXT NOT NULL, id TEXT NOT NULL,
    role TEXT NOT NULL, server_path TEXT NOT NULL, local_path TEXT NOT NULL, pc_id TEXT NOT NULL,
    user_id TEXT NOT NULL, checked_out_at TEXT NOT NULL, released_at TEXT,
    server_mtime_at_checkout TEXT NOT NULL, server_hash_at_checkout TEXT NOT NULL,
    PRIMARY KEY(projectId, id))`);
  db.prepare('INSERT INTO checkouts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
    projectId,
    'co-1',
    'rhino',
    file.serverModel,
    file.model,
    'pc',
    '홍길동',
    at(8, 9),
    at(9, 18),
    at(6, 8),
    'h',
  );
  return { root, server, file, linkModel, linkPlan };
}
