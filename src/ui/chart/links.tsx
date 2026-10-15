// Links of the row × time chart (Design SCR-38): one line per relation between two placed items,
// styled by kind (width, dash, arrow) — one colour for all (`--text-3`); the chosen chain is drawn
// in the accent colour by the `on` class, links after the cursor and outside the chain fade.
import type { ChartLink, PlacedItem } from './layout.ts';

export interface LinkStyle {
  width: number;
  dash?: string;
  arrow?: boolean;
  /** Drawn fainter than the rest (a note's mention). */
  faint?: boolean;
  label: string;
}

export const ARROW_ID = 'chart-arrow';

/** The marker the arrow links use; put once inside the chart's <svg>. */
export function ChartDefs() {
  return (
    <defs>
      <marker
        id={ARROW_ID}
        viewBox="0 0 8 8"
        refX="7"
        refY="4"
        markerWidth="6"
        markerHeight="6"
        orient="auto-start-reverse"
      >
        <path d="M0,0 L8,4 L0,8 z" className="chart-arrow" />
      </marker>
    </defs>
  );
}

export function ChartLinks({
  links,
  placed,
  styles,
  state,
}: {
  links: readonly ChartLink[];
  placed: ReadonlyMap<string, PlacedItem>;
  styles: Record<string, LinkStyle>;
  /** 'on' (in the chosen chain), 'dim' (outside it), 'later' (after the cursor) or 'base'. */
  state: (link: ChartLink) => 'on' | 'dim' | 'later' | 'base';
}) {
  return (
    <g className="chart-links">
      {links.map((link, index) => {
        const from = placed.get(link.from);
        const to = placed.get(link.to);
        if (!from || !to) return null;
        const style = styles[link.kind] ?? { width: 1, label: link.kind };
        // Two items at the same point (a checkout and its original) get a short vertical tie.
        const same = Math.abs(from.x - to.x) < 2 && Math.abs(from.y - to.y) < 2;
        const d = same
          ? `M${from.x},${from.y - 6} L${to.x},${to.y + 6}`
          : `M${from.x},${from.y} C${(from.x + to.x) / 2},${from.y} ${(from.x + to.x) / 2},${to.y} ${to.x},${to.y}`;
        return (
          <path
            key={`${link.kind}-${link.from}-${link.to}-${index}`}
            className={`chart-link chart-link-${state(link)}${style.faint ? ' chart-link-faint' : ''}`}
            data-kind={link.kind}
            d={d}
            fill="none"
            strokeWidth={style.width}
            strokeDasharray={style.dash}
            markerEnd={style.arrow ? `url(#${ARROW_ID})` : undefined}
          />
        );
      })}
    </g>
  );
}
