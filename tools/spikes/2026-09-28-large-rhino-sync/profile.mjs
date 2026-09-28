import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { launchOwnedHost } from '../../../hosts/common/owned-process.ts';
import { sdkOptions } from '../../../src/server/sdk-options.ts';

const directory = resolve('.vide/large-rhino-sync', randomUUID());
await mkdir(directory, { recursive: true });
const script = join(directory, 'profile.py');
await writeFile(script, `import Rhino, System, json, os, time, traceback
from System.Collections.Generic import List
folder=${JSON.stringify(directory.replaceAll('\\', '/'))}
result={'stages':[]}
def stage(name, began, **values):
    values.update(name=name, seconds=time.time()-began, workingSetBytes=int(System.Diagnostics.Process.GetCurrentProcess().WorkingSet64))
    result['stages'].append(values)
    with open(os.path.join(folder,'progress.json'),'w') as f: json.dump(result,f,default=lambda value: int(value))
try:
    doc=Rhino.RhinoDoc.ActiveDoc
    assert doc.Objects.Count==0
    doc.ModelUnitSystem=Rhino.UnitSystem.Meters
    began=time.time()
    for i in range(10000): doc.Objects.AddPoint(i%100,i//100,0)
    box=Rhino.Geometry.Box(Rhino.Geometry.BoundingBox(0,0,0,2,3,4))
    for i in range(300): doc.Objects.AddBrep(box.ToBrep())
    for i in range(300): doc.Objects.AddLine(Rhino.Geometry.Point3d(i,0,0),Rhino.Geometry.Point3d(i,10,0))
    mesh=Rhino.Geometry.Mesh.CreateFromBox(box,2,2,2)
    for i in range(100): doc.Objects.AddMesh(mesh)
    geometry=List[Rhino.Geometry.GeometryBase]();geometry.Add(box.ToBrep())
    attributes=List[Rhino.DocObjects.ObjectAttributes]();attributes.Add(Rhino.DocObjects.ObjectAttributes())
    definition=doc.InstanceDefinitions.Add('Synthetic block','',Rhino.Geometry.Point3d.Origin,geometry,attributes)
    for i in range(13): doc.Objects.AddInstanceObject(definition,Rhino.Geometry.Transform.Translation(i*3,0,0))
    objects=list(doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject))
    stage('construct',began,objectCount=len(objects))
    options=Rhino.FileIO.SerializationOptions();options.WriteUserData=True;options.WriteRenderMeshes=False;options.WriteAnalysisMeshes=False
    began=time.time();total=0;largest=0;types={}
    for obj in objects:
        value=obj.Geometry.ToJSON(options)+'\\n'+obj.Attributes.ToJSON(options)
        size=System.Text.Encoding.UTF8.GetByteCount(value);total+=size;largest=max(largest,size)
        key=str(obj.ObjectType);types[key]=types.get(key,0)+1
    stage('fingerprint-serialization',began,totalBytes=total,largestObjectBytes=largest,types=types)
    began=time.time();vertices=0;triangles=0;unmeshed={}
    for obj in objects:
        g=obj.Geometry
        if isinstance(g,Rhino.Geometry.Brep): meshes=Rhino.Geometry.Mesh.CreateFromBrep(g,Rhino.Geometry.MeshingParameters.FastRenderMesh)
        elif isinstance(g,Rhino.Geometry.Mesh): meshes=[g]
        else:
            key=str(obj.ObjectType);unmeshed[key]=unmeshed.get(key,0)+1
            continue
        for m in meshes:
            vertices+=m.Vertices.Count;triangles+=m.Faces.TriangleCount+2*m.Faces.QuadCount
            if not isinstance(g,Rhino.Geometry.Mesh):m.Dispose()
    stage('display-meshing',began,vertices=vertices,triangles=triangles,notMeshedTypes=unmeshed)
    began=time.time();destination=os.path.join(folder,'synthetic.3dm')
    write=Rhino.FileIO.FileWriteOptions();write.SuppressAllInput=True;write.SuppressDialogBoxes=True;write.UpdateDocumentPath=False;write.IncludePreviewImage=False
    assert doc.Write3dmFile(destination,write)
    stage('native-write',began,fileBytes=os.path.getsize(destination))
    began=time.time();copy=Rhino.FileIO.File3dm.Read(destination)
    saved={str(o.Attributes.ObjectId):o for o in copy.Objects}
    missing=[str(o.Id) for o in objects if str(o.Id) not in saved]
    assert not missing
    stage('native-read',began,archiveObjects=len(saved),activeObjects=len(objects),instanceDefinitions=copy.AllInstanceDefinitions.Count)
    copy.Dispose();result['ok']=True
except Exception as e: result.update(ok=False,error=str(e),trace=traceback.format_exc())
with open(os.path.join(folder,'result.tmp'),'w') as f:json.dump(result,f,default=lambda value: int(value))
os.rename(os.path.join(folder,'result.tmp'),os.path.join(folder,'result.json'))
`, 'utf8');
let host;
try {
  host = await launchOwnedHost({
    executable: sdkOptions(directory).executable,
    visible: false,
    args: ['/nosplash', '/notemplate', '/scheme=VIDE-Worker-Test', `/runscript="_-RunPythonScript (${script})"`],
    spawnProcess: (f, a, o) => spawn(f, a, { ...o, windowsVerbatimArguments: true }),
  });
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    try {
      const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
      console.log(JSON.stringify({ directory, ...result }));
      if (!result.ok) process.exitCode = 1;
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await new Promise((accept) => setTimeout(accept, 500));
    }
    if (Date.now() >= deadline) throw new Error('PROFILE_TIMEOUT');
  }
} finally {
  await host?.stop();
}
