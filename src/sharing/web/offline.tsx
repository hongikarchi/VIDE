import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { z } from 'zod';
import { api, message, type Project } from './api';
import { decodeSnapshot, type Snapshot } from '../../contracts/offline-snapshot';
import { OfflineAgenda, OfflineHistory } from './offline-summary';

// PLAN-20, PLAN-33: a project while its work PC is off (SPEC-04.10). 할 일 (editable; the PC
// applies the changes when it is on), the work history summary, a place for notes (PLAN-32), the
// last saved view of each linked file when the PC stores one, and requests left for the PC, which
// it picks up when it is on again. Nothing here changes the model; the PC shows the requests for
// the user to send.
const snapshotsSchema = z.object({
  snapshots: z.array(
    z.object({
      linkId: z.string(),
      name: z.string(),
      host: z.string(),
      size: z.number(),
      objectCount: z.number(),
      capturedAt: z.number(),
      updatedAt: z.number(),
    }),
  ),
});
type SnapshotInfo = z.infer<typeof snapshotsSchema>['snapshots'][number];
const queueSchema = z.object({
  requests: z.array(
    z.object({
      id: z.string(),
      linkId: z.string().nullable(),
      body: z.string(),
      createdAt: z.number(),
      deliveredAt: z.number().nullable(),
      canceledAt: z.number().nullable(),
    }),
  ),
});
type Queued = z.infer<typeof queueSchema>['requests'][number];

const when = (time: number) =>
  new Date(time).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const megabytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1048576).toFixed(1)} MB`;

async function loadSnapshot(projectId: string, linkId: string): Promise<Snapshot> {
  const response = await fetch(`/api/projects/${projectId}/snapshots/${linkId}`, {
    credentials: 'same-origin',
  });
  if (!response.ok || !response.body) throw new Error('저장된 모델을 불러오지 못했습니다.');
  const unzipped = response.body.pipeThrough(new DecompressionStream('gzip'));
  return decodeSnapshot(new Uint8Array(await new Response(unzipped).arrayBuffer()));
}

/** Colours made for a dark CAD screen (white, pale yellow) are drawn dark on this light page. */
function readable(colors: Uint8Array) {
  const out = new Float32Array(colors.length);
  for (let i = 0; i < colors.length; i += 3) {
    const light = colors[i] > 225 && colors[i + 1] > 225 && colors[i + 2] > 200;
    out[i] = light ? 0.16 : colors[i] / 255;
    out[i + 1] = light ? 0.17 : colors[i + 1] / 255;
    out[i + 2] = light ? 0.18 : colors[i + 2] / 255;
  }
  return out;
}

function SnapshotView({ snapshot, hidden }: { snapshot: Snapshot; hidden: Set<string> }) {
  const host = useRef<HTMLDivElement>(null),
    layers = useRef(new Map<string, THREE.Object3D[]>()),
    redraw = useRef<() => void>(() => {}),
    [view, setView] = useState<'top' | 'perspective'>('top'),
    [error, setError] = useState('');
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
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    element.append(renderer.domElement);
    const labels = document.createElement('canvas');
    labels.className = 'offline-labels';
    element.append(labels);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#f5f5f1');
    scene.add(new THREE.AmbientLight(0xffffff, 1.3));
    const light = new THREE.DirectionalLight(0xffffff, 2.5);
    light.position.set(3, -4, 7);
    scene.add(light);
    const byLayer = new Map<string, THREE.Object3D[]>();
    for (const group of snapshot.groups) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(group.positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(readable(group.colors), 3));
      let shape: THREE.Object3D;
      if (group.kind === 'mesh' && group.indices) {
        geometry.setIndex(new THREE.BufferAttribute(group.indices, 1));
        geometry.computeVertexNormals();
        shape = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: 0.85,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
          }),
        );
      } else if (group.kind === 'lines')
        shape = new THREE.LineSegments(
          geometry,
          new THREE.LineBasicMaterial({ vertexColors: true }),
        );
      else
        shape = new THREE.Points(
          geometry,
          new THREE.PointsMaterial({ vertexColors: true, size: 5, sizeAttenuation: false }),
        );
      shape.visible = !hidden.has(group.layer);
      scene.add(shape);
      byLayer.set(group.layer, [...(byLayer.get(group.layer) ?? []), shape]);
    }
    layers.current = byLayer;
    const [ex, ey, ez] = snapshot.extent;
    const span = Math.max(Math.hypot(ex, ey, ez) * 2, 0.001);
    const top = view === 'top';
    const camera = top
      ? new THREE.OrthographicCamera(
          -span / 2,
          span / 2,
          span / 2,
          -span / 2,
          -span * 10,
          span * 10,
        )
      : new THREE.PerspectiveCamera(40, 1, span / 10000, span * 100);
    if (top) {
      camera.up.set(0, 1, 0);
      camera.position.set(0, 0, span);
    } else {
      camera.up.set(0, 0, 1);
      camera.position.copy(new THREE.Vector3(1, -1, 0.8).normalize().multiplyScalar(span * 1.5));
    }
    camera.lookAt(0, 0, 0);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableRotate = !top;
    controls.screenSpacePanning = true;
    if (top)
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      };
    const context = labels.getContext('2d');
    const point = new THREE.Vector3(),
      tip = new THREE.Vector3();
    // Labels: only those large enough to read, at most a few hundred at a time.
    const drawLabels = (width: number, height: number) => {
      if (!context) return;
      const ratio = Math.min(devicePixelRatio, 2);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      let drawn = 0;
      for (const text of snapshot.texts) {
        if (drawn >= 400) break;
        if (hidden.has(text.layer)) continue;
        point.set(text.p[0], text.p[1], text.p[2]).project(camera);
        if (point.x < -1.1 || point.x > 1.1 || point.y < -1.1 || point.y > 1.1 || point.z > 1)
          continue;
        tip.set(text.p[0], text.p[1] + text.h, text.p[2]).project(camera);
        const px = Math.hypot((tip.x - point.x) * width, (tip.y - point.y) * height) / 2;
        if (px < 7) continue;
        const x = ((point.x + 1) / 2) * width,
          y = ((1 - point.y) / 2) * height;
        context.save();
        context.translate(x, y);
        if (top) context.rotate(-text.r);
        context.font = `${Math.min(px, 48)}px 'Malgun Gothic', sans-serif`;
        const light = /^#(e|f)[0-9a-f](e|f)[0-9a-f]/i.test(text.color);
        context.fillStyle = light ? '#2a2c2e' : text.color;
        context.fillText(text.s, 0, 0);
        context.restore();
        drawn++;
      }
    };
    let pending = 0;
    const draw = () => {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        renderer.render(scene, camera);
        drawLabels(element.clientWidth, element.clientHeight);
      });
    };
    redraw.current = draw;
    const resize = () => {
      const width = element.clientWidth,
        height = element.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      const ratio = Math.min(devicePixelRatio, 2);
      labels.width = width * ratio;
      labels.height = height * ratio;
      const aspect = width / height;
      if (camera instanceof THREE.PerspectiveCamera) camera.aspect = aspect;
      else {
        const half = aspect >= 1 ? span / 2 : span / 2 / aspect;
        camera.left = -half * aspect;
        camera.right = half * aspect;
        camera.top = half;
        camera.bottom = -half;
      }
      camera.updateProjectionMatrix();
      draw();
    };
    controls.addEventListener('change', draw);
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    return () => {
      cancelAnimationFrame(pending);
      observer.disconnect();
      controls.dispose();
      for (const shapes of byLayer.values())
        for (const shape of shapes) {
          const drawable = shape as THREE.Mesh;
          drawable.geometry.dispose();
          (drawable.material as THREE.Material).dispose();
        }
      renderer.dispose();
      renderer.domElement.remove();
      labels.remove();
      redraw.current = () => {};
    };
    // Layer visibility is applied below without rebuilding the scene.
  }, [snapshot, view]);
  useEffect(() => {
    for (const [layer, shapes] of layers.current)
      for (const shape of shapes) shape.visible = !hidden.has(layer);
    redraw.current();
  }, [hidden]);
  return (
    <div className="offline-view">
      <div className="offline-canvas" ref={host} data-testid="offline-canvas" />
      <div className="offline-view-tools">
        <button aria-pressed={view === 'top'} onClick={() => setView('top')}>
          평면
        </button>
        <button aria-pressed={view === 'perspective'} onClick={() => setView('perspective')}>
          3D
        </button>
      </div>
      {error ? <p className="status banner">{error}</p> : null}
    </div>
  );
}

export function OfflineProject({
  project,
  pcOnline,
  notice,
}: {
  project: Project;
  pcOnline: boolean;
  /** Why the PC could not be opened (an update it needs), shown above the page. */
  notice?: string;
}) {
  const [files, setFiles] = useState<SnapshotInfo[] | null>(null),
    [chosen, setChosen] = useState(''),
    [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [loading, setLoading] = useState(false),
    [hidden, setHidden] = useState<Set<string>>(new Set()),
    [requests, setRequests] = useState<Queued[]>([]),
    [body, setBody] = useState(''),
    [target, setTarget] = useState(''),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false);
  const refreshQueue = useCallback(async () => {
    setRequests(queueSchema.parse(await api(`/projects/${project.id}/queue`)).requests);
  }, [project.id]);
  useEffect(() => {
    void api(`/projects/${project.id}/snapshots`)
      .then((value) => {
        const list = snapshotsSchema.parse(value).snapshots;
        setFiles(list);
        setChosen((current) => current || list[0]?.linkId || '');
      })
      .catch((error) => setStatus(message(error)));
    void refreshQueue().catch(() => {});
    const timer = setInterval(() => void refreshQueue().catch(() => {}), 20_000);
    return () => clearInterval(timer);
  }, [project.id, refreshQueue]);
  useEffect(() => {
    if (!chosen) return;
    let live = true;
    setLoading(true);
    setSnapshot(null);
    setHidden(new Set());
    loadSnapshot(project.id, chosen)
      .then((value) => live && setSnapshot(value))
      .catch((error) => live && setStatus(message(error)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [project.id, chosen]);
  async function send() {
    if (busy || !body.trim()) return;
    setBusy(true);
    try {
      await api(`/projects/${project.id}/queue`, 'POST', {
        body: body.trim(),
        ...(target ? { linkId: target } : {}),
      });
      setBody('');
      setStatus(
        pcOnline
          ? '요청을 남겼습니다. 작업 PC의 VIDE 작업 이력에 곧 나타납니다.'
          : '요청을 남겼습니다. 작업 PC가 켜지면 VIDE 작업 이력에 나타납니다.',
      );
      await refreshQueue();
    } catch (error) {
      setStatus(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function cancel(id: string) {
    try {
      await api(`/projects/${project.id}/queue/${id}`, 'DELETE');
      await refreshQueue();
    } catch (error) {
      setStatus(message(error));
    }
  }
  const current = files?.find((file) => file.linkId === chosen);
  const layerNames = snapshot
    ? [...new Set([...snapshot.groups, ...snapshot.texts].map((item) => item.layer))].sort()
    : [];
  return (
    <main className="offline-page">
      <div className="offline-main">
        {!pcOnline ? (
          <p className="banner offline-banner" role="status">
            {files?.length
              ? 'PC가 꺼져 있어 지금 모델은 보이지 않습니다. 아래는 마지막으로 저장된 모델입니다.'
              : 'PC가 꺼져 있어 모델은 보이지 않습니다.'}{' '}
            할 일은 여기서 고치면 PC가 켜질 때 반영됩니다.
          </p>
        ) : null}
        {notice ? (
          <p className="banner offline-banner" role="status">
            {notice}
          </p>
        ) : null}
        <div className="offline-summary">
          <OfflineAgenda projectId={project.id} />
          <OfflineHistory projectId={project.id} />
        </div>
        {/* Notes (PLAN-32) appear here through that work; nothing is stored for them by this page. */}
        <section className="offline-section offline-notes" aria-label="노트" data-slot="notes">
          <h2>노트</h2>
          <p className="muted">노트는 준비 중입니다.</p>
        </section>
        <section className="offline-model">
          <h2>저장된 모델</h2>
          {files === null ? <p className="muted">불러오는 중…</p> : null}
          {files?.length === 0 ? (
            <p className="muted offline-empty">
              저장된 모델이 없습니다. 작업 PC의 VIDE에서 이 프로젝트의 링크 파일 목록 → “PC가 꺼져도
              사이트에서 보기”를 켜면, 다음 Sync부터 보기용 모델이 여기에 저장됩니다.
            </p>
          ) : null}
          {files && files.length > 1 ? (
            <div className="offline-files" role="tablist">
              {files.map((file) => (
                <button
                  key={file.linkId}
                  role="tab"
                  aria-selected={file.linkId === chosen}
                  aria-pressed={file.linkId === chosen}
                  onClick={() => setChosen(file.linkId)}
                >
                  {file.name}
                </button>
              ))}
            </div>
          ) : null}
          {current ? (
            <p className="muted offline-meta">
              {current.name} · 객체 {current.objectCount.toLocaleString()}개 ·{' '}
              {when(current.capturedAt)} Sync · {megabytes(current.size)} · 보기 전용
            </p>
          ) : null}
          {loading ? <p className="muted">모델을 여는 중…</p> : null}
          {snapshot ? (
            <div className="offline-stage">
              <SnapshotView snapshot={snapshot} hidden={hidden} />
              {layerNames.length > 1 ? (
                <details className="offline-layers">
                  <summary>레이어 {layerNames.length}</summary>
                  {layerNames.map((layer) => (
                    <label key={layer}>
                      <input
                        type="checkbox"
                        checked={!hidden.has(layer)}
                        onChange={(event) => {
                          const next = new Set(hidden);
                          if (event.target.checked) next.delete(layer);
                          else next.add(layer);
                          setHidden(next);
                        }}
                      />
                      {layer || '(레이어 없음)'}
                    </label>
                  ))}
                </details>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
      <aside className="offline-queue">
        <h2>작업 PC에 요청 남기기</h2>
        <p className="muted">
          {pcOnline
            ? '작업 PC가 켜져 있습니다. 바로 열어 작업할 수도 있습니다.'
            : '작업 PC가 꺼져 있습니다. 남긴 요청은 PC가 켜지면 VIDE 작업 이력에 나타나고, 내용을 확인한 뒤 보냅니다.'}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {files && files.length > 0 ? (
            <select
              aria-label="대상 파일"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              <option value="">대상 파일 지정 안 함</option>
              {files.map((file) => (
                <option key={file.linkId} value={file.linkId}>
                  {file.name}
                </option>
              ))}
            </select>
          ) : null}
          <textarea
            aria-label="요청 내용"
            placeholder="예: 2층 보 단면을 H-400으로 바꿔줘"
            maxLength={4000}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <button className="primary" disabled={busy || !body.trim()}>
            요청 남기기
          </button>
        </form>
        {status ? (
          <p className="status" role="status">
            {status}
          </p>
        ) : null}
        <ul className="offline-requests">
          {requests.map((item) => (
            <li
              key={item.id}
              data-state={item.canceledAt ? 'canceled' : item.deliveredAt ? 'delivered' : 'waiting'}
            >
              <span>{item.body}</span>
              <small>
                {when(item.createdAt)} ·{' '}
                {item.canceledAt
                  ? '취소됨'
                  : item.deliveredAt
                    ? `PC에 전달됨 ${when(item.deliveredAt)}`
                    : 'PC 대기 중'}
              </small>
              {!item.deliveredAt && !item.canceledAt ? (
                <button className="ghost" onClick={() => void cancel(item.id)}>
                  취소
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </aside>
    </main>
  );
}
