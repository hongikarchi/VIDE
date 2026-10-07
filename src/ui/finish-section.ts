// 마감 단면 그림 (SPEC-11.3 6, Design SCR-28): layers drawn with a hatch per material kind, layer
// and total dimensions on two lines, and an optional leader listing the layers. Ported from the
// user's finish-code app (section.js) as an SVG string; colours come from `currentColor` and the
// CSS classes in finish-jig.css. A changed thickness changes the widths at once.
export interface SectionLayer {
  nm: string;
  kind: string;
  t: number;
  over?: boolean;
}
export interface SectionOptions {
  /** Drawing width (px). */
  w?: number;
  /** Band depth across the layers. */
  band?: number;
  /** List the layers with a leader. */
  leader?: boolean;
  /** 'x': layers left to right (walls); 'y': top to bottom (ceilings), or bottom up with `up`. */
  axis?: 'x' | 'y';
  /** Floors: stacked from the bottom up. */
  up?: boolean;
}

export const HATCHES: Record<string, string> = {
  conc: '<path d="M0 0h8v8H0z" fill="none"/><circle cx="2" cy="2" r=".7"/><circle cx="6" cy="5.5" r=".55"/><path d="M4.2 6.6l1-1.6.9 1.6z" stroke="none"/>',
  mortar:
    '<circle cx="1.5" cy="1.5" r=".45"/><circle cx="4.5" cy="3.5" r=".45"/><circle cx="2.5" cy="5.5" r=".45"/><circle cx="6" cy="6.5" r=".45"/>',
  insul: '<path d="M-1 -1L9 9M-1 9L9 -1M-1 3L5 9M3 -1L9 5" fill="none" stroke-width=".6"/>',
  stud: '<path d="M-1 -1L9 9M-1 9L9 -1" fill="none" stroke-width=".55"/>',
  foam: '<circle cx="2" cy="2" r="1.4" fill="none" stroke-width=".5"/><circle cx="6" cy="6" r="1.1" fill="none" stroke-width=".5"/>',
  board:
    '<path d="M0 8L8 0" fill="none" stroke-width=".5"/><path d="M-2 2L2 -2M6 10L10 6" fill="none" stroke-width=".5"/>',
  memb: '<path d="M0 4h8" fill="none" stroke-width="1.6"/>',
  drain:
    '<circle cx="2" cy="2" r="1.5" fill="none" stroke-width=".6"/><circle cx="6" cy="6" r="1.5" fill="none" stroke-width=".6"/>',
  tile: '<path d="M0 0h8v8H0z" stroke="none"/>',
  stone: '<path d="M-1 3L5 -3M-1 7L7 -1M1 9L9 1M5 9L9 5" fill="none" stroke-width=".7"/>',
  wood: '<path d="M0 1.6h8M0 4h8M0 6.4h8" fill="none" stroke-width=".45"/><path d="M2 0v1.6M5.5 4v2.4" fill="none" stroke-width=".45"/>',
  metal: '<path d="M0 0h8v8H0z" stroke="none"/>',
  glass: '<path d="M-1 5L5 -1M2 9L9 2" fill="none" stroke-width=".5"/>',
  paint: '<path d="M0 0h8v8H0z" stroke="none"/>',
  sheet: '<path d="M0 0h8v8H0z" stroke="none"/>',
  carpet: '<path d="M1 7v-2M3 7v-3M5 7v-2M7 7v-3" fill="none" stroke-width=".6"/>',
  acoustic:
    '<circle cx="2" cy="2" r=".8"/><circle cx="6" cy="6" r=".8"/><circle cx="6" cy="2" r=".8"/><circle cx="2" cy="6" r=".8"/>',
  elastic:
    '<circle cx="2.5" cy="2.5" r="1"/><circle cx="6" cy="5.5" r=".8"/><circle cx="1" cy="6" r=".7"/>',
  rebar: '<circle cx="4" cy="4" r="1.3"/>',
  air: '',
  coat: '',
  glue: '<path d="M0 4h8" fill="none" stroke-width=".8" stroke-dasharray="1.5 1.5"/>',
  int: '<path d="M-1 9L9 -1" fill="none" stroke-width=".5" stroke-dasharray="2 2"/>',
  none: '',
};
const SOLID: Record<string, number> = {
  tile: 0.82,
  metal: 0.62,
  paint: 0.5,
  sheet: 0.45,
  memb: 0.9,
};

const f = (n: number) => String(Math.round(n * 10) / 10);
const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const attrs = (values: Record<string, string | number | undefined>) =>
  Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');
let uid = 0;

/** The section as an SVG string (`<svg class="finish-section" …>`). */
export function sectionSvg(layers: readonly SectionLayer[], options: SectionOptions = {}): string {
  const axis = options.axis ?? 'x';
  const up = Boolean(options.up);
  const W = options.w ?? 300;
  const band = options.band ?? 44;
  const leader = Boolean(options.leader);
  const dimH = axis === 'x' ? 30 : 48;
  const id = `fsx${++uid}`;

  let shown = layers.filter((layer) => layer.t > 0 || layer.kind === 'air');
  let total = shown.reduce((sum, layer) => sum + Math.max(layer.t, 0), 0);
  if (total <= 0) {
    shown = [];
    total = 1;
  }
  const lead = leader ? Math.max(150, W * 0.55) : 0;
  const bodyLen = Math.max(60, W - (leader ? lead + 14 : 0));
  const scale = bodyLen / total;
  let px = shown.map((layer) => Math.max(layer.t * scale, 1.4));
  const sum = px.reduce((a, b) => a + b, 0);
  if (sum > bodyLen) px = px.map((value) => (value * bodyLen) / sum);
  const length = px.reduce((a, b) => a + b, 0);

  let svgW: number, svgH: number, ox: number, oy: number;
  if (axis === 'x') {
    svgW = length + 12 + lead + (leader ? 14 : 0);
    svgH = band + dimH + 10;
    ox = 6;
    oy = dimH + 4;
  } else {
    svgW = Math.max(band + dimH + 16 + lead, 130);
    svgH = length + 16;
    ox = dimH + 6;
    oy = 8;
  }
  const out: string[] = [];
  // Structure line (thick).
  const sy = up ? oy + length : oy;
  out.push(
    `<line class="fsx-struct" ${attrs({
      x1: ox,
      y1: axis === 'x' ? oy : sy,
      x2: axis === 'x' ? ox : ox + band,
      y2: axis === 'x' ? oy + band : sy,
    })}/>`,
  );
  // Layer bands.
  let pos = 0;
  const ticks: { at: number; t?: number; over?: boolean }[] = [{ at: 0 }];
  shown.forEach((layer, i) => {
    const w = px[i];
    const [x, y, ww, hh] =
      axis === 'x' ? [ox + pos, oy, w, band] : [ox, up ? oy + length - pos - w : oy + pos, band, w];
    const kind = HATCHES[layer.kind] != null ? layer.kind : 'none';
    out.push(
      `<rect class="fsx-band" ${attrs({ x: f(x), y: f(y), width: f(ww), height: f(hh), fill: `url(#${id}-${kind})`, stroke: 'currentColor', 'stroke-width': 0.5 })}/>`,
    );
    pos += w;
    ticks.push({ at: pos, t: layer.t, over: layer.over });
  });
  // Dimensions: per layer (row 0) and the total (row 1).
  const dim = (a: number, b: number, label: string, row: number, flag?: boolean) => {
    const off = row === 0 ? 13 : 25;
    let A: [number, number], B: [number, number], T: [number, number];
    if (axis === 'x') {
      const yy = oy - off;
      A = [ox + a, yy];
      B = [ox + b, yy];
      T = [(A[0] + B[0]) / 2, yy - 3];
    } else {
      const xx = ox - off;
      const ya = up ? oy + length - a : oy + a;
      const yb = up ? oy + length - b : oy + b;
      A = [xx, ya];
      B = [xx, yb];
      T = [xx - 3, (ya + yb) / 2];
    }
    out.push(
      `<line class="fsx-dim" ${attrs({ x1: f(A[0]), y1: f(A[1]), x2: f(B[0]), y2: f(B[1]) })}/>`,
    );
    for (const P of [A, B]) {
      out.push(
        `<path class="fsx-dim" d="M${f(P[0] - 2.5)} ${f(P[1] + 2.5)}L${f(P[0] + 2.5)} ${f(P[1] - 2.5)}"/>`,
      );
      out.push(
        axis === 'x'
          ? `<line class="fsx-ext" ${attrs({ x1: f(P[0]), y1: f(P[1] - 2), x2: f(P[0]), y2: f(oy - 1) })}/>`
          : `<line class="fsx-ext" ${attrs({ x1: f(P[0] - 2), y1: f(P[1]), x2: f(ox - 1), y2: f(P[1]) })}/>`,
      );
    }
    if (label)
      out.push(
        `<text class="fsx-txt${flag ? ' over' : ''}" ${attrs({
          x: f(T[0]),
          y: f(T[1]),
          'text-anchor': axis === 'x' ? 'middle' : 'end',
          'dominant-baseline': axis === 'x' ? 'auto' : 'middle',
        })}>${escape(label)}</text>`,
      );
  };
  for (let i = 1; i < ticks.length; i++) {
    const a = ticks[i - 1].at;
    const b = ticks[i].at;
    dim(a, b, b - a >= 15 ? f(ticks[i].t ?? 0) : '', 0, ticks[i].over);
  }
  dim(0, length, f(total), 1);
  // Leader listing the layers.
  if (leader) {
    const anchor =
      axis === 'x'
        ? [ox + length * 0.42, oy + band * 0.38]
        : [ox + band * 0.55, oy + length * 0.45];
    const elbow = axis === 'x' ? [ox + length + 24, anchor[1]] : [ox + band + 24, anchor[1]];
    const tx = elbow[0] + 8;
    const lh = 13;
    const n = shown.length;
    const top = Math.max(10, elbow[1] - ((n - 1) * lh) / 2);
    out.push(`<circle class="fsx-lead-d" cx="${f(anchor[0])}" cy="${f(anchor[1])}" r="2"/>`);
    out.push(
      `<path class="fsx-lead" d="M${f(anchor[0])} ${f(anchor[1])}L${f(elbow[0])} ${f(elbow[1])}"/>`,
    );
    out.push(
      `<path class="fsx-lead" d="M${f(elbow[0])} ${f(top)}L${f(elbow[0])} ${f(top + (n - 1) * lh)}"/>`,
    );
    shown.forEach((layer, i) => {
      const yy = top + i * lh;
      out.push(`<path class="fsx-lead" d="M${f(elbow[0])} ${f(yy)}h6"/>`);
      out.push(
        `<text class="fsx-note${layer.over ? ' over' : ''}" x="${f(tx)}" y="${f(yy)}" dominant-baseline="middle">${escape((layer.t > 0 ? `T${f(layer.t)} ` : '') + layer.nm)}</text>`,
      );
    });
    svgH = Math.max(svgH, top + n * lh + 6);
  }
  const used = new Set(shown.map((layer) => (HATCHES[layer.kind] != null ? layer.kind : 'none')));
  const defs = Object.entries(HATCHES)
    .filter(([kind]) => used.has(kind))
    .map(
      ([kind, body]) =>
        `<pattern id="${id}-${kind}" width="8" height="8" patternUnits="userSpaceOnUse"><g stroke="currentColor" fill="currentColor"${SOLID[kind] ? ` opacity="${SOLID[kind]}"` : ''}>${body}</g></pattern>`,
    )
    .join('');
  return `<svg class="finish-section" viewBox="0 0 ${f(svgW)} ${f(svgH)}" width="100%" height="${f(svgH)}" preserveAspectRatio="xMinYMin meet" role="img" aria-label="단면"><defs>${defs}</defs><g>${out.join('')}</g></svg>`;
}
