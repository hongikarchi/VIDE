export interface DisplayGeometry {
  valid?: boolean;
  vertices?: number[];
  indices?: number[];
  line?: number[];
  segments?: number[];
  nativeType?: string;
  origin?: number[];
}
type Representation =
  | { type: 'mesh'; positions: number[]; indices: number[] }
  | { type: 'line' | 'segments' | 'point'; positions: number[] };
export function sceneRepresentation(object: DisplayGeometry): Representation | null {
  if (object.valid === false) return null;
  if (object.vertices?.length && object.indices?.length)
    return { type: 'mesh', positions: object.vertices, indices: object.indices };
  if (object.line?.length) return { type: 'line', positions: object.line };
  if (object.segments?.length) return { type: 'segments', positions: object.segments };
  if (
    object.nativeType === 'Point' &&
    Array.isArray(object.origin) &&
    object.origin.length === 3 &&
    object.origin.every(Number.isFinite)
  )
    return { type: 'point', positions: object.origin };
  return null;
}
