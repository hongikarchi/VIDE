import { isPacked, type Positions } from '../contracts/geometry-transfer.ts';

/**
 * Keep GPU float32 positions local; retain the world origin in the object transform. A received
 * binary array (`PackedPositions`, T-085) is already local to its first point: it is used as it is.
 */
export function displayCoordinates(positions: Positions): {
  origin: [number, number, number];
  local: Float32Array;
} {
  if (isPacked(positions)) return { origin: [...positions.origin], local: positions };
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const axis = i % 3;
    min[axis] = Math.min(min[axis], positions[i]);
    max[axis] = Math.max(max[axis], positions[i]);
  }
  const origin = min.map((value, axis) => value + (max[axis] - value) / 2) as [
      number,
      number,
      number,
    ],
    local = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i++) local[i] = positions[i] - origin[i % 3];
  return { origin, local };
}
