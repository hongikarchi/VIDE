import { csharpLiteral as literal } from '../common/csharp.ts';
import type { GeometryObject } from '../../src/core/geometry.ts';
// Duplicate before any original candidate object is transformed or removed.
export function prepareNativeCopies(
  objects: GeometryObject[],
  baseline?: { objects: GeometryObject[] },
) {
  const additions = new Map<string, string>(),
    prepare: string[] = [];
  for (const [index, object] of objects.entries()) {
    if (object.kind !== 'native' || baseline?.objects.some((item) => item.id === object.id))
      continue;
    const source = baseline?.objects.find((item) => item.id === object.nativeSourceId);
    if (!source || source.kind !== 'native') throw Error('MISSING_NATIVE_BASE');
    const delta = object.origin.map((value, i) => value - source.origin[i]);
    if (
      delta.length !== 3 ||
      delta.some((value) => !Number.isFinite(value) || Math.abs(value) > 200000)
    )
      throw Error('INVALID_GEOMETRY');
    prepare.push(`var copySource${index}=work.Objects.FindId(new Guid(${literal(source.nativeId)}));
   if(copySource${index}==null||copySource${index}.IsLocked||copySource${index}.IsReference||copySource${index}.IsInstanceDefinitionGeometry||copySource${index}.Attributes.GroupCount>0||copySource${index}.HasHistoryRecord()||copySource${index}.HistoryParents().Length>0||copySource${index}.HistoryChildren().Length>0)throw new Exception("Unsupported copy source");
   var copyGeometry${index}=copySource${index}.Geometry.Duplicate();
   if(!(copyGeometry${index} is Rhino.Geometry.Brep||copyGeometry${index} is Rhino.Geometry.Extrusion||copyGeometry${index} is Rhino.Geometry.Curve||copyGeometry${index} is Rhino.Geometry.Mesh||copyGeometry${index} is Rhino.Geometry.Point))throw new Exception("Unsupported copy geometry");
   if(!copyGeometry${index}.Transform(Rhino.Geometry.Transform.Translation(${delta.join(',')}))||!copyGeometry${index}.IsValid)throw new Exception("Copy transform failed");
   var copyAttributes${index}=copySource${index}.Attributes.Duplicate();copyAttributes${index}.ObjectId=Guid.Empty;copyAttributes${index}.Name=${literal(object.name)};copyAttributes${index}.SetUserString("vide-id",${literal(object.id)});`);
    additions.set(
      object.id,
      `if(work.Objects.Add(copyGeometry${index},copyAttributes${index})==Guid.Empty)throw new Exception("Copy add failed");`,
    );
  }
  return { prepare: prepare.join('\n'), additions };
}
