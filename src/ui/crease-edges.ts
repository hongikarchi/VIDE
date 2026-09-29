// Crease edges of a triangle mesh (PLAN-18): the edges where neighbouring faces meet at more than
// the threshold angle, plus open boundary edges — what THREE.EdgesGeometry draws, without its
// per-vertex and per-edge string keys (about half the time of opening a large model went there).
// Vertices at the same position (rounded to 1e-4, as three.js does) are welded, so meshes split at
// creases or seams (a Rhino render mesh) still find their neighbours.

/** Returns xyz pairs (LineSegments positions) in the mesh's own coordinates. */
export function creaseEdges(
  position: ArrayLike<number>,
  index: ArrayLike<number> | null,
  thresholdDegrees: number,
): Float32Array {
  const vertexCount = Math.floor(position.length / 3);
  const faceCount = Math.floor((index ? index.length : vertexCount) / 3);
  if (!faceCount) return new Float32Array(0);
  const corner = (i: number) => (index ? index[i] : i);
  // Weld: one id per distinct rounded position (open addressing on the rounded integers).
  const xyz = position instanceof Float32Array ? position : Float32Array.from(position);
  // Mesh positions are local to the object (display coordinates), so 1e-4 steps fit in int32.
  const words = new Int32Array(vertexCount * 3);
  for (let i = 0; i < words.length; i++) words[i] = Math.round(xyz[i] * 1e4);
  let size = 1;
  while (size < vertexCount * 2) size <<= 1;
  const slots = new Int32Array(size).fill(-1);
  const weld = new Int32Array(vertexCount);
  let welded = 0;
  for (let v = 0; v < vertexCount; v++) {
    const x = words[v * 3],
      y = words[v * 3 + 1],
      z = words[v * 3 + 2];
    let slot =
      (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (size - 1);
    for (;;) {
      const found = slots[slot];
      if (found < 0) {
        slots[slot] = v;
        weld[v] = welded++;
        break;
      }
      if (words[found * 3] === x && words[found * 3 + 1] === y && words[found * 3 + 2] === z) {
        weld[v] = weld[found];
        break;
      }
      slot = (slot + 1) & (size - 1);
    }
  }
  // Face normals.
  const normals = new Float32Array(faceCount * 3);
  for (let f = 0; f < faceCount; f++) {
    const a = corner(f * 3) * 3,
      b = corner(f * 3 + 1) * 3,
      c = corner(f * 3 + 2) * 3;
    const ux = xyz[b] - xyz[a],
      uy = xyz[b + 1] - xyz[a + 1],
      uz = xyz[b + 2] - xyz[a + 2];
    const vx = xyz[c] - xyz[a],
      vy = xyz[c + 1] - xyz[a + 1],
      vz = xyz[c + 2] - xyz[a + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    normals[f * 3] = nx / length;
    normals[f * 3 + 1] = ny / length;
    normals[f * 3 + 2] = nz / length;
  }
  // Edges by welded endpoints: the first face seen, then the second.
  const cos = Math.cos((thresholdDegrees * Math.PI) / 180);
  let edgeSize = 1;
  while (edgeSize < faceCount * 3 * 2) edgeSize <<= 1;
  const keyA = new Int32Array(edgeSize).fill(-1),
    keyB = new Int32Array(edgeSize),
    faceOf = new Int32Array(edgeSize),
    cornerOf = new Int32Array(edgeSize),
    shared = new Uint8Array(edgeSize);
  const out: number[] = [];
  const push = (i: number, j: number) => {
    out.push(
      xyz[i * 3],
      xyz[i * 3 + 1],
      xyz[i * 3 + 2],
      xyz[j * 3],
      xyz[j * 3 + 1],
      xyz[j * 3 + 2],
    );
  };
  for (let f = 0; f < faceCount; f++) {
    for (let k = 0; k < 3; k++) {
      const i = corner(f * 3 + k),
        j = corner(f * 3 + ((k + 1) % 3));
      let a = weld[i],
        b = weld[j];
      if (a === b) continue;
      if (a > b) [a, b] = [b, a];
      let slot = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663)) & (edgeSize - 1);
      for (;;) {
        if (keyA[slot] < 0) {
          keyA[slot] = a;
          keyB[slot] = b;
          faceOf[slot] = f;
          cornerOf[slot] = f * 3 + k;
          break;
        }
        if (keyA[slot] === a && keyB[slot] === b) {
          if (!shared[slot]) {
            shared[slot] = 1;
            const g = faceOf[slot];
            const dot =
              normals[f * 3] * normals[g * 3] +
              normals[f * 3 + 1] * normals[g * 3 + 1] +
              normals[f * 3 + 2] * normals[g * 3 + 2];
            if (dot <= cos) push(i, j);
          }
          break;
        }
        slot = (slot + 1) & (edgeSize - 1);
      }
    }
  }
  // Edges with a single face are open boundaries.
  for (let slot = 0; slot < edgeSize; slot++)
    if (keyA[slot] >= 0 && !shared[slot]) {
      const at = cornerOf[slot],
        f = Math.floor(at / 3),
        k = at % 3;
      push(corner(at), corner(f * 3 + ((k + 1) % 3)));
    }
  return Float32Array.from(out);
}
