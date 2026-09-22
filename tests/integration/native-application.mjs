// Applies existing synthetic candidates only to an explicitly identified empty test document.
// args: playwright, launch.json, project, first, second, instance, documentId, --run-live
import assert from 'node:assert/strict';import {readFile,mkdir} from 'node:fs/promises';import {pathToFileURL} from 'node:url';
import {listDocuments} from '../../hosts/rhino/documents.ts';import {rhinoCommand} from '../../hosts/rhino/transport.ts';
if(process.argv[9]!=='--run-live')throw Error('Explicit --run-live required');
const [playwright,launch,projectId,firstId,secondId,instance,documentId]=process.argv.slice(2,9);const id=Number(documentId);
const documents=await listDocuments();assert.equal(documents.instance,instance);assert.equal(documents.documents.find(d=>d.id===id)?.objectCount,0,'Test target must be empty; inspect prior result before resuming.');
const seed=await rhinoCommand('execute_rhinocommon_csharp_code',{code:`var doc=Rhino.RhinoDoc.FromRuntimeSerialNumber(${id}u);var attributes=new Rhino.DocObjects.ObjectAttributes();attributes.Name="Unrelated test point";attributes.SetUserString("vide-test","unrelated");output.AppendLine(doc.Objects.AddPoint(new Rhino.Geometry.Point3d(9000,9000,0),attributes).ToString());`});assert.equal(seed.success,true);
const {chromium}=await import(pathToFileURL(playwright).href),{url}=JSON.parse(await readFile(launch,'utf8'));const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}});await page.goto(url);await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('연결됨'));await page.goto(new URL('/?project='+projectId,url).href);await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('연결됨'));
 const apply=async(index)=>{
  await page.getByRole('button',{name:'문서에 적용',exact:true}).nth(index).click();await page.locator('.application-dialog').waitFor({state:'visible'});await page.getByLabel('적용할 Rhino 문서',{exact:true}).selectOption(String(id));await page.getByRole('button',{name:'영향 검토',exact:true}).click();await page.getByRole('button',{name:'검토한 변경 적용',exact:true}).waitFor({state:'visible'});await page.getByRole('button',{name:'검토한 변경 적용',exact:true}).click();await page.locator('.application-dialog').getByText('문서 반영 완료 · 파일은 아직 저장하지 않았습니다.',{exact:true}).waitFor({timeout:60000});await page.locator('.application-dialog').getByRole('button',{name:'닫기',exact:true}).click();
 };
 await apply(0);
 const inspect=async()=>{const response=await rhinoCommand('execute_rhinocommon_csharp_code',{code:`var doc=Rhino.RhinoDoc.FromRuntimeSerialNumber(${id}u);foreach(var obj in doc.Objects){if(obj.Attributes.GetUserString("vide-project")=="${projectId}"){var box=obj.Geometry.GetBoundingBox(true);output.AppendLine(obj.Id.ToString()+"|"+(box.Max.Z-box.Min.Z).ToString(System.Globalization.CultureInfo.InvariantCulture));}}output.AppendLine("count="+doc.Objects.Count.ToString());`});assert.equal(response.success,true);return response.output.trim().split(/\r?\n/);};
 const first=await inspect();assert.ok(first.includes('count=2'));assert.equal(Number(first[0].split('|')[1]),6000);
 await apply(1);const second=await inspect();assert.ok(second.includes('count=2'));assert.equal(Number(second[0].split('|')[1]),4500);assert.equal(first[0].split('|')[0],second[0].split('|')[0],'Replacement must preserve native object identity');
 await page.reload();await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('연결됨'));assert.equal(await page.getByText('원본 반영됨 · 파일 저장 별도',{exact:true}).count(),2);
 await mkdir('docs/assets/native-workspace',{recursive:true});await page.screenshot({path:'docs/assets/native-workspace/native-application.png'});
 console.log(JSON.stringify({applied:2,unrelatedPreserved:true,nativeIdPreserved:true,heightsMillimeters:[6000,4500],saved:false,projectId,firstId,secondId}));
}finally{await browser.close();}
