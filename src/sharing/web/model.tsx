import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Scene } from './api';
import type { SharedPin, SharedSketch } from '../../contracts/shared-spatial';
import { spatialTools, worldPoint, type SpatialState, type StrokeDraft } from './spatial-tools';
import { displayCoordinates } from '../../core/display-coordinates';

export interface SpatialDraft {
  pin?: SharedPin | null;
  sketches?: SharedSketch[];
  interrupted?: StrokeDraft | null;
  pending?: boolean;
}
function clear(group: THREE.Group) {
  for (const child of group.children) {
    if (
      child instanceof THREE.Mesh ||
      child instanceof THREE.Line ||
      child instanceof THREE.Points
    ) {
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) material.dispose();
    }
  }
  group.clear();
}
function drawStroke(group: THREE.Group, stroke: StrokeDraft, span: number, dashed = false) {
  const { origin, local } = displayCoordinates(
      stroke.points.flatMap((point) => worldPoint(stroke.plane, point)),
    ),
    geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(local, 3));
  if (stroke.points.length === 1) {
    const point = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: 0xd97660,
        size: 7,
        sizeAttenuation: false,
        depthTest: false,
      }),
    );
    point.position.set(...origin);
    group.add(point);
    return;
  }
  const material = dashed
    ? new THREE.LineDashedMaterial({
        color: 0xd97660,
        dashSize: span / 30,
        gapSize: span / 50,
        depthTest: false,
      })
    : new THREE.LineBasicMaterial({ color: 0xd97660, depthTest: false });
  const line = new THREE.Line(geometry, material);
  line.position.set(...origin);
  line.computeLineDistances();
  line.renderOrder = 10;
  group.add(line);
}

export function Model({
  model,
  selected,
  onSelect,
  editable = false,
  draft = {},
  onPin,
  onSketch,
  onInterrupted,
}: {
  model: Scene;
  selected: string | null;
  onSelect: (id: string | null) => void;
  editable?: boolean;
  draft?: SpatialDraft;
  onPin?: (pin: SharedPin, id: string | null) => void;
  onSketch?: (sketch: SharedSketch) => void;
  onInterrupted?: (sketch: StrokeDraft) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    objects = useRef<THREE.Object3D[]>([]),
    select = useRef(onSelect),
    [view, setView] = useState('perspective'),
    [fit, setFit] = useState(0),
    [error, setError] = useState('');
  select.current = onSelect;
  const [mode, setMode] = useState<SpatialState['mode']>('select'),
    [plane, setPlane] = useState<SharedSketch['plane']>('XY'),
    [role, setRole] = useState<SharedSketch['role']>('reference');
  const control = useRef<OrbitControls | null>(null),
    overlay = useRef<THREE.Group | null>(null),
    scale = useRef(1),
    state = useRef<SpatialState>({ mode, plane, role, locked: false }),
    events = useRef({ onPin, onSketch, onInterrupted });
  events.current = { onPin, onSketch, onInterrupted };
  state.current = {
    mode,
    plane,
    role,
    locked: !editable || !!draft.pending || !!draft.interrupted,
  };
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setError('이 브라우저에서 3D 표시를 시작하지 못했습니다.');
      return;
    }
    setError('');
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    element.append(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#f5f5f1');
    scene.add(new THREE.AmbientLight(0xffffff, 2));
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(3, -4, 7);
    scene.add(light);
    const group = new THREE.Group();
    scene.add(group);
    for (const object of model.objects) {
      const { origin, local } = displayCoordinates(object.geometry.positions),
        geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(local, 3));
      let shape: THREE.Object3D;
      if (object.geometry.type === 'mesh') {
        geometry.setIndex(object.geometry.indices);
        geometry.computeVertexNormals();
        shape = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({
            color: 0xb6c3c4,
            roughness: 0.8,
            side: THREE.DoubleSide,
          }),
        );
      } else if (object.geometry.type === 'line')
        shape = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0x607d84 }));
      else
        shape = new THREE.Points(
          geometry,
          new THREE.PointsMaterial({ color: 0x607d84, size: 6, sizeAttenuation: false }),
        );
      shape.position.set(...origin);
      shape.userData.id = object.id;
      group.add(shape);
    }
    objects.current = group.children;
    const bounds = new THREE.Box3().setFromObject(group),
      center = bounds.getCenter(new THREE.Vector3()),
      span = Math.max(bounds.getSize(new THREE.Vector3()).length(), 0.001),
      distance = span * 1.5;
    const perspective = view === 'perspective',
      camera = perspective
        ? new THREE.PerspectiveCamera(40, 1, span / 10000, span * 100)
        : new THREE.OrthographicCamera(-span, span, span, -span, span / 10000, span * 100);
    camera.up.set(0, 0, 1);
    const direction =
      view === 'top'
        ? new THREE.Vector3(0, 0, 1)
        : view === 'front'
          ? new THREE.Vector3(0, -1, 0)
          : view === 'right'
            ? new THREE.Vector3(1, 0, 0)
            : new THREE.Vector3(1, -1, 0.8).normalize();
    if (view === 'top') camera.up.set(0, 1, 0);
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.lookAt(center);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.enableDamping = true;
    control.current = controls;
    controls.enabled = mode !== 'sketch';
    scale.current = span;
    const drawing = new THREE.Group(),
      preview = new THREE.Group();
    scene.add(drawing, preview);
    overlay.current = drawing;
    const resize = () => {
      const width = element.clientWidth,
        height = element.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      const aspect = width / height;
      if (camera instanceof THREE.PerspectiveCamera) camera.aspect = aspect;
      else {
        camera.left = (-span * aspect) / 2;
        camera.right = (span * aspect) / 2;
        camera.top = span / 2;
        camera.bottom = -span / 2;
      }
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    let frame = 0;
    const render = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    render();
    const detach = spatialTools({
      canvas: renderer.domElement,
      camera,
      objects: group.children,
      span,
      state: () => state.current,
      selected: (id) => select.current(id),
      pin: (pin, id) => events.current.onPin?.(pin, id),
      sketch: (value) => events.current.onSketch?.(value),
      interrupted: (value) => events.current.onInterrupted?.(value),
      preview: (stroke) => {
        clear(preview);
        if (stroke) drawStroke(preview, stroke, span);
      },
    });
    return () => {
      detach();
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      clear(group);
      clear(drawing);
      clear(preview);
      objects.current = [];
      overlay.current = null;
      control.current = null;
    };
  }, [model, view, fit]);
  useEffect(() => {
    if (control.current) control.current.enabled = mode !== 'sketch';
  }, [mode, model, view, fit]);
  useEffect(() => {
    const group = overlay.current;
    if (!group) return;
    clear(group);
    for (const stroke of draft.sketches ?? []) drawStroke(group, stroke, scale.current);
    if (draft.interrupted) drawStroke(group, draft.interrupted, scale.current, true);
    if (draft.pin) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(scale.current / 100, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xd97660 }),
      );
      marker.position.set(...draft.pin.position);
      group.add(marker);
    }
  }, [draft.pin, draft.sketches, draft.interrupted, model, view, fit]);
  useEffect(() => {
    for (const object of objects.current) {
      const shape = object as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
      shape.material.color.setHex(object.userData.id === selected ? 0xd97660 : 0xb6c3c4);
    }
  }, [selected, model, view, fit]);
  return (
    <section
      className="model-area"
      data-projection={view === 'perspective' ? 'perspective' : 'orthographic'}
    >
      <div ref={host} className="canvas" aria-label="공유 모델 3D 뷰포트" />
      {error ? <p role="alert">{error}</p> : null}
      {editable ? (
        <nav className="spatial-tools" aria-label="공간 입력">
          <button aria-pressed={mode === 'select'} onClick={() => setMode('select')}>
            탐색
          </button>
          <button
            disabled={state.current.locked}
            aria-pressed={mode === 'pin'}
            onClick={() => setMode('pin')}
          >
            핀
          </button>
          <button
            disabled={state.current.locked}
            aria-pressed={mode === 'sketch'}
            onClick={() => {
              setMode('sketch');
              setView(plane === 'XY' ? 'top' : plane === 'XZ' ? 'front' : 'right');
            }}
          >
            스케치
          </button>
        </nav>
      ) : null}
      {mode === 'sketch' ? (
        <div className="sketch-options">
          <select
            aria-label="스케치 평면"
            disabled={state.current.locked}
            value={plane}
            onChange={(event) => {
              const value = event.target.value as SharedSketch['plane'];
              setPlane(value);
              setView(value === 'XY' ? 'top' : value === 'XZ' ? 'front' : 'right');
            }}
          >
            <option>XY</option>
            <option>XZ</option>
            <option>YZ</option>
          </select>
          <select
            aria-label="선 역할"
            disabled={state.current.locked}
            value={role}
            onChange={(event) => setRole(event.target.value as SharedSketch['role'])}
          >
            <option value="reference">참고</option>
            <option value="boundary">경계</option>
            <option value="path">경로</option>
            <option value="direction">방향</option>
          </select>
          <small>원점 기준 · m</small>
        </div>
      ) : null}
      <nav className="camera" aria-label="카메라">
        <button onClick={() => setFit((value) => value + 1)}>전체 보기</button>
        {[
          ['perspective', '원근'],
          ['top', '위'],
          ['front', '앞'],
          ['right', '오른쪽'],
        ].map(([value, label]) => (
          <button
            key={value}
            disabled={mode === 'sketch'}
            aria-pressed={view === value}
            onClick={() => setView(value)}
          >
            {label}
          </button>
        ))}
      </nav>
    </section>
  );
}
