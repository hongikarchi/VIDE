import { csharpLiteral as literal } from '../common/csharp.ts';
import { z } from 'zod';
import {
  nativeApplicationPayloadSchema,
  applicationCandidateSchema,
} from './application-contract.ts';
import type { Movement } from './application-contract.ts';
import { legacyRhinoCommand as rhinoCommand } from './transport.ts';
import { DomainError } from '../../src/core/store.ts';
import { documentGuard, documentFingerprint, attributeSnapshot } from './document-contract.ts';
function movementsCode(movements: Movement[]) {
  if (
    !Array.isArray(movements) ||
    !movements.length ||
    movements.length > 500 ||
    movements.some(
      (item) =>
        !/^[-a-f0-9]{36}$/i.test(item.id) ||
        !Array.isArray(item.delta) ||
        item.delta.length !== 3 ||
        item.delta.some((value) => !Number.isFinite(value) || Math.abs(value) > 200000),
    )
  )
    throw new DomainError('INVALID_INPUT');
  return `var movements=new Dictionary<Guid,Rhino.Geometry.Vector3d>();${movements.map((item) => `movements.Add(new Guid(${literal(item.id)}),new Rhino.Geometry.Vector3d(${item.delta.join(',')}));`).join('')}
 foreach(var id in movements.Keys){var obj=document.Objects.FindId(id);if(obj==null||obj.IsLocked||obj.IsReference||obj.IsInstanceDefinitionGeometry||obj.Attributes.GroupCount>0||obj.HasHistoryRecord()||obj.HistoryParents().Length>0||obj.HistoryChildren().Length>0||!(obj.Geometry is Rhino.Geometry.Brep||obj.Geometry is Rhino.Geometry.Extrusion||obj.Geometry is Rhino.Geometry.Curve||obj.Geometry is Rhino.Geometry.Mesh||obj.Geometry is Rhino.Geometry.Point))throw new Exception("Unsupported target");}`;
}
export async function previewNativeApplication(
  instance: string,
  documentId: number,
  expectedHash: string,
  movements: Movement[],
) {
  const response = await rhinoCommand(
    'execute_rhinocommon_csharp_code',
    {
      code: `try{${documentGuard(instance, documentId)}${documentFingerprint}
 if(fingerprint!=${literal(expectedHash)}){output.AppendLine("CONFLICT");return;}
 ${movementsCode(movements)}output.AppendLine(fingerprint);output.AppendLine(document.ModelUnitSystem.ToString());}catch{output.AppendLine("REJECTED");}`,
    },
    { timeoutMs: 15000 },
  );
  if (!response.success) throw new DomainError('HOST_REJECTED');
  if (response.output.trim() === 'CONFLICT') throw new DomainError('SOURCE_CHANGED');
  if (response.output.trim() === 'REJECTED') throw new DomainError('UNSUPPORTED_NATIVE_TARGET');
  const [documentHash, units] = response.output.trim().split(/\r?\n/);
  if (!/^[a-f0-9]{64}$/.test(documentHash)) throw new DomainError('HOST_INVALID_RESPONSE');
  return {
    documentHash,
    units,
    added: 0,
    updated: movements.length,
    removed: 0,
    mode: 'native-move',
  };
}
export async function applyNativeMovements(
  commandId: string,
  candidateValue: unknown,
  payloadValue: unknown,
) {
  const candidate = applicationCandidateSchema.parse(candidateValue),
    payload = nativeApplicationPayloadSchema.parse(payloadValue);
  const code = `bool started=false;var staged=new Dictionary<Guid,Rhino.Geometry.GeometryBase>();
 try{
 ${documentGuard(payload.instance, payload.documentId)}${documentFingerprint}
 if(fingerprint!=${literal(payload.documentHash)}){output.AppendLine("CONFLICT");return;}
 string fileHash;using(var sha=System.Security.Cryptography.SHA256.Create()){fileHash=BitConverter.ToString(sha.ComputeHash(System.IO.File.ReadAllBytes(${literal(candidate.filename)}))).Replace("-","").ToLowerInvariant();}
 if(fileHash!=${literal(payload.candidateHash)}){output.AppendLine("CONFLICT");return;}
 ${movementsCode(payload.movements)}
 ${attributeSnapshot}
 var attributes=document.Objects.ToDictionary(obj=>obj.Id,obj=>attributeSnapshot(obj.Attributes));
 var unchanged=document.Objects.Where(obj=>!movements.ContainsKey(obj.Id)).ToDictionary(obj=>obj.Id,obj=>obj.Geometry.ToJSON(serialization));
 double scale=Rhino.RhinoMath.UnitScale(Rhino.UnitSystem.Meters,document.ModelUnitSystem);
 foreach(var move in movements){var geometry=document.Objects.FindId(move.Key).Geometry.Duplicate();var delta=move.Value*scale;if(!geometry.Translate(delta)||!geometry.IsValid)throw new Exception("Invalid translation");staged.Add(move.Key,geometry);}
 var evidencePath=${literal(candidate.filename + '.' + commandId + '.application')};
 using(var evidence=new System.IO.StreamWriter(new System.IO.FileStream(evidencePath,System.IO.FileMode.CreateNew,System.IO.FileAccess.Write))){
 evidence.WriteLine("VIDE-NATIVE-APPLICATION-2");evidence.WriteLine(${literal(commandId)});evidence.WriteLine(${literal(payload.instance)});evidence.WriteLine(${payload.documentId});evidence.WriteLine(fingerprint);evidence.WriteLine(document.ModelUnitSystem.ToString());evidence.WriteLine(attributes.Count);
 Func<string,string> encode=value=>Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(value));
 foreach(var obj in document.Objects){var expected=staged.ContainsKey(obj.Id)?staged[obj.Id]:obj.Geometry;evidence.WriteLine(obj.Id.ToString()+"|"+encode(attributes[obj.Id])+"|"+encode(obj.Geometry.ToJSON(serialization))+"|"+encode(expected.ToJSON(serialization)));}
 }
 string evidenceHash;using(var sha=System.Security.Cryptography.SHA256.Create()){evidenceHash=BitConverter.ToString(sha.ComputeHash(System.IO.File.ReadAllBytes(evidencePath))).Replace("-","").ToLowerInvariant();}
 uint undo=document.BeginUndoRecord("VIDE native movement");
 try{
 started=true;document.Strings.SetString(${literal('vide-evidence-' + commandId)},evidenceHash);
 foreach(var item in staged){started=true;if(!document.Objects.Replace(item.Key,item.Value,false))throw new Exception("Replace failed");}
 if(document.Objects.Count!=attributes.Count)throw new Exception("Object count changed");
 foreach(var entry in attributes){var obj=document.Objects.FindId(entry.Key);if(obj==null||attributeSnapshot(obj.Attributes)!=entry.Value)throw new Exception("Attributes changed");if(staged.ContainsKey(entry.Key)){if(!Rhino.Geometry.GeometryBase.GeometryEquals(staged[entry.Key],obj.Geometry))throw new Exception("Geometry mismatch");}else if(obj.Geometry.ToJSON(serialization)!=unchanged[entry.Key])throw new Exception("Unrelated object changed");}
 document.Strings.SetString("vide-application",${literal(commandId)});document.Views.Redraw();output.AppendLine("OK");
 }finally{if(undo!=0)document.EndUndoRecord(undo);}
 }catch(Exception error){output.AppendLine((started?"UNKNOWN":"REJECTED")+"|"+error.Message);}finally{foreach(var geometry in staged.Values)geometry.Dispose();}`;
  const response = await rhinoCommand(
    'execute_rhinocommon_csharp_code',
    { code },
    { timeoutMs: 60000 },
  );
  if (!response.success) throw new DomainError('HOST_REJECTED');
  const result = response.output.trim();
  if (result === 'CONFLICT')
    return { state: 'failed', result: { code: 'SOURCE_CHANGED', applied: false } };
  if (result.startsWith('REJECTED'))
    return { state: 'failed', result: { code: 'UNSUPPORTED_NATIVE_TARGET', applied: false } };
  if (result !== 'OK')
    return { state: 'unknown', result: { code: 'HOST_RESULT_UNKNOWN', applied: false } };
  return {
    state: 'succeeded',
    result: {
      applied: true,
      saved: false,
      objectCount: payload.movements.length,
      instance: payload.instance,
      documentId: payload.documentId,
    },
  };
}
