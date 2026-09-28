import { sceneRepresentation } from '../core/scene-representation.ts';
import { displayCoordinates } from '../core/display-coordinates.ts';
import type { DisplayGeometry } from '../core/scene-representation.ts';
import type { Point2, Point3, DraftStroke, SketchPlacement } from './model.ts';
import { planePoint } from './model.ts';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

type Camera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
type PlaneName = 'XY' | 'XZ' | 'YZ';
type ToolMode = 'select' | 'pin' | 'sketch';
export interface BrushSettings {
  color: string;
  width: number;
  placement: SketchPlacement;
  plane: PlaneName;
  offset: number;
  erase: boolean;
}
export type SketchEvent =
  | { type: 'stroke'; stroke: DraftStroke }
  | { type: 'erase'; index: number };
interface DisplaySketch {
  points?: Point2[];
  plane?: string;
  planeOffset?: number;
  strokes?: DraftStroke[];
}
interface DisplayObject extends DisplayGeometry {
  id: string;
}
type RenderObject =
  | THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  | THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>
  | THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
function disposeObject(object: THREE.Object3D) {
  object.traverse((item) => {
    if (item instanceof THREE.Mesh || item instanceof THREE.Line || item instanceof THREE.Points) {
      item.geometry.dispose();
      for (const material of Array.isArray(item.material) ? item.material : [item.material])
        material.dispose();
    }
  });
}
export function createViewport(
  container: HTMLElement,
  objects: DisplayObject[],
  onPick: (ids: string[], mode: 'replace' | 'add' | 'remove', pin: boolean) => void,
  onSketch: (event: SketchEvent) => void,
  onCamera?: (state: { view: string; projection: 'orthographic' | 'perspective' }) => void,
) {
  let dirty = true;
  let selectedIds = new Set<string>();
  let lineSignature = '';
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#edf0ec');
  const perspective = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  const orthographic = new THREE.OrthographicCamera(-25, 25, 25, -25, 0.1, 1000);
  let viewSpan = 50;
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
  const grid = new THREE.GridHelper(100, 50, 0xb8c2b9, 0xe0e5dc);
  grid.rotation.x = Math.PI / 2;
  scene.add(grid);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9caaa1, 2.4));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(-12, -16, 30);
  scene.add(light);
  const meshes: RenderObject[] = [];
  const byId = new Map<string, RenderObject>();
  function replace(data: DisplayObject[]) {
    dirty = true;
    selectedIds = new Set();
    byId.clear();
    for (const mesh of meshes) {
      scene.remove(mesh);
      disposeObject(mesh);
    }
    meshes.length = 0;
    for (const object of data) {
      const representation = sceneRepresentation(object);
      if (!representation) continue;
      const geometry = new THREE.BufferGeometry(),
        positions = representation.positions;
      // Keep small details near the geometry origin before uploading float32 GPU attributes.
      const { origin, local } = displayCoordinates(positions);
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
        mesh = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({
            color: 0xd7ded4,
            roughness: 0.85,
            side: THREE.DoubleSide,
          }),
        );
        mesh.add(
          new THREE.LineSegments(
            new THREE.EdgesGeometry(geometry),
            new THREE.LineBasicMaterial({ color: 0x69766c }),
          ),
        );
      } else if (representation.type === 'segments')
        mesh = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x69766c }));
      else mesh = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0x69766c }));
      mesh.position.set(origin[0], origin[1], origin[2]);
      mesh.userData.id = object.id;
      scene.add(mesh);
      meshes.push(mesh);
      byId.set(object.id, mesh);
    }
  }
  replace(objects);
  const lines = new THREE.Group();
  scene.add(lines);
  const ray = new THREE.Raycaster(),
    mouse = new THREE.Vector2();
  let mode: ToolMode = 'select',
    down: { x: number; y: number } | null = null,
    frame: number;
  let brush: BrushSettings = {
    color: '#d0473a',
    width: 4,
    placement: 'surface',
    plane: 'XY',
    offset: 0,
    erase: false,
  };
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
    for (const material of lineMaterials)
      material.resolution.set(renderer.domElement.width, renderer.domElement.height);
  }
  function configure() {
    // Sketching keeps 3D navigation: left draws, right orbits, Shift+right pans, wheel zooms.
    controls.enableRotate = !standardView;
    controls.mouseButtons.LEFT = undefined;
    controls.mouseButtons.RIGHT = standardView ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
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
    controls.minDistance = 4;
    controls.maxDistance = 180;
    controls.minZoom = 0.2;
    controls.maxZoom = 20;
    controls.target.copy(target);
    controls.addEventListener('change', reportCamera);
    configure();
    sizing();
    controls.update();
    renderer.domElement.dataset.projection =
      camera instanceof THREE.OrthographicCamera ? 'orthographic' : 'perspective';
    reportCamera();
  }
  function fit(id?: string) {
    const targets = id ? meshes.filter((m) => m.userData.id === id) : meshes;
    if (!targets.length) return;
    const bounds = new THREE.Box3();
    targets.forEach((m) => bounds.expandByObject(m));
    const center = bounds.getCenter(new THREE.Vector3());
    const sceneRadius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 0.1);
    camera.near = Math.max(sceneRadius / 10000, 0.001);
    camera.far = Math.max(sceneRadius * 100, 1000);
    controls.minDistance = Math.max(sceneRadius * 0.01, 0.05);
    controls.maxDistance = Math.max(sceneRadius * 20, 180);
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
  function rayAt(e: PointerEvent) {
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
    if (e.button !== 0) return;
    if (mode === 'sketch') {
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
  function fixedPlane() {
    const normal =
      brush.plane === 'XY'
        ? new THREE.Vector3(0, 0, 1)
        : brush.plane === 'XZ'
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(1, 0, 0);
    return new THREE.Plane(normal, -brush.offset);
  }
  /** Grease-Pencil-like placement: onto model surfaces, a view plane, or a fixed axis plane. */
  function projectPoint(e: PointerEvent, fallback: THREE.Plane) {
    rayAt(e);
    if (brush.placement === 'surface') {
      const hit = ray.intersectObjects(surfaceMeshes(), false)[0];
      if (hit) {
        // Continue off the edge of an object at the depth of the last surface point.
        if (drawing) drawing.fallback = viewPlane(hit.point);
        return hit.point.clone();
      }
    }
    return ray.ray.intersectPlane(fallback, new THREE.Vector3());
  }
  function startStroke(e: PointerEvent) {
    const fallback =
      brush.placement === 'plane' ? fixedPlane() : viewPlane(controls.target.clone());
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
      const id = object.userData.id;
      const position = object.geometry.getAttribute('position');
      if (typeof id !== 'string' || !position) continue;
      object.updateMatrixWorld();
      const count = position.count,
        stride = Math.max(1, Math.floor(count / 4000));
      const screen: number[] = [];
      let all = true,
        any = false;
      for (let i = 0; i < count; i += stride) {
        corner.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld).project(camera);
        const x = ((corner.x + 1) / 2) * r.width,
          y = ((1 - corner.y) / 2) * r.height;
        screen.push(x, y);
        if (corner.z <= 1 && inside(x, y)) any = true;
        else all = false;
        if (crossing ? any : !all) break;
      }
      if (!crossing) {
        if (all && screen.length) picked.push(id);
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
      const hit = ray.intersectObjects(meshes, false)[0]?.object.userData.id;
      if (typeof hit === 'string' && !picked.includes(hit)) picked.push(hit);
    }
    return picked;
  }
  function pointerUp(e: PointerEvent) {
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
          mode === 'pin',
        );
      return;
    }
    rayAt(e);
    const id = ray.intersectObjects(meshes, false)[0]?.object.userData.id;
    onPick(typeof id === 'string' ? [id] : [], selectionMode(e), mode === 'pin');
  }
  function cancel() {
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
      renderer.render(scene, camera);
      dirty = false;
    }
  }
  animate();
  return {
    capture() {
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL('image/png');
    },
    replace(data: DisplayObject[]) {
      replace(data);
      fit();
    },
    select(ids: readonly string[]) {
      const next = new Set(ids);
      if (next.size === selectedIds.size && ids.every((id) => selectedIds.has(id))) return;
      for (const id of selectedIds)
        if (!next.has(id)) {
          const previous = byId.get(id);
          previous?.material.color.setHex(previous instanceof THREE.Mesh ? 0xd7ded4 : 0x69766c);
        }
      for (const id of next) byId.get(id)?.material.color.setHex(0xe4bca6);
      selectedIds = next;
      dirty = true;
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
    projection,
    /** Attached sketches, unattached brush strokes and numeric plane points. */
    sketches(
      attached: readonly DisplaySketch[],
      draft: DraftStroke[],
      draftPoints: Point2[],
      plane: PlaneName,
      offset = 0,
    ) {
      draftStrokes = draft;
      const signature = JSON.stringify([attached, draft, draftPoints, plane, offset]);
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
      if (draftPoints.length >= 2)
        lines.add(strokeLine(planeStroke(draftPoints, plane, offset), '#c5684b', 3));
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
      disposeObject(scene);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
