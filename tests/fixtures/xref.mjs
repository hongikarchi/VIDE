// Synthetic drawings for 도면 관계 (SPEC-01.11 11, PLAN-43 T-200) and a fake xref reader. Each
// `.dwg` holds a DWG header and then the JSON its read should give, so the fake reader answers from
// the copy it is handed (as the real one reads only copies). No ZWCAD, no real drawing.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MM = 0.001;
/** Row-major insert transform: rotate about Z, uniform scale, then move. */
export function insertTransform([x, y, z], rotation, scale) {
  const c = Math.cos(rotation) * scale,
    s = Math.sin(rotation) * scale;
  return [c, -s, 0, x, s, c, 0, y, 0, 0, scale, z, 0, 0, 0, 1];
}
const insert = (name, position, rotation = 0, scale = 1, space = 'model') => ({
  name,
  handle: 'H' + name,
  space,
  layout: space === 'paper' ? 'Layout1' : space === 'model' ? 'Model' : null,
  block: null,
  nested: false,
  position,
  rotation,
  scale: [scale, scale, scale],
  transform: insertTransform(position, rotation, scale),
});
const drawing = (xrefs = [], inserts = []) => ({
  units: 4,
  scale: MM,
  unitsAssumed: false,
  error: null,
  xrefs,
  inserts,
});
const xref = (name, path, overlay = false) => ({ name, path, overlay, status: 'Unresolved' });

/**
 * parent.dwg → child (absolute, at (1000,0) rotated 90° scale 2, inserted twice in model space and
 * once on a layout, and again under a second block name: a duplicate), sub\grand.dwg (relative,
 * overlay), beam.dwg (a stored path of another PC, found in the same folder), missing.dwg;
 * child.dwg → nested.dwg (relative); loop-a ↔ loop-b (a cycle); alone.dwg (no xref).
 */
export async function writeSyntheticDrawings(folder) {
  await mkdir(join(folder, 'sub'), { recursive: true });
  const files = {
    'parent.dwg': drawing(
      [
        xref('child', join(folder, 'child.dwg')),
        xref('child-again', join(folder, 'child.dwg')),
        xref('grand', 'sub\\grand.dwg', true),
        xref('beam', 'D:\\예전 PC\\도면\\beam.dwg'),
        xref('missing', 'Z:\\없는 폴더\\missing.dwg'),
      ],
      [
        insert('child', [1000, 0, 0], Math.PI / 2, 2),
        insert('child', [5000, 0, 0]),
        insert('child', [0, 0, 0], 0, 1, 'paper'),
        insert('child-again', [9000, 0, 0]),
        insert('grand', [0, 500, 0]),
        insert('beam', [0, 0, 3000]),
      ],
    ),
    'child.dwg': drawing([xref('nested', 'nested.dwg')], [insert('nested', [100, 0, 0])]),
    'nested.dwg': drawing(),
    'sub/grand.dwg': drawing(),
    'beam.dwg': drawing(),
    'loop-a.dwg': drawing([xref('loop-b', 'loop-b.dwg')], [insert('loop-b', [0, 0, 0])]),
    'loop-b.dwg': drawing([xref('loop-a', 'loop-a.dwg', true)], [insert('loop-a', [0, 0, 0])]),
    'alone.dwg': drawing(),
  };
  for (const [name, read] of Object.entries(files))
    await writeFile(join(folder, name), 'AC1032' + JSON.stringify(read));
  return files;
}

const parse = async (path) => JSON.parse((await readFile(path, 'utf8')).slice(6));

/** Answers from the copies; `calls` counts the graph and display runs and files. */
export function fakeXrefReader({ available = true, delay = 0 } = {}) {
  const calls = { graph: [], display: [] };
  const wait = () => new Promise((resolve) => setTimeout(resolve, delay));
  return {
    calls,
    async available() {
      return available;
    },
    async graph(files, _work, progress) {
      calls.graph.push(files.length);
      const out = new Map();
      for (const file of files) {
        await wait();
        out.set(file.id, await parse(file.path));
        progress(out.size);
      }
      return out;
    },
    async display(files, _work, progress) {
      calls.display.push(files.length);
      const out = new Map();
      for (const file of files) {
        await wait();
        const read = await parse(file.path);
        out.set(file.id, {
          ...read,
          objects: [{ id: 'cad-1', nativeId: '1', kind: 'polyline', name: '0 / 1' }],
          scene: [
            {
              id: 'cad-1',
              nativeId: '1',
              nativeType: 'Line',
              line: [0, 0, 0, 0.5, 0, 0],
              vertices: [],
              indices: [],
              length: 0.5,
            },
          ],
          displayCoverage: { total: 1, displayed: 1, omitted: 0, omittedTypes: {} },
          displayWarnings: {},
        });
        progress(out.size);
      }
      return out;
    },
  };
}
