import { csharpLiteral as literal } from '../common/csharp.ts';
import { z } from 'zod';
import { legacyObjectSchema } from '../../src/core/geometry.ts';
import type { GeometryObject } from '../../src/core/geometry.ts';
import { nativeSceneSchema } from '../../src/contracts/native-model.ts';
const baselineSchema = z
  .object({
    filename: z.string(),
    fileHash: z.string().optional(),
    objects: z.array(legacyObjectSchema),
  })
  .passthrough();
function sceneOutput(output: string) {
  try {
    return z.array(nativeSceneSchema).parse(JSON.parse(output));
  } catch {
    throw Object.assign(Error('HOST_RESULT_UNKNOWN'), { code: 'HOST_RESULT_UNKNOWN' });
  }
}
import { userAttributesCode } from './user-attributes.ts';
import { prepareNativeCopies } from './native-copy.ts';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { legacyRhinoCommand as rhinoCommand } from './transport.ts';
import { spawn } from 'node:child_process';

const point = (p: number[]) => `new Rhino.Geometry.Point3d(${p.join(',')})`;
const fingerprint = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
/** Fixed RhinoCommon programs compiled from validated geometry, never model-authored code. */
export class RhinoWorkspace {
  directory: string;
  constructor(directory: string) {
    this.directory = resolve(directory);
  }
  async open(filename: string) {
    const target = resolve(filename);
    if (!target.startsWith(this.directory + '\\') && !target.startsWith(this.directory + '/'))
      throw Error('INVALID_ARTIFACT');
    const executable = join(
      process.env.ProgramFiles || 'C:\\Program Files',
      'Rhino 8',
      'System',
      'Rhino.exe',
    );
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, ['/nosplash', target], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
    return { opened: true };
  }
  async status() {
    try {
      const result = await rhinoCommand(
        'execute_rhinocommon_csharp_code',
        { code: 'output.AppendLine(Rhino.RhinoApp.Version.ToString());' },
        { timeoutMs: 4000 },
      );
      return { available: result.success === true, version: result.output?.trim() };
    } catch (error) {
      return {
        available: false,
        reason:
          error && typeof error === 'object' && 'code' in error ? error.code : 'HOST_UNAVAILABLE',
      };
    }
  }
  async importFile(projectId: string, requestId: string, source: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(projectId) || !/^[a-zA-Z0-9-]+$/.test(requestId))
      throw Error('INVALID_ID');
    const directory = join(this.directory, projectId);
    await mkdir(directory, { recursive: true });
    const filename = join(directory, requestId + '.3dm');
    const code = `using(var work=Rhino.RhinoDoc.OpenHeadless(${literal(source)})){
      if(work==null)throw new Exception("Invalid 3dm");
      if(work.ModelUnitSystem==Rhino.UnitSystem.None)throw new Exception("Unknown units");
      work.AdjustModelUnitSystem(Rhino.UnitSystem.Meters,true);
      foreach(var obj in work.Objects){var attributes=obj.Attributes.Duplicate();attributes.SetUserString("vide-id",obj.Id.ToString());work.Objects.ModifyAttributes(obj,attributes,true);}
      var options=new Rhino.FileIO.FileWriteOptions();options.SuppressDialogBoxes=true;options.SuppressAllInput=true;
      if(!work.Write3dmFile(${literal(filename)},options))throw new Exception("Save failed");
    }${readback(filename)}`;
    const response = await rhinoCommand(
      'execute_rhinocommon_csharp_code',
      { code },
      { timeoutMs: 60000 },
    );
    if (!response.success)
      throw Object.assign(new Error('HOST_REJECTED'), {
        code: 'HOST_REJECTED',
        detail: response.message,
      });
    const scene = sceneOutput(response.output);
    if (scene.some((o) => !o.valid))
      throw Object.assign(new Error('IMPORT_LIMIT'), { code: 'IMPORT_LIMIT' });
    const objects = scene.map((o) => ({
      id: o.id,
      nativeId: o.nativeId,
      kind: 'native' as const,
      name: Buffer.from(o.name64, 'base64').toString('utf8'),
      origin: o.origin,
    }));
    return { objects, scene, filename, fileHash: await fingerprint(filename), verified: true };
  }
  async build(
    projectId: string,
    requestId: string,
    objects: GeometryObject[],
    baselineValue?: unknown,
  ) {
    const baseline = baselineValue === undefined ? undefined : baselineSchema.parse(baselineValue);
    if (!/^[a-zA-Z0-9-]+$/.test(projectId) || !/^[a-zA-Z0-9-]+$/.test(requestId))
      throw Error('INVALID_ID');
    const directory = join(this.directory, projectId);
    await mkdir(directory, { recursive: true });
    const filename = join(directory, requestId + '.3dm');
    if (baseline?.fileHash && (await fingerprint(baseline.filename)) !== baseline.fileHash)
      throw Object.assign(new Error('SOURCE_CHANGED'), { code: 'SOURCE_CHANGED' });
    const copies = prepareNativeCopies(objects, baseline);
    const operations = objects
      .map((o, i) => {
        if (o.kind === 'native') {
          const previous = baseline?.objects.find((x) => x.id === o.id);
          if (!previous) {
            if (copies.additions.has(o.id)) return copies.additions.get(o.id);
            throw Error('MISSING_NATIVE_BASE');
          }
          if (previous.kind !== 'native') throw Error('MISSING_NATIVE_BASE');
          const delta = o.origin.map((n, j) => n - previous.origin[j]);
          return `var original${i}=work.Objects.FindId(new Guid(${literal(previous.nativeId)}));if(original${i}==null)throw new Exception("Missing source");
          if(!work.Objects.Transform(original${i}.Id,Rhino.Geometry.Transform.Translation(${delta.join(',')}),true).Equals(Guid.Empty)){}else throw new Exception("Transform failed");`;
        }
        let geometry;
        if (o.kind === 'box')
          geometry = `new Rhino.Geometry.BoundingBox(${point(o.origin)},${point(o.origin.map((n, j) => n + o.size[j]))}).ToBrep()`;
        else {
          const curve = `new Rhino.Geometry.PolylineCurve(new Rhino.Geometry.Point3d[]{${o.points.map(point).join(',')}})`;
          geometry =
            o.kind === 'extrude'
              ? `Rhino.Geometry.Extrusion.Create(${curve},${o.height},true)`
              : curve;
        }
        return `var g${i}=${geometry}; if(g${i}==null || !g${i}.IsValid)throw new Exception("Invalid geometry");
        var a${i}=new Rhino.DocObjects.ObjectAttributes();a${i}.Name=${literal(o.name)};a${i}.SetUserString("vide-id",${literal(o.id)});
        if(work.Objects.Add(g${i},a${i})==Guid.Empty)throw new Exception("Add failed");`;
      })
      .join('\n');
    const wanted = objects.filter((o) => o.kind === 'native').map((o) => o.id);
    const code = `using(var work=${baseline?.filename ? `Rhino.RhinoDoc.OpenHeadless(${literal(baseline.filename)})` : 'Rhino.RhinoDoc.CreateHeadless(null)'}){
      ${copies.prepare}
      var keep=new HashSet<string>(new string[]{${wanted.map(literal).join(',')}});
      foreach(var old in work.Objects.ToArray())if(!keep.Contains(old.Attributes.GetUserString("vide-id")))work.Objects.Delete(old.Id,true);
      work.ModelUnitSystem=Rhino.UnitSystem.Meters;work.ModelAbsoluteTolerance=0.001;
      ${operations}
      var options=new Rhino.FileIO.FileWriteOptions();options.SuppressDialogBoxes=true;options.SuppressAllInput=true;
      if(!work.Write3dmFile(${literal(filename)},options))throw new Exception("Save failed");
    }
    ${readback(filename)}`;
    const response = await rhinoCommand(
      'execute_rhinocommon_csharp_code',
      { code },
      { timeoutMs: 60000 },
    );
    if (!response.success)
      throw Object.assign(new Error('HOST_REJECTED'), {
        code: 'HOST_REJECTED',
        detail: response.message,
      });
    const scene = sceneOutput(response.output);
    if (scene.length !== objects.length || scene.some((o) => !o.valid))
      throw Object.assign(new Error('HOST_VERIFICATION_FAILED'), {
        code: 'HOST_VERIFICATION_FAILED',
      });
    return { scene, filename, fileHash: await fingerprint(filename), verified: true };
  }
}

function readback(filename: string) {
  return `    using(var verify=Rhino.RhinoDoc.OpenHeadless(${literal(filename)})){
      var result=new List<string>();int remainingAttributeBytes=262144;
      foreach(var obj in verify.Objects){
        var bounds=obj.Geometry.GetBoundingBox(true);
        var vertices=new List<double>();var indices=new List<int>();var line=new List<double>();
        var brep=obj.Geometry as Rhino.Geometry.Brep;var extrusion=obj.Geometry as Rhino.Geometry.Extrusion;if(extrusion!=null)brep=extrusion.ToBrep();
        var nativeMesh=obj.Geometry as Rhino.Geometry.Mesh;
        var meshes=brep!=null?Rhino.Geometry.Mesh.CreateFromBrep(brep,Rhino.Geometry.MeshingParameters.FastRenderMesh):nativeMesh!=null?new Rhino.Geometry.Mesh[]{nativeMesh}:new Rhino.Geometry.Mesh[0];
        foreach(var mesh in meshes){
          int offset=vertices.Count/3;foreach(var v in mesh.Vertices){vertices.Add(v.X);vertices.Add(v.Y);vertices.Add(v.Z);}
          foreach(var f in mesh.Faces){indices.Add(offset+f.A);indices.Add(offset+f.B);indices.Add(offset+f.C);if(f.IsQuad){indices.Add(offset+f.A);indices.Add(offset+f.C);indices.Add(offset+f.D);}}
        }
        var curve=obj.Geometry as Rhino.Geometry.Curve;
        if(curve!=null){Rhino.Geometry.Polyline poly; if(curve.TryGetPolyline(out poly)){foreach(var p in poly){line.Add(p.X);line.Add(p.Y);line.Add(p.Z);}}else{foreach(var t in curve.DivideByCount(128,true)){var p=curve.PointAt(t);line.Add(p.X);line.Add(p.Y);line.Add(p.Z);}}}
        var area=brep!=null?Rhino.Geometry.AreaMassProperties.Compute(brep):curve!=null&&curve.IsClosed?Rhino.Geometry.AreaMassProperties.Compute(curve):null;
        var volume=brep!=null&&brep.IsSolid?Rhino.Geometry.VolumeMassProperties.Compute(brep):null;
        Func<double,string> number=n=>n.ToString("R",System.Globalization.CultureInfo.InvariantCulture);
        var nativeLength=curve!=null?curve.GetLength():0;
        ${userAttributesCode}
        result.Add("{\\"attributes64\\":["+String.Join(",",attributePairs)+"],\\"attributesComplete\\":"+(attributesComplete?"true":"false")+",\\"boundsSize\\":["+number(bounds.Max.X-bounds.Min.X)+","+number(bounds.Max.Y-bounds.Min.Y)+","+number(bounds.Max.Z-bounds.Min.Z)+"],\\"length\\":"+(nativeLength>0?number(nativeLength):"null")+",\\"layer64\\":\\""+Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(verify.Layers[obj.Attributes.LayerIndex].FullPath))+"\\",\\"id\\":\\""+obj.Attributes.GetUserString("vide-id")+"\\",\\"nativeId\\":\\""+obj.Id+"\\",\\"nativeType\\":\\""+obj.Geometry.ObjectType.ToString()+"\\",\\"name64\\":\\""+Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(obj.Name??"Object"))+"\\",\\"origin\\":["+number(bounds.Min.X)+","+number(bounds.Min.Y)+","+number(bounds.Min.Z)+"],\\"vertices\\":["+String.Join(",",vertices.Select(number))+"],\\"indices\\":["+String.Join(",",indices)+"],\\"line\\":["+String.Join(",",line.Select(number))+"],\\"area\\":"+(area!=null?number(area.Area):"null")+",\\"volume\\":"+(volume!=null?number(volume.Volume):"null")+",\\"valid\\":"+(obj.Geometry.IsValid?"true":"false")+"}");
      }
      output.AppendLine("["+String.Join(",",result)+"]");
    }`;
}
