import type { OverlayItem } from '../viewport.ts';
import './kit.css';

// View parts (Design §14 `viewport-overlay` · `plan-map`, SCR-13 3D·평면 겹침): the 3D overlay
// layer menu with on/off and opacity (the layers themselves are drawn by the viewport), and a
// plan drawn in SVG from the same items, turned so the grid reads square. Picking an item in the
// plan selects it like a table row.

export interface LayerRow {
  key: string;
  title: string;
  count: number;
  visible: boolean;
  opacity?: number;
}
export function OverlayControls({
  layers,
  onVisible,
  onOpacity,
}: {
  layers: readonly LayerRow[];
  onVisible: (key: string, on: boolean) => void;
  /** Omitted when the viewport cannot fade a layer. */
  onOpacity?: (key: string, value: number) => void;
}) {
  const on = layers.filter((layer) => layer.visible).length;
  return (
    <details className="kit-card kit-layer-menu">
      <summary>
        보기 {on}/{layers.length} 켜짐
      </summary>
      <ul className="kit-layers">
        {layers.map((layer) => (
          <li key={layer.key} data-layer={layer.key}>
            <label>
              <input
                type="checkbox"
                checked={layer.visible}
                onChange={(event) => onVisible(layer.key, event.target.checked)}
              />
              {layer.title} <span className="kit-muted">{layer.count}</span>
            </label>
            {onOpacity ? (
              <input
                type="range"
                aria-label={`${layer.title} 투명도`}
                min={0.1}
                max={1}
                step={0.1}
                value={layer.opacity ?? 1}
                disabled={!layer.visible}
                onChange={(event) => onOpacity(layer.key, Number(event.target.value))}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

export interface PlanLayer {
  key: string;
  items: readonly OverlayItem[];
}
/** A plan of overlay items in world metres; `rotate` (degrees) turns that direction to horizontal. */
export function PlanMap({
  title = '평면',
  layers,
  rotate = 0,
  selected,
  onPick,
}: {
  title?: string;
  layers: readonly PlanLayer[];
  rotate?: number;
  selected?: { key: string; id: string };
  onPick?: (key: string, id: string) => void;
}) {
  const theta = (-rotate * Math.PI) / 180;
  const cos = Math.cos(theta),
    sin = Math.sin(theta);
  // Plan north up: SVG y grows downwards, so v is negated.
  const at = (x: number, y: number): [number, number] => [x * cos - y * sin, -(x * sin + y * cos)];
  const shapes = layers.map((layer) => ({
    key: layer.key,
    items: layer.items.map((item) => ({
      item,
      pts:
        item.kind === 'point'
          ? [at(item.at[0], item.at[1])]
          : item.points.map((p) => at(p[0], p[1])),
    })),
  }));
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const layer of shapes)
    for (const { pts } of layer.items)
      for (const [x, y] of pts) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
  if (!Number.isFinite(minX))
    return (
      <p className="kit-muted" role="status">
        평면에 그릴 결과가 아직 없습니다.
      </p>
    );
  const size = Math.max(maxX - minX, maxY - minY, 1);
  const pad = size * 0.06;
  const r = size * 0.012;
  const font = size * 0.028;
  const list = (pts: [number, number][]) => pts.map(([x, y]) => `${x},${y}`).join(' ');
  return (
    <svg
      className="kit-plan"
      role="img"
      aria-label={title}
      viewBox={`${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {shapes.map((layer) => (
        <g key={layer.key} data-layer={layer.key}>
          {layer.items.map(({ item, pts }) => {
            const chosen = selected?.key === layer.key && selected.id === item.id;
            const common = {
              'data-id': item.id,
              'data-tone': item.tone ?? 'ov-new',
              'data-selected': chosen ? '' : undefined,
              onClick: onPick ? () => onPick(layer.key, item.id) : undefined,
            };
            const shape =
              item.kind === 'point' ? (
                <circle cx={pts[0][0]} cy={pts[0][1]} r={chosen ? r * 1.6 : r} {...common} />
              ) : item.kind === 'polygon' ? (
                <polygon points={list(pts)} data-fill={item.fill ? '' : undefined} {...common} />
              ) : (
                <polyline
                  points={list(item.closed ? [...pts, pts[0]] : pts)}
                  data-dashed={item.dashed ? '' : undefined}
                  {...common}
                />
              );
            const [lx, ly] = pts[Math.floor((pts.length - 1) / 2)];
            return (
              <g key={item.id}>
                {shape}
                {item.label && item.kind === 'point' ? (
                  <text x={lx + r * 1.4} y={ly - r * 1.4} fontSize={font}>
                    {item.label}
                  </text>
                ) : null}
                {item.label && item.kind !== 'point' && ly !== undefined ? (
                  <text x={lx} y={ly} fontSize={font}>
                    {item.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      ))}
    </svg>
  );
}
