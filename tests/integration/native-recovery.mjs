// Live Rhino recovery fault injection. AI is a deterministic test adapter; native execution is real.
// args: playwright instance documentId --run-live
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startServer } from '../../src/server/server.ts';
import { applyNativeMovements } from '../../hosts/rhino/native-application.ts';
const [playwright, instance, serial, flag] = process.argv.slice(2);
if (flag !== '--run-live') throw Error('Explicit --run-live required');
const documentId = Number(serial);
const directory = resolve('.vide', 'recovery-check', randomUUID());
await mkdir(directory, { recursive: true });
const filename = join(directory, 'workspace.sqlite');
let target,
  calls = 0;
const providerFactory = () => ({
  status: async () => ({ available: true }),
  run: async () => ({
    text: JSON.stringify({
      message: 'Recovery test movement',
      operations: [{ kind: 'move', id: target, delta: [1, 0, 0] }],
    }),
  }),
});
const applicationOptions = {
  nativeApply: async (...args) => {
    calls++;
    const actual = await applyNativeMovements(...args);
    assert.equal(actual.state, 'succeeded', JSON.stringify(actual));
    return { state: 'unknown', result: { code: 'HOST_RESULT_UNKNOWN' } };
  },
};
let app = await startServer({ filename, providerFactory, applicationOptions }),
  browser;
const authenticate = async () => {
  const response = await fetch(app.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
  });
  return response.headers.get('set-cookie').split(';')[0];
};
let cookie = await authenticate();
const api = async (path, body) => {
  const response = await fetch(app.origin + '/api/v1' + path, {
    method: body ? 'POST' : 'GET',
    headers: { Origin: app.origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify(result));
  return result;
};
try {
  const project = await api('/projects', { name: '원본 적용 응답 유실 검증' });
  const capture = await api(`/projects/${project.id}/capture`, {
    id: randomUUID(),
    instance,
    documentId,
  });
  assert.equal(capture.state, 'succeeded');
  assert.equal(capture.result.objects.length, 2);
  const solid = capture.result.scene.find((object) => object.volume > 0);
  assert.ok(Math.abs(solid.volume - 216) < 0.001);
  target = solid.id;
  const id = randomUUID();
  await api(`/projects/${project.id}/requests`, {
    id,
    provider: 'codex-cli',
    permission: 'candidate',
    baseRequestId: capture.id,
    body: 'Move test solid 1 m',
    pins: [],
    sketches: [],
    files: [],
  });
  let candidate;
  const deadline = Date.now() + 60000;
  while (true) {
    candidate = await api(`/projects/${project.id}/requests/${id}`);
    if (!['queued', 'running'].includes(candidate.state)) break;
    if (Date.now() > deadline) throw Error('Inspect persisted native job before retry');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(candidate.state, 'succeeded');
  const preview = await api(`/projects/${project.id}/applications`, {
    requestId: id,
    instance,
    documentId,
  });
  const outcome = await api(`/projects/${project.id}/applications/${preview.id}`, {});
  assert.equal(outcome.state, 'unknown');
  assert.equal(calls, 1);
  const evidence = candidate.result.filename + '.' + preview.id + '.application',
    saved = await readFile(evidence);
  await writeFile(evidence, Buffer.concat([saved, Buffer.from('corrupted')]));
  await app.close();
  app = await startServer({ filename, providerFactory, applicationOptions });
  cookie = await authenticate();
  assert.equal((await api(`/projects/${project.id}/applications/${preview.id}`)).state, 'unknown');
  const { chromium } = await import(pathToFileURL(playwright).href);
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  await page.goto(app.launchUrl);
  await page.getByRole('button', { name: '결과 다시 확인', exact: true }).click();
  await page
    .getByText('변경 전후의 확인 증거가 없어 자동 해소할 수 없습니다. 추가 적용은 보류합니다.', {
      exact: true,
    })
    .waitFor();
  assert.equal((await api(`/projects/${project.id}/applications/${preview.id}`)).state, 'unknown');
  await writeFile(evidence, saved);
  // A unit change invalidates recovery even when numeric coordinates have not changed.
  const { rhinoCommand } = await import('../../hosts/rhino/transport.ts');
  const change = await rhinoCommand('execute_rhinocommon_csharp_code', {
    code: `var doc=Rhino.RhinoDoc.FromRuntimeSerialNumber(${documentId}u);output.AppendLine(doc.ModelUnitSystem.ToString());doc.ModelUnitSystem=Rhino.UnitSystem.Meters;`,
  });
  assert.equal(change.success, true);
  assert.equal(change.output.trim(), 'Millimeters');
  try {
    const diverged = await api(`/projects/${project.id}/applications/${preview.id}/reconcile`, {});
    assert.equal(diverged.state, 'unknown');
    assert.equal(diverged.result.code, 'APPLICATION_DIVERGED');
  } finally {
    await rhinoCommand('execute_rhinocommon_csharp_code', {
      code: `Rhino.RhinoDoc.FromRuntimeSerialNumber(${documentId}u).ModelUnitSystem=Rhino.UnitSystem.Millimeters;`,
    });
  }
  await page.getByRole('button', { name: '결과 다시 확인', exact: true }).click();
  await page.getByText('원본 반영됨 · 파일 저장 별도', { exact: true }).waitFor();
  const recovered = await api(`/projects/${project.id}/applications/${preview.id}`);
  assert.equal(recovered.state, 'succeeded');
  assert.equal(recovered.result.reconciled, true);
  assert.equal(recovered.result.previousResult.code, 'HOST_RESULT_UNKNOWN');
  assert.equal(calls, 1);
  await page.reload();
  await page.getByText('원본 반영됨 · 파일 저장 별도', { exact: true }).waitFor();
  console.log(
    JSON.stringify({
      projectId: project.id,
      commandId: preview.id,
      hostWrites: 1,
      restartRecovered: true,
      tamperedEvidenceRejected: true,
      changedUnitsRejected: true,
      browserVerified: true,
    }),
  );
} finally {
  if (browser) await browser.close();
  await app.close();
}
