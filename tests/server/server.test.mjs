import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'vide-http-test-'));
  const app = await startServer({ filename: join(directory, 'test.sqlite') });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const api = (path, { body, method = 'GET', headers = {} } = {}) => fetch(app.origin + '/api/v1' + path,
    { method, headers: { Origin: app.origin, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const response = await api('/session', { method: 'POST', body: { token: new URL(app.launchUrl).hash.slice(1) } });
  const cookie = response.headers.get('set-cookie').split(';')[0];
  return { app, api: (path, options = {}) => api(path, { ...options, headers: { Cookie: cookie, ...options.headers } }), cookie };
}

test('쿠키 없는 접근, 다른 Origin, DNS rebinding Host를 거절한다', async t => {
  const { app, api } = await fixture(t);
  assert.equal((await fetch(app.origin + '/api/v1/projects')).status, 401);
  assert.equal((await api('/projects', { headers: { Origin: 'https://attacker.example' } })).status, 403);
  const rebound = await new Promise((resolve, reject) => {
    const request = httpRequest(app.origin + '/api/v1/projects', { headers: { Host: 'attacker.example' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }); request.on('error', reject); request.end();
  });
  assert.equal(rebound, 403);
  assert.equal((await api('/projects', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const response = await api('/session', { method: 'POST', body: { token: '한'.repeat(64) } });
  assert.equal(response.status, 401);
});

test('실제 HTTP 프로젝트·입력 저장과 다른 프로젝트 격리·버전 충돌', async t => {
  const { api } = await fixture(t);
  const project = await (await api('/projects', { method: 'POST', body: { name: '합성 프로젝트' } })).json();
  const other = await (await api('/projects', { method: 'POST', body: { name: '별도' } })).json();
  const note = await (await api(`/projects/${project.id}/inputs`, { method: 'POST', body: { text: '원본 보존', pins: [] } })).json();
  const inputPath = `/projects/${project.id}/inputs/${note.id}`;
  assert.equal((await api(inputPath, { method: 'PUT', body: { revision: 1, body: { text: '수정', pins: [] } } })).status, 200);
  assert.equal((await api(inputPath, { method: 'PUT', body: { revision: 1, body: { text: '오래된 수정', pins: [] } } })).status, 409);
  assert.equal((await api(`/projects/${other.id}/inputs/${note.id}`, { method: 'PUT', body: { revision: 2, body: { text: '오염', pins: [] } } })).status, 404);
  assert.deepEqual(await (await api(`/projects/${other.id}/inputs`)).json(), []);
  const saved = await (await api(`/projects/${project.id}/inputs`)).json(); assert.equal(saved[0].body.text, '수정');
});

test('API는 Origin 없는 쓰기와 실행 엔드포인트·경로 탈출을 허용하지 않는다', async t => {
  const { app, cookie, api } = await fixture(t);
  const response = await fetch(app.origin + '/api/v1/projects', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"name":"wrong"}' });
  assert.equal(response.status, 403);
  assert.equal((await api('/execute', { method: 'POST', body: {} })).status, 404);
  assert.equal((await fetch(app.origin + '/src/core/store.mjs')).status, 404);
  assert.equal((await fetch(app.origin + '/')).headers.get('content-security-policy').includes("frame-ancestors 'none'"), true);
});

test('UTF-8 바이트가 요청 청크 사이에 나뉘어도 한국어 입력이 보존된다', async t => {
  const { app, cookie } = await fixture(t), bytes = Buffer.from('{"name":"한글 프로젝트"}');
  const response = await new Promise((resolve, reject) => {
    const request = httpRequest(app.origin + '/api/v1/projects', { method: 'POST', headers: { Origin: app.origin, Cookie: cookie, 'Content-Type': 'application/json' } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(text) }));
    });
    request.on('error', reject); request.write(bytes.subarray(0, 10)); setTimeout(() => request.end(bytes.subarray(10)), 5);
  });
  assert.equal(response.status, 201); assert.equal(response.data.name, '한글 프로젝트');
});
