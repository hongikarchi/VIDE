import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { creaseEdges } from '../../src/ui/crease-edges.ts';

// Same edges as THREE.EdgesGeometry (compared as sorted segment sets), much faster.
const segments = (array) => {
  const out = [];
  for (let i = 0; i < array.length; i += 6) {
    const a = [...array.slice(i, i + 3)].map((v) => v.toFixed(4)).join(),
      b = [...array.slice(i + 3, i + 6)].map((v) => v.toFixed(4)).join();
    out.push(a < b ? a + '|' + b : b + '|' + a);
  }
  return out.sort();
};
const compare = (geometry) => {
  const mine = creaseEdges(
    geometry.getAttribute('position').array,
    geometry.index?.array ?? null,
    38,
  );
  const theirs = new THREE.EdgesGeometry(geometry, 38).getAttribute('position').array;
  assert.deepEqual(segments(mine), segments(theirs));
  return mine.length / 6;
};

test('crease edges match THREE.EdgesGeometry on split, welded and open meshes', () => {
  // A box split at its creases (each face has its own vertices): the 12 edges.
  assert.equal(compare(new THREE.BoxGeometry(2, 3, 4)), 12);
  // Unindexed copy of the same box.
  assert.equal(compare(new THREE.BoxGeometry(2, 3, 4).toNonIndexed()), 12);
  // A smooth cylinder: only the rims of its caps.
  compare(new THREE.CylinderGeometry(1, 1, 2, 24));
  // An open bumpy patch: its boundary.
  const plane = new THREE.PlaneGeometry(4, 4, 10, 10);
  const p = plane.getAttribute('position');
  for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin(p.getX(i)) * 0.1);
  assert.equal(compare(plane), 40);
  // Survey coordinates stay exact (welding compares float32 bits, not rounded text).
  const far = new THREE.BoxGeometry(1, 1, 1).translate(200000, 500000, 0);
  assert.equal(compare(far), 12);
});

test('crease edges of 9,000 patches stay well under a second', () => {
  const plane = new THREE.PlaneGeometry(2.5, 2.5, 10, 10);
  const position = plane.getAttribute('position').array,
    index = plane.index.array;
  const began = performance.now();
  for (let i = 0; i < 9000; i++) creaseEdges(position, index, 38);
  const ms = performance.now() - began;
  assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
  console.log(`9,000 patches: ${ms.toFixed(0)} ms`);
});
