import { sceneRepresentation } from '../core/scene-representation.ts';
import { displayCoordinates } from '../core/display-coordinates.ts';
import type { DisplayGeometry } from '../core/scene-representation.ts';
import type { Point2 } from './model.ts';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

type Camera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
type PlaneName = 'XY' | 'XZ' | 'YZ';
type ToolMode = 'select' | 'pin' | 'sketch';
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
  onPick: (id: string, pin: boolean) => void,
  onPoint: (point: Point2) => void,
  onCamera?: (state: { view: string; projection: 'orthographic' | 'perspective' }) => void,
) {
  let dirty = true;
  let selectedId: string | null = null;
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
  renderer.domElement.setAttribute('aria-label', '3D 모델 · 드래그 회전, 휠 확대, 우클릭 이동');
  renderer.domElement.tabIndex = 0;
  container.append(renderer.domElement);
  let controls: OrbitControls<Camera> = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
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
    selectedId = null;
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
      } else mesh = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0x69766c }));
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
    planeName: PlaneName = 'XY',
    down: { x: number; y: number } | null = null,
    frame: number;
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
  }
  function configure() {
    controls.enableRotate = !standardView && mode !== 'sketch';
    controls.mouseButtons.LEFT =
      mode === 'sketch' ? undefined : standardView ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
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
    controls.enableDamping = true;
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
    planeName = name;
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
  function pointerDown(e: PointerEvent) {
    if (e.button === 0) down = { x: e.clientX, y: e.clientY };
  }
  function pointerUp(e: PointerEvent) {
    if (e.button !== 0 || !down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 5) return;
    rayAt(e);
    if (mode === 'sketch') {
      const normal =
        planeName === 'XY'
          ? new THREE.Vector3(0, 0, 1)
          : planeName === 'XZ'
            ? new THREE.Vector3(0, 1, 0)
            : new THREE.Vector3(1, 0, 0);
      const hit = ray.ray.intersectPlane(new THREE.Plane(normal, 0), new THREE.Vector3());
      if (hit) {
        const uv =
          planeName === 'XY'
            ? [hit.x, hit.y]
            : planeName === 'XZ'
              ? [hit.x, hit.z]
              : [hit.y, hit.z];
        onPoint([Math.round(uv[0] * 100) / 100, Math.round(uv[1] * 100) / 100]);
      }
    } else {
      const hit = ray.intersectObjects(meshes, false)[0];
      if (hit && typeof hit.object.userData.id === 'string')
        onPick(hit.object.userData.id, mode === 'pin');
    }
  }
  function cancel() {
    down = null;
  }
  renderer.domElement.addEventListener('pointerdown', pointerDown);
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
    select(id: string | null) {
      if (id === selectedId) return;
      const previous = selectedId ? byId.get(selectedId) : undefined;
      previous?.material.color.setHex(previous instanceof THREE.Mesh ? 0xd7ded4 : 0x69766c);
      if (id) byId.get(id)?.material.color.setHex(0xe4bca6);
      selectedId = id;
      dirty = true;
    },
    mode(next: ToolMode, plane: PlaneName = 'XY') {
      mode = next;
      configure();
      renderer.domElement.dataset.tool = next;
      if (next === 'sketch') planeView(plane);
    },
    plane: planeView,
    home,
    fit,
    projection,
    lines(sketches: { points: Point2[]; plane?: string }[], draft: Point2[], plane: PlaneName) {
      const signature = JSON.stringify([sketches, draft, plane]);
      if (signature === lineSignature) return;
      lineSignature = signature;
      dirty = true;
      while (lines.children.length) {
        const l = lines.children[0];
        lines.remove(l);
        disposeObject(l);
      }
      for (const s of [...sketches, { points: draft, plane }]) {
        if (s.points.length < 2) continue;
        const points = s.points.map(([u, v]) =>
          s.plane === 'XY'
            ? new THREE.Vector3(u, v, 0.02)
            : s.plane === 'XZ'
              ? new THREE.Vector3(u, -0.02, v)
              : new THREE.Vector3(0.02, u, v),
        );
        const l = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points),
          new THREE.LineBasicMaterial({ color: 0xc5684b, depthTest: false }),
        );
        l.renderOrder = 10;
        lines.add(l);
      }
    },
    dispose() {
      cancelAnimationFrame(frame);
      resize.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      renderer.domElement.removeEventListener('pointercancel', cancel);
      renderer.domElement.removeEventListener('webglcontextrestored', contextRestored);
      disposeObject(scene);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
