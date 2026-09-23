import {csharpLiteral as literal} from '../common/csharp.ts';
import {z} from 'zod';
import {applicationPayloadSchema,applicationCandidateSchema} from './application-contract.ts';
import type {Movement} from './application-contract.ts';
import {documentGuard as guard,documentFingerprint as fingerprint} from './document-contract.ts';
import {legacyRhinoCommand as rhinoCommand} from './transport.ts';
import {DomainError} from '../../src/core/store.ts';
export async function previewApplication(projectId:string,instance:string,documentId:number,objects:{id:string}[]){
 if(!/^[a-zA-Z0-9-]+$/.test(projectId))throw new DomainError('INVALID_INPUT');
 const code=`${guard(instance,documentId)}${fingerprint}
 output.AppendLine(fingerprint);output.AppendLine(document.ModelUnitSystem.ToString());
 foreach(var obj in document.Objects)if(obj.Attributes.GetUserString("vide-project")==${literal(projectId)})output.AppendLine(obj.Attributes.GetUserString("vide-id"));`;
 const response=await rhinoCommand('execute_rhinocommon_csharp_code',{code},{timeoutMs:15000});
 if(!response.success)throw new DomainError('STALE_CONNECTION');
 const [hash,units,...owned]=response.output.trim().split(/\r?\n/);
 if(!/^[a-f0-9]{64}$/.test(hash)||new Set(owned).size!==owned.length)throw new DomainError('HOST_INVALID_RESPONSE');
 const wanted=objects.map(o=>o.id);
 return {documentHash:hash,units,added:wanted.filter(id=>!owned.includes(id)).length,updated:wanted.filter(id=>owned.includes(id)).length,removed:owned.filter(id=>!wanted.includes(id)).length};
}
export async function applyToDocument(projectId:string,commandId:string,candidateValue:unknown,payloadValue:unknown){
 const candidate=applicationCandidateSchema.parse(candidateValue),payload=applicationPayloadSchema.parse(payloadValue);
 const code=`bool started=false;
 try{
 ${guard(payload.instance,payload.documentId)}${fingerprint}
 if(fingerprint!=${literal(payload.documentHash)}){output.AppendLine("CONFLICT");return;}
 string fileHash;using(var sha=System.Security.Cryptography.SHA256.Create()){fileHash=BitConverter.ToString(sha.ComputeHash(System.IO.File.ReadAllBytes(${literal(candidate.filename)}))).Replace("-","").ToLowerInvariant();}
 if(fileHash!=${literal(payload.candidateHash)}){output.AppendLine("CONFLICT");return;}
 using(var source=Rhino.RhinoDoc.OpenHeadless(${literal(candidate.filename)})){
  if(source==null||source.ModelUnitSystem!=Rhino.UnitSystem.Meters)throw new Exception("Candidate units unavailable");
  var owned=document.Objects.Where(o=>o.Attributes.GetUserString("vide-project")==${literal(projectId)}).ToArray();
  if(owned.Any(o=>o.IsLocked||o.IsReference))throw new Exception("Locked target");
  var current=owned.ToDictionary(o=>o.Attributes.GetUserString("vide-id"),o=>o.Id);
  var wanted=new HashSet<string>();var staged=new List<Tuple<string,Rhino.Geometry.GeometryBase,string>>();
  double scale=Rhino.RhinoMath.UnitScale(Rhino.UnitSystem.Meters,document.ModelUnitSystem);
  foreach(var obj in source.Objects){var id=obj.Attributes.GetUserString("vide-id");if(String.IsNullOrEmpty(id)||!wanted.Add(id))throw new Exception("Invalid candidate identity");var geometry=obj.Geometry.Duplicate();if(!geometry.Transform(Rhino.Geometry.Transform.Scale(Rhino.Geometry.Point3d.Origin,scale))||!geometry.IsValid)throw new Exception("Invalid geometry");staged.Add(Tuple.Create(id,geometry,obj.Name??"Object"));}
  uint undo=document.BeginUndoRecord("VIDE candidate application");
  try{
   foreach(var item in staged){started=true;if(current.ContainsKey(item.Item1)){if(!document.Objects.Replace(current[item.Item1],item.Item2,false))throw new Exception("Replace failed");}else{var attributes=document.CreateDefaultAttributes();attributes.Name=item.Item3;attributes.SetUserString("vide-project",${literal(projectId)});attributes.SetUserString("vide-id",item.Item1);var added=document.Objects.Add(item.Item2,attributes);if(added==Guid.Empty)throw new Exception("Add failed");current.Add(item.Item1,added);}}
   foreach(var item in owned)if(!wanted.Contains(item.Attributes.GetUserString("vide-id"))){started=true;if(!document.Objects.Delete(item.Id,true))throw new Exception("Delete failed");}
   foreach(var item in staged){var live=document.Objects.FindId(current[item.Item1]);if(live==null||!live.Geometry.IsValid)throw new Exception("Verification failed");var expected=item.Item2.GetBoundingBox(true);var actual=live.Geometry.GetBoundingBox(true);if(expected.Min.DistanceTo(actual.Min)>document.ModelAbsoluteTolerance||expected.Max.DistanceTo(actual.Max)>document.ModelAbsoluteTolerance)throw new Exception("Geometry mismatch");}
   if(document.Objects.Count(o=>o.Attributes.GetUserString("vide-project")==${literal(projectId)})!=staged.Count)throw new Exception("Object count mismatch");
   document.Strings.SetString("vide-application",${literal(commandId)});document.Views.Redraw();
   output.AppendLine("OK|"+staged.Count.ToString());
  }finally{if(undo!=0)document.EndUndoRecord(undo);foreach(var item in staged)item.Item2.Dispose();}
 }
 }catch{output.AppendLine(started?"UNKNOWN":"REJECTED");}`;
 const response=await rhinoCommand('execute_rhinocommon_csharp_code',{code},{timeoutMs:60000});
 if(!response.success)throw new DomainError('HOST_REJECTED');
 const result=response.output.trim();
 if(result==='CONFLICT')return {state:'failed',result:{code:'SOURCE_CHANGED',applied:false}};
 if(result==='REJECTED')return {state:'failed',result:{code:'HOST_REJECTED',applied:false}};
 if(result==='UNKNOWN'||!/^OK\|\d+$/.test(result))return {state:'unknown',result:{code:'HOST_RESULT_UNKNOWN',applied:false}};
 return {state:'succeeded',result:{applied:true,saved:false,objectCount:Number(result.split('|')[1]),documentId:payload.documentId,instance:payload.instance}};
}
