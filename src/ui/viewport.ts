import { creaseEdges } from './crease-edges.ts';
import { sceneRepresentation } from '../core/scene-representation.ts';
import { displayCoordinates } from '../core/display-coordinates.ts';
import type { DisplayGeometry } from '../core/scene-representation.ts';
import type { Point2, Point3, DraftStroke } from './model.ts';
import { planePoint } from './model.ts';
import * as THREE from 'three';
import { defaultDisplay, type DisplaySettings } from './display-settings.ts';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import {
  aciColor,
  lineWeightPixels,
  plotPen,
  plotStyleTable,
  type PlotStyleTable,
} from './plot-style.ts';
import {
  TextAtlas,
  annotationAnchor,
  buildFillMesh,
  buildTextMeshes,
  paintVertices,
  runStyles,
  type CadFill,
  type CadStyle,
  type CadText,
  type StyleRun,
  type StyledGeometry,
} from './cad-annotations.ts';
import { TOKEN_FALLBACK } from './tokens.ts';

type Camera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
type PlaneName = 'XY' | 'XZ' | 'YZ';
type ToolMode = 'select' | 'sketch';
export interface BrushSettings {
  color: string;
  width: number;
  /** Follow model surfaces under the pen; otherwise stay on the stroke's view plane. */
  surface: boolean;
  erase: boolean;
}
export type SketchEvent =
  | { type: 'stroke'; stroke: DraftStroke }
  | { type: 'erase'; index: number };
/** Overlay colours are Design §02 token names; the viewport resolves them to screen colours. */
export type OverlayTone =
  | 'ov-grid'
  | 'ov-new'
  | 'ov-existing'
  | 'ov-clash'
  | 'ok'
  | 'warn'
  | 'ng'
  | 'na';
/**
 * One display primitive of a jig overlay layer (SPEC-07.10), in world metres. Polygons lie in
 * plan at height `z`; `label` draws a small tag (e.g. the issue number of a table row).
 */
export type OverlayItem = { id: string; tone?: OverlayTone; label?: string } & (
  | { kind: 'polygon'; points: readonly Point2[]; z: number; fill?: boolean }
  | {
      kind: 'polyline';
      points: readonly Point3[];
      closed?: boolean;
      dashed?: boolean;
      /** Screen pixels. */
      width?: number;
    }
  | { kind: 'point'; at: Point3 }
);
export interface OverlayStyle {
  visible?: boolean;
  /** 0–1, multiplies the primitives' own opacity. */
  opacity?: number;
}
/** What a click hit: document objects, or one item of an overlay layer. */
export type PickSource =
  | { source: 'document' }
  | { source: 'overlay'; key: string; itemId: string };
/** Frame document objects (display ids), a box in metres, or an overlay layer or item. */
export type FocusTarget =
  | readonly string[]
  | { min: Point3; max: Point3 }
  | { overlay: string; itemId?: string };
// tokens.css values of the overlay tokens, used until the stylesheet defines the tokens.
const OVERLAY_TONES: Record<OverlayTone, string> = TOKEN_FALLBACK;
interface DisplaySketch {
  points?: Point2[];
  plane?: string;
  planeOffset?: number;
  strokes?: DraftStroke[];
}
/**
 * Host-agnostic display colours. `displayColor` is the resolved screen colour (#rrggbb);
 * `colorIndex` is a resolved ACI 1–255; legacy CAD `color` is a raw ACI (0 ByBlock, 256 ByLayer);
 * `lineWeight` is in mm (resolved, > 0).
 */
interface DisplayObject extends DisplayGeometry {
  id: string;
  /** Rhino display hash: equal hashes mean the displayed geometry is unchanged. */
  geometryHash?: string;
  displayColor?: string;
  color?: number | string;
  colorIndex?: number;
  layerColor?: string;
  materialColor?: string | null;
  lineWeight?: number;
  /** CAD: per-segment style runs, solid fills and text annotations. */
  segmentStyles?: StyleRun[];
  fills?: CadFill[];
  texts?: CadText[];
  /** Rhino block instance: shared definition geometry and its row-major 4x4 transform. */
  block?: { definition: string; transform: number[] };
}
const hexColor = (value: unknown) =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;
/** Screen colour of the object itself (Rhino display colour, CAD true colour or ACI). */
function objectColor(object: DisplayObject) {
  return (
    hexColor(object.displayColor) ??
    hexColor(object.color) ??
    (object.colorIndex !== undefined ? aciColor(object.colorIndex) : undefined) ??
    (typeof object.color === 'number' ? aciColor(object.color) : undefined)
  );
}
function objectIndex(object: DisplayObject) {
  if (object.colorIndex !== undefined) return object.colorIndex;
  return typeof object.color === 'number' && object.color >= 1 && object.color <= 255
    ? object.color
    : undefined;
}
// Rhino shaded palette: light neutral surfaces, darker crease edges. The selection is the point
// colour (--accent #d0664a, a lighter tint on surfaces), kept apart from the crimson of violations
// (--ng), which the verdict tint and overlay use.
const SURFACE = 0xd6d9d3,
  WIRE = 0x4c5650,
  EDGE = 0x3d4540,
  SELECTED = 0xe3a392,
  SELECTED_WIRE = 0xd0664a;
const CREASE_ANGLE = 38;
// Neutral fill for CAD solid hatches in the default colour source.
const FILL = 0xb9c0ba;
type RenderObject =
  | THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  | THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>
  | THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
const surfaceMaterial = () =>
  new THREE.MeshStandardMaterial({
    color: SURFACE,
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
    // Push faces back so crease edges draw cleanly on top.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
/** Rhino block definition display, in definition space (meters). */
interface BlockDefinition {
  hash: string;
  vertices: number[];
  indices: number[];
  segments: number[];
  texts?: CadText[];
}
interface SharedBlock {
  origin: THREE.Vector3;
  surface?: THREE.BufferGeometry;
  wire?: THREE.BufferGeometry;
}
function disposeObject(object: THREE.Object3D) {
  object.traverse((item) => {
    if (item instanceof THREE.Mesh || item instanceof THREE.Line || item instanceof THREE.Points) {
      // Block definition geometry is shared by its instances and owned by the viewport cache.
      if (!item.userData.sharedGeometry) item.geometry.dispose();
      // Text atlas page materials are shared across objects and owned by the atlas.
      if (item.userData.sharedMaterial) return;
      for (const material of Array.isArray(item.material) ? item.material : [item.material])
        material.dispose();
    }
  });
}
/** Walk from a raycast hit (fill/text child) up to the object that carries the scene id. */
function ownerId(object: THREE.Object3D | undefined) {
  for (let item = object; item; item = item.parent ?? undefined)
    if (typeof item.userData.id === 'string') return item.userData.id as string;
  return undefined;
}
export function createViewport(
  container: HTMLElement,
  objects: DisplayObject[],
  onPick: (ids: string[], mode: 'replace' | 'add' | 'remove', source: PickSource) => void,
  onSketch: (event: SketchEvent) => void,
  onCamera?: (state: { view: string; projection: 'orthographic' | 'perspective' }) => void,
) {
  let dirty = true;
  let selectedIds = new Set<string>();
  let tints: Map<string, string> | null = null;
  let lineSignature = '';
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#f2f1ee');
  let display: DisplaySettings = { ...defaultDisplay };
  let plotStyle: PlotStyleTable = plotStyleTable();
  let darkBackground = false;
  const plotMaterials = new Set<LineMaterial>();
  const perspective = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  const orthographic = new THREE.OrthographicCamera(-25, 25, 25, -25, 0.1, 1000);
  let viewSpan = 50;
  // How far the plan views may zoom in: down to a few centimetres of the framed model.
  let maxZoom = 20;
  // Perspective zoom limits of the framed model, kept when switching projection.
  let distances = { min: 4, max: 180 };
  let standardView = false;
  let camera: Camera = perspective;
  camera.up.set(0, 0, 1);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.domElement.setAttribute(
    'aria-label',
    '3D 모델 · 우클릭 회전, Shift 우클릭 이동, 휠 확대',
  );
  renderer.domElement.tabIndex = 0;
  container.append(renderer.domElement);
  let controls: OrbitControls<Camera> = new OrbitControls(camera, renderer.domElement);
  // Rhino-style navigation: camera stops with the pointer, zoom follows the cursor.
  controls.enableDamping = false;
  controls.zoomToCursor = true;
  controls.minDistance = 4;
  controls.maxDistance = 180;
  /** The grid is a backdrop: drawn first and never occludes plan drawings lying on z = 0. */
  const backdrop = (helper: THREE.GridHelper) => {
    helper.renderOrder = -10;
    for (const material of Array.isArray(helper.material) ? helper.material : [helper.material])
      material.depthWrite = false;
    helper.raycast = () => {};
    return helper;
  };
  let grid = backdrop(new THREE.GridHelper(100, 50, 0xc6c4be, 0xe3e2de));
  grid.rotation.x = Math.PI / 2;
  scene.add(grid);
  // Soft sky fill plus a headlight that follows the camera, like Rhino's default lighting.
  const sky = new THREE.HemisphereLight(0xffffff, 0xaab2aa, 1.9);
  scene.add(sky);
  const light = new THREE.DirectionalLight(0xffffff, 1.9);
  scene.add(light, light.target);
  const meshes: RenderObject[] = [];
  const byId = new Map<string, RenderObject>();
  // Rhino-style Hide/Isolate: hidden objects are not drawn, picked or framed until Unhide.
  const hiddenIds = new Set<string>();
  const visibleMeshes = () => meshes.filter((mesh) => mesh.visible);
  function applyHidden() {
    for (const mesh of meshes) mesh.visible = !hiddenIds.has(mesh.userData.id);
    rebatchAll();
    dirty = true;
  }
  let atlas = new TextAtlas();
  // Block definitions: one GPU geometry per definition hash, shared by every instance.
  const blockGeometry = new Map<string, SharedBlock>();
  const sharedEdges = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
  function sharedBlock(definition: BlockDefinition) {
    let shared = blockGeometry.get(definition.hash);
    if (shared) return shared;
    // Local coordinates around the definition's first point keep float32 precision.
    const anchor = (definition.vertices.length ? definition.vertices : definition.segments).slice(
      0,
      3,
    );
    const origin = new THREE.Vector3(anchor[0] ?? 0, anchor[1] ?? 0, anchor[2] ?? 0);
    const local = (values: number[]) => {
      const out = new Float32Array(values.length);
      for (let i = 0; i < values.length; i += 3) {
        out[i] = values[i] - origin.x;
        out[i + 1] = values[i + 1] - origin.y;
        out[i + 2] = values[i + 2] - origin.z;
      }
      return out;
    };
    shared = { origin };
    if (definition.vertices.length && definition.indices.length) {
      shared.surface = new THREE.BufferGeometry();
      shared.surface.setAttribute(
        'position',
        new THREE.BufferAttribute(local(definition.vertices), 3),
      );
      shared.surface.setIndex(definition.indices);
      shared.surface.computeVertexNormals();
    }
    if (definition.segments.length) {
      shared.wire = new THREE.BufferGeometry();
      shared.wire.setAttribute(
        'position',
        new THREE.BufferAttribute(local(definition.segments), 3),
      );
    }
    blockGeometry.set(definition.hash, shared);
    return shared;
  }
  /** A block instance: shared definition geometry placed by the instance transform. */
  function blockInstance(object: DisplayObject, definition: BlockDefinition) {
    const shared = sharedBlock(definition);
    const texts = definition.texts ?? [];
    let mesh: RenderObject;
    if (shared.surface) mesh = new THREE.Mesh(shared.surface, surfaceMaterial());
    else if (shared.wire)
      mesh = new THREE.LineSegments(shared.wire, new THREE.LineBasicMaterial({ color: WIRE }));
    else if (texts.length)
      mesh = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: WIRE }),
      );
    else return undefined;
    mesh.userData.sharedGeometry = !!(shared.surface || shared.wire);
    if (shared.surface && shared.wire) {
      const wire = new THREE.LineSegments(
        shared.wire,
        new THREE.LineBasicMaterial({ color: WIRE }),
      );
      wire.userData.sharedGeometry = true;
      mesh.add(wire);
    }
    if (texts.length)
      for (const text of buildTextMeshes(texts, shared.origin, atlas)) mesh.add(text);
    mesh.userData.cad = texts.length ? { texts } : undefined;
    const transform = object.block!.transform;
    mesh.matrixAutoUpdate = false;
    mesh.matrix
      .set(...(transform as Parameters<THREE.Matrix4['set']>))
      .multiply(new THREE.Matrix4().makeTranslation(shared.origin));
    return mesh;
  }
  /**
   * Incremental (Live Sync): objects whose display hash is unchanged keep their GPU geometry and
   * only refresh colours; the rest are rebuilt. A full replace rebuilds everything.
   */
  function replace(
    data: DisplayObject[],
    incremental = false,
    definitions: Record<string, BlockDefinition> = {},
  ) {
    dirty = true;
    const next = new Map(data.map((object) => [object.id, object]));
    const kept = new Set<string>();
    for (const mesh of meshes) {
      const object = incremental ? next.get(mesh.userData.id) : undefined;
      if (object?.geometryHash && object.geometryHash === mesh.userData.geometryHash) {
        kept.add(object.id);
        mesh.userData.colors = {
          object: objectColor(object),
          layer: hexColor(object.layerColor),
          material: hexColor(object.materialColor),
        };
        continue;
      }
      scene.remove(mesh);
      releasePlot(mesh);
      disposeObject(mesh);
      byId.delete(mesh.userData.id);
    }
    const survivors = meshes.filter((mesh) => kept.has(mesh.userData.id));
    meshes.length = 0;
    for (const mesh of survivors) meshes.push(mesh);
    selectedIds = incremental ? new Set([...selectedIds].filter((id) => next.has(id))) : new Set();
    // Strings are cached across Syncs; start a fresh atlas when it has grown large.
    if (!incremental && atlas.size > 6) {
      atlas.dispose();
      atlas = new TextAtlas();
    }
    if (!incremental) {
      for (const shared of blockGeometry.values()) {
        shared.surface?.dispose();
        shared.wire?.dispose();
      }
      blockGeometry.clear();
    }
    for (const object of data) {
      if (kept.has(object.id)) continue;
      if (object.block) {
        const definition = definitions[object.block.definition];
        const instance = definition && blockInstance(object, definition);
        if (!instance) continue;
        instance.userData.colors = {
          object: objectColor(object),
          layer: hexColor(object.layerColor),
          material: hexColor(object.materialColor),
        };
        instance.userData.plot = { colorIndex: objectIndex(object), lineWeight: object.lineWeight };
        instance.userData.id = object.id;
        instance.userData.geometryHash = object.geometryHash;
        scene.add(instance);
        instance.visible = !hiddenIds.has(object.id);
        meshes.push(instance);
        byId.set(object.id, instance);
        continue;
      }
      const representation = sceneRepresentation(object);
      if (!representation) continue;
      const geometry = new THREE.BufferGeometry(),
        annotationOnly = representation.type === 'annotation',
        positions = annotationOnly ? [] : representation.positions;
      // Keep small details near the geometry origin before uploading float32 GPU attributes.
      const { origin, local } = annotationOnly
        ? {
            origin: (annotationAnchor(object) ?? new THREE.Vector3()).toArray() as [
              number,
              number,
              number,
            ],
            local: new Float32Array(0),
          }
        : displayCoordinates(positions);
      geometry.setAttribute('position', new THREE.BufferAttribute(local, 3));
      let mesh: RenderObject;
      if (representation.type === 'point')
        mesh = new THREE.Points(
          geometry,
          new THREE.PointsMaterial({ color: 0x69766c, size: 9, sizeAttenuation: false }),
        );
      else if (representation.type === 'mesh') {
        geometry.setIndex(representation.indices);
        geometry.computeVertexNormals();
        mesh = new THREE.Mesh(geometry, surfaceMaterial());
      } else if (representation.type === 'segments' || annotationOnly)
        mesh = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: WIRE }));
      else mesh = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: WIRE }));
      mesh.userData.colors = {
        object: objectColor(object),
        layer: hexColor(object.layerColor),
        material: hexColor(object.materialColor),
      };
      mesh.userData.plot = { colorIndex: objectIndex(object), lineWeight: object.lineWeight };
      mesh.position.set(origin[0], origin[1], origin[2]);
      // A surface that also carries wire segments (e.g. a solid hatch and its boundary).
      if (representation.type === 'mesh' && object.segments?.length) {
        const wire = new THREE.BufferGeometry();
        const points = new Float32Array(object.segments.length);
        for (let i = 0; i < points.length; i += 3) {
          points[i] = object.segments[i] - origin[0];
          points[i + 1] = object.segments[i + 1] - origin[1];
          points[i + 2] = object.segments[i + 2] - origin[2];
        }
        wire.setAttribute('position', new THREE.BufferAttribute(points, 3));
        mesh.add(new THREE.LineSegments(wire, new THREE.LineBasicMaterial({ color: WIRE })));
      }
      // CAD: per-segment styles plus fills and texts as children of the same pickable object.
      if (object.segmentStyles?.length && mesh instanceof THREE.LineSegments && !annotationOnly)
        mesh.userData.styled = runStyles(object.segmentStyles, local.length / 6);
      const anchor = new THREE.Vector3(origin[0], origin[1], origin[2]);
      if (object.fills?.length) {
        const fill = buildFillMesh(object.fills, anchor);
        if (fill) mesh.add(fill);
      }
      if (object.texts?.length)
        for (const text of buildTextMeshes(object.texts, anchor, atlas)) mesh.add(text);
      mesh.userData.cad = object.segmentStyles || object.fills || object.texts ? object : undefined;
      mesh.userData.id = object.id;
      // CAD objects carry styles/annotations outside the hash; they are always rebuilt.
      mesh.userData.geometryHash = mesh.userData.cad ? undefined : object.geometryHash;
      scene.add(mesh);
      mesh.visible = !hiddenIds.has(object.id);
      meshes.push(mesh);
      byId.set(object.id, mesh);
    }
    applyDisplay();
  }
  /** Crease edges are built lazily (only when shown) so large models stay cheap. */
  function edgesOf(mesh: THREE.Mesh) {
    let edges = mesh.userData.edges as
      | THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
      | undefined;
    if (!edges) {
      // Instances of one block share their crease edges as they share the surface.
      let geometry = mesh.userData.sharedGeometry ? sharedEdges.get(mesh.geometry) : undefined;
      if (!geometry) {
        geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          'position',
          new THREE.BufferAttribute(
            creaseEdges(
              mesh.geometry.getAttribute('position').array,
              mesh.geometry.index?.array ?? null,
              CREASE_ANGLE,
            ),
            3,
          ),
        );
        if (mesh.userData.sharedGeometry) sharedEdges.set(mesh.geometry, geometry);
      }
      edges = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: EDGE }));
      edges.userData.sharedGeometry = !!mesh.userData.sharedGeometry;
      edges.raycast = () => {};
      mesh.userData.edges = edges;
      mesh.add(edges);
    }
    return edges;
  }
  function baseColor(object: RenderObject) {
    const tinted = tints?.get(object.userData.id as string);
    if (tinted) return new THREE.Color(tinted);
    const colors = object.userData.colors as Record<string, string | undefined> | undefined;
    const source = display.colorSource === 'default' ? undefined : colors?.[display.colorSource];
    // ACI 7 is "foreground": white on dark screens, near-black on light ones.
    const plot = object.userData.plot as { colorIndex?: number } | undefined;
    if (display.colorSource === 'object' && plot?.colorIndex === 7)
      return new THREE.Color(darkBackground ? 0xffffff : 0x1f2421);
    if (source) return new THREE.Color(source);
    return new THREE.Color(object instanceof THREE.Mesh ? SURFACE : WIRE);
  }
  function releasePlot(object: RenderObject) {
    const runs = object.userData.plotRuns as THREE.Group | undefined;
    if (runs) {
      object.remove(runs);
      runs.traverse((item) => {
        if (item instanceof LineSegments2) {
          plotMaterials.delete(item.material);
          item.geometry.dispose();
          item.material.dispose();
        }
      });
      object.userData.plotRuns = undefined;
    }
    const fat = object.userData.plotLine as LineSegments2 | undefined;
    if (!fat) return;
    object.remove(fat);
    plotMaterials.delete(fat.material);
    fat.geometry.dispose();
    fat.material.dispose();
    object.userData.plotLine = undefined;
  }
  /** Fat line for plot preview (WebGL lines are always 1 px), built lazily per line object. */
  function plotLineOf(object: THREE.Line) {
    let fat = object.userData.plotLine as LineSegments2 | undefined;
    if (!fat) {
      const position = object.geometry.getAttribute('position');
      const points: number[] = [];
      const step = object instanceof THREE.LineSegments ? 2 : 1;
      for (let i = 0; i + 1 < position.count; i += step)
        points.push(
          position.getX(i),
          position.getY(i),
          position.getZ(i),
          position.getX(i + 1),
          position.getY(i + 1),
          position.getZ(i + 1),
        );
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(points);
      const material = new LineMaterial({ color: 0x000000, linewidth: 1, worldUnits: false });
      material.resolution.set(renderer.domElement.width, renderer.domElement.height);
      plotMaterials.add(material);
      fat = new LineSegments2(geometry, material);
      fat.raycast = () => {};
      object.userData.plotLine = fat;
      object.add(fat);
    }
    return fat;
  }
  /** Screen colour of one CAD style under the current colour source (ACI 7 = foreground). */
  function styleColor(style: CadStyle, object: RenderObject, fallback: number) {
    const cad = object.userData.cad as DisplayObject | undefined;
    if (display.colorSource === 'layer') {
      const layer = hexColor(style.layer) ?? hexColor(cad?.layerColor);
      return new THREE.Color(layer ?? fallback);
    }
    if (display.colorSource === 'object') {
      if (!hexColor(style.rgb) && style.ci === 7)
        return new THREE.Color(darkBackground ? 0xffffff : 0x1f2421);
      const own = hexColor(style.rgb) ?? (style.ci !== undefined ? aciColor(style.ci) : undefined);
      if (own) return new THREE.Color(own);
      return baseColor(object);
    }
    return new THREE.Color(fallback);
  }
  function stylePen(style: CadStyle, object: RenderObject) {
    const cad = object.userData.cad as DisplayObject | undefined;
    const screen =
      hexColor(style.rgb) ??
      (style.ci !== undefined ? aciColor(style.ci) : undefined) ??
      '#' + baseColor(object).getHexString();
    return plotPen(plotStyle, {
      colorIndex: style.ci ?? (cad ? objectIndex(cad) : undefined),
      screenColor: screen,
      lineWeight: style.lw ?? cad?.lineWeight,
    });
  }
  /** Fills and texts: vertex colours per style, following selection, plot and display mode. */
  function paintAnnotations(object: RenderObject, selected: boolean) {
    for (const child of object.children) {
      const part = child.userData.part as string | undefined;
      if (!part || !(child instanceof THREE.Mesh)) continue;
      const styled = child.userData.styled as StyledGeometry;
      const selectedColor = new THREE.Color(part === 'fill' ? SELECTED : SELECTED_WIRE);
      paintVertices(child.geometry, styled, (style) =>
        selected
          ? selectedColor
          : display.plot
            ? new THREE.Color(stylePen(style, object).color)
            : styleColor(style, object, part === 'fill' ? FILL : WIRE),
      );
      if (part === 'fill') {
        const material = child.material as THREE.MeshBasicMaterial;
        const ghosted = !display.plot && display.mode === 'ghosted';
        child.visible = display.plot || display.mode !== 'wireframe';
        material.transparent = ghosted;
        material.opacity = ghosted ? 0.3 : 1;
        material.depthWrite = !ghosted;
      }
    }
  }
  /** Plot preview for styled CAD segments: one fat-line batch per pen lineweight. */
  function paintRunPlot(object: THREE.LineSegments, selected: boolean) {
    const styled = object.userData.styled as StyledGeometry;
    let group = object.userData.plotRuns as THREE.Group | undefined;
    if (!group || group.userData.table !== plotStyle) {
      releasePlot(object as unknown as RenderObject);
      group = new THREE.Group();
      group.userData.table = plotStyle;
      const position = object.geometry.getAttribute('position');
      const pens = styled.styles.map((style) => stylePen(style, object as unknown as RenderObject));
      const batches = new Map<number, { points: number[]; colors: number[] }>();
      for (let i = 0; i + 1 < position.count; i += 2) {
        const pen = pens[styled.vertexStyle[i]] ?? pens[0];
        const weight = lineWeightPixels(pen?.lineWeight ?? plotStyle.defaultLineWeight);
        const batch = batches.get(weight) ?? { points: [], colors: [] };
        batches.set(weight, batch);
        const color = new THREE.Color(pen?.color ?? '#000000');
        batch.points.push(
          position.getX(i),
          position.getY(i),
          position.getZ(i),
          position.getX(i + 1),
          position.getY(i + 1),
          position.getZ(i + 1),
        );
        batch.colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
      }
      for (const [weight, batch] of batches) {
        const geometry = new LineSegmentsGeometry();
        geometry.setPositions(batch.points);
        geometry.setColors(batch.colors);
        const material = new LineMaterial({
          color: 0xffffff,
          linewidth: weight,
          worldUnits: false,
          vertexColors: true,
        });
        material.resolution.set(renderer.domElement.width, renderer.domElement.height);
        plotMaterials.add(material);
        const fat = new LineSegments2(geometry, material);
        fat.userData.weight = weight;
        fat.raycast = () => {};
        group.add(fat);
      }
      object.userData.plotRuns = group;
      object.add(group);
    }
    group.visible = true;
    for (const fat of group.children as LineSegments2[]) {
      fat.material.vertexColors = !selected;
      fat.material.color.set(selected ? SELECTED_WIRE : 0xffffff);
      fat.material.needsUpdate = true;
    }
  }
  /** Plot preview: CTB pen colours and lineweights on white paper; surfaces print white. */
  function paintPlot(object: RenderObject, selected: boolean) {
    const plot = object.userData.plot as { colorIndex?: number; lineWeight?: number };
    const screen = '#' + baseColor(object).getHexString();
    const pen = plotPen(plotStyle, { ...plot, screenColor: screen });
    const ink = new THREE.Color(selected ? SELECTED_WIRE : pen.color);
    if (object instanceof THREE.Mesh) {
      object.material.color.set(selected ? SELECTED : 0xffffff);
      object.material.visible = true;
      object.material.transparent = false;
      object.material.opacity = 1;
      object.material.depthWrite = true;
      object.material.needsUpdate = true;
      const edges = edgesOf(object);
      edges.visible = true;
      edges.material.color.copy(ink);
    } else if (object instanceof THREE.LineSegments && object.userData.styled) {
      object.material.visible = false;
      paintRunPlot(object, selected);
    } else if (object instanceof THREE.Line) {
      object.material.visible = false;
      const fat = plotLineOf(object);
      fat.visible = true;
      fat.material.color.copy(ink);
      fat.material.linewidth = lineWeightPixels(pen.lineWeight);
    } else object.material.color.copy(ink);
  }
  function paint(object: RenderObject) {
    const selected = selectedIds.has(object.userData.id);
    if (display.plot) {
      paintPlot(object, selected);
      paintAnnotations(object, selected);
      return;
    }
    const fat = object.userData.plotLine as LineSegments2 | undefined;
    if (fat) fat.visible = false;
    const runPlot = object.userData.plotRuns as THREE.Group | undefined;
    if (runPlot) runPlot.visible = false;
    paintAnnotations(object, selected);
    const styled = object.userData.styled as StyledGeometry | undefined;
    if (styled && object instanceof THREE.LineSegments) {
      object.material.visible = true;
      if (selected) {
        object.material.vertexColors = false;
        object.material.color.set(SELECTED_WIRE);
      } else {
        paintVertices(object.geometry, styled, (style) => styleColor(style, object, WIRE));
        object.material.vertexColors = true;
        object.material.color.set(0xffffff);
      }
      object.material.needsUpdate = true;
      return;
    }
    if (object instanceof THREE.Line) object.material.visible = true;
    const color = selected
      ? new THREE.Color(object instanceof THREE.Mesh ? SELECTED : SELECTED_WIRE)
      : baseColor(object);
    object.material.color.copy(color);
    if (object instanceof THREE.Mesh) {
      const material = object.material;
      const ghosted = display.mode === 'ghosted';
      material.visible = display.mode !== 'wireframe';
      material.transparent = ghosted;
      material.opacity = ghosted ? (selected ? 0.7 : 0.28) : 1;
      material.depthWrite = !ghosted;
      material.needsUpdate = true;
      const showEdges = display.mode !== 'shaded' || display.edges;
      const existing = object.userData.edges as THREE.LineSegments | undefined;
      if (showEdges) {
        const edges = edgesOf(object);
        edges.visible = true;
        // Wireframe edges take the object colour; shaded edges stay a dark outline.
        edges.material.color.copy(
          selected
            ? new THREE.Color(SELECTED_WIRE)
            : display.mode === 'shaded'
              ? new THREE.Color(EDGE)
              : color.clone().multiplyScalar(display.colorSource === 'default' ? 1 : 0.8),
        );
      } else if (existing) existing.visible = false;
    }
  }
  function applyBackground() {
    const dark =
      !display.plot &&
      (display.background === 'dark' ||
        (display.background === 'auto' && document.documentElement.dataset.theme === 'dark'));
    // --bg-recessed of tokens.css (light / dark).
    (scene.background as THREE.Color).set(display.plot ? '#ffffff' : dark ? '#161616' : '#f2f1ee');
    const rotation = grid.rotation.clone();
    scene.remove(grid);
    grid.geometry.dispose();
    for (const material of Array.isArray(grid.material) ? grid.material : [grid.material])
      material.dispose();
    grid = backdrop(
      dark
        ? new THREE.GridHelper(100, 50, 0x454543, 0x2c2c2b)
        : new THREE.GridHelper(100, 50, 0xc6c4be, 0xe3e2de),
    );
    grid.rotation.copy(rotation);
    grid.visible = !display.plot;
    scene.add(grid);
    renderer.domElement.dataset.background = dark ? 'dark' : 'light';
    darkBackground = dark;
  }
  function applyDisplay() {
    for (const object of meshes) paint(object);
    rebatchAll();
    renderer.domElement.dataset.display = display.mode;
    renderer.domElement.dataset.colorSource = display.colorSource;
    renderer.domElement.dataset.plot = String(display.plot);
    dirty = true;
  }
  /*
   * Draw batching. Per-object meshes stay the source of truth for picking, selection, hiding and
   * colours, but plain surfaces, their crease edges and plain lines are drawn through merged
   * geometry: objects are grouped in spatial chunks (up to CHUNK objects, local origin per cell so
   * survey coordinates keep millimetres) with per-vertex colours. A batched object sits on the
   * PICK layer (raycast only); selected, hidden and specially drawn parts stay individually drawn.
   * Changing the selection rebuilds only the chunks involved.
   */
  const RENDER_LAYER = 0,
    PICK_LAYER = 1,
    CHUNK = 400,
    CELL = 250;
  const batchRoot = new THREE.Group();
  scene.add(batchRoot);
  interface Batch {
    members: RenderObject[];
    origin: THREE.Vector3;
    drawn: THREE.Object3D[];
  }
  let batches = new Map<string, Batch>();
  let batchOfId = new Map<string, string>();
  const onLayer = (object: THREE.Object3D, layer: number) => object.layers.set(layer);
  /** The parts of an object that a chunk may draw; empty when it must be drawn by itself. */
  function batchParts(object: RenderObject) {
    if (display.plot || !object.visible || selectedIds.has(object.userData.id)) return undefined;
    if (object instanceof THREE.Points) return undefined;
    if (object instanceof THREE.Mesh) {
      const edges = object.userData.edges as THREE.LineSegments | undefined;
      return {
        surface: object.material.visible ? object : undefined,
        edges: edges?.visible ? edges : undefined,
      };
    }
    if (object.userData.plotRuns || object.userData.plotLine || !object.material.visible)
      return undefined;
    return { line: object };
  }
  function disposeBatch(batch: Batch) {
    for (const drawn of batch.drawn) {
      batchRoot.remove(drawn);
      disposeObject(drawn);
    }
    batch.drawn = [];
  }
  function buildBatch(batch: Batch) {
    disposeBatch(batch);
    const surfaces: THREE.Mesh[] = [],
      wires: THREE.Line[] = [];
    for (const member of batch.members) {
      const parts = batchParts(member);
      const surface = parts && 'surface' in parts ? parts.surface : undefined;
      const edges = parts && 'edges' in parts ? parts.edges : undefined;
      const line = parts && 'line' in parts ? parts.line : undefined;
      onLayer(member, surface || line ? PICK_LAYER : RENDER_LAYER);
      const own = member.userData.edges as THREE.LineSegments | undefined;
      if (own) onLayer(own, edges ? PICK_LAYER : RENDER_LAYER);
      if (surface) surfaces.push(surface as THREE.Mesh);
      if (edges) wires.push(edges);
      if (line) wires.push(line as THREE.Line);
    }
    const point = new THREE.Vector3(),
      normal = new THREE.Vector3(),
      normalMatrix = new THREE.Matrix3();
    if (surfaces.length) {
      let vertexCount = 0,
        indexCount = 0;
      for (const mesh of surfaces) {
        const count = mesh.geometry.getAttribute('position').count;
        vertexCount += count;
        indexCount += mesh.geometry.index?.count ?? count;
      }
      const positions = new Float32Array(vertexCount * 3),
        normals = new Float32Array(vertexCount * 3),
        colors = new Float32Array(vertexCount * 3),
        indices = new Uint32Array(indexCount);
      let v = 0,
        n = 0;
      for (const mesh of surfaces) {
        mesh.updateWorldMatrix(true, false);
        normalMatrix.getNormalMatrix(mesh.matrixWorld);
        const position = mesh.geometry.getAttribute('position'),
          normalAttribute = mesh.geometry.getAttribute('normal'),
          color = (mesh.material as THREE.MeshStandardMaterial).color,
          base = v;
        for (let i = 0; i < position.count; i++, v++) {
          point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).sub(batch.origin);
          positions[v * 3] = point.x;
          positions[v * 3 + 1] = point.y;
          positions[v * 3 + 2] = point.z;
          if (normalAttribute) {
            normal.fromBufferAttribute(normalAttribute, i).applyNormalMatrix(normalMatrix);
            normals[v * 3] = normal.x;
            normals[v * 3 + 1] = normal.y;
            normals[v * 3 + 2] = normal.z;
          }
          colors[v * 3] = color.r;
          colors[v * 3 + 1] = color.g;
          colors[v * 3 + 2] = color.b;
        }
        const index = mesh.geometry.index;
        if (index) for (let i = 0; i < index.count; i++) indices[n++] = base + index.getX(i);
        else for (let i = 0; i < position.count; i++) indices[n++] = base + i;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      const sample = surfaces[0].material as THREE.MeshStandardMaterial;
      const material = surfaceMaterial();
      material.vertexColors = true;
      material.color.set(0xffffff);
      material.transparent = sample.transparent;
      material.opacity = sample.opacity;
      material.depthWrite = sample.depthWrite;
      const merged = new THREE.Mesh(geometry, material);
      merged.position.copy(batch.origin);
      merged.raycast = () => {};
      batch.drawn.push(merged);
    }
    if (wires.length) {
      let count = 0;
      for (const line of wires) {
        const vertices = line.geometry.getAttribute('position').count;
        count += line instanceof THREE.LineSegments ? vertices : Math.max(0, vertices - 1) * 2;
      }
      const positions = new Float32Array(count * 3),
        colors = new Float32Array(count * 3);
      let v = 0;
      for (const line of wires) {
        line.updateWorldMatrix(true, false);
        const position = line.geometry.getAttribute('position'),
          painted = (line.material as THREE.LineBasicMaterial).vertexColors
            ? line.geometry.getAttribute('color')
            : undefined,
          color = (line.material as THREE.LineBasicMaterial).color;
        const put = (i: number) => {
          point.fromBufferAttribute(position, i).applyMatrix4(line.matrixWorld).sub(batch.origin);
          positions[v * 3] = point.x;
          positions[v * 3 + 1] = point.y;
          positions[v * 3 + 2] = point.z;
          colors[v * 3] = painted ? painted.getX(i) : color.r;
          colors[v * 3 + 1] = painted ? painted.getY(i) : color.g;
          colors[v * 3 + 2] = painted ? painted.getZ(i) : color.b;
          v++;
        };
        if (line instanceof THREE.LineSegments) for (let i = 0; i < position.count; i++) put(i);
        else
          for (let i = 0; i + 1 < position.count; i++) {
            put(i);
            put(i + 1);
          }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const merged = new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({ vertexColors: true }),
      );
      merged.position.copy(batch.origin);
      merged.raycast = () => {};
      batch.drawn.push(merged);
    }
    for (const drawn of batch.drawn) batchRoot.add(drawn);
  }
  /** Regroup every object into chunks and rebuild all merged geometry. */
  function rebatchAll() {
    for (const batch of batches.values()) disposeBatch(batch);
    batches = new Map();
    batchOfId = new Map();
    const open = new Map<string, number>();
    for (const object of meshes) {
      object.updateWorldMatrix(true, false);
      const at = new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);
      const cell = `${Math.floor(at.x / CELL)}:${Math.floor(at.y / CELL)}:${Math.floor(at.z / CELL)}`;
      const kind = object instanceof THREE.Mesh ? 'm' : 'l';
      const group = kind + '|' + cell;
      const index = open.get(group) ?? 0;
      let key = group + '|' + index;
      let batch = batches.get(key);
      if (batch && batch.members.length >= CHUNK) {
        open.set(group, index + 1);
        key = group + '|' + (index + 1);
        batch = undefined;
      }
      if (!batch) {
        batch = {
          members: [],
          drawn: [],
          origin: new THREE.Vector3(
            Math.floor(at.x / CELL) * CELL,
            Math.floor(at.y / CELL) * CELL,
            Math.floor(at.z / CELL) * CELL,
          ),
        };
        batches.set(key, batch);
      }
      batch.members.push(object);
      batchOfId.set(object.userData.id, key);
    }
    for (const batch of batches.values()) buildBatch(batch);
    dirty = true;
  }
  /** Rebuild only the chunks holding these objects (selection changes). */
  function rebatchIds(ids: Iterable<string>) {
    const keys = new Set<string>();
    for (const id of ids) {
      const key = batchOfId.get(id);
      if (key) keys.add(key);
    }
    for (const key of keys) {
      const batch = batches.get(key);
      if (batch) buildBatch(batch);
    }
    dirty = true;
  }
  replace(objects);
  const lines = new THREE.Group();
  scene.add(lines);
  const ray = new THREE.Raycaster(),
    mouse = new THREE.Vector2();
  // Batched objects are drawn through merged geometry but still picked one by one.
  ray.layers.enableAll();
  // Overlay fat lines are picked within a few pixels of their drawn width.
  (ray.params as unknown as Record<string, unknown>).Line2 = { threshold: 4 };
  let mode: ToolMode = 'select',
    down: { x: number; y: number } | null = null,
    frame: number;
  let brush: BrushSettings = {
    color: '#d0473a',
    width: 4,
    surface: true,
    erase: false,
  };
  // Grease-Pencil-like depth: a stroke lies on the view plane through its anchor — the surface
  // under its first point, else the last surface point drawn on (like Blender's 3D cursor), else
  // the orbit centre. In top/front/side views that view plane is the axis plane itself.
  let anchor: THREE.Vector3 | null = null;
  // Apple Pencil: once a pen is seen, the pen draws and fingers only navigate.
  let penSeen = false;
  const touches = new Set<number>();
  // Screen-constant line widths need the drawing buffer size.
  const lineMaterials = new Set<LineMaterial>();
  function strokeLine(points: THREE.Vector3[], color: string, width: number) {
    const origin = points[0].clone();
    const geometry = new LineGeometry();
    geometry.setPositions(points.flatMap((p) => [p.x - origin.x, p.y - origin.y, p.z - origin.z]));
    const material = new LineMaterial({
      color: new THREE.Color(color).getHex(),
      linewidth: width,
      worldUnits: false,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    });
    material.resolution.set(renderer.domElement.width, renderer.domElement.height);
    lineMaterials.add(material);
    const line = new Line2(geometry, material);
    line.position.copy(origin);
    line.renderOrder = 10;
    return line;
  }
  function clearGroup(group: THREE.Group) {
    while (group.children.length) {
      const child = group.children[0];
      group.remove(child);
      child.traverse((item) => {
        if (item instanceof Line2) lineMaterials.delete(item.material);
      });
      disposeObject(child);
    }
  }
  /*
   * Jig overlay layers (SPEC-07.10, PLAN-22 T-041): display primitives keyed by layer, in a group
   * of their own. They are never in `meshes`, so selection, hiding, batching, "fit all", select-all
   * and requests never see them. Drawn over the document (no depth test) and under sketches.
   */
  const overlayRoot = new THREE.Group();
  scene.add(overlayRoot);
  const overlays = new Map<string, { group: THREE.Group; style: Required<OverlayStyle> }>();
  // Resolved once per layer build: a layer can hold thousands of items of a few tones.
  let tones: Map<OverlayTone, string> | undefined;
  function toneColor(tone: OverlayTone = 'ov-new') {
    let color = tones?.get(tone);
    if (color) return color;
    // The stylesheet's token wins once it is defined; the defaults are the tokens.css light values.
    const css = getComputedStyle(document.documentElement).getPropertyValue(`--${tone}`).trim();
    color = hexColor(css) ?? OVERLAY_TONES[tone] ?? OVERLAY_TONES['ov-new'];
    tones?.set(tone, color);
    return color;
  }
  /** A screen-constant tag; its scale follows the camera (see scaleLabels). */
  function overlayLabel(text: string, color: string) {
    const k = 2,
      font = `600 ${11 * k}px 'Inter Variable', 'Noto Sans KR Variable', 'Malgun Gothic', sans-serif`;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    context.font = font;
    const width = Math.ceil(context.measureText(text).width) + 12 * k,
      height = 18 * k;
    canvas.width = width;
    canvas.height = height;
    context.font = font;
    context.fillStyle = '#ffffffee';
    context.strokeStyle = color;
    context.lineWidth = k;
    context.beginPath();
    context.roundRect(k / 2, k / 2, width - k, height - k, 4 * k);
    context.fill();
    context.stroke();
    context.fillStyle = '#292c2d';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, width / 2, height / 2 + k / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        sizeAttenuation: false,
        depthTest: false,
        depthWrite: false,
        transparent: true,
      }),
    );
    sprite.userData.labelSize = [width / k, height / k];
    sprite.renderOrder = 8;
    return sprite;
  }
  function overlayItem(item: OverlayItem) {
    const color = toneColor(item.tone);
    const finite = (values: readonly number[]) => values.every(Number.isFinite);
    const group = new THREE.Group();
    const part = (object: THREE.Object3D, name: string, opacity: number) => {
      object.userData.overlayPart = name;
      object.userData.baseOpacity = opacity;
      group.add(object);
    };
    let labelAt: THREE.Vector3 | undefined;
    if (item.kind === 'point') {
      if (!finite(item.at)) return undefined;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
      const point = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({
          color,
          size: 10,
          sizeAttenuation: false,
          depthTest: false,
          depthWrite: false,
          transparent: true,
        }),
      );
      point.position.set(...item.at);
      point.renderOrder = 7;
      part(point, 'point', 1);
      labelAt = point.position.clone();
    } else {
      const points =
        item.kind === 'polygon'
          ? item.points.map(([x, y]) => new THREE.Vector3(x, y, item.z))
          : item.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
      if (points.length < 2 || !points.every((p) => finite(p.toArray()))) return undefined;
      const closed = item.kind === 'polygon' || item.closed;
      const line = strokeLine(
        closed ? [...points, points[0]] : points,
        color,
        item.kind === 'polyline' ? (item.width ?? 2) : 1.5,
      );
      line.renderOrder = 6;
      if (item.kind === 'polyline' && item.dashed) {
        line.material.dashed = true;
        line.material.dashSize = 0.6;
        line.material.gapSize = 0.35;
        line.computeLineDistances();
      }
      part(line, 'line', 1);
      if (item.kind === 'polygon' && item.fill && points.length >= 3) {
        const origin = points[0];
        const shape = new THREE.Shape(
          points.map((p) => new THREE.Vector2(p.x - origin.x, p.y - origin.y)),
        );
        const fill = new THREE.Mesh(
          new THREE.ShapeGeometry(shape),
          new THREE.MeshBasicMaterial({
            color,
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false,
            transparent: true,
          }),
        );
        fill.position.copy(origin);
        fill.renderOrder = 5;
        part(fill, 'fill', 0.32);
      }
      labelAt =
        item.kind === 'polygon'
          ? points.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(points.length)
          : points[Math.floor((points.length - 1) / 2)]
              .clone()
              .lerp(points[Math.ceil((points.length - 1) / 2)], 0.5);
    }
    if (item.label && labelAt) {
      const label = overlayLabel(item.label, color);
      label.position.copy(labelAt);
      // Tags sit above points; on areas and lines they are centred on the anchor.
      if (item.kind === 'point') label.center.set(0.5, -0.35);
      part(label, 'label', 1);
    }
    return group;
  }
  function disposeOverlay(group: THREE.Group) {
    group.traverse((item) => {
      if (item instanceof Line2) lineMaterials.delete(item.material);
      if (item instanceof THREE.Sprite) {
        // Sprites share one quad geometry; only the tag texture and material are their own.
        item.material.map?.dispose();
        item.material.dispose();
      } else if (item instanceof THREE.Mesh || item instanceof THREE.Points) {
        item.geometry.dispose();
        (item.material as THREE.Material).dispose();
      }
    });
  }
  function applyOverlayStyle(key: string) {
    const layer = overlays.get(key);
    if (!layer) return;
    layer.group.visible = layer.style.visible;
    layer.group.traverse((item) => {
      const base = item.userData.baseOpacity as number | undefined;
      if (base === undefined) return;
      const material = (item as THREE.Mesh).material as THREE.Material;
      material.opacity = base * layer.style.opacity;
    });
    dirty = true;
  }
  /** Replace one overlay layer's items; null removes the layer. The layer's style is kept. */
  function setOverlay(key: string, items: readonly OverlayItem[] | null) {
    const previous = overlays.get(key);
    if (previous) {
      overlayRoot.remove(previous.group);
      disposeOverlay(previous.group);
      overlays.delete(key);
    }
    dirty = true;
    if (!items) return;
    const group = new THREE.Group();
    tones = new Map();
    try {
      for (const item of items) {
        const built = overlayItem(item);
        if (!built) continue;
        built.userData.overlayItem = { key, itemId: item.id };
        group.add(built);
      }
    } finally {
      tones = undefined;
    }
    overlays.set(key, { group, style: previous?.style ?? { visible: true, opacity: 1 } });
    overlayRoot.add(group);
    applyOverlayStyle(key);
  }
  /** Tags keep their pixel size: scale = 2·px / (P₁₁·height) for both projections. */
  function scaleLabels() {
    const k =
      2 / (camera.projectionMatrix.elements[5] * Math.max(1, renderer.domElement.clientHeight));
    overlayRoot.traverse((item) => {
      if (!(item instanceof THREE.Sprite)) return;
      const [w, h] = item.userData.labelSize as [number, number];
      item.scale.set(w * k, h * k, 1);
    });
  }
  /** Frame document objects, a box, or an overlay layer or item; small targets get room. */
  function focus(target: FocusTarget) {
    const bounds = new THREE.Box3();
    if ('overlay' in target) {
      const group = overlays.get(target.overlay)?.group;
      if (!group) return;
      group.updateMatrixWorld(true);
      for (const item of group.children)
        if (target.itemId === undefined || item.userData.overlayItem?.itemId === target.itemId)
          for (const child of item.children)
            if (!(child instanceof THREE.Sprite)) bounds.expandByObject(child);
    } else if ('min' in target) {
      bounds.set(new THREE.Vector3(...target.min), new THREE.Vector3(...target.max));
    } else {
      const wanted = new Set(target);
      for (const mesh of meshes) if (wanted.has(mesh.userData.id)) bounds.expandByObject(mesh);
    }
    if (bounds.isEmpty()) return;
    const size = bounds.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z);
    if (span < 3) bounds.expandByScalar((3 - span) / 2);
    frameBox(bounds);
  }
  const live = new THREE.Group();
  scene.add(live);
  let drawing: {
    points: THREE.Vector3[];
    screen: { x: number; y: number };
    pressure: number[];
    pen: boolean;
    fallback: THREE.Plane;
  } | null = null;
  let erasing = false;
  let draftStrokes: DraftStroke[] = [];
  function sizing() {
    dirty = true;
    const w = container.clientWidth,
      h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    perspective.aspect = w / h;
    perspective.updateProjectionMatrix();
    orthographic.left = (-viewSpan * w) / h / 2;
    orthographic.right = (viewSpan * w) / h / 2;
    orthographic.top = viewSpan / 2;
    orthographic.bottom = -viewSpan / 2;
    orthographic.updateProjectionMatrix();
    for (const material of [...lineMaterials, ...plotMaterials])
      material.resolution.set(renderer.domElement.width, renderer.domElement.height);
  }
  function configure() {
    // Sketching keeps 3D navigation: left draws, right orbits, Shift+right pans, wheel zooms.
    controls.enableRotate = !standardView;
    controls.mouseButtons.LEFT = undefined;
    controls.mouseButtons.RIGHT = standardView ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    // Touch: one finger orbits (pans in top/front/side), two fingers zoom and pan. While
    // sketching without a pen, one finger draws instead.
    controls.touches.ONE =
      mode === 'sketch' && !penSeen ? null : standardView ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
    controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
  }
  function reportCamera() {
    dirty = true;
    const direction = camera.position.clone().sub(controls.target).normalize();
    const ortho = camera instanceof THREE.OrthographicCamera;
    let view =
      !ortho && direction.distanceTo(new THREE.Vector3(34, -45, 30).normalize()) < 0.001
        ? 'axon'
        : '';
    if (ortho) {
      if (direction.distanceTo(new THREE.Vector3(0, 0, 1)) < 0.001) view = 'plan';
      else if (direction.distanceTo(new THREE.Vector3(0, -1, 0)) < 0.001) view = 'front';
      else if (direction.distanceTo(new THREE.Vector3(1, 0, 0)) < 0.001) view = 'side';
    }
    onCamera?.({ view, projection: ortho ? 'orthographic' : 'perspective' });
  }
  function activate(next: Camera, target: THREE.Vector3) {
    controls.dispose();
    camera = next;
    camera.lookAt(target);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.zoomToCursor = true;
    controls.minDistance = distances.min;
    controls.maxDistance = distances.max;
    controls.minZoom = 0.2;
    controls.maxZoom = maxZoom;
    controls.target.copy(target);
    controls.addEventListener('change', reportCamera);
    configure();
    sizing();
    controls.update();
    renderer.domElement.dataset.projection =
      camera instanceof THREE.OrthographicCamera ? 'orthographic' : 'perspective';
    reportCamera();
  }
  /** Frame one object, several objects, or everything visible. */
  function fit(id?: string | readonly string[]) {
    const wanted = id === undefined ? undefined : new Set(typeof id === 'string' ? [id] : id);
    const targets = wanted
      ? meshes.filter((m) => wanted.has(m.userData.id))
      : meshes.filter((m) => m.visible);
    if (!targets.length) return;
    const bounds = new THREE.Box3();
    targets.forEach((m) => bounds.expandByObject(m));
    frameBox(bounds);
  }
  function frameBox(bounds: THREE.Box3) {
    const center = bounds.getCenter(new THREE.Vector3());
    const sceneRadius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 0.1);
    camera.near = Math.max(sceneRadius / 10000, 0.001);
    camera.far = Math.max(sceneRadius * 100, 1000);
    // Zoom stops only a few centimetres from the surface, as in Rhino, not at 1% of the model.
    distances = {
      min: Math.max(sceneRadius * 0.0005, 0.02),
      max: Math.max(sceneRadius * 20, 180),
    };
    controls.minDistance = distances.min;
    controls.maxDistance = distances.max;
    const shift = center.clone().sub(controls.target);
    camera.position.add(shift);
    controls.target.copy(center);
    camera.lookAt(center);
    camera.updateMatrixWorld();
    if (camera instanceof THREE.OrthographicCamera) {
      const direction = camera.position.clone().sub(center).normalize();
      camera.position.copy(center).addScaledVector(direction, sceneRadius * 3);
      camera.lookAt(center);
      camera.updateMatrixWorld();
      let halfW = 0,
        halfH = 0;
      const c = center.clone().applyMatrix4(camera.matrixWorldInverse);
      for (const x of [bounds.min.x, bounds.max.x])
        for (const y of [bounds.min.y, bounds.max.y])
          for (const z of [bounds.min.z, bounds.max.z]) {
            const q = new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse).sub(c);
            halfW = Math.max(halfW, Math.abs(q.x));
            halfH = Math.max(halfH, Math.abs(q.y));
          }
      const aspect = container.clientWidth / Math.max(1, container.clientHeight);
      viewSpan = 2.6 * Math.max(halfH, halfW / aspect, 0.001);
      camera.zoom = 1;
      maxZoom = controls.maxZoom = Math.max(20, viewSpan / 0.05);
    } else {
      const radius = sceneRadius;
      const v = THREE.MathUtils.degToRad(camera.fov / 2),
        h = Math.atan(Math.tan(v) * camera.aspect);
      const distance = (radius / Math.sin(Math.min(v, h))) * 1.1;
      const direction = camera.position.clone().sub(center).normalize();
      camera.position.copy(center).addScaledVector(direction, distance);
    }
    sizing();
    controls.update();
  }
  function home() {
    standardView = false;
    perspective.up.set(0, 0, 1);
    perspective.position.set(34, -43, 32);
    activate(perspective, new THREE.Vector3(0, 2, 2));
    grid.rotation.set(Math.PI / 2, 0, 0);
    fit();
  }
  home();
  function planeView(name: PlaneName) {
    standardView = true;
    orthographic.zoom = 1;
    orthographic.up.set(0, 0, 1);
    if (name === 'XY') {
      orthographic.up.set(0, 1, 0);
      orthographic.position.set(0, 0, 52);
      grid.rotation.set(Math.PI / 2, 0, 0);
    } else if (name === 'XZ') {
      orthographic.position.set(0, -52, 0);
      grid.rotation.set(0, 0, 0);
    } else {
      orthographic.position.set(52, 0, 0);
      grid.rotation.set(0, 0, Math.PI / 2);
    }
    activate(orthographic, new THREE.Vector3());
    fit();
  }
  function projection(kind: 'orthographic' | 'perspective') {
    const next = kind === 'orthographic' ? orthographic : perspective;
    if (next === camera) return;
    const target = controls.target.clone(),
      position = camera.position.clone(),
      up = camera.up.clone();
    const distance = position.distanceTo(target);
    if (next instanceof THREE.OrthographicCamera) {
      viewSpan = 2 * distance * Math.tan(THREE.MathUtils.degToRad(perspective.fov / 2));
      next.zoom = 1;
    } else {
      const desired =
        viewSpan /
        orthographic.zoom /
        (2 * Math.tan(THREE.MathUtils.degToRad(perspective.fov / 2)));
      position
        .copy(target)
        .addScaledVector(camera.position.clone().sub(target).normalize(), desired);
      standardView = false;
    }
    next.position.copy(position);
    next.up.copy(up);
    next.near = camera.near;
    next.far = camera.far;
    activate(next, target);
  }
  function rayAt(e: { clientX: number; clientY: number }) {
    const r = renderer.domElement.getBoundingClientRect();
    mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, (-(e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const span =
      camera instanceof THREE.OrthographicCamera
        ? viewSpan / camera.zoom
        : 2 *
          camera.position.distanceTo(controls.target) *
          Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    ray.params.Points.threshold = ray.params.Line.threshold = (span / Math.max(r.height, 1)) * 6;
  }
  function cameraPointerDown(e: PointerEvent) {
    // OrbitControls swaps ROTATE/PAN for Shift. Keep both gestures planar in standard views.
    if (e.button === 2 && standardView)
      controls.mouseButtons.RIGHT =
        e.shiftKey || e.ctrlKey || e.metaKey ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
  }
  const marquee = document.createElement('div');
  marquee.className = 'selection-marquee';
  marquee.hidden = true;
  container.append(marquee);
  function selectionMode(e: PointerEvent | MouseEvent) {
    return e.ctrlKey || e.metaKey ? 'remove' : e.shiftKey ? 'add' : 'replace';
  }
  function pointerDown(e: PointerEvent) {
    if (e.pointerType === 'touch') touches.add(e.pointerId);
    if (e.pointerType === 'pen' && !penSeen) {
      penSeen = true;
      configure();
    }
    if (e.button !== 0) return;
    if (mode === 'sketch') {
      // A second finger means navigation (pinch/pan): drop the stroke the first finger began.
      if (e.pointerType === 'touch' && (penSeen || touches.size > 1)) {
        if (drawing) {
          drawing = null;
          clearGroup(live);
          dirty = true;
        }
        return;
      }
      renderer.domElement.setPointerCapture?.(e.pointerId);
      if (brush.erase) {
        erasing = true;
        erase(e);
        return;
      }
      startStroke(e);
      return;
    }
    down = { x: e.clientX, y: e.clientY };
  }
  const surfaceMeshes = () => meshes.filter((m) => m instanceof THREE.Mesh);
  function viewPlane(through: THREE.Vector3) {
    const normal = camera.getWorldDirection(new THREE.Vector3()).negate();
    return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, through);
  }
  const surfaceHit = (e: PointerEvent) => {
    rayAt(e);
    return ray.intersectObjects(surfaceMeshes(), false)[0];
  };
  /** Onto the surface under the pen (when following surfaces), else onto the stroke's plane. */
  function projectPoint(e: PointerEvent, fallback: THREE.Plane) {
    const hit = brush.surface ? surfaceHit(e) : undefined;
    if (hit) {
      // Continue off the edge of an object at the depth of the last surface point.
      if (drawing) drawing.fallback = viewPlane(hit.point);
      anchor = hit.point.clone();
      return hit.point.clone();
    }
    if (!brush.surface) rayAt(e);
    return ray.ray.intersectPlane(fallback, new THREE.Vector3());
  }
  function startStroke(e: PointerEvent) {
    const hit = surfaceHit(e);
    if (hit) anchor = hit.point.clone();
    const fallback = viewPlane((anchor ?? controls.target).clone());
    drawing = {
      points: [],
      screen: { x: e.clientX, y: e.clientY },
      pressure: [],
      pen: e.pointerType === 'pen',
      fallback,
    };
    const point = projectPoint(e, fallback);
    if (point) drawing.points.push(point);
    drawing.pressure.push(e.pressure || 0.5);
  }
  function extendStroke(e: PointerEvent) {
    if (!drawing || drawing.points.length >= 2000) return;
    // Keep strokes light: sample only after the pointer moves a few screen pixels.
    if (Math.hypot(e.clientX - drawing.screen.x, e.clientY - drawing.screen.y) < 3) return;
    const point = projectPoint(e, drawing.fallback);
    if (!point) return;
    drawing.screen = { x: e.clientX, y: e.clientY };
    drawing.points.push(point);
    drawing.pressure.push(e.pressure || 0.5);
    clearGroup(live);
    if (drawing.points.length >= 2)
      live.add(strokeLine(drawing.points, brush.color, strokeWidth(drawing)));
    dirty = true;
  }
  function strokeWidth(stroke: NonNullable<typeof drawing>) {
    if (!stroke.pen) return brush.width;
    const average = stroke.pressure.reduce((sum, value) => sum + value, 0) / stroke.pressure.length;
    return Math.min(64, Math.max(0.5, brush.width * Math.min(2, Math.max(0.3, average * 2))));
  }
  function finishStroke() {
    const stroke = drawing;
    drawing = null;
    clearGroup(live);
    dirty = true;
    if (!stroke || stroke.points.length < 2) return;
    const round = (value: number) => Math.round(value * 1000) / 1000;
    onSketch({
      type: 'stroke',
      stroke: {
        points: stroke.points.map((p): Point3 => [round(p.x), round(p.y), round(p.z)]),
        color: brush.color,
        width: Math.round(strokeWidth(stroke) * 10) / 10,
      },
    });
  }
  function erase(e: PointerEvent) {
    const r = renderer.domElement.getBoundingClientRect();
    const x = e.clientX - r.left,
      y = e.clientY - r.top;
    const screen = ([px, py, pz]: Point3) => {
      const v = new THREE.Vector3(px, py, pz).project(camera);
      return [((v.x + 1) / 2) * r.width, ((1 - v.y) / 2) * r.height] as const;
    };
    const near = (a: readonly [number, number], b: readonly [number, number]) => {
      const dx = b[0] - a[0],
        dy = b[1] - a[1];
      const t = Math.max(
        0,
        Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)),
      );
      return Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y) < 10;
    };
    for (let index = draftStrokes.length - 1; index >= 0; index--) {
      const points = draftStrokes[index].points.map(screen);
      if (points.some((point, i) => i > 0 && near(points[i - 1], point))) {
        onSketch({ type: 'erase', index });
        return;
      }
    }
  }
  function pointerMove(e: PointerEvent) {
    if (mode === 'sketch') {
      if (!(e.buttons & 1)) return;
      if (drawing) extendStroke(e);
      else if (erasing) erase(e);
      return;
    }
    if (!down || !(e.buttons & 1)) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 5) return;
    const r = container.getBoundingClientRect();
    marquee.hidden = false;
    // Rhino: left-to-right selects enclosed objects (solid), right-to-left selects crossing (dashed).
    marquee.dataset.crossing = String(e.clientX < down.x);
    Object.assign(marquee.style, {
      left: Math.min(down.x, e.clientX) - r.left + 'px',
      top: Math.min(down.y, e.clientY) - r.top + 'px',
      width: Math.abs(e.clientX - down.x) + 'px',
      height: Math.abs(e.clientY - down.y) + 'px',
    });
  }
  const corner = new THREE.Vector3();
  function boxSelect(x0: number, y0: number, x1: number, y1: number, crossing: boolean) {
    const r = renderer.domElement.getBoundingClientRect();
    const minX = Math.min(x0, x1) - r.left,
      maxX = Math.max(x0, x1) - r.left,
      minY = Math.min(y0, y1) - r.top,
      maxY = Math.max(y0, y1) - r.top;
    camera.updateMatrixWorld();
    const inside = (x: number, y: number) => x >= minX && x <= maxX && y >= minY && y <= maxY;
    const cross = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
      (qx - px) * (ry - py) - (qy - py) * (rx - px);
    const edges: [number, number, number, number][] = [
      [minX, minY, maxX, minY],
      [maxX, minY, maxX, maxY],
      [maxX, maxY, minX, maxY],
      [minX, maxY, minX, minY],
    ];
    const segmentHits = (ax: number, ay: number, bx: number, by: number) => {
      if (inside(ax, ay) || inside(bx, by)) return true;
      if (Math.max(ax, bx) < minX || Math.min(ax, bx) > maxX) return false;
      if (Math.max(ay, by) < minY || Math.min(ay, by) > maxY) return false;
      return edges.some(
        ([cx, cy, dx, dy]) =>
          cross(ax, ay, bx, by, cx, cy) * cross(ax, ay, bx, by, dx, dy) <= 0 &&
          cross(cx, cy, dx, dy, ax, ay) * cross(cx, cy, dx, dy, bx, by) <= 0,
      );
    };
    const picked: string[] = [];
    for (const object of meshes) {
      if (!object.visible) continue;
      const id = object.userData.id;
      const position = object.geometry.getAttribute('position');
      if (typeof id !== 'string' || !position) continue;
      object.updateMatrixWorld(true);
      const count = position.count,
        stride = Math.max(1, Math.floor(count / 4000));
      const screen: number[] = [];
      let all = true,
        any = false,
        tested = 0;
      const test = (
        source: THREE.Object3D,
        attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
        record: boolean,
      ) => {
        const n = attribute.count,
          step = Math.max(1, Math.floor(n / 4000));
        for (let i = 0; i < n; i += step) {
          corner.fromBufferAttribute(attribute, i).applyMatrix4(source.matrixWorld).project(camera);
          const x = ((corner.x + 1) / 2) * r.width,
            y = ((1 - corner.y) / 2) * r.height;
          if (record) screen.push(x, y);
          tested++;
          if (corner.z <= 1 && inside(x, y)) any = true;
          else all = false;
          if (crossing ? any : !all) return;
        }
      };
      test(object, position, true);
      // CAD fills and texts are part of the object for window/crossing selection.
      for (const child of object.children)
        if (child.userData.part && child instanceof THREE.Mesh && (crossing ? !any : all))
          test(child, child.geometry.getAttribute('position'), false);
      if (!crossing) {
        if (all && tested) picked.push(id);
        continue;
      }
      if (!any && object instanceof THREE.Line)
        for (let i = 2; i + 1 < screen.length && !any; i += 2)
          any = segmentHits(screen[i - 2], screen[i - 1], screen[i], screen[i + 1]);
      if (!any && object instanceof THREE.Mesh && stride === 1 && screen.length === count * 2) {
        const index = object.geometry.getIndex();
        if (index)
          for (let t = 0; t + 2 < index.count && !any; t += 3)
            for (const [a, b] of [
              [0, 1],
              [1, 2],
              [2, 0],
            ]) {
              const p = index.getX(t + a) * 2,
                q = index.getX(t + b) * 2;
              if (segmentHits(screen[p], screen[p + 1], screen[q], screen[q + 1])) {
                any = true;
                break;
              }
            }
      }
      if (any) picked.push(id);
    }
    if (crossing) {
      // A crossing window drawn entirely inside a large face still touches that face.
      mouse.set(((minX + maxX) / 2 / r.width) * 2 - 1, (-(minY + maxY) / 2 / r.height) * 2 + 1);
      ray.setFromCamera(mouse, camera);
      const hit = ownerId(ray.intersectObjects(visibleMeshes(), true)[0]?.object);
      if (hit && !picked.includes(hit)) picked.push(hit);
    }
    return picked;
  }
  function pointerUp(e: PointerEvent) {
    touches.delete(e.pointerId);
    if (e.button === 0 && mode === 'sketch') {
      erasing = false;
      finishStroke();
      return;
    }
    if (e.button !== 0 || !down) return;
    const start = down;
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    down = null;
    marquee.hidden = true;
    if (moved > 5) {
      if (mode !== 'sketch')
        onPick(
          boxSelect(start.x, start.y, e.clientX, e.clientY, e.clientX < start.x),
          selectionMode(e),
          { source: 'document' },
        );
      return;
    }
    const pick = pickAt(e.clientX, e.clientY);
    onPick(pick.ids, selectionMode(e), pick.source);
  }
  /**
   * A click: overlay marks (points, labels, lines) first as they are drawn on top, then document
   * objects, then overlay fills — a large fill never hides the objects under it.
   */
  function pickAt(x: number, y: number): { ids: string[]; source: PickSource } {
    rayAt({ clientX: x, clientY: y });
    const overlayAt = (parts: string[]) => {
      if (mode !== 'select') return undefined;
      const targets: THREE.Object3D[] = [];
      for (const { group } of overlays.values())
        if (group.visible)
          group.traverse((item) => {
            if (parts.includes(item.userData.overlayPart)) targets.push(item);
          });
      const hit = targets.length ? ray.intersectObjects(targets, false)[0] : undefined;
      const item = hit?.object.parent;
      return item?.userData.overlayItem as { key: string; itemId: string } | undefined;
    };
    const mark = overlayAt(['point', 'label', 'line']);
    if (mark) return { ids: [], source: { source: 'overlay', ...mark } };
    const id = ownerId(ray.intersectObjects(visibleMeshes(), true)[0]?.object);
    if (id) return { ids: [id], source: { source: 'document' } };
    const area = overlayAt(['fill']);
    if (area) return { ids: [], source: { source: 'overlay', ...area } };
    return { ids: [], source: { source: 'document' } };
  }
  function cancel(e?: PointerEvent) {
    if (e) touches.delete(e.pointerId);
    down = null;
    marquee.hidden = true;
    drawing = null;
    erasing = false;
    clearGroup(live);
  }
  renderer.domElement.addEventListener('pointerdown', cameraPointerDown, true);
  renderer.domElement.addEventListener('pointerdown', pointerDown);
  renderer.domElement.addEventListener('pointermove', pointerMove);
  renderer.domElement.addEventListener('pointerup', pointerUp);
  renderer.domElement.addEventListener('pointercancel', cancel);
  const contextRestored = () => {
    dirty = true;
  };
  renderer.domElement.addEventListener('webglcontextrestored', contextRestored);
  const resize = new ResizeObserver(sizing);
  resize.observe(container);
  function animate() {
    frame = requestAnimationFrame(animate);
    controls.update();
    if (dirty) {
      if (overlays.size) scaleLabels();
      light.position.copy(camera.position);
      light.target.position.copy(controls.target);
      renderer.render(scene, camera);
      dirty = false;
    }
  }
  animate();
  const api = {
    /**
     * Rendering cost of the current scene (measurement only): draw calls and primitives of one
     * frame, and the average time to render and finish `frames` frames while orbiting.
     */
    benchmark(frames = 60) {
      const gl = renderer.getContext();
      const start = camera.position.clone();
      const pivot = controls.target.clone();
      const offset = start.clone().sub(pivot);
      renderer.info.autoReset = false;
      renderer.info.reset();
      renderer.render(scene, camera);
      const { calls, triangles, lines, points } = renderer.info.render;
      renderer.info.autoReset = true;
      const began = performance.now();
      for (let i = 0; i < frames; i++) {
        const turn = offset
          .clone()
          .applyAxisAngle(new THREE.Vector3(0, 0, 1), (i / frames) * Math.PI * 2);
        camera.position.copy(pivot).add(turn);
        camera.lookAt(pivot);
        renderer.render(scene, camera);
        gl.finish();
      }
      const frameMs = (performance.now() - began) / frames;
      camera.position.copy(start);
      camera.lookAt(pivot);
      dirty = true;
      return {
        calls,
        triangles,
        lines,
        points,
        objects: meshes.length,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        frameMs,
      };
    },
    /** The model as shown, without jig overlays: review snapshots and thumbnails keep only it. */
    capture() {
      const shown = overlayRoot.visible;
      overlayRoot.visible = false;
      try {
        renderer.render(scene, camera);
        return renderer.domElement.toDataURL('image/png');
      } finally {
        overlayRoot.visible = shown;
        dirty = true;
      }
    },
    /**
     * The model view for the AI (PLAN-24): the sketch strokes as drawn plus a numbered marker at
     * each pinned object (display ids), scaled to at most `maxSize` px, as a compact data URL.
     */
    captureWithAnnotations(
      pins: readonly { id: string; label?: string }[] = [],
      { maxSize = 1280, type = 'image/jpeg', quality = 0.8 } = {},
    ) {
      const shown = overlayRoot.visible;
      overlayRoot.visible = false;
      try {
        renderer.render(scene, camera);
        const source = renderer.domElement;
        const scale = Math.min(1, maxSize / Math.max(source.width, source.height, 1));
        const width = Math.max(1, Math.round(source.width * scale)),
          height = Math.max(1, Math.round(source.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) return source.toDataURL('image/png');
        // JPEG has no transparency: the view's own background shows where the model is empty.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.drawImage(source, 0, 0, width, height);
        const radius = Math.max(9, Math.round(Math.max(width, height) / 90));
        context.font = `bold ${Math.round(radius * 1.1)}px sans-serif`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        pins.forEach((pin, index) => {
          const object = byId.get(pin.id);
          if (!object) return;
          object.updateWorldMatrix(true, true);
          const box = new THREE.Box3().setFromObject(object);
          if (box.isEmpty()) return;
          const at = box.getCenter(new THREE.Vector3()).project(camera);
          if (at.z > 1 || Math.abs(at.x) > 1 || Math.abs(at.y) > 1) return;
          const x = ((at.x + 1) / 2) * width,
            y = ((1 - at.y) / 2) * height;
          context.beginPath();
          context.arc(x, y, radius, 0, Math.PI * 2);
          context.fillStyle = TOKEN_FALLBACK.accent;
          context.fill();
          context.lineWidth = Math.max(2, radius / 5);
          context.strokeStyle = '#ffffff';
          context.stroke();
          context.fillStyle = '#ffffff';
          context.fillText((pin.label || String(index + 1)).slice(0, 3), x, y);
        });
        return canvas.toDataURL(type, quality);
      } finally {
        overlayRoot.visible = shown;
        dirty = true;
      }
    },
    replace(data: DisplayObject[], definitions?: Record<string, BlockDefinition>) {
      replace(data, false, definitions);
      fit();
    },
    /** Live Sync: rebuild only changed objects and keep the camera. */
    update(data: DisplayObject[], definitions?: Record<string, BlockDefinition>) {
      replace(data, true, definitions);
    },
    /** Override colours per object id (e.g. structure verdicts); null clears them. */
    tint(colors: Record<string, string> | null) {
      tints = colors ? new Map(Object.entries(colors)) : null;
      applyDisplay();
    },
    /** Back to the display's own colours. */
    clearTint() {
      if (!tints) return;
      tints = null;
      applyDisplay();
    },
    /** Draw one overlay layer of display primitives over the model; null removes it. */
    overlay: setOverlay,
    /** Show or hide an overlay layer and set its opacity. */
    overlayStyle(key: string, style: OverlayStyle) {
      const layer = overlays.get(key);
      if (!layer) return;
      if (style.visible !== undefined) layer.style.visible = style.visible;
      if (style.opacity !== undefined)
        layer.style.opacity = Math.min(1, Math.max(0, Number(style.opacity) || 0));
      applyOverlayStyle(key);
    },
    /** Test/diagnostic hook: the overlay layers and their item counts. */
    overlayInfo() {
      return [...overlays].map(([key, { group, style }]) => ({
        key,
        items: group.children.map((item) => item.userData.overlayItem.itemId as string),
        ...style,
      }));
    },
    focus,
    /** Test/diagnostic hook: what a click at this screen point (client px) would pick. */
    pickAt,
    select(ids: readonly string[]) {
      const next = new Set(ids);
      if (next.size === selectedIds.size && ids.every((id) => selectedIds.has(id))) return;
      const changed = [...selectedIds].filter((id) => !next.has(id));
      selectedIds = next;
      for (const id of [...changed, ...next]) {
        const object = byId.get(id);
        if (object) paint(object);
      }
      rebatchIds([...changed, ...next]);
      dirty = true;
    },
    /** Shading mode, colour source, crease edges and background. */
    display(next: DisplaySettings) {
      const background = next.background !== display.background || next.plot !== display.plot;
      display = { ...next };
      if (background || next.background === 'auto') applyBackground();
      applyDisplay();
    },
    /** Replace the plot style table (e.g. a parsed .ctb); monochrome is the default. */
    plotStyle(table?: PlotStyleTable) {
      plotStyle = plotStyleTable(table);
      applyDisplay();
    },
    /** Test/diagnostic hook: rendered colour (lines: plot ink in plot mode) and plot width. */
    colorOf(id: string) {
      const object = byId.get(id);
      if (!object) return undefined;
      const fat = object.userData.plotLine as LineSegments2 | undefined;
      const edges = object.userData.edges as
        | THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
        | undefined;
      const ink = display.plot
        ? (fat?.material.color ?? edges?.material.color ?? object.material.color)
        : object.material.color;
      return '#' + ink.getHexString();
    },
    /** Diagnostics for CAD styles: distinct vertex colours per part and plot batches. */
    cadInfo(id: string) {
      const object = byId.get(id);
      if (!object) return undefined;
      const colors = (geometry: THREE.BufferGeometry, name = 'color') => {
        const attribute = geometry.getAttribute(name);
        const seen = new Set<string>();
        if (attribute)
          for (let i = 0; i < attribute.count; i++)
            seen.add(
              '#' +
                new THREE.Color(
                  attribute.getX(i),
                  attribute.getY(i),
                  attribute.getZ(i),
                ).getHexString(),
            );
        return [...seen].sort();
      };
      const parts = object.children.filter((child) => child.userData.part) as THREE.Mesh[];
      const runs = object.userData.plotRuns as THREE.Group | undefined;
      return {
        lineColors: object.userData.styled ? colors(object.geometry) : [],
        vertexColors: (object.material as THREE.Material & { vertexColors?: boolean }).vertexColors,
        fills: parts
          .filter((p) => p.userData.part === 'fill')
          .map((p) => ({
            triangles: p.geometry.getAttribute('position').count / 3,
            colors: colors(p.geometry),
            visible: p.visible,
          })),
        texts: parts
          .filter((p) => p.userData.part === 'text')
          .map((p) => ({
            quads: p.geometry.getAttribute('position').count / 6,
            colors: colors(p.geometry),
          })),
        plot: runs?.visible
          ? (runs.children as LineSegments2[]).map((fat) => ({
              width: fat.material.linewidth,
              colors: colors(fat.geometry as unknown as THREE.BufferGeometry, 'instanceColorStart'),
            }))
          : [],
      };
    },
    /** Screen position (client px) of a world point, for pointer-driven tests. */
    screenOf(point: [number, number, number]) {
      const r = renderer.domElement.getBoundingClientRect();
      const v = new THREE.Vector3(...point).project(camera);
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    },
    plotWidthOf(id: string) {
      const fat = byId.get(id)?.userData.plotLine as LineSegments2 | undefined;
      return fat?.material.linewidth;
    },
    mode(next: ToolMode) {
      mode = next;
      if (next !== 'sketch') cancel();
      configure();
      renderer.domElement.dataset.tool = next;
    },
    brush(next: Partial<BrushSettings>) {
      brush = { ...brush, ...next };
      renderer.domElement.dataset.erase = String(brush.erase);
    },
    plane: planeView,
    home,
    fit,
    hide(ids: readonly string[]) {
      for (const id of ids) hiddenIds.add(id);
      applyHidden();
    },
    /** Hide everything except `ids`. */
    isolate(ids: readonly string[]) {
      const keep = new Set(ids);
      for (const mesh of meshes) if (!keep.has(mesh.userData.id)) hiddenIds.add(mesh.userData.id);
      for (const id of ids) hiddenIds.delete(id);
      applyHidden();
    },
    unhide() {
      hiddenIds.clear();
      applyHidden();
    },
    /** IDs currently drawn (for select-all). */
    visibleIds() {
      return visibleMeshes().map((mesh) => mesh.userData.id as string);
    },
    hiddenCount() {
      return hiddenIds.size;
    },
    projection,
    /** Attached sketches (older ones may be plane points) and the unattached brush strokes. */
    sketches(attached: readonly DisplaySketch[], draft: DraftStroke[]) {
      draftStrokes = draft;
      const signature = JSON.stringify([attached, draft]);
      if (signature === lineSignature) return;
      lineSignature = signature;
      dirty = true;
      clearGroup(lines);
      const vector = ([x, y, z]: Point3) => new THREE.Vector3(x, y, z);
      const planeStroke = (points: Point2[], name: string, planeOffset = 0) =>
        points.map((point) => vector(planePoint(name, point, planeOffset)));
      for (const sketch of attached) {
        if (sketch.points && sketch.points.length >= 2)
          lines.add(
            strokeLine(
              planeStroke(sketch.points, sketch.plane ?? 'XY', sketch.planeOffset),
              '#c5684b',
              3,
            ),
          );
        for (const stroke of sketch.strokes ?? [])
          if (stroke.points.length >= 2)
            lines.add(strokeLine(stroke.points.map(vector), stroke.color, stroke.width));
      }
      for (const stroke of draft)
        if (stroke.points.length >= 2)
          lines.add(strokeLine(stroke.points.map(vector), stroke.color, stroke.width));
    },
    dispose() {
      cancelAnimationFrame(frame);
      resize.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', cameraPointerDown, true);
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('pointermove', pointerMove);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      marquee.remove();
      renderer.domElement.removeEventListener('pointercancel', cancel);
      renderer.domElement.removeEventListener('webglcontextrestored', contextRestored);
      for (const key of [...overlays.keys()]) setOverlay(key, null);
      disposeObject(scene);
      atlas.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
  // Measurement hook for performance spikes and tests (read-only numbers, see benchmark()).
  (window as unknown as { videViewport?: typeof api }).videViewport = api;
  return api;
}
