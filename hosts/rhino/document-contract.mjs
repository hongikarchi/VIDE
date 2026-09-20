import {DomainError} from '../../src/core/store.mjs';
const literal=text=>'@"'+String(text).replaceAll('"','""')+'"';
export function documentGuard(instance,id){
 if(!/^\d+:\d+$/.test(instance)||!Number.isInteger(id)||id<=0||id>4294967295)throw new DomainError('INVALID_INPUT');
 return `var process=System.Diagnostics.Process.GetCurrentProcess();
 if(process.Id.ToString()+":"+process.StartTime.ToUniversalTime().Ticks.ToString()!=${literal(instance)})throw new Exception("Process changed");
 var document=Rhino.RhinoDoc.FromRuntimeSerialNumber(${id}u);
 if(document==null||document.IsHeadless)throw new Exception("Document closed");
 if(document.ModelUnitSystem==Rhino.UnitSystem.None||document.Objects.Count>500)throw new Exception("Unsupported document");`;
}
export const documentFingerprint=`var serialization=new Rhino.FileIO.SerializationOptions();
 var content=new System.Text.StringBuilder(document.ModelUnitSystem.ToString());
 foreach(var obj in document.Objects.OrderBy(o=>o.Id)){content.Append(obj.Id.ToString());content.Append(obj.Geometry.ToJSON(serialization));content.Append(obj.Attributes.ToJSON(serialization));}
 string fingerprint;using(var sha=System.Security.Cryptography.SHA256.Create()){fingerprint=BitConverter.ToString(sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(content.ToString()))).Replace("-","").ToLowerInvariant();}`;
