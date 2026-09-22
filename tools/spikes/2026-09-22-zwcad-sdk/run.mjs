import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {launchOwnedRhino as launchOwnedProcess} from '../../../hosts/rhino/owned-process.ts';

const directory=resolve('.vide/zwcad-sdk',randomUUID());await mkdir(directory,{recursive:true});
const plugin=resolve('.vide/build/zwcad-sdk-probe/VIDE.Zwcad.SdkProbe.dll'),script=join(directory,'probe.scr');
const expectedFailure=process.argv.includes('--compile-error')?'COMPILE_FAILED':process.argv.includes('--runtime-error')?'EXPECTED_RUNTIME_FAILURE':null;
if(expectedFailure)await writeFile(join(directory,'code.cs'),expectedFailure==='COMPILE_FAILED'?'this is not C#;':`var blocks=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);var space=(BlockTableRecord)tr.GetObject(blocks[BlockTableRecord.ModelSpace],OpenMode.ForRead);foreach(ObjectId id in space){var line=tr.GetObject(id,OpenMode.ForWrite) as Polyline;if(line!=null)line.SetPointAt(1,new Point2d(100,100));}throw new InvalidOperationException("EXPECTED_RUNTIME_FAILURE");`);
if(expectedFailure&&process.argv.includes('--code'))throw Error('Choose a single probe mode');
if(process.argv.includes('--code'))await writeFile(join(directory,'code.cs'),`
var blocks=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);
var space=(BlockTableRecord)tr.GetObject(blocks[BlockTableRecord.ModelSpace],OpenMode.ForRead);
foreach(ObjectId id in space){
 var line=tr.GetObject(id,OpenMode.ForWrite) as Polyline;
 if(line==null)continue;
 line.SetPointAt(1,new Point2d(24000,0));line.SetPointAt(2,new Point2d(24000,10000));
 return new { handle=line.Handle.ToString(),areaSquareMetres=line.Area/1000000 };
}
throw new InvalidOperationException("NO_POLYLINE");
`);
await readFile(plugin);
await writeFile(script,`(command "_NETLOAD" ${JSON.stringify(plugin.replaceAll('\\','/'))})\nVIDESdkProbe\n`);
const owner=await launchOwnedProcess({executable:'C:/Program Files/ZWSOFT/ZWCAD 2023/ZWCAD.exe',args:['/b',script],visible:false,environment:{...process.env,VIDE_ZWCAD_PROBE_DIR:directory}});
await writeFile(join(directory,'process.json'),JSON.stringify(owner.identity,null,2));
try{
 const deadline=Date.now()+90000;let result;
 while(Date.now()<deadline){try{result=JSON.parse(await readFile(join(directory,'result.json'),'utf8'));break;}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,300));}
 if(!result)throw Error('ZWCAD_SDK_PROBE_TIMEOUT');
 if(expectedFailure){assert.equal(result.passed,false);assert.ok(result.message.startsWith(expectedFailure),JSON.stringify(result));assert.equal(result.sourceHashPreserved,true);assert.equal(result.candidateCreated,false);}
 else{assert.equal(result.passed,true,JSON.stringify(result));assert.equal(result.areaSquareMetres,200);assert.equal(result.lengthMetres,60);assert.equal(result.activeDocumentAccessed,false);
  if(process.argv.includes('--code')){assert.equal(result.candidateAreaSquareMetres,240);assert.equal(result.candidateLengthMetres,68);assert.equal(result.sourceHashPreserved,true);assert.equal(result.codeResult.handle,result.handle);}
 }
 const evidence={...result,verificationPassed:true,expectedFailure,directory};await writeFile(join(directory,'verification.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}catch(error){await writeFile(join(directory,'failure.json'),JSON.stringify({passed:false,error:error.message,directory},null,2));throw error;}
finally{await owner.stop();}
