import {rhinoCommand} from './transport.mjs';
import {DomainError} from '../../src/core/store.mjs';
const literal=text=>'@"'+String(text).replaceAll('"','""')+'"';
function guard(instance,id){
 if(!/^\d+:\d+$/.test(instance)||!Number.isInteger(id)||id<=0||id>4294967295)throw new DomainError('INVALID_INPUT');
 return `var process=System.Diagnostics.Process.GetCurrentProcess();
 if(process.Id.ToString()+":"+process.StartTime.ToUniversalTime().Ticks.ToString()!=${literal(instance)})throw new Exception("Process changed");
 var document=Rhino.RhinoDoc.FromRuntimeSerialNumber(${id}u);
 if(document==null||document.IsHeadless)throw new Exception("Document closed");
 if(document.ModelUnitSystem==Rhino.UnitSystem.None||document.Objects.Count>500)throw new Exception("Unsupported document");`;
}
const fingerprint=`var serialization=new Rhino.FileIO.SerializationOptions();
 var content=new System.Text.StringBuilder(document.ModelUnitSystem.ToString());
 foreach(var obj in document.Objects.OrderBy(o=>o.Id)){content.Append(obj.Id.ToString());content.Append(obj.Geometry.ToJSON(serialization));content.Append(obj.Attributes.ToJSON(serialization));}
 string fingerprint;using(var sha=System.Security.Cryptography.SHA256.Create()){fingerprint=BitConverter.ToString(sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(content.ToString()))).Replace("-","").ToLowerInvariant();}`;
export async function previewApplication(projectId,instance,documentId,objects){
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
export async function applyToDocument(projectId,commandId,candidate,payload){
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
