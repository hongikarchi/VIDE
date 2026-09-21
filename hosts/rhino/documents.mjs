import {hostDocumentsSchema,hostSelectionSchema} from '../../src/contracts/host-documents.ts';
import {documentGuard,documentFingerprint} from './document-contract.mjs';
import {rhinoCommand} from './transport.ts';
import {DomainError} from '../../src/core/store.mjs';
const session='var process=System.Diagnostics.Process.GetCurrentProcess();var session=process.Id.ToString()+":"+process.StartTime.ToUniversalTime().Ticks.ToString();';
export async function listDocuments(){
 const code=`${session}
 var rows=new List<string>();
 foreach(var document in Rhino.RhinoDoc.OpenDocuments(false)){
  var name=Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(document.Name??"Untitled"));
  rows.Add(document.RuntimeSerialNumber.ToString()+"|"+name+"|"+document.ModelUnitSystem.ToString()+"|"+document.Objects.Count.ToString()+"|"+(document.Modified?"1":"0"));
 }
 output.AppendLine(session);foreach(var row in rows)output.AppendLine(row);`;
 const result=await rhinoCommand('execute_rhinocommon_csharp_code',{code},{timeoutMs:8000});
 if(!result.success)throw new DomainError('HOST_REJECTED');
 const [instance,...rows]=result.output.trim().split(/\r?\n/);
 if(!/^\d+:\d+$/.test(instance))throw new DomainError('HOST_INVALID_RESPONSE');
 const parsed=hostDocumentsSchema.safeParse({instance,documents:rows.filter(Boolean).map(row=>{const [id,name,units,count,modified]=row.split('|');return {id:Number(id),name:Buffer.from(name,'base64').toString('utf8')||'무제',units,objectCount:Number(count),modified:modified==='1'};})});
 if(!parsed.success)throw new DomainError('HOST_INVALID_RESPONSE');return parsed.data;
}
export async function inspectDocument(instance,id){
 if(!/^\d+:\d+$/.test(instance)||!Number.isInteger(id)||id<=0||id>4294967295)throw new DomainError('INVALID_INPUT');
 const code=`${documentGuard(instance,id)}${documentFingerprint}
 output.AppendLine(document.RuntimeSerialNumber.ToString());output.AppendLine(fingerprint);
 foreach(var item in document.Objects.GetSelectedObjects(false,false))output.AppendLine(item.Id.ToString());`;
 const result=await rhinoCommand('execute_rhinocommon_csharp_code',{code},{timeoutMs:8000});
 if(!result.success)throw new DomainError('STALE_CONNECTION');
 const [serial,documentHash,...selectedIds]=result.output.trim().split(/\r?\n/);
 if(Number(serial)!==id||!/^[a-f0-9]{64}$/.test(documentHash))throw new DomainError('STALE_CONNECTION');
 const parsed=hostSelectionSchema.safeParse({instance,documentId:id,documentHash,selectedIds,observedAt:new Date().toISOString()});
 if(!parsed.success)throw new DomainError('HOST_INVALID_RESPONSE');return parsed.data;
}
