import * as THREE from 'three';

/** Resolved CAD display style: ACI 1–255, true colour, lineweight (mm), effective layer colour. */
export interface CadStyle {
  ci?: number;
  rgb?: string;
  lw?: number;
  layer?: string;
}
export interface StyleRun extends CadStyle {
  n: number;
}
export interface CadFill extends CadStyle {
  loops: number[][];
}
export interface CadText extends CadStyle {
  s: string;
  p: number[];
  h: number;
  r: number;
  wf?: number;
  ax: number;
  ay: number;
}

/** Per-vertex style lookup shared by segments, fills and text quads. */
export interface StyledGeometry {
  styles: CadStyle[];
  vertexStyle: Uint32Array;
}

/** Segment runs → one style index per vertex (two vertices per segment). */
export function runStyles(runs: StyleRun[], segmentCount: number): StyledGeometry {
  const vertexStyle = new Uint32Array(segmentCount * 2);
  let segment = 0;
  runs.forEach((run, index) => {
    for (let i = 0; i < run.n && segment < segmentCount; i++, segment++)
      vertexStyle[segment * 2] = vertexStyle[segment * 2 + 1] = index;
  });
  // Segments beyond the declared runs keep the last style.
  for (; segment < segmentCount; segment++)
    vertexStyle[segment * 2] = vertexStyle[segment * 2 + 1] = Math.max(0, runs.length - 1);
  return { styles: runs, vertexStyle };
}

/** Write vertex colours for a styled geometry. */
export function paintVertices(
  geometry: THREE.BufferGeometry,
  styled: StyledGeometry,
  colorOf: (style: CadStyle) => THREE.Color,
) {
  const count = styled.vertexStyle.length;
  let attribute = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!attribute || attribute.count !== count) {
    attribute = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    geometry.setAttribute('color', attribute);
  }
  const cache = styled.styles.map(colorOf);
  for (let i = 0; i < count; i++) {
    const color = cache[styled.vertexStyle[i]] ?? cache[0];
    attribute.setXYZ(i, color.r, color.g, color.b);
  }
  attribute.needsUpdate = true;
}

// ---------------------------------------------------------------------------------------------
// Solid hatch fills

function planeBasis(points: THREE.Vector3[]) {
  // Newell normal of the outer loop; falls back to +Z for degenerate loops.
  const normal = new THREE.Vector3();
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    normal.x += (a.y - b.y) * (a.z + b.z);
    normal.y += (a.z - b.z) * (a.x + b.x);
    normal.z += (a.x - b.x) * (a.y + b.y);
  }
  if (normal.lengthSq() < 1e-20) normal.set(0, 0, 1);
  normal.normalize();
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(normal.dot(u)) > 0.9) u.set(0, 1, 0);
  u.sub(normal.clone().multiplyScalar(normal.dot(u))).normalize();
  const v = normal.clone().cross(u);
  return { u, v };
}
function toVectors(loop: number[], origin: THREE.Vector3) {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i + 2 < loop.length; i += 3)
    points.push(
      new THREE.Vector3(loop[i] - origin.x, loop[i + 1] - origin.y, loop[i + 2] - origin.z),
    );
  // Drop a closing duplicate point.
  if (points.length > 2 && points[0].distanceToSquared(points.at(-1)!) < 1e-18) points.pop();
  return points;
}
function inside(point: THREE.Vector2, polygon: THREE.Vector2[]) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      hit = !hit;
  }
  return hit;
}

/** Triangulate planar solid fills (first loop outer, contained loops holes, others islands). */
export function buildFillMesh(fills: CadFill[], origin: THREE.Vector3) {
  const positions: number[] = [];
  const vertexStyle: number[] = [];
  fills.forEach((fill, styleIndex) => {
    const loops = fill.loops
      .map((loop) => toVectors(loop, origin))
      .filter((loop) => loop.length >= 3);
    if (!loops.length) return;
    const { u, v } = planeBasis(loops[0]);
    const flat = loops.map((loop) => loop.map((p) => new THREE.Vector2(p.dot(u), p.dot(v))));
    const outer = flat[0];
    const groups: { contour: number; holes: number[] }[] = [{ contour: 0, holes: [] }];
    for (let i = 1; i < flat.length; i++)
      if (inside(flat[i][0], outer)) groups[0].holes.push(i);
      else groups.push({ contour: i, holes: [] });
    for (const group of groups) {
      const contour = flat[group.contour],
        holes = group.holes.map((i) => flat[i]);
      const all = [...loops[group.contour], ...group.holes.flatMap((i) => loops[i])];
      let faces: number[][];
      try {
        faces = THREE.ShapeUtils.triangulateShape(contour, holes);
      } catch {
        continue;
      }
      for (const face of faces)
        for (const index of face) {
          const p = all[index];
          if (!p) continue;
          positions.push(p.x, p.y, p.z);
          vertexStyle.push(styleIndex);
        }
    }
  });
  if (!positions.length) return undefined;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      // Behind the drawing lines drawn in the same place.
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    }),
  );
  mesh.renderOrder = -1;
  mesh.userData.part = 'fill';
  mesh.userData.styled = {
    styles: fills,
    vertexStyle: Uint32Array.from(vertexStyle),
  } satisfies StyledGeometry;
  return mesh;
}

// ---------------------------------------------------------------------------------------------
// Text: strings are rasterised once into shared 2048² canvas pages (white on transparent) and
// drawn as quads tinted by vertex colour, so thousands of labels share a few textures.

const PAGE = 2048,
  FONT_PX = 40,
  // Em-relative layout of every rasterised cell: baseline, ascent room and descent room.
  ASCENT = 1.1,
  DESCENT = 0.35,
  PAD = 2;
const FONT_STACK =
  "'Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR','Noto Sans CJK KR',sans-serif";
// CAD text height is roughly the Latin cap height (~0.72 em of common fonts).
const CAP = 0.72;
interface Glyph {
  page: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Advance width in em (without padding). */
  width: number;
  /** Padding in em. */
  pad: number;
}
interface Page {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  material: THREE.MeshBasicMaterial;
  x: number;
  y: number;
  row: number;
}
export class TextAtlas {
  pages: Page[] = [];
  private cache = new Map<string, Glyph>();
  private dirty = new Set<Page>();
  private page() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = PAGE;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ffffff';
    context.textBaseline = 'alphabetic';
    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 4;
    texture.colorSpace = THREE.NoColorSpace;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      vertexColors: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      alphaTest: 0.04,
    });
    const page: Page = { canvas, context, texture, material, x: 0, y: 0, row: 0 };
    this.pages.push(page);
    return page;
  }
  glyph(text: string): Glyph {
    const cached = this.cache.get(text);
    if (cached) return cached;
    let page = this.pages.at(-1) ?? this.page();
    let size = FONT_PX;
    page.context.font = `${size}px ${FONT_STACK}`;
    let measured = page.context.measureText(text).width;
    // Very long lines are rasterised smaller so they fit one page row.
    if (measured + 2 * PAD > PAGE) {
      size = Math.max(8, Math.floor((size * (PAGE - 2 * PAD)) / measured));
      page.context.font = `${size}px ${FONT_STACK}`;
      measured = page.context.measureText(text).width;
    }
    const cellW = Math.ceil(measured + 2 * PAD),
      cellH = Math.ceil(size * (ASCENT + DESCENT) + 2 * PAD);
    if (page.x + cellW > PAGE) {
      page.x = 0;
      page.y += page.row;
      page.row = 0;
    }
    if (page.y + cellH > PAGE) {
      page = this.page();
      page.context.font = `${size}px ${FONT_STACK}`;
    }
    page.context.fillText(text, page.x + PAD, page.y + PAD + size * ASCENT);
    const glyph: Glyph = {
      page: this.pages.indexOf(page),
      u0: page.x / PAGE,
      u1: (page.x + cellW) / PAGE,
      // CanvasTexture flips Y: canvas top maps to v = 1.
      v1: 1 - page.y / PAGE,
      v0: 1 - (page.y + cellH) / PAGE,
      width: measured / size,
      pad: PAD / size,
    };
    page.x += cellW;
    page.row = Math.max(page.row, cellH);
    this.cache.set(text, glyph);
    this.dirty.add(page);
    return glyph;
  }
  /** Upload pages that received new strings. */
  flush() {
    for (const page of this.dirty) page.texture.needsUpdate = true;
    this.dirty.clear();
  }
  get size() {
    return this.pages.length;
  }
  dispose() {
    for (const page of this.pages) {
      page.texture.dispose();
      page.material.dispose();
    }
    this.pages = [];
    this.cache.clear();
    this.dirty.clear();
  }
}

/** Build one merged quad mesh per atlas page for an object's texts (origin-relative). */
export function buildTextMeshes(texts: CadText[], origin: THREE.Vector3, atlas: TextAtlas) {
  const perPage = new Map<number, { positions: number[]; uvs: number[]; styles: number[] }>();
  texts.forEach((text, styleIndex) => {
    if (!(text.h > 0) || !text.s.trim() || text.p.length !== 3 || !text.p.every(Number.isFinite))
      return;
    const em = text.h / CAP,
      wf = text.wf && text.wf > 0 ? text.wf : 1,
      spacing = 1.66 * text.h;
    const lines = text.s.split(/\r?\n/);
    const top = text.h,
      bottom = -(lines.length - 1) * spacing;
    const dy =
      text.ay === 1 ? -bottom : text.ay === 2 ? -(top + bottom) / 2 : text.ay === 3 ? -top : 0;
    const cos = Math.cos(text.r),
      sin = Math.sin(text.r);
    const px = text.p[0] - origin.x,
      py = text.p[1] - origin.y,
      pz = text.p[2] - origin.z;
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      const glyph = atlas.glyph(line);
      const width = glyph.width * em * wf;
      const dx = text.ax === 1 ? -width / 2 : text.ax === 2 ? -width : 0;
      const baseline = dy - index * spacing;
      const x0 = dx - glyph.pad * em * wf,
        x1 = dx + width + glyph.pad * em * wf,
        y0 = baseline - (DESCENT + glyph.pad) * em,
        y1 = baseline + (ASCENT + glyph.pad) * em;
      const bucket = perPage.get(glyph.page) ?? { positions: [], uvs: [], styles: [] };
      perPage.set(glyph.page, bucket);
      const corner = (x: number, y: number) =>
        bucket.positions.push(px + x * cos - y * sin, py + x * sin + y * cos, pz);
      // Two triangles: (0,0) (1,0) (1,1) / (0,0) (1,1) (0,1)
      for (const [x, y, u, v] of [
        [x0, y0, glyph.u0, glyph.v0],
        [x1, y0, glyph.u1, glyph.v0],
        [x1, y1, glyph.u1, glyph.v1],
        [x0, y0, glyph.u0, glyph.v0],
        [x1, y1, glyph.u1, glyph.v1],
        [x0, y1, glyph.u0, glyph.v1],
      ]) {
        corner(x, y);
        bucket.uvs.push(u, v);
        bucket.styles.push(styleIndex);
      }
    });
  });
  atlas.flush();
  const meshes: THREE.Mesh[] = [];
  for (const [page, bucket] of perPage) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(bucket.positions), 3),
    );
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(bucket.uvs), 2));
    const mesh = new THREE.Mesh(geometry, atlas.pages[page].material);
    mesh.renderOrder = 2;
    mesh.userData.part = 'text';
    // The page material is shared; never dispose it with the object.
    mesh.userData.sharedMaterial = true;
    mesh.userData.styled = {
      styles: texts,
      vertexStyle: Uint32Array.from(bucket.styles),
    } satisfies StyledGeometry;
    meshes.push(mesh);
  }
  return meshes;
}

/** Anchor for text/fill-only items (first text point or first fill vertex). */
export function annotationAnchor(object: { texts?: CadText[]; fills?: CadFill[] }) {
  const p = object.texts?.[0]?.p ?? object.fills?.[0]?.loops?.[0]?.slice(0, 3);
  return p && p.length === 3 ? new THREE.Vector3(p[0], p[1], p[2]) : undefined;
}
