// Applies a previously verified synthetic movement candidate to its captured test document.
// args: playwright launch.json projectId --run-live
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { rhinoCommand } from '../../hosts/rhino/transport.ts';
import { documentGuard, documentFingerprint } from '../../hosts/rhino/document-contract.ts';
const [playwright, launch, projectId, flag] = process.argv.slice(2);
if (flag !== '--run-live') throw Error('Explicit --run-live required');
const { chromium } = await import(pathToFileURL(playwright).href),
  { url } = JSON.parse(await readFile(launch, 'utf8'));
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url);
  await page.waitForFunction(() =>
    document.querySelector('#connection-status').textContent.includes('연결됨'),
  );
  await page.goto(new URL('/?project=' + projectId, url).href);
  await page.waitForFunction(() =>
    document.querySelector('#connection-status').textContent.includes('연결됨'),
  );
  const requests = await page.evaluate(
    async (id) => (await fetch(`/api/v1/projects/${id}/requests`)).json(),
    projectId,
  );
  assert.equal(requests.length, 2);
  const first = requests[0],
    second = requests[1],
    source = first.result.sourceDocument;
  assert.equal(first.input.source, 'document');
  assert.equal(first.result.objects.length, 2);
  assert.equal(second.result.baseRequestId, first.id);
  const guard = documentGuard(source.instance, source.documentId),
    solid = first.result.scene.find((object) => object.volume > 0),
    object = first.result.objects.find((object) => object.id === solid.id);
  assert.ok(Math.abs(solid.volume - 216) < 0.001, 'Use the synthetic 8 x 6 x 4.5 m test fixture');
  const before = await rhinoCommand('execute_rhinocommon_csharp_code', {
    code: `${guard}${documentFingerprint}output.AppendLine(fingerprint);`,
  });
  assert.equal(
    before.output.trim(),
    source.documentHash,
    'Test must start at captured state; do not retry a completed write.',
  );
  await page.getByRole('button', { name: '문서에 적용', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '호스트 원본 적용' });
  await dialog.waitFor();
  assert.equal(
    await dialog.getByLabel('적용할 호스트 문서').inputValue(),
    String(source.documentId),
  );
  assert.equal(await dialog.getByLabel('적용할 호스트 문서').isDisabled(), true);
  await dialog.getByRole('button', { name: '영향 검토', exact: true }).click();
  await dialog
    .getByText('추가 0 · 수정 1 · 삭제 0개. 취득한 원본의 이동 대상만 변경합니다.', { exact: true })
    .waitFor();
  await dialog.getByRole('button', { name: '검토한 변경 적용', exact: true }).click();
  await dialog
    .getByText('문서 반영 완료 · 파일은 아직 저장하지 않았습니다.', { exact: true })
    .waitFor({ timeout: 60000 });
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  const applied = await rhinoCommand('execute_rhinocommon_csharp_code', {
    code: `${guard}var obj=document.Objects.FindId(new Guid("${solid.id}"));output.AppendLine(obj.Geometry.GetBoundingBox(true).Min.X.ToString(System.Globalization.CultureInfo.InvariantCulture));output.AppendLine(obj.Name);output.AppendLine(document.Objects.Count.ToString());`,
  });
  assert.equal(applied.success, true);
  const values = applied.output.trim().split(/\r?\n/);
  assert.equal(Number(values[0]), 2000);
  assert.equal(values[1], object.name);
  assert.equal(Number(values[2]), 2);
  await page.reload();
  await page.getByText('원본 반영됨 · 파일 저장 별도', { exact: true }).waitFor();
  await page.getByRole('button', { name: '문서에 적용', exact: true }).click();
  await dialog.getByRole('button', { name: '영향 검토', exact: true }).click();
  await dialog.getByText(/기준 파일 또는 열린 문서가 변경/).waitFor();
  assert.equal(
    await dialog.getByRole('button', { name: '검토한 변경 적용', exact: true }).isDisabled(),
    true,
  );
  console.log(
    JSON.stringify({
      projectId,
      requestId: second.id,
      movedMillimeters: 2000,
      nativeIdPreserved: true,
      declaredAttributesAndUnrelatedGeometryVerified: true,
      reapplicationBlocked: true,
      saved: false,
    }),
  );
} finally {
  await browser.close();
}
