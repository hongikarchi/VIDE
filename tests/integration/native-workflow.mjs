// Explicit live integration test: consumes subscription CLI calls and creates its own Rhino candidate files.
// node tests/integration/native-workflow.mjs <playwright-module> <launch.json> --run-live
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
if(process.argv[4]!=='--run-live')throw Error('Pass --run-live to create isolated native test candidates.');
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const {url}=JSON.parse(await readFile(process.argv[3],'utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 await page.goto(url);await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('연결됨'));
 const project=process.argv[5]?{id:process.argv[5]}:await page.evaluate(async()=>{const response=await fetch('/api/v1/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'통합 검수 '+new Date().toISOString()})});if(!response.ok)throw Error('Project creation failed');return response.json();});
 await page.goto(new URL('/?project='+project.id,url).href);await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('연결됨'));
 const model=await page.locator('#model option').evaluateAll(options=>options.map(o=>({id:o.value,label:o.textContent})).find(o=>/sol/i.test(o.label)&&/gpt/i.test(o.label))?.id);
 if(!model)throw Error('No verified Sol model in the connected catalog');
 await page.selectOption('#model',model);await page.selectOption('#effort','low');await page.selectOption('#permission','candidate');
 const submit=async(text,count)=>{
  await page.fill('#body',text);await page.locator('#request').click();
  const deadline=Date.now()+210000;
  while(true){
   const finished=await page.evaluate(async({projectId,count})=>{const rows=await(await fetch(`/api/v1/projects/${projectId}/requests`)).json();return rows.length>=count&&!['queued','running'].includes(rows.at(-1).state);},{projectId:project.id,count});
   if(finished)break;if(Date.now()>deadline)throw Error('Native request timed out; inspect saved request before resuming.');
   await new Promise(resolve=>setTimeout(resolve,500));
  }
  const rows=await page.evaluate(async id=>(await fetch(`/api/v1/projects/${id}/requests`)).json(),project.id);
  const result=rows.at(-1);assert.equal(result.state,'succeeded',JSON.stringify(result.result));assert.equal(result.result.hostExecuted,true);return result;
 };
 console.log('Verifying isolated Rhino candidate');
 const existing=await page.evaluate(async id=>(await fetch(`/api/v1/projects/${id}/requests`)).json(),project.id);
 const first=existing[0]||await submit('원점에 폭 8 m, 깊이 6 m, 높이 6 m인 박스 하나를 만들어. 이름은 검수 매스. 치수를 임의로 바꾸지 마.',1);
 assert.deepEqual(first.result.objects[0].size,[8,6,6]);
 await page.locator('#document-tree').evaluate(n=>n.open=true);await page.locator('#object-tree').evaluate(n=>n.open=true);
 await page.locator('#objects button').first().click();await page.locator('#selection-pin').click();
 console.log('Verifying pinned follow-up');
 const second=existing[1]||await submit('첨부한 매스 높이만 4.5 m로 바꿔. 폭 8 m, 깊이 6 m와 원점은 그대로 유지해.',2);
 assert.deepEqual(second.result.objects[0].size,[8,6,4.5]);assert.equal(second.result.baseRequestId,first.id);
 const comparison=await page.evaluate(async({projectId,before,after})=>(await fetch(`/api/v1/projects/${projectId}/comparison?before=${before}&after=${after}`)).json(),{projectId:project.id,before:first.id,after:second.id});
 assert.equal(comparison.compatible,true);assert.equal(comparison.rows[0].status,'changed');assert.ok(Math.abs(comparison.rows[0].delta.volume+72)<.001);
 await page.waitForFunction(()=>[...document.querySelectorAll('.chat-message button')].filter(b=>b.textContent==='수량표').length===2);
 await page.getByRole('button',{name:'수량표',exact:true}).last().click();await page.getByRole('dialog',{name:'후보 수량표',exact:true}).waitFor({state:'visible'});
 await page.getByLabel('비교할 이전 후보',{exact:true}).selectOption(first.id);await page.getByRole('button',{name:'현재 후보와 비교',exact:true}).click();await page.locator('.comparison-result').getByText(/체적/).waitFor();
 await mkdir('docs/assets/native-workspace',{recursive:true});await page.screenshot({path:'docs/assets/native-workspace/quantity-comparison.png'});
 console.log(JSON.stringify({projectId:project.id,first:first.id,second:second.id,beforeSize:first.result.objects[0].size,afterSize:second.result.objects[0].size,volumeDelta:comparison.rows[0].delta.volume}));
}finally{await browser.close();}
