import * as THREE from 'three';
import type { SharedPin, SharedSketch } from '../../contracts/shared-spatial';

export type StrokeDraft = Omit<SharedSketch, 'points'> & { points: [number, number][] };
export interface SpatialState {
  mode: 'select' | 'pin' | 'sketch';
  plane: SharedSketch['plane'];
  role: SharedSketch['role'];
  locked: boolean;
}
export { sketchWorldPoint as worldPoint } from '../../contracts/shared-spatial';
export function spatialTools(options: {
  canvas: HTMLCanvasElement;
  camera: THREE.Camera;
  objects: THREE.Object3D[];
  span: number;
  state: () => SpatialState;
  selected: (id: string | null) => void;
  pin: (pin: SharedPin, objectId: string | null) => void;
  sketch: (sketch: SharedSketch) => void;
  interrupted: (sketch: StrokeDraft) => void;
  preview: (sketch: StrokeDraft | null) => void;
}) {
  const { canvas } = options,
    ray = new THREE.Raycaster();
  ray.params.Line.threshold = options.span / 100;
  ray.params.Points.threshold = options.span / 100;
  let down: { x: number; y: number; pointerId: number } | null = null,
    stroke: StrokeDraft | null = null;
  const setRay = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    ray.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      options.camera,
    );
  };
  const add = (event: PointerEvent) => {
    if (!stroke || stroke.points.length >= 1000) return;
    setRay(event);
    const normal =
        stroke.plane === 'XY'
          ? new THREE.Vector3(0, 0, 1)
          : stroke.plane === 'XZ'
            ? new THREE.Vector3(0, 1, 0)
            : new THREE.Vector3(1, 0, 0),
      point = ray.ray.intersectPlane(new THREE.Plane(normal, 0), new THREE.Vector3());
    if (
      !point ||
      [point.x, point.y, point.z].some((n) => !Number.isFinite(n) || Math.abs(n) > 100000)
    )
      return;
    const next: [number, number] =
        stroke.plane === 'XY'
          ? [point.x, point.y]
          : stroke.plane === 'XZ'
            ? [point.x, point.z]
            : [point.y, point.z],
      last = stroke.points.at(-1);
    if (!last || Math.hypot(next[0] - last[0], next[1] - last[1]) > options.span / 2000) {
      stroke.points.push(next);
      options.preview({ ...stroke, points: [...stroke.points] });
    }
  };
  const start = (event: PointerEvent) => {
    if (event.button !== 0 || event.isPrimary === false || down) return;
    const state = options.state();
    if (state.locked && state.mode !== 'select') return;
    down = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    if (state.mode === 'sketch') {
      stroke = { plane: state.plane, unit: 'm', role: state.role, points: [] };
      canvas.setPointerCapture(event.pointerId);
      add(event);
    }
  };
  const move = (event: PointerEvent) => {
    if (stroke && down?.pointerId === event.pointerId) add(event);
  };
  const stop = (event: PointerEvent) => {
    if (!down || down.pointerId !== event.pointerId) return;
    const previous = down;
    down = null;
    if (stroke) {
      add(event);
      const done = stroke;
      stroke = null;
      options.preview(null);
      if (done.points.length >= 2) options.sketch(done);
      else if (done.points.length) options.interrupted(done);
      return;
    }
    if (Math.hypot(event.clientX - previous.x, event.clientY - previous.y) > 5) return;
    setRay(event);
    const hit = ray.intersectObjects(options.objects, false)[0],
      id = hit ? String(hit.object.userData.id) : null;
    options.selected(id);
    if (options.state().mode === 'pin' && !options.state().locked) {
      const point =
        hit?.point ??
        ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
      if (point) options.pin({ unit: 'm', position: [point.x, point.y, point.z] }, id);
    }
  };
  const cancel = () => {
    down = null;
    if (stroke?.points.length) options.interrupted(stroke);
    stroke = null;
    options.preview(null);
  };
  canvas.addEventListener('pointerdown', start);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', cancel);
  window.addEventListener('blur', cancel);
  return () => {
    canvas.removeEventListener('pointerdown', start);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', stop);
    canvas.removeEventListener('pointercancel', cancel);
    window.removeEventListener('blur', cancel);
    cancel();
  };
}
