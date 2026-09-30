// A/B parity checks (SPIKE-2026-09-30-ai-parity-ab): judge a candidate model against the fixed
// expectations in requests.json, and draw a plain viewport picture of it. Pure functions; the
// engine run (run.mjs) and the unit test feed them scenes.

const decode64 = (value) => (value ? Buffer.from(value, 'base64').toString('utf8') : '');

/** One scene row in millimetres: bounds, name, layer, polyline. `scale` turns scene units into mm. */
export function objectOf(row, scale = 1) {
  const min = (row.origin ?? [0, 0, 0]).map((v) => v * scale);
  const size = (row.boundsSize ?? [0, 0, 0]).map((v) => v * scale);
  return {
    id: row.id,
    name: row.name64 !== undefined ? decode64(row.name64) : (row.name ?? ''),
    layer: row.layer64 !== undefined ? decode64(row.layer64) : (row.layer ?? ''),
    type: row.nativeType ?? '',
    min,
    size,
    max: min.map((v, i) => v + size[i]),
    line: (row.line ?? []).map((v) => v * scale),
    vertices: (row.vertices ?? []).map((v) => v * scale),
    indices: row.indices ?? [],
  };
}

const within = (value, [low, high]) => value >= low && value <= high;
const center = (o) => o.min.map((v, i) => v + o.size[i] / 2);
const union = (objects) =>
  objects.reduce(
    (box, o) => ({
      min: box.min.map((v, i) => Math.min(v, o.min[i])),
      max: box.max.map((v, i) => Math.max(v, o.max[i])),
    }),
    { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
  );
const fmt = (n) => Math.round(n * 10) / 10;

/**
 * Evaluates the checks of one request.
 * @param checks requests.json `checks`
 * @param state { scene, changes, baseScene, scale, baseScale } — `scene` is the candidate model,
 *   `changes` its { added, removed, modified } against the base, `baseScene` the Sync it started from.
 * @returns [{ type, ok, detail }]
 */
export function evaluate(checks, state) {
  const objects = (state.scene ?? []).map((row) => objectOf(row, state.scale ?? 1));
  const base = (state.baseScene ?? []).map((row) => objectOf(row, state.baseScale ?? 1));
  const changes = state.changes ?? { added: [], removed: [], modified: [] };
  const added = new Set(changes.added ?? []);
  const addedObjects = objects.filter((o) => added.has(o.id));
  const onLayer = (list, name) => list.filter((o) => o.layer === name);
  return checks.map((check) => {
    const result = (ok, detail) => ({ type: check.type, ok, detail });
    switch (check.type) {
      case 'added': {
        const n = addedObjects.length;
        if (check.min !== undefined && n < check.min)
          return result(false, `added ${n} < ${check.min}`);
        if (check.max !== undefined && n > check.max)
          return result(false, `added ${n} > ${check.max}`);
        if (check.shape === 'vertical') {
          const flat = addedObjects.filter((o) => o.size[2] < 2 * Math.max(o.size[0], o.size[1]));
          if (flat.length) return result(false, `${flat.length} added objects are not vertical`);
        }
        return result(true, `added ${n}`);
      }
      case 'addedOnGrid': {
        const lines = onLayer(objects, check.gridLayer);
        const xs = lines.filter((o) => o.size[0] < o.size[1]).map((o) => o.min[0] + o.size[0] / 2);
        const ys = lines.filter((o) => o.size[1] < o.size[0]).map((o) => o.min[1] + o.size[1] / 2);
        const tolerance = check.tolerance ?? 50;
        const off = addedObjects.filter((o) => {
          const [x, y] = center(o);
          return (
            !xs.some((g) => Math.abs(g - x) <= tolerance) ||
            !ys.some((g) => Math.abs(g - y) <= tolerance)
          );
        });
        const taken = new Set(
          addedObjects.map((o) =>
            center(o)
              .map((v) => Math.round(v / tolerance))
              .slice(0, 2)
              .join(),
          ),
        );
        if (off.length)
          return result(false, `${off.length} added objects off the grid intersections`);
        if (taken.size !== addedObjects.length)
          return result(false, `${addedObjects.length - taken.size} intersections doubled`);
        return result(true, `${taken.size} of ${xs.length * ys.length} intersections`);
      }
      case 'removedMax': {
        const n = (changes.removed ?? []).length;
        return result(n <= check.max, `removed ${n}`);
      }
      case 'layer': {
        const list = onLayer(objects, check.layer);
        if (check.count !== undefined && list.length !== check.count)
          return result(false, `${check.layer}: ${list.length} objects, expected ${check.count}`);
        if (check.sizeZ) {
          const wrong = list.filter((o) => !within(o.size[2], check.sizeZ));
          if (wrong.length)
            return result(
              false,
              `${check.layer}: height ${wrong.map((o) => fmt(o.size[2])).join(', ')} outside ${check.sizeZ.join('–')}`,
            );
        }
        return result(true, `${check.layer}: ${list.length} objects`);
      }
      case 'layerAny': {
        const list = onLayer(objects, check.layer);
        const hit = list.find(
          (o) =>
            (!check.originZ || within(o.min[2], check.originZ)) &&
            (!check.sizeZ || within(o.size[2], check.sizeZ)),
        );
        return hit
          ? result(true, `${check.layer}: ${hit.name || hit.id} at z ${fmt(hit.min[2])}`)
          : result(
              false,
              `${check.layer}: none at z ${check.originZ?.join('–') ?? 'any'} (have ${list.map((o) => fmt(o.min[2])).join(', ')})`,
            );
      }
      case 'untouchedOutside': {
        const allowed = new Set(check.layers);
        const layerOf = new Map([...base, ...objects].map((o) => [o.id, o.layer]));
        const touched = [
          ...(changes.added ?? []),
          ...(changes.removed ?? []),
          ...(changes.modified ?? []).map((m) => m.id),
        ].filter((id) => !allowed.has(layerOf.get(id)));
        return result(
          !touched.length,
          touched.length
            ? `${touched.length} other objects changed`
            : 'only allowed layers changed',
        );
      }
      case 'addedNear': {
        const guide = onLayer(objects, check.layer)[0] ?? onLayer(base, check.layer)[0];
        if (!guide) return result(false, `no object on ${check.layer}`);
        if (!addedObjects.length) return result(false, 'nothing added');
        const box = union(addedObjects);
        const margin = check.margin ?? 300;
        const far = [0, 1].some(
          (i) =>
            Math.abs(box.min[i] - guide.min[i]) > margin ||
            Math.abs(box.max[i] - guide.max[i]) > margin,
        );
        const height = box.max[2] - Math.max(box.min[2], guide.min[2]);
        if (far)
          return result(
            false,
            `added bounds ${box.min.slice(0, 2).map(fmt)}–${box.max.slice(0, 2).map(fmt)} do not follow the guide`,
          );
        if (check.minSizeZ !== undefined && height < check.minSizeZ)
          return result(false, `height above the guide ${fmt(height)} < ${check.minSizeZ}`);
        return result(true, `follows the guide, ${fmt(height)} high`);
      }
      case 'gridNames': {
        const lines = onLayer(objects, check.layer);
        if (check.count !== undefined && lines.length !== check.count)
          return result(false, `${check.layer}: ${lines.length} lines, expected ${check.count}`);
        const groups = [
          lines.filter((o) => o.size[0] < o.size[1]).sort((a, b) => a.min[0] - b.min[0]),
          lines.filter((o) => o.size[1] <= o.size[0]).sort((a, b) => a.min[1] - b.min[1]),
        ];
        const prefixes = groups.map((group) => {
          const names = group.map((o) => /^([XY])(\d+)$/.exec(o.name.trim()));
          if (names.some((m) => !m)) return null;
          const prefix = names[0]?.[1];
          const ordered = names.every((m, i) => m[1] === prefix && Number(m[2]) === i + 1);
          return ordered ? prefix : null;
        });
        const ok = prefixes.every(Boolean) && prefixes[0] !== prefixes[1];
        return result(
          ok,
          ok
            ? `${prefixes[0]}1..${groups[0].length}, ${prefixes[1]}1..${groups[1].length}`
            : `names: ${lines.map((o) => o.name).join(', ')}`,
        );
      }
      default:
        return result(false, 'unknown check ' + check.type);
    }
  });
}

/** Changes between two scene dumps by object id (Rhino ids survive in a live document). */
export function diff(beforeRows, afterRows) {
  const old = new Map(beforeRows.map((r) => [r.id, r]));
  const now = new Map(afterRows.map((r) => [r.id, r]));
  const differs = (a, b) =>
    a.name64 !== b.name64 ||
    a.layer64 !== b.layer64 ||
    [...a.origin, ...a.boundsSize].some(
      (v, i) => Math.abs(v - [...b.origin, ...b.boundsSize][i]) > 0.01,
    );
  return {
    added: afterRows.filter((r) => !old.has(r.id)).map((r) => r.id),
    removed: beforeRows.filter((r) => !now.has(r.id)).map((r) => r.id),
    modified: afterRows
      .filter((r) => old.has(r.id) && differs(old.get(r.id), r))
      .map((r) => ({ id: r.id, geometry: true, attributes: true, nativeIdentity: false })),
  };
}
/**
 * A plain picture of the candidate model (plan and axonometric side by side) as SVG: the stand-in
 * for a viewport capture until the engine returns host captures. Added and modified objects are
 * drawn in the accent colour.
 */
export function captureSvg(scene, { scale = 1, highlight = [], title = '' } = {}) {
  const objects = (scene ?? []).map((row) => objectOf(row, scale));
  const marked = new Set(highlight);
  const views = [
    { name: '평면', project: ([x, y]) => [x, -y] },
    {
      name: '축측',
      project: ([x, y, z]) => [(x - y) * Math.cos(Math.PI / 6), -((x + y) * 0.5 + z)],
    },
  ];
  const width = 560,
    height = 420,
    pad = 24;
  const pointsOf = (o) => {
    const polylines = [];
    if (o.line.length >= 6) {
      const points = [];
      for (let i = 0; i + 2 < o.line.length; i += 3) points.push(o.line.slice(i, i + 3));
      polylines.push(points);
    }
    if (o.vertices.length && o.indices.length) {
      // Triangle edges, thinned for big meshes.
      const step = Math.max(3, Math.floor(o.indices.length / 600) * 3);
      for (let i = 0; i + 2 < o.indices.length; i += step) {
        const tri = [o.indices[i], o.indices[i + 1], o.indices[i + 2], o.indices[i]].map((k) =>
          o.vertices.slice(k * 3, k * 3 + 3),
        );
        polylines.push(tri);
      }
    }
    if (!polylines.length) {
      // Bounds box edges when the row has no drawable geometry.
      const [a, b] = [o.min, o.max];
      const c = (x, y, z) => [x ? b[0] : a[0], y ? b[1] : a[1], z ? b[2] : a[2]];
      polylines.push([c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0), c(0, 0, 0)]);
      polylines.push([c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1), c(0, 0, 1)]);
    }
    return polylines;
  };
  const shapes = objects.map((o) => ({ o, polylines: pointsOf(o) }));
  const panels = views.map((view, index) => {
    const projected = shapes.map(({ o, polylines }) => ({
      o,
      polylines: polylines.map((line) => line.map(view.project)),
    }));
    const all = projected.flatMap((s) => s.polylines.flat());
    const xs = all.map((p) => p[0]),
      ys = all.map((p) => p[1]);
    const [x0, x1, y0, y1] = all.length
      ? [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
      : [0, 1, 0, 1];
    const k = Math.min((width - 2 * pad) / (x1 - x0 || 1), (height - 2 * pad) / (y1 - y0 || 1));
    const offsetX = index * width + pad,
      offsetY = pad + 18;
    const paths = projected
      .sort((a, b) => Number(marked.has(a.o.id)) - Number(marked.has(b.o.id)))
      .map(({ o, polylines }) => {
        const d = polylines
          .map(
            (line) =>
              'M' +
              line
                .map(([x, y]) => `${fmt(offsetX + (x - x0) * k)} ${fmt(offsetY + (y - y0) * k)}`)
                .join('L'),
          )
          .join('');
        const hot = marked.has(o.id);
        return `<path d="${d}" fill="none" stroke="${hot ? '#d9480f' : '#5c6470'}" stroke-width="${hot ? 1.6 : 0.8}"><title>${escape(o.layer + ' · ' + o.name)}</title></path>`;
      })
      .join('');
    return `<text x="${offsetX}" y="${pad}" font-size="13" fill="#222">${view.name}</text>${paths}`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width * 2}" height="${height + 30}" viewBox="0 0 ${width * 2} ${height + 30}" font-family="sans-serif"><rect width="100%" height="100%" fill="#fff"/>${panels.join('')}<text x="${pad}" y="${height + 20}" font-size="12" fill="#555">${escape(title)} · 주황 = 추가·변경</text></svg>`;
}

function escape(text) {
  return String(text).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
}
