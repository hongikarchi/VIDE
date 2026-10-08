// 재단 윤곽 (SPEC-16.7 6, PLAN-49 T-256): a flat plate laid on XY — the first vertex at the origin,
// the pattern axis (projected into the plate plane) along +X, the front face (reference normal) up,
// so the outline stays counter-clockwise; a mirror type is drawn front up as well. Also the plate's
// width × height along those axes (SPEC-16.2 공통 규칙 4 on the flat plate). Curved panels are not
// unrolled here (곡면 펼침 is T-259): the caller passes only flat plates.

import type { FaceSampler } from './sample.ts';
import { cross3, dot3, len3, norm3, scale3, sub3, type Vec2, type Vec3 } from './vec.ts';

/** Pattern-axis direction at a UV point: along +U or +V of the face away from the start corner. */
export function patternAxis(
  sampler: FaceSampler,
  uv: Vec2,
  axis: 'u' | 'v',
  startCorner: string,
): Vec3 {
  const [uEnd, vEnd] = startCorner.split('-');
  const sign = (axis === 'u' ? uEnd : vEnd) === 'max' ? -1 : 1;
  const h = axis === 'u' ? (sampler.u1 - sampler.u0) * 1e-4 : (sampler.v1 - sampler.v0) * 1e-4;
  const [u, v] = uv;
  const a = axis === 'u' ? sampler.point(u + h, v) : sampler.point(u, v + h);
  const b = axis === 'u' ? sampler.point(u - h, v) : sampler.point(u, v - h);
  return scale3(norm3(sub3(a, b)), sign);
}

/** The plate frame: +X the pattern axis in the plane, +Y = normal × X. */
export function plateFrame(normal: Vec3, axis: Vec3, fallback: Vec3): { x: Vec3; y: Vec3 } {
  let x = sub3(axis, scale3(normal, dot3(axis, normal)));
  if (len3(x) < 1e-9) x = sub3(fallback, scale3(normal, dot3(fallback, normal)));
  if (len3(x) < 1e-12) x = cross3(normal, Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  x = norm3(x);
  return { x, y: cross3(normal, x) };
}

/** Flat outline in the plate frame from the first vertex, and the plate's width × height. */
export function unrollPlate(
  flat: readonly Vec3[],
  frame: { x: Vec3; y: Vec3 },
): { outline: Vec2[]; size: [number, number] } {
  const o = flat[0];
  const outline = flat.map((p) => {
    const q = sub3(p, o);
    return [tidy(dot3(q, frame.x)), tidy(dot3(q, frame.y))] as Vec2;
  });
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (const [x, y] of outline) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  return { outline, size: [x1 - x0, y1 - y0] };
}

/** Round off float noise below 1 nm (keeps −0 out). */
const tidy = (x: number) => Math.round(x * 1e9) / 1e9 + 0;
