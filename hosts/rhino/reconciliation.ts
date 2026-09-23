import { csharpLiteral as literal } from '../common/csharp.ts';
import { z } from 'zod';
import {
  nativeApplicationPayloadSchema,
  applicationCandidateSchema,
} from './application-contract.ts';
import type { Movement } from './application-contract.ts';
import { legacyRhinoCommand as rhinoCommand } from './transport.ts';
import { DomainError } from '../../src/core/store.ts';
import { documentGuard, attributeSnapshot } from './document-contract.ts';
export async function reconcileNativeApplication(
  commandId: string,
  candidateValue: unknown,
  payloadValue: unknown,
) {
  const candidate = applicationCandidateSchema.parse(candidateValue),
    payload = nativeApplicationPayloadSchema.parse(payloadValue);
  const filename = candidate.filename + '.' + commandId + '.application';
  const code = `try{
 ${documentGuard(payload.instance, payload.documentId)}${attributeSnapshot}
 if(!System.IO.File.Exists(${literal(filename)})){output.AppendLine("MISSING");return;}
 string evidenceHash;using(var sha=System.Security.Cryptography.SHA256.Create()){evidenceHash=BitConverter.ToString(sha.ComputeHash(System.IO.File.ReadAllBytes(${literal(filename)}))).Replace("-","").ToLowerInvariant();}
 if(document.Strings.GetValue(${literal('vide-evidence-' + commandId)})!=evidenceHash){output.AppendLine("MISSING");return;}
 var lines=System.IO.File.ReadAllLines(${literal(filename)});
 if(lines.Length<7||lines[0]!="VIDE-NATIVE-APPLICATION-2"||lines[1]!=${literal(commandId)}||lines[2]!=${literal(payload.instance)}||lines[3]!=${literal(String(payload.documentId))}||lines[4]!=${literal(payload.documentHash)}){output.AppendLine("MISSING");return;}
 int count;if(!Int32.TryParse(lines[6],out count)||count<0||count>500||lines.Length!=count+7){output.AppendLine("MISSING");return;}
 if(document.Objects.Count!=count||document.ModelUnitSystem.ToString()!=lines[5]){output.AppendLine("DIVERGED");return;}
 bool matchesBefore=true,matchesAfter=true;var ids=new HashSet<Guid>();
 Func<string,string> decode=value=>System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(value));
 foreach(var line in lines.Skip(7)){
  var row=line.Split('|');Guid id;if(row.Length!=4||!Guid.TryParse(row[0],out id)||!ids.Add(id)){output.AppendLine("MISSING");return;}
  var obj=document.Objects.FindId(id);if(obj==null||attributeSnapshot(obj.Attributes)!=decode(row[1])){output.AppendLine("DIVERGED");return;}
  using(var before=Rhino.Runtime.CommonObject.FromJSON(decode(row[2])) as Rhino.Geometry.GeometryBase)
  using(var after=Rhino.Runtime.CommonObject.FromJSON(decode(row[3])) as Rhino.Geometry.GeometryBase){
   if(before==null||after==null){output.AppendLine("MISSING");return;}
   matchesBefore=matchesBefore&&Rhino.Geometry.GeometryBase.GeometryEquals(before,obj.Geometry);
   matchesAfter=matchesAfter&&Rhino.Geometry.GeometryBase.GeometryEquals(after,obj.Geometry);
  }
 }
 output.AppendLine(matchesAfter?"APPLIED":matchesBefore?"ORIGINAL":"DIVERGED");
 }catch{output.AppendLine("UNAVAILABLE");}`;
  const response = await rhinoCommand(
    'execute_rhinocommon_csharp_code',
    { code },
    { timeoutMs: 30000 },
  );
  if (!response.success) throw new DomainError('HOST_REJECTED');
  const evidence = {
    checkedAt: new Date().toISOString(),
    instance: payload.instance,
    documentId: payload.documentId,
  };
  if (response.output.trim() === 'APPLIED')
    return {
      state: 'succeeded',
      result: {
        ...evidence,
        applied: true,
        saved: false,
        reconciled: true,
        objectCount: payload.movements.length,
      },
    };
  if (response.output.trim() === 'ORIGINAL')
    return {
      state: 'failed',
      result: { ...evidence, applied: false, reconciled: true, code: 'SOURCE_RESTORED' },
    };
  return {
    state: 'unknown',
    result: {
      ...evidence,
      applied: false,
      reconciled: false,
      code:
        response.output.trim() === 'MISSING'
          ? 'APPLICATION_EVIDENCE_MISSING'
          : response.output.trim() === 'DIVERGED'
            ? 'APPLICATION_DIVERGED'
            : 'HOST_RESULT_UNKNOWN',
    },
  };
}
