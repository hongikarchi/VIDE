// 스토리보드 브리프용 실제 화면 캡처 도구(docs/briefs/README.md「스토리보드 브리프」).
// 이미 만든 기능의 카드에 넣을 PNG를 개발 엔진 화면에서 찍는다. 외부 네트워크를 쓰지 않는다.
//
// 세션: tests/integration/browser-*.mjs와 같다. launch 링크(http://127.0.0.1:<port>/#<token>)를 열면
// 화면이 POST /api/v1/session 으로 쿠키를 받는다. 그 뒤 단계의 path는 같은 쿠키로 연다.
// 설치된 엔진(47821)·47831은 쓰지 않는다. 개발 엔진을 임의 포트·임시 데이터 폴더로 띄워 쓰고 끝나면 종료한다.
//
// 예:
//   node tools/briefs/capture.mjs --url http://127.0.0.1:48123 --token <임시데이터>/launch.json \
//     --out docs/briefs/assets/color-request --steps <scratch>/steps.json
//
// --token: launch.json(url에 #token) 또는 토큰 64자 한 줄 파일. --url을 빼면 launch.json의 주소를 쓴다.
// --steps: JSON 배열. 단계 하나 = { "name": "01-compose", "path"?: "/", "actions"?: [...], "clip"?: "<선택자>" }
//   "mask"?: ["<선택자>", ...] — 더 가릴 요소. 계정 이메일(상태 막대)은 늘 가린다.
//   actions 원소: {"goto":"/경로"} {"click":"<선택자>"} {"type":"<선택자>","text":"..."}
//                 {"press":"Enter"} {"wait":"<선택자>"} {"wait":500}(ms)
// 결과: 1280×800, 밝은 테마, <out>/<name>.png. stdout에 {"out":..., "steps":[이름...]} JSON.
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

// 브리프에 사람 정보가 들어가지 않게 늘 가리는 요소(src/ui/account-indicator.ts의 계정 표시).
const ALWAYS_MASK = ['[aria-label="현재 AI 계정"]'];

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`알 수 없는 인자: ${key}`);
    out[key.slice(2)] = argv[++i];
  }
  return out;
}

async function launchLink(urlArg, tokenPath) {
  const text = (await readFile(tokenPath, 'utf8')).trim();
  let origin = urlArg ? new URL(urlArg).origin : null;
  let token = text;
  if (text.startsWith('{')) {
    const link = new URL(JSON.parse(text).url);
    origin ??= link.origin;
    token = link.hash.slice(1);
  }
  if (!origin) throw new Error('--url이 필요하다(토큰 파일에 주소가 없음)');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('토큰 형식이 맞지 않다');
  const port = new URL(origin).port;
  if (port === '47821' || port === '47831') throw new Error('설치된 엔진 포트는 쓰지 않는다');
  return { origin, link: `${origin}/#${token}` };
}

async function run(page, origin, action) {
  if (action.goto !== undefined) await page.goto(origin + action.goto);
  else if (action.click) await page.locator(action.click).first().click();
  else if (action.type) await page.locator(action.type).first().fill(action.text ?? '');
  else if (action.press) await page.keyboard.press(action.press);
  else if (typeof action.wait === 'number') await page.waitForTimeout(action.wait);
  else if (action.wait) await page.locator(action.wait).first().waitFor();
  else throw new Error(`알 수 없는 동작: ${JSON.stringify(action)}`);
}

const opt = args(process.argv.slice(2));
if (!opt.token || !opt.out || !opt.steps)
  throw new Error('사용: --url <엔진 URL> --token <파일> --out <폴더> --steps <json>');
const { origin, link } = await launchLink(opt.url, opt.token);
const steps = JSON.parse(await readFile(opt.steps, 'utf8'));
const outDir = resolve(opt.out);
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const done = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'light',
  });
  // 밝은 테마 고정(src/ui/theme.ts의 저장 키).
  await context.addInitScript(() => {
    try {
      localStorage.setItem('vide:theme', 'light');
    } catch {}
  });
  // 외부 네트워크 차단: 엔진 주소 밖의 요청은 끊는다.
  await context.route('**/*', (route) =>
    route.request().url().startsWith(origin) || route.request().url().startsWith('data:')
      ? route.continue()
      : route.abort(),
  );
  const page = await context.newPage();
  const session = page.waitForResponse((r) => r.url().endsWith('/api/v1/session'), {
    timeout: 15000,
  });
  await page.goto(link);
  if (!(await session).ok()) throw new Error('세션을 열지 못했다(토큰 거부)');
  for (const step of steps) {
    if (!step.name || !/^[a-z0-9-]+$/.test(step.name))
      throw new Error(`단계 이름은 ASCII 소문자·숫자·-: ${step.name}`);
    if (step.path !== undefined) await page.goto(origin + step.path);
    for (const action of step.actions ?? []) await run(page, origin, action);
    await page.waitForLoadState('networkidle').catch(() => {});
    const file = join(outDir, `${step.name}.png`);
    const shot = {
      path: file,
      mask: [...ALWAYS_MASK, ...(step.mask ?? [])].map((s) => page.locator(s)),
      maskColor: '#e5e4e0',
    };
    if (step.clip) await page.locator(step.clip).first().screenshot(shot);
    else await page.screenshot(shot);
    done.push(step.name);
  }
} finally {
  await browser.close();
}
process.stdout.write(JSON.stringify({ out: outDir, steps: done }) + '\n');
