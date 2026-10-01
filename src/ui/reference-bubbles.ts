// Bubble placement on the 이해 확인 board (SPEC-09.4·09.5): each region's bubble sits near its
// anchor without covering another bubble or leaving the figure. Greedy: bubbles are placed from
// top to bottom; each takes the first spot of a ring of candidates around its anchor (nearest
// first) that covers no other bubble and no anchor, or, with none free, the one that covers least.

export interface BubbleInput {
  letter: string;
  /** The anchor in figure pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface BubblePlace {
  letter: string;
  left: number;
  top: number;
  width: number;
  height: number;
}
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));

export function placeBubbles(
  bubbles: readonly BubbleInput[],
  area: { width: number; height: number },
  gap = 14,
): BubblePlace[] {
  const placed: BubblePlace[] = [];
  const clampBox = (box: Box): Box => ({
    ...box,
    left: Math.min(Math.max(0, area.width - box.width), Math.max(0, box.left)),
    top: Math.min(Math.max(0, area.height - box.height), Math.max(0, box.top)),
  });
  // Every anchor point (with a little room) is kept clear: the leader must be seen to land.
  const anchors: Box[] = bubbles.map((entry) => ({
    left: entry.x - 10,
    top: entry.y - 10,
    width: 20,
    height: 20,
  }));
  const order = [...bubbles].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const bubble of order) {
    const { width, height } = bubble;
    const candidates: Box[] = [];
    // Rings of positions around the anchor: above, below, left, right and the corners, farther
    // out each ring.
    for (let ring = 0; ring < 8; ring++) {
      const d = gap + ring * (Math.max(height, 24) * 0.6 + 6);
      const offsets: [number, number][] = [
        [-width / 2, -height - d],
        [-width / 2, d],
        [d, -height / 2],
        [-width - d, -height / 2],
        [d * 0.7, -height - d * 0.7],
        [-width - d * 0.7, -height - d * 0.7],
        [d * 0.7, d * 0.7],
        [-width - d * 0.7, d * 0.7],
      ];
      for (const [dx, dy] of offsets)
        candidates.push(clampBox({ left: bubble.x + dx, top: bubble.y + dy, width, height }));
    }
    const cost = (box: Box) =>
      placed.reduce((sum, other) => sum + overlap(box, other), 0) +
      anchors.reduce((sum, other) => sum + overlap(box, other), 0);
    let best = candidates.find((box) => cost(box) === 0);
    if (!best) best = candidates.reduce((a, b) => (cost(b) < cost(a) ? b : a));
    placed.push({ letter: bubble.letter, ...best });
  }
  const byLetter = new Map(placed.map((place) => [place.letter, place]));
  return bubbles.map((bubble) => byLetter.get(bubble.letter)!);
}

/** The point of a bubble's edge nearest to its anchor (where the leader line ends). */
export function leaderEnd(place: Box, x: number, y: number): [number, number] {
  return [
    Math.min(place.left + place.width, Math.max(place.left, x)),
    Math.min(place.top + place.height, Math.max(place.top, y)),
  ];
}
