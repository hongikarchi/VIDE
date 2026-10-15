// Time axis of the row × time chart (Design SCR-38): two lines — month (or day) ticks and the
// density strip of events — under a cursor that can be dragged (a range input, so the keyboard
// moves it too), with [재생] at the left end and the cursor's date in Mono.
import { useEffect, useRef } from 'react';
import {
  densityStrip,
  shortTime,
  stepCursor,
  timeScale,
  timeTicks,
  type Domain,
} from './layout.ts';

export function Timeline({
  domain,
  width,
  times,
  cursor,
  onCursor,
  playing,
  onPlaying,
  offset = 0,
}: {
  domain: Domain;
  /** Width of the time area (px), the same as the chart's. */
  width: number;
  /** Event times (ms) for the density strip. */
  times: readonly number[];
  cursor: number;
  onCursor: (t: number) => void;
  playing: boolean;
  onPlaying: (playing: boolean) => void;
  /** Left offset of the time area (the row name column). */
  offset?: number;
}) {
  const x = timeScale(domain, width);
  const buckets = Math.max(8, Math.floor(width / 6));
  const density = densityStrip(times, domain, buckets);
  const peak = Math.max(1, ...density);
  const latest = useRef(cursor);
  latest.current = cursor;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const next = stepCursor(latest.current, domain);
      onCursor(next);
      if (next >= domain.end) onPlaying(false);
    }, 120);
    return () => clearInterval(timer);
  }, [playing, domain, onCursor, onPlaying]);
  const span = Math.max(1, domain.end - domain.start);
  return (
    <div className="chart-timeline">
      <div className="chart-timeline-head" style={{ width: offset }}>
        <button
          type="button"
          className="chart-play"
          aria-pressed={playing}
          onClick={() => {
            if (!playing && cursor >= domain.end) onCursor(domain.start);
            onPlaying(!playing);
          }}
        >
          {playing ? '멈춤' : '재생'}
        </button>
        <span className="chart-cursor-date" aria-live="polite">
          {shortTime(cursor)}
        </span>
      </div>
      <div className="chart-timeline-axis" style={{ width }}>
        <svg width={width} height={30} style={{ width, height: 30 }} aria-hidden="true">
          {timeTicks(domain).map((tick) => (
            <g key={tick.t}>
              <line className="chart-tick" x1={x(tick.t)} x2={x(tick.t)} y1={0} y2={6} />
              <text className="chart-tick-label" x={x(tick.t) + 3} y={11}>
                {tick.label}
              </text>
            </g>
          ))}
          {density.map((count, index) =>
            count ? (
              <rect
                key={index}
                className="chart-density"
                x={x(domain.start + (span * index) / buckets)}
                width={Math.max(1, width / buckets - 1)}
                y={28 - (count / peak) * 12}
                height={(count / peak) * 12}
              />
            ) : null,
          )}
          <line className="chart-cursor-line" x1={x(cursor)} x2={x(cursor)} y1={0} y2={30} />
        </svg>
        <input
          type="range"
          className="chart-cursor"
          aria-label="시간 커서"
          aria-valuetext={shortTime(cursor)}
          min={domain.start}
          max={domain.end}
          step={Math.max(1, Math.round(span / 500))}
          value={Math.min(domain.end, Math.max(domain.start, cursor))}
          onChange={(event) => {
            onPlaying(false);
            onCursor(Number(event.target.value));
          }}
        />
      </div>
    </div>
  );
}
