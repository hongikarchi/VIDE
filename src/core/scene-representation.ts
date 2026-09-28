export interface DisplayGeometry {
  valid?: boolean;
  vertices?: number[];
  indices?: number[];
  line?: number[];
  segments?: number[];
  nativeType?: string;
  origin?: number[];
  /** CAD solid hatch loops (flattened xyz) and text annotations. */
  fills?: { loops: number[][] }[];
  texts?: { p: number[] }[];
}
type Representation =
  | { type: 'mesh'; positions: number[]; indices: number[] }
  | { type: 'line' | 'segments' | 'point'; positions: number[] }
  // Text/fill-only CAD items: rendered from their annotations; positions is an anchor point.
  | { type: 'annotation'; positions: number[] };
export function sceneRepresentation(object: DisplayGeometry): Representation | null {
  if (object.valid === false) return null;
  if (object.vertices?.length && object.indices?.length)
    return { type: 'mesh', positions: object.vertices, indices: object.indices };
  if (object.line?.length) return { type: 'line', positions: object.line };
  if (object.segments?.length) return { type: 'segments', positions: object.segments };
  const anchor = object.texts?.[0]?.p ?? object.fills?.[0]?.loops?.[0]?.slice(0, 3);
  if (anchor?.length === 3 && anchor.every(Number.isFinite))
    return { type: 'annotation', positions: anchor };
  if (
    object.nativeType === 'Point' &&
    Array.isArray(object.origin) &&
    object.origin.length === 3 &&
    object.origin.every(Number.isFinite)
  )
    return { type: 'point', positions: object.origin };
  return null;
}
