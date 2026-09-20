import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';
const [playwright,launch]=process.argv.slice(2),{chromium}=await import(pathToFileURL(playwright).href),{url}=JSON.parse(await readFile(launch,'utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}});await page.goto(url);await page.waitForFunction(()=>document.querySelector('#project-picker').value);
 await page.evaluate(async()=>{
  const {renderInspector}=await import('/inspector.mjs'),{attachNativeAttributes}=await import('/native-attributes.mjs');
  const object={id:'synthetic',name:'Attribute test'},request={id:'synthetic-basis',result:{host:'rhino',scene:[{id:object.id,attributes64:[[btoa('BuildingId'),btoa('TEST-01')],[btoa('Literal'),btoa('<script>window.injected=true</script>')]],attributesComplete:false}]}};
  window.attributeDraft={files:[],pins:[],baseRequestId:'kept'};
  renderInspector(object,request.result,request,'properties',{attachAttributes:()=>attachNativeAttributes(window.attributeDraft,request,object)});
  document.querySelector('#inspector-toggle').click();
 });
 await page.getByText('표시 속성을 요청에 첨부',{exact:true}).click();
 const state=await page.evaluate(()=>({draft:window.attributeDraft,injected:window.injected===true,text:document.querySelector('#inspector-content').textContent}));
 assert.equal(state.injected,false);assert.equal(state.draft.baseRequestId,'kept');assert.equal(state.draft.files.length,1);assert.match(state.text,/일부 속성만 읽었습니다/);assert.match(state.text,/<script>/);
 console.log(JSON.stringify({literalDisplay:true,explicitAttachment:true,basisPreserved:true}));
}finally{await browser.close();}
