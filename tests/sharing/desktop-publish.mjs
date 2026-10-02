import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeSharingFixture } from './host-roundtrip.mjs';
import { startServer } from '../../src/server/server.ts';

export async function verifyDesktopPublish({
  browser,
  origin,
  alice,
  directory,
  db,
  projectId,
  reviewer,
}) {
  const native = process.argv.includes('--host')
    ? await nativeSharingFixture(directory)
    : undefined;
  const app = await startServer({
      filename: join(directory, 'desktop.sqlite'),
      ...native?.options,
    }),
    desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    owner = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    const local = app.store.createProject('Synthetic export'),
      other = app.store.createProject('Other'),
      id = 'publication-fixture';
    const input = {
      id,
      body: 'PRIVATE instruction',
      permission: 'candidate',
      provider: 'claude-cli',
      pins: [],
      sketches: [],
      files: [],
      source: 'file',
      host: native ? 'zwcad' : 'rhino',
    };
    const result = native?.result || {
      hostExecuted: true,
      verified: true,
      host: 'rhino',
      objects: [
        { id: 'object-1', name: 'Public object', kind: 'native', nativeId: 'PRIVATE-guid' },
        { id: 'hidden', name: 'PRIVATE hidden', kind: 'native' },
      ],
      scene: [
        {
          id: 'object-1',
          vertices: [0, 0, 0, 4, 0, 0, 4, 3, 0, 0, 3, 0, 0, 0, 5, 4, 0, 5, 4, 3, 5, 0, 3, 5],
          indices: [
            0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7,
            6, 3, 0, 4, 3, 4, 7,
          ],
          volume: 60,
          area: 94,
          nativeId: 'PRIVATE-guid',
        },
        { id: 'hidden', nativeType: 'Point', origin: [10, 10, 10] },
      ],
    };
    const objectId = result.objects[0].id;
    app.store.db
      .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run(
        id,
        local.id,
        JSON.stringify(input),
        'succeeded',
        JSON.stringify(result),
        new Date().toISOString(),
      );
    await desktop.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
    await desktop.route('**/api/v1/providers', (route) =>
      route.fulfill({
        json: [
          { id: 'claude-cli', available: false },
          { id: 'codex-cli', available: false },
        ],
      }),
    );
    await desktop.route('**/api/v1/models', (route) =>
      route.fulfill({
        json: [{ id: 'claude-cli', name: 'Test', provider: 'claude-cli', efforts: ['default'] }],
      }),
    );
    await desktop.goto(app.launchUrl);
    await desktop.getByRole('button', { name: '공유 자료', exact: true }).click();
    await desktop.getByLabel('게시 제목', { exact: true }).fill('브라우저 게시 검수');
    await desktop.getByLabel(result.objects[0].name, { exact: true }).check();
    const downloadPromise = desktop.waitForEvent('download');
    await desktop.getByRole('button', { name: '공유 자료 내려받기', exact: true }).click();
    const download = await downloadPromise,
      filename = join(directory, 'public-export.json');
    await download.saveAs(filename);
    const source = await readFile(filename, 'utf8'),
      file = JSON.parse(source);
    assert.doesNotMatch(source, /PRIVATE|hidden/);
    assert.equal(file.scene.objects.length, 1);
    const status = await desktop.evaluate(
      async ({ other, id }) =>
        (
          await fetch(`/api/v1/projects/${other}/requests/${id}/publication-export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Wrong project', objectIds: ['object-1'] }),
          })
        ).status,
      { other: other.id, id },
    );
    assert.equal(status, 404);
    await desktop.screenshot({ path: join(directory, 'desktop-export.png'), fullPage: true });
    await owner.goto(origin);
    await owner.getByLabel('이메일', { exact: true }).fill(alice.email);
    await owner.getByLabel('비밀번호', { exact: true }).fill(alice.password);
    await owner.getByRole('button', { name: '로그인', exact: true }).click();
    await owner.getByRole('button', { name: 'A', exact: true }).click();
    await owner.getByText('모델 게시', { exact: true }).click();
    await owner.getByLabel('공유 자료 파일').setInputFiles(filename);
    await owner.getByRole('heading', { name: '브라우저 게시 검수', exact: true }).waitFor();
    let lost = false;
    await owner.route('**/finalize', async (route) => {
      if (!lost) {
        lost = true;
        await route.fetch();
        await route.abort();
      } else await route.continue();
    });
    await owner.getByRole('button', { name: '이 자료 게시 / 재확인', exact: true }).click();
    await owner.getByText(/같은 파일의 게시 확인으로 이어갈 수 있습니다/).waitFor();
    await owner.reload();
    await owner.getByText('모델 게시', { exact: true }).click();
    await owner.getByRole('button', { name: '이 자료 게시 / 재확인', exact: true }).click();
    await owner.getByText('게시가 완료되었습니다.', { exact: true }).waitFor();
    await owner.locator('canvas').waitFor();
    assert.equal(
      (
        await db
          .prepare('SELECT count(*) n FROM publications WHERE project_id=? AND request_id=?')
          .bind(projectId, file.requestId)
          .first()
      ).n,
      1,
    );
    await owner.screenshot({ path: join(directory, 'published-from-desktop.png'), fullPage: true });
    const publication = await db
      .prepare('SELECT id FROM publications WHERE project_id=? AND request_id=?')
      .bind(projectId, file.requestId)
      .first();
    const noteInput = {
      submissionId: 'feedback-roundtrip',
      body: native ? '경계의 폭을 24 m에서 26 m로 변경해 주세요.' : '이 부분의 높이를 낮춰 주세요.',
      objectId,
      pin: { unit: 'm', position: [1, 2, 3] },
      sketches: [
        {
          plane: 'XZ',
          unit: 'm',
          role: 'path',
          points: [
            [1, 2],
            [2, 3],
            [3, 4],
          ],
        },
      ],
    };
    const posted = await (reviewer || owner).evaluate(
      async ({ projectId, publication, input }) => {
        const response = await fetch(
          `/api/projects/${projectId}/publications/${publication}/comments`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
          },
        );
        return { status: response.status, data: await response.json() };
      },
      { projectId, publication: publication.id, input: noteInput },
    );
    assert.equal(posted.status, 201);
    await owner.reload();
    const feedbackDownload = owner.waitForEvent('download');
    await owner.getByRole('link', { name: 'IDE용 의견 내려받기', exact: true }).last().click();
    const feedback = join(directory, 'feedback.json');
    await (await feedbackDownload).saveAs(feedback);
    await desktop.getByRole('button', { name: '닫기', exact: true }).click();
    // 외부 의견 sits in the 산출물 screen's head (T-109).
    await desktop.locator('.rail [data-workspace-target="output"]').click();
    await desktop.getByRole('button', { name: /^외부 의견/ }).click();
    await desktop.getByLabel('외부 의견 파일').setInputFiles(feedback);
    await desktop
      .getByText('의견을 로컬에 보관했습니다. 아직 작업 입력으로 채택하거나 실행하지 않았습니다.', {
        exact: true,
      })
      .waitFor();
    await desktop.getByLabel('외부 의견 파일').setInputFiles(feedback);
    await desktop
      .getByRole('button', { name: '외부 의견을 요청 초안에 첨부', exact: true })
      .click();
    const draft = await desktop.evaluate(
      (id) => JSON.parse(localStorage.getItem('vide:draft:' + id)),
      local.id,
    );
    assert.equal(draft.baseRequestId, id);
    assert.equal(draft.pins[0].basis, id);
    assert.deepEqual(draft.sketches[0].points, noteInput.sketches[0].points);
    assert.equal(draft.instructions[0], noteInput.body);
    const original = JSON.parse(
      draft.files.find((file) => file.name.startsWith('Shared-feedback-')).text,
    );
    assert.deepEqual(original.original.comment.input.pin, noteInput.pin);
    assert.equal(original.original.publicationId, publication.id);
    assert.equal(app.store.db.prepare('SELECT count(*) n FROM shared_feedback').get().n, 1);
    assert.equal(app.store.db.prepare('SELECT count(*) n FROM workspace_requests').get().n, 1);
    await desktop.screenshot({ path: join(directory, 'feedback-adopted.png'), fullPage: true });
    await desktop.reload();
    await desktop
      .getByRole('button', { name: '▧ 외부 의견 · 브라우저 게시 검수 제외', exact: true })
      .waitFor();
    await desktop.waitForFunction(
      (id) =>
        JSON.parse(localStorage.getItem('vide:draft:' + id) || 'null')?.files?.some((file) =>
          file.name.startsWith('Shared-feedback-'),
        ),
      local.id,
    );
    const hostEvidence = native
      ? await native.complete({ desktop, owner, local, draft, projectId, publication })
      : {};
    return {
      ...hostEvidence,
      desktopExplicitExport: true,
      crossProjectExportRejected: true,
      browserPublish: true,
      publishResponseLossReloadIdempotent: true,
      feedbackFileRoundtrip: true,
      feedbackDraftOnly: true,
    };
  } finally {
    await desktop.close();
    await owner.close();
    await app.close();
  }
}
