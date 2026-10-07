// Walk mode (PLAN-37, SPEC-01.9 4, Design §05): an eye-level first-person camera over the shown
// model, shared by the work screen's viewport and the account site's viewers. Right drag (one
// finger on touch) looks around, WASD/arrows walk, Q/E turn, Shift runs, PageUp/PageDown change
// floor, a double click or double tap walks to that spot. The walker stands on surfaces whose
// normal is mostly vertical, climbs steps up to STEP high and, with collision on, slides along
// walls instead of passing through them. Rays go through a BVH built lazily per nearby mesh
// (three-mesh-bvh, indirect so the mesh's own index keeps its order).
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/** Metres: eye above the feet, highest step climbed, body radius, clearance a floor needs above. */
export const WALK = {
  eye: 1.6,
  step: 0.45,
  radius: 0.3,
  clearance: 1.9,
  walkSpeed: 1.4,
  runSpeed: 4.5,
  turnRate: 1.6,
  lookRate: 0.004,
  fov: 60,
} as const;
const PITCH_LIMIT = 1.3;
// A surface is walkable when its normal is within ~53° of vertical.
const WALKABLE = 0.6;
// Candidates are the meshes within this horizontal distance; refreshed after moving REFRESH.
const NEAR = 12;
const REFRESH = 4;

export interface WalkHost {
  camera: THREE.PerspectiveCamera;
  /** The canvas: look drags and double clicks are read from it. */
  dom: HTMLElement;
  /** The element the walk bar and the joystick are placed in (position: relative). */
  container: HTMLElement;
  /** Meshes the walker stands on and collides with (visible surfaces only). */
  surfaces(): readonly THREE.Object3D[];
  /** The camera moved: draw a frame. */
  changed(): void;
  /** The user left walk mode from the bar or with Escape. */
  exit(): void;
  /** Short notices (no floor above, ...). */
  notice?(text: string): void;
  /**
   * 'own' reads the keyboard itself; 'host' leaves keydown to the host, which calls key() (the work
   * screen's shortcut order). keyup and blur are always read here.
   */
  keyboard?: 'own' | 'host';
}

interface Hit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
}

const MOVE_KEYS = new Set([
  'w',
  'a',
  's',
  'd',
  'q',
  'e',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'shift',
]);

const editable = (target: EventTarget | null) =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement ||
  (target instanceof HTMLElement && target.isContentEditable);

export function createWalk(host: WalkHost) {
  const { camera, dom, container } = host;
  let active = false;
  let collide = true;
  const feet = new THREE.Vector3();
  let yaw = 0,
    pitch = 0,
    fall = 0;
  const pressed = new Set<string>();
  const stick = { x: 0, y: 0 };
  let look: { id: number; x: number; y: number } | null = null;
  let lastTap: { time: number; x: number; y: number } | null = null;
  let saved: { fov: number; near: number } | null = null;
  let last = 0;

  // ---- geometry queries ----------------------------------------------------------------------
  const trees = new WeakMap<THREE.BufferGeometry, MeshBVH | null>();
  const boxes = new WeakMap<THREE.Object3D, THREE.Box3>();
  let candidates: THREE.Mesh[] = [];
  let candidateAt: THREE.Vector3 | null = null;
  const inverse = new THREE.Matrix4(),
    local = new THREE.Ray(),
    normalMatrix = new THREE.Matrix3();

  function treeOf(geometry: THREE.BufferGeometry) {
    let tree = trees.get(geometry);
    if (tree === undefined) {
      try {
        tree = geometry.getAttribute('position') ? new MeshBVH(geometry, { indirect: true }) : null;
      } catch {
        tree = null;
      }
      trees.set(geometry, tree);
    }
    return tree;
  }
  function boxOf(mesh: THREE.Mesh) {
    let box = boxes.get(mesh);
    if (!box) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      mesh.updateWorldMatrix(true, false);
      box = (mesh.geometry.boundingBox ?? new THREE.Box3()).clone().applyMatrix4(mesh.matrixWorld);
      boxes.set(mesh, box);
    }
    return box;
  }
  function refresh(force = false) {
    if (
      !force &&
      candidateAt &&
      Math.hypot(feet.x - candidateAt.x, feet.y - candidateAt.y) < REFRESH
    )
      return;
    const source = host.surfaces();
    candidateAt = feet.clone();
    candidates = [];
    for (const object of source) {
      if (!(object instanceof THREE.Mesh) || !object.visible) continue;
      const box = boxOf(object);
      if (
        box.max.x < feet.x - NEAR ||
        box.min.x > feet.x + NEAR ||
        box.max.y < feet.y - NEAR ||
        box.min.y > feet.y + NEAR
      )
        continue;
      candidates.push(object);
    }
  }
  /** Nearest hit along a world ray, within `far` metres. */
  function cast(origin: THREE.Vector3, direction: THREE.Vector3, far: number, all = false) {
    const hits: Hit[] = [];
    const end = origin.clone().addScaledVector(direction, Math.min(far, 1e5));
    const world = new THREE.Ray(origin, direction);
    for (const mesh of candidates) {
      // A layer or object hidden since the candidates were found is not walked on.
      if (!mesh.visible || !mesh.parent?.visible) continue;
      const box = boxOf(mesh);
      // Cheap reject: the segment's bounding box misses the mesh's box.
      if (
        Math.max(origin.x, end.x) < box.min.x ||
        Math.min(origin.x, end.x) > box.max.x ||
        Math.max(origin.y, end.y) < box.min.y ||
        Math.min(origin.y, end.y) > box.max.y ||
        Math.max(origin.z, end.z) < box.min.z ||
        Math.min(origin.z, end.z) > box.max.z
      )
        continue;
      const tree = treeOf(mesh.geometry);
      if (!tree) continue;
      mesh.updateWorldMatrix(true, false);
      inverse.copy(mesh.matrixWorld).invert();
      local.copy(world).applyMatrix4(inverse);
      normalMatrix.getNormalMatrix(mesh.matrixWorld);
      const found = all
        ? tree.raycast(local, THREE.DoubleSide)
        : [tree.raycastFirst(local, THREE.DoubleSide)].filter(Boolean);
      for (const result of found) {
        if (!result || !result.face) continue;
        const point = result.point.clone().applyMatrix4(mesh.matrixWorld);
        const distance = point.distanceTo(origin);
        if (distance > far) continue;
        const normal = result.face.normal.clone().applyMatrix3(normalMatrix).normalize();
        hits.push({ point, normal, distance });
      }
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits;
  }
  const DOWN = new THREE.Vector3(0, 0, -1);
  /** The walkable floor under (x, y) at most STEP above `from`, or undefined. */
  function floorBelow(x: number, y: number, from: number) {
    const top = from + WALK.step;
    for (const hit of cast(new THREE.Vector3(x, y, top), DOWN, 500))
      if (Math.abs(hit.normal.z) >= WALKABLE) return hit.point.z;
    return undefined;
  }
  /** Floors at (x, y) with headroom: walkable surfaces nothing covers within CLEARANCE. */
  function levels(x: number, y: number) {
    let top = -Infinity;
    for (const mesh of candidates) top = Math.max(top, boxOf(mesh).max.z);
    if (!Number.isFinite(top)) return [];
    const hits = cast(new THREE.Vector3(x, y, top + 1), DOWN, 1e6, true);
    const zs = hits.map((h) => h.point.z).sort((a, b) => a - b);
    const out: number[] = [];
    for (const hit of hits) {
      if (Math.abs(hit.normal.z) < WALKABLE) continue;
      const z = hit.point.z;
      const above = zs.find((other) => other > z + 0.05);
      if (above !== undefined && above - z < WALK.clearance) continue;
      if (!out.some((other) => Math.abs(other - z) < 0.3)) out.push(z);
    }
    return out.sort((a, b) => a - b);
  }

  // ---- camera ---------------------------------------------------------------------------------
  function place() {
    camera.position.set(feet.x, feet.y, feet.z + WALK.eye);
    const dir = new THREE.Vector3(
      Math.cos(pitch) * Math.cos(yaw),
      Math.cos(pitch) * Math.sin(yaw),
      Math.sin(pitch),
    );
    camera.up.set(0, 0, 1);
    camera.lookAt(camera.position.clone().add(dir));
    camera.updateMatrixWorld();
    host.changed();
  }
  /** Where an orbit should look after leaving: a few metres ahead of the eye. */
  function target() {
    const dir = new THREE.Vector3(
      Math.cos(pitch) * Math.cos(yaw),
      Math.cos(pitch) * Math.sin(yaw),
      Math.sin(pitch),
    );
    return camera.position.clone().addScaledVector(dir, 5);
  }

  // ---- movement -------------------------------------------------------------------------------
  /** Horizontal move limited by walls (two slides at most). */
  function slide(move: THREE.Vector3) {
    if (!collide || move.lengthSq() === 0) return move;
    let result = move.clone();
    for (let i = 0; i < 2 && result.lengthSq() > 1e-10; i++) {
      const length = result.length();
      const dir = result.clone().divideScalar(length);
      let block: Hit | undefined;
      for (const height of [WALK.step + 0.05, Math.min(1.2, WALK.eye - 0.1)]) {
        const origin = new THREE.Vector3(feet.x, feet.y, feet.z + height);
        // Far enough to see a wall the walker meets at a slant (radius / cos 70°).
        const hit = cast(origin, dir, length + WALK.radius * 3).find(
          (h) => Math.abs(h.normal.z) < WALKABLE,
        );
        if (hit && (!block || hit.distance < block.distance)) block = hit;
      }
      if (!block) return result;
      const normal = new THREE.Vector3(block.normal.x, block.normal.y, 0);
      if (normal.lengthSq() < 1e-8) return new THREE.Vector3();
      normal.normalize();
      if (normal.dot(dir) > 0) normal.negate();
      // Keep RADIUS from the wall's plane, not along the (slanted) ray.
      const facing = Math.max(-normal.dot(dir), 1e-3);
      const room = Math.max(0, (block.distance * facing - WALK.radius) / facing);
      const forward = dir.clone().multiplyScalar(Math.min(room, length));
      const rest = result.clone().sub(forward);
      rest.addScaledVector(normal, -rest.dot(normal));
      feet.add(forward);
      result = rest;
    }
    // Still blocked after two slides (a sharp corner): stop rather than push into a wall.
    return new THREE.Vector3();
  }
  function settle(dt: number) {
    const ground = floorBelow(feet.x, feet.y, feet.z);
    if (ground === undefined) {
      fall = 0;
      return;
    }
    if (ground >= feet.z - 0.01) {
      // Steps: rise quickly, but not in one frame.
      feet.z += Math.min(ground - feet.z, Math.max(0.02, dt * 6));
      fall = 0;
      return;
    }
    fall = Math.min(fall + 9.8 * dt, 30);
    feet.z = Math.max(ground, feet.z - fall * dt);
    if (feet.z === ground) fall = 0;
  }
  function update(now = performance.now()) {
    if (!active) return false;
    const dt = Math.min(0.1, last ? (now - last) / 1000 : 0);
    last = now;
    if (!dt) return false;
    const key = (k: string) => pressed.has(k);
    const forward =
      (key('w') || key('arrowup') ? 1 : 0) - (key('s') || key('arrowdown') ? 1 : 0) - stick.y;
    const strafe = (key('d') ? 1 : 0) - (key('a') ? 1 : 0) + stick.x;
    const turn = (key('q') || key('arrowleft') ? 1 : 0) - (key('e') || key('arrowright') ? 1 : 0);
    const before = feet.clone(),
      beforeYaw = yaw;
    if (turn) yaw += turn * WALK.turnRate * dt;
    refresh();
    if (forward || strafe) {
      const speed = key('shift') ? WALK.runSpeed : WALK.walkSpeed;
      const move = new THREE.Vector3(Math.cos(yaw), Math.sin(yaw), 0)
        .multiplyScalar(forward)
        .add(new THREE.Vector3(Math.sin(yaw), -Math.cos(yaw), 0).multiplyScalar(strafe));
      if (move.lengthSq() > 1) move.normalize();
      move.multiplyScalar(speed * dt);
      feet.add(slide(move));
    }
    settle(dt);
    if (feet.distanceToSquared(before) > 1e-12 || yaw !== beforeYaw || fall) {
      place();
      return true;
    }
    return false;
  }

  // ---- input ----------------------------------------------------------------------------------
  function key(e: KeyboardEvent, down: boolean) {
    if (!active || editable(e.target) || e.ctrlKey || e.metaKey || e.altKey) return false;
    const k = e.key.toLowerCase();
    if (down && k === 'escape') {
      host.exit();
      return true;
    }
    if (down && (k === 'pageup' || k === 'pagedown')) {
      changeFloor(k === 'pageup' ? 1 : -1);
      e.preventDefault();
      return true;
    }
    if (!MOVE_KEYS.has(k)) return false;
    if (down) pressed.add(k);
    else pressed.delete(k);
    if (k.startsWith('arrow')) e.preventDefault();
    return true;
  }
  const keydown = (e: KeyboardEvent) => {
    key(e, true);
  };
  const keyup = (e: KeyboardEvent) => {
    // Autofill sends key events without a key.
    if (typeof e.key !== 'string') return;
    pressed.delete(e.key.toLowerCase());
    if (e.key === 'Shift') pressed.delete('shift');
  };
  const blur = () => {
    pressed.clear();
    look = null;
  };
  function pointerdown(e: PointerEvent) {
    if (!active) return;
    const looking = e.pointerType === 'touch' ? e.isPrimary : e.button === 2;
    if (!looking) return;
    look = { id: e.pointerId, x: e.clientX, y: e.clientY };
    if (e.pointerType !== 'touch')
      try {
        dom.setPointerCapture?.(e.pointerId);
      } catch {
        /* The pointer is already gone (or synthetic): looking still follows the moves. */
      }
  }
  function pointermove(e: PointerEvent) {
    if (!active || !look || look.id !== e.pointerId) return;
    const dx = e.clientX - look.x,
      dy = e.clientY - look.y;
    look.x = e.clientX;
    look.y = e.clientY;
    // The mouse aims the eye: right looks right, up looks up (user, 2026-10-07: the old drag that
    // pulled the scene felt reversed). A finger still drags the scene, like a panorama.
    const sign = e.pointerType === 'touch' ? 1 : -1;
    yaw += sign * dx * WALK.lookRate;
    pitch = THREE.MathUtils.clamp(pitch + sign * dy * WALK.lookRate, -PITCH_LIMIT, PITCH_LIMIT);
    place();
  }
  function pointerup(e: PointerEvent) {
    if (!active) return;
    if (look?.id === e.pointerId) look = null;
    if (e.pointerType === 'touch') {
      const now = performance.now();
      if (
        lastTap &&
        now - lastTap.time < 320 &&
        Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24
      ) {
        lastTap = null;
        jumpAt(e.clientX, e.clientY);
      } else lastTap = { time: now, x: e.clientX, y: e.clientY };
    }
  }
  const contextmenu = (e: Event) => {
    if (active) e.preventDefault();
  };
  const dblclick = (e: MouseEvent) => {
    if (active) jumpAt(e.clientX, e.clientY);
  };

  /** Walk to the surface under a screen point (client px): onto a floor, or before a wall. */
  function jumpAt(x: number, y: number) {
    const rect = dom.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    // The work screen draws batched objects on another layer; picking reads every layer.
    ray.layers.enableAll();
    ray.setFromCamera(
      new THREE.Vector2(
        ((x - rect.left) / rect.width) * 2 - 1,
        (-(y - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    );
    const meshes = host.surfaces().filter((o) => o instanceof THREE.Mesh && o.visible);
    const hit = ray.intersectObjects(meshes as THREE.Object3D[], false)[0];
    if (!hit) return false;
    const normal = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
      : new THREE.Vector3(0, 0, 1);
    const at = hit.point.clone();
    if (Math.abs(normal.z) < WALKABLE) {
      // A wall: stand half a metre in front of it, on the floor below that point.
      const back = ray.ray.direction.clone().setZ(0).normalize().multiplyScalar(-0.5);
      at.add(back);
    }
    feet.set(at.x, at.y, Math.abs(normal.z) >= WALKABLE ? at.z : feet.z);
    refresh(true);
    if (Math.abs(normal.z) < WALKABLE) {
      const ground = floorBelow(at.x, at.y, at.z);
      if (ground !== undefined) feet.z = ground;
    }
    fall = 0;
    place();
    return true;
  }
  /** Up (1) or down (-1) one floor at the walker's position. */
  function changeFloor(direction: 1 | -1) {
    refresh(true);
    const all = levels(feet.x, feet.y);
    const next =
      direction > 0
        ? all.find((z) => z > feet.z + 0.6)
        : [...all].reverse().find((z) => z < feet.z - 0.6);
    if (next === undefined) {
      host.notice?.(direction > 0 ? '위층이 없습니다.' : '아래층이 없습니다.');
      return false;
    }
    feet.z = next;
    fall = 0;
    place();
    return true;
  }

  // ---- on-screen controls ---------------------------------------------------------------------
  const bar = document.createElement('div');
  bar.className = 'walk-bar';
  bar.hidden = true;
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', '걷기');
  const button = (label: string, title: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onClick);
    bar.append(b);
    return b;
  };
  const hint = document.createElement('span');
  hint.className = 'walk-hint';
  bar.append(hint);
  button('아래층', '아래층으로 (PageDown)', () => changeFloor(-1));
  button('위층', '위층으로 (PageUp)', () => changeFloor(1));
  const collideButton = button('벽 충돌', '벽을 통과하지 않음 · 누르면 통과', () => {
    collide = !collide;
    collideButton.setAttribute('aria-pressed', String(collide));
  });
  collideButton.setAttribute('aria-pressed', 'true');
  button('나가기', '걷기 끝내기 (Esc)', () => host.exit());
  const coarse = matchMedia?.('(pointer: coarse)').matches ?? false;
  hint.textContent = coarse
    ? '조이스틱 이동 · 한 손가락 둘러보기 · 두 번 탭 그 자리로'
    : 'WASD·방향키 이동 · Q/E 회전 · Shift 달리기 · 우클릭 끌기 둘러보기 · 더블클릭 그 자리로';
  const pad = document.createElement('div');
  pad.className = 'walk-joystick';
  pad.hidden = true;
  pad.setAttribute('aria-hidden', 'true');
  const knob = document.createElement('div');
  pad.append(knob);
  let padPointer: number | null = null;
  const padMove = (e: PointerEvent) => {
    if (padPointer !== e.pointerId) return;
    const r = pad.getBoundingClientRect();
    const radius = r.width / 2;
    let dx = e.clientX - (r.left + radius),
      dy = e.clientY - (r.top + radius);
    const length = Math.hypot(dx, dy);
    if (length > radius) {
      dx = (dx / length) * radius;
      dy = (dy / length) * radius;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    stick.x = dx / radius;
    stick.y = dy / radius;
  };
  const padEnd = (e: PointerEvent) => {
    if (padPointer !== e.pointerId) return;
    padPointer = null;
    stick.x = stick.y = 0;
    knob.style.transform = '';
  };
  pad.addEventListener('pointerdown', (e) => {
    padPointer = e.pointerId;
    pad.setPointerCapture?.(e.pointerId);
    padMove(e);
    e.preventDefault();
  });
  pad.addEventListener('pointermove', padMove);
  pad.addEventListener('pointerup', padEnd);
  pad.addEventListener('pointercancel', padEnd);
  container.append(bar, pad);

  dom.addEventListener('pointerdown', pointerdown);
  dom.addEventListener('pointermove', pointermove);
  dom.addEventListener('pointerup', pointerup);
  dom.addEventListener('pointercancel', pointerup);
  dom.addEventListener('contextmenu', contextmenu);
  dom.addEventListener('dblclick', dblclick);
  window.addEventListener('keyup', keyup);
  window.addEventListener('blur', blur);
  if (host.keyboard !== 'host') window.addEventListener('keydown', keydown);

  return {
    get active() {
      return active;
    },
    get collide() {
      return collide;
    },
    /** Is a look drag under way (the host then leaves that pointer alone)? */
    looking(pointerId: number) {
      return look?.id === pointerId;
    },
    /**
     * Start at the floor under `at` (else the lowest floor there, else at `at`), facing along
     * `facing` (only its horizontal part counts).
     */
    start(at: THREE.Vector3, facing: THREE.Vector3) {
      active = true;
      saved = { fov: camera.fov, near: camera.near };
      camera.fov = WALK.fov;
      camera.near = Math.min(camera.near, 0.05);
      camera.updateProjectionMatrix();
      feet.copy(at);
      yaw = Math.atan2(facing.y, facing.x);
      if (!Number.isFinite(yaw)) yaw = 0;
      pitch = 0;
      fall = 0;
      refresh(true);
      const below = floorBelow(at.x, at.y, at.z);
      if (below !== undefined) feet.z = below;
      else {
        const all = levels(at.x, at.y);
        if (all.length) feet.z = all[0];
      }
      last = 0;
      pressed.clear();
      bar.hidden = false;
      pad.hidden = !coarse;
      dom.dataset.walk = 'true';
      place();
    },
    /** Leave: restores the camera's lens and returns where an orbit should look. */
    stop() {
      if (!active) return undefined;
      active = false;
      pressed.clear();
      look = null;
      stick.x = stick.y = 0;
      bar.hidden = true;
      pad.hidden = true;
      delete dom.dataset.walk;
      if (saved) {
        camera.fov = saved.fov;
        camera.near = saved.near;
        camera.updateProjectionMatrix();
      }
      return target();
    },
    update,
    key,
    /** The shown model changed (Sync, hide/isolate): find nearby meshes again. */
    invalidate() {
      candidateAt = null;
    },
    jumpAt,
    changeFloor,
    /** Stand at a point (its floor within a step) facing `heading` radians from +x, if given. */
    teleport(point: readonly [number, number, number], heading?: number) {
      feet.set(point[0], point[1], point[2]);
      if (heading !== undefined) yaw = heading;
      pitch = 0;
      fall = 0;
      refresh(true);
      const ground = floorBelow(feet.x, feet.y, feet.z);
      if (ground !== undefined) feet.z = ground;
      place();
    },
    /** Test/diagnostic hook: the walker's feet, heading and collision setting. */
    state() {
      return { feet: feet.toArray(), yaw, pitch, collide, active, candidates: candidates.length };
    },
    /** Test hook: hold movement keys for `ms` milliseconds of simulated time. */
    simulate(keys: readonly string[], ms: number, step = 16) {
      const held = new Set(pressed);
      pressed.clear();
      for (const k of keys) pressed.add(k.toLowerCase());
      let now = (last || performance.now()) + 0;
      last = now;
      for (let t = 0; t < ms; t += step) {
        now += step;
        update(now);
      }
      pressed.clear();
      for (const k of held) pressed.add(k);
      last = 0;
      return this.state();
    },
    dispose() {
      dom.removeEventListener('pointerdown', pointerdown);
      dom.removeEventListener('pointermove', pointermove);
      dom.removeEventListener('pointerup', pointerup);
      dom.removeEventListener('pointercancel', pointerup);
      dom.removeEventListener('contextmenu', contextmenu);
      dom.removeEventListener('dblclick', dblclick);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', blur);
      window.removeEventListener('keydown', keydown);
      bar.remove();
      pad.remove();
    },
  };
}
export type Walk = ReturnType<typeof createWalk>;
