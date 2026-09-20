// Saves and reopens an immutable review of an existing synthetic candidate; no AI or host writes.
// args: playwright launch.json projectId
import assert from 'node:assert/strict';import {readFile,mkdir} from 'node:fs/promises';import {pathToFileURL} from 'node:url';
const [playwright,launch,projectId]=process.argv.slice(2);const {chromium}=await import(pathToFileURL(playwright).href),{url}=JSON.parse(await readFile(launch,'utf8'));const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(url);await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('연결됨'));
 await page.goto(new URL('/?project='+projectId,url).href);await page.getByRole('button',{name:'검토본 저장',exact:true}).last().click();
 const creator=page.getByRole('dialog',{name:'검토본 저장',exact:true});await creator.getByLabel('검토본 제목').fill('검토 후보 · 레이어별 수량');const views=await creator.getByLabel('검토본 표 구성').locator('option').evaluateAll(options=>options.map(option=>option.value));assert.ok(views.length>1);await creator.getByLabel('검토본 표 구성').selectOption(views[1]);
 await creator.getByRole('button',{name:'검토본 저장',exact:true}).click();const viewer=page.getByRole('dialog',{name:'저장한 검토본',exact:true});await viewer.waitFor();const frame=viewer.frameLocator('iframe');await frame.getByRole('heading',{name:'검토 후보 · 레이어별 수량',exact:true}).waitFor();assert.ok((await frame.locator('body').innerText()).includes('그룹: 레이어별'));
 const download=page.waitForEvent('download');await viewer.getByRole('link',{name:'HTML 내려받기'}).click();const artifact=await download,html=await readFile(await artifact.path(),'utf8');assert.ok(html.includes('data:image/png;base64,'));assert.ok(!html.includes('api/v1'));assert.ok(!html.includes('C:\\Users'));assert.ok(html.includes('원본 반영 기록 없음'));
 await mkdir('docs/assets/native-workspace',{recursive:true});await page.screenshot({path:'docs/assets/native-workspace/saved-review.png'});
 await viewer.getByRole('button',{name:'닫기',exact:true}).click();await page.reload();await page.locator('#review-list').locator('..').evaluate(node=>node.open=true);await page.locator('#review-list').getByRole('button',{name:'검토 후보 · 레이어별 수량',exact:true}).first().click();await frame.getByRole('heading',{name:'검토 후보 · 레이어별 수량',exact:true}).waitFor();assert.deepEqual(errors,[]);
 console.log(JSON.stringify({projectId,persisted:true,embeddedImage:true,filteredTable:true,htmlPortable:true}));
}finally{await browser.close();}
