// Item glyphs of the row × time chart (Design SCR-38): one small SVG shape per kind, drawn at the
// item's point. Shape tells the kind; colour stays the text colour (no colour coding by kind).

export type GlyphKind = 'model' | 'drawing' | 'jig' | 'report' | 'note' | 'image' | 'file';

/** The shape of each kind, for the legend and the screen-reader names. */
export const GLYPH_NAMES: Record<GlyphKind, string> = {
  model: '세모',
  drawing: '네모',
  jig: '마름모',
  report: '동그라미',
  note: '작은 사각',
  image: '빗금 사각',
  file: '점',
};

export function Glyph({
  kind,
  x,
  y,
  size = 9,
}: {
  kind: string;
  x: number;
  y: number;
  size?: number;
}) {
  const h = size / 2;
  switch (kind as GlyphKind) {
    case 'model':
      return (
        <polygon
          className="chart-glyph"
          points={`${x},${y - h} ${x + h},${y + h} ${x - h},${y + h}`}
        />
      );
    case 'drawing':
      return <rect className="chart-glyph" x={x - h} y={y - h} width={size} height={size} />;
    case 'jig':
      return (
        <polygon
          className="chart-glyph"
          points={`${x},${y - h - 1} ${x + h + 1},${y} ${x},${y + h + 1} ${x - h - 1},${y}`}
        />
      );
    case 'report':
      return <circle className="chart-glyph" cx={x} cy={y} r={h} />;
    case 'note':
      return (
        <rect
          className="chart-glyph"
          x={x - h * 0.7}
          y={y - h * 0.7}
          width={h * 1.4}
          height={h * 1.4}
        />
      );
    case 'image':
      return (
        <g className="chart-glyph chart-glyph-image">
          <rect x={x - h} y={y - h} width={size} height={size} />
          <path
            d={`M${x - h},${y + h / 2} L${x - h / 2},${y + h} M${x - h},${y} L${x},${y + h} M${x - h / 2},${y - h} L${x + h},${y + h / 2} M${x},${y - h} L${x + h},${y}`}
          />
        </g>
      );
    default:
      return <circle className="chart-glyph" cx={x} cy={y} r={h * 0.6} />;
  }
}
