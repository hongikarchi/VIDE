import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runDirectory } from '../integration/run-directory.mjs';
const origin = process.env.VIDE_SHARING_TEST_ORIGIN;
if (origin !== 'https://vide-sharing-staging.archivibe.workers.dev')
  throw new Error('Explicit staging origin required');
const directory = runDirectory('sharing-remote');
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const contexts = [];
try {
  const user = async (label) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    contexts.push(context);
    const page = await context.newPage(),
      email = 'vide-' + label + '-' + Date.now() + '@example.com',
      password = randomBytes(24).toString('hex');
    await page.goto(origin);
    await page.getByRole('button', { name: '계정 만들기', exact: true }).click();
    await page.getByLabel('이름', { exact: true }).fill('VIDE test ' + label);
    await page.getByLabel('이메일', { exact: true }).fill(email);
    await page.getByLabel('비밀번호', { exact: true }).fill(password);
    await page.getByRole('button', { name: '계정 만들기', exact: true }).click();
    await page.getByRole('button', { name: '로그인', exact: true }).waitFor();
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await page.getByText('새 공유 프로젝트', { exact: true }).waitFor();
    return { context, page, email };
  };
  const owner = await user('owner'),
    member = await user('member');
  const call = async (user, path, method = 'GET', data) => {
    const r = await user.context.request.fetch(origin + '/api' + path, {
      method,
      headers: { Origin: origin },
      ...(data ? { data } : {}),
    });
    return { status: r.status(), value: await r.json() };
  };
  await owner.page.getByText('새 공유 프로젝트', { exact: true }).click();
  await owner.page.getByLabel('새 프로젝트 이름').fill('VIDE 무료 공유 시험');
  await owner.page.getByRole('button', { name: '만들기', exact: true }).click();
  await owner.page.getByText('프로젝트 공유 관리', { exact: true }).click();
  await owner.page.getByLabel('초대 이메일').fill(member.email);
  await owner.page.getByRole('button', { name: '초대', exact: true }).click();
  const link = await owner.page.getByRole('link', { name: '초대 링크' }).getAttribute('href');
  const projects = await call(owner, '/projects'),
    project = projects.value.projects[0].id;
  await member.page.goto(link);
  await member.page.getByRole('button', { name: '프로젝트 초대 수락' }).click();
  await member.page
    .getByText('참여를 신청했습니다. 소유자 승인 후 새로고침해 주세요.', { exact: true })
    .waitFor();
  assert.equal((await call(member, '/projects/' + project)).status, 404);
  await owner.page.getByRole('button', { name: '신청 새로고침' }).click();
  await owner.page.getByRole('button', { name: '참여 승인' }).click();
  await owner.page.getByText('참여 신청을 처리했습니다.', { exact: true }).waitFor();
  assert.equal((await call(member, '/projects/' + project)).status, 200);
  await member.page.reload();
  await member.page.getByRole('button', { name: 'VIDE 무료 공유 시험', exact: true }).waitFor();
  await owner.page.screenshot({ path: directory + '/owner.png' });
  await member.page.screenshot({ path: directory + '/member.png' });
  await owner.page.getByLabel(member.email + ' 권한').selectOption('remove');
  await owner.page.getByText('권한을 갱신했습니다.', { exact: true }).waitFor();
  assert.equal((await call(member, '/projects/' + project)).status, 404);
  assert.equal(
    (await call(owner, '/projects/' + project + '/publications', 'POST', {})).status,
    503,
  );
  assert.equal(
    (await call(owner, '/auth/request-password-reset', 'POST', { email: owner.email })).status,
    403,
  );
  assert.equal((await call(owner, '/auth/get-session')).value.user.emailVerified, false);
  await owner.page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await owner.page.getByRole('button', { name: '로그인', exact: true }).waitFor();
  assert.equal((await call(owner, '/projects')).status, 401);
  await writeFile(
    directory + '/result.json',
    JSON.stringify(
      {
        passed: true,
        origin,
        signupLoginBrowser: true,
        ownerApproval: true,
        revokedAccess: true,
        unverifiedPreserved: true,
        resetDisabled: true,
        uploadsDisabled: true,
        logout: true,
      },
      null,
      2,
    ),
  );
  console.log(directory);
} finally {
  await browser.close();
}
