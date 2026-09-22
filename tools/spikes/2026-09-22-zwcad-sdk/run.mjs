import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {launchOwnedRhino as launchOwnedProcess} from '../../../hosts/rhino/owned-process.ts';

const directory=resolve('.vide/zwcad-sdk',randomUUID());await mkdir(directory,{recursive:true});
const plugin=resolve('.vide/build/zwcad-sdk-probe/VIDE.Zwcad.SdkProbe.dll'),script=join(directory,'probe.scr');
await readFile(plugin);
await writeFile(script,`(command "_NETLOAD" ${JSON.stringify(plugin.replaceAll('\\','/'))})\nVIDESdkProbe\n`);
const owner=await launchOwnedProcess({executable:'C:/Program Files/ZWSOFT/ZWCAD 2023/ZWCAD.exe',args:['/b',script],visible:false,environment:{...process.env,VIDE_ZWCAD_PROBE_DIR:directory}});
await writeFile(join(directory,'process.json'),JSON.stringify(owner.identity,null,2));
try{
 const deadline=Date.now()+90000;let result;
 while(Date.now()<deadline){try{result=JSON.parse(await readFile(join(directory,'result.json'),'utf8'));break;}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,300));}
 if(!result)throw Error('ZWCAD_SDK_PROBE_TIMEOUT');
 assert.equal(result.passed,true,JSON.stringify(result));assert.equal(result.areaSquareMetres,200);assert.equal(result.lengthMetres,60);assert.equal(result.activeDocumentAccessed,false);
 console.log(JSON.stringify({...result,directory}));
}catch(error){await writeFile(join(directory,'failure.json'),JSON.stringify({passed:false,error:error.message,directory},null,2));throw error;}
finally{await owner.stop();}
