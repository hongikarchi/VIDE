// Plane geometry the collector needs on EPSG:5186 metres: polygon checks, area, bounds, a point
// inside a parcel (VWorld point filters miss when the point sits on a boundary) and the 2 km²
// tiles of a box query (VWorld geomFilter limit, SPIKE §2).

export type Position = [number, number];
/** MultiPolygon coordinates: polygons → rings (first outer) → positions. */
export type Polygons = Position[][][];
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const isPosition = (value: unknown): value is Position =>
  Array.isArray(value) &&
  value.length >= 2 &&
  typeof value[0] === 'number' &&
  typeof value[1] === 'number' &&
  Number.isFinite(value[0]) &&
  Number.isFinite(value[1]);

function ringOf(value: unknown): Position[] | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const ring: Position[] = [];
  for (const point of value) {
    if (!isPosition(point)) return null;
    ring.push([point[0], point[1]]);
  }
  return ring;
}

function polygonOf(value: unknown): Position[][] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const rings: Position[][] = [];
  for (const entry of value) {
    const ring = ringOf(entry);
    if (!ring) return null;
    rings.push(ring);
  }
  return rings;
}

/** A GeoJSON Polygon/MultiPolygon as MultiPolygon coordinates, or null when malformed. */
export function polygonsOf(geometry: unknown): Polygons | null {
  if (!geometry || typeof geometry !== 'object') return null;
  const { type, coordinates } = geometry as { type?: unknown; coordinates?: unknown };
  if (type === 'Polygon') {
    const polygon = polygonOf(coordinates);
    return polygon ? [polygon] : null;
  }
  if (type === 'MultiPolygon' && Array.isArray(coordinates) && coordinates.length) {
    const polygons: Polygons = [];
    for (const entry of coordinates) {
      const polygon = polygonOf(entry);
      if (!polygon) return null;
      polygons.push(polygon);
    }
    return polygons;
  }
  return null;
}

function ringArea(ring: readonly Position[]) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum / 2);
}

/** Area in square units: outer rings minus holes. */
export function areaOf(polygons: Polygons) {
  let area = 0;
  for (const polygon of polygons)
    polygon.forEach((ring, index) => (area += index === 0 ? ringArea(ring) : -ringArea(ring)));
  return area;
}

export function boundsOf(polygons: Polygons): Bounds {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const polygon of polygons)
    for (const [x, y] of polygon[0]) {
      bounds.minX = Math.min(bounds.minX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.maxY = Math.max(bounds.maxY, y);
    }
  return bounds;
}

export const unionBounds = (list: readonly Bounds[]): Bounds => ({
  minX: Math.min(...list.map((b) => b.minX)),
  minY: Math.min(...list.map((b) => b.minY)),
  maxX: Math.max(...list.map((b) => b.maxX)),
  maxY: Math.max(...list.map((b) => b.maxY)),
});

export const expandBounds = (b: Bounds, by: number): Bounds => ({
  minX: b.minX - by,
  minY: b.minY - by,
  maxX: b.maxX + by,
  maxY: b.maxY + by,
});

function inRing([x, y]: Position, ring: readonly Position[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygons(point: Position, polygons: Polygons) {
  return polygons.some(
    (polygon) => inRing(point, polygon[0]) && !polygon.slice(1).some((hole) => inRing(point, hole)),
  );
}

/**
 * A point strictly inside the largest polygon: the middle of the widest span on the horizontal
 * line through the outer ring's vertical middle (a centroid can fall outside an L-shaped lot).
 */
export function interiorPoint(polygons: Polygons): Position {
  const polygon = [...polygons].sort((a, b) => areaOf([b]) - areaOf([a]))[0];
  const bounds = boundsOf([polygon]);
  for (const fraction of [0.5, 0.37, 0.63, 0.25, 0.75]) {
    const y = bounds.minY + (bounds.maxY - bounds.minY) * fraction;
    const xs: number[] = [];
    for (const ring of polygon)
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        if (y1 > y !== y2 > y) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
    xs.sort((a, b) => a - b);
    let best: Position | null = null;
    let width = 0;
    for (let i = 0; i + 1 < xs.length; i += 2)
      if (xs[i + 1] - xs[i] > width) {
        width = xs[i + 1] - xs[i];
        best = [(xs[i] + xs[i + 1]) / 2, y];
      }
    if (best && pointInPolygons(best, [polygon])) return best;
  }
  return polygon[0][0];
}

/** Squares covering `bounds` whose area stays under `maxArea` (VWorld: 2 km² per geomFilter). */
export function tilesOf(bounds: Bounds, maxArea = 2_000_000): Bounds[] {
  const side = Math.sqrt(maxArea) * 0.99;
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const columns = Math.max(1, Math.ceil(width / side));
  const rows = Math.max(1, Math.ceil(height / side));
  const tiles: Bounds[] = [];
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++)
      tiles.push({
        minX: bounds.minX + (width * column) / columns,
        maxX: bounds.minX + (width * (column + 1)) / columns,
        minY: bounds.minY + (height * row) / rows,
        maxY: bounds.minY + (height * (row + 1)) / rows,
      });
  return tiles;
}

export const distance = (a: Position, b: Position) => Math.hypot(a[0] - b[0], a[1] - b[1]);
