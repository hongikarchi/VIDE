import test from 'node:test';
import assert from 'node:assert/strict';
import { leaderEnd, overlap, placeBubbles } from '../../src/ui/reference-bubbles.ts';

// Bubble placement on the 이해 확인 board (SPEC-09.5, T-090 (b)): near the anchor, inside the
// figure, never covering another bubble when there is room.
const area = { width: 640, height: 448 };
const bubble = (letter, x, y, width = 180, height = 52) => ({ letter, x, y, width, height });

test('bubbles of crowded anchors do not overlap and stay in the figure', () => {
  const cases = [
    [bubble('A', 320, 220), bubble('B', 330, 230), bubble('C', 340, 215)],
    [bubble('A', 10, 10), bubble('B', 630, 440), bubble('C', 320, 224), bubble('D', 20, 430)],
    Array.from({ length: 6 }, (_, i) =>
      bubble(String.fromCharCode(65 + i), 300 + i * 8, 200 + i * 6, 150, 44),
    ),
  ];
  for (const bubbles of cases) {
    const places = placeBubbles(bubbles, area);
    assert.deepEqual(
      places.map((place) => place.letter),
      bubbles.map((entry) => entry.letter),
      'one place per bubble, in order',
    );
    for (const place of places) {
      assert.ok(place.left >= 0 && place.top >= 0);
      assert.ok(place.left + place.width <= area.width + 0.001);
      assert.ok(place.top + place.height <= area.height + 0.001);
    }
    for (let i = 0; i < places.length; i++)
      for (let j = i + 1; j < places.length; j++)
        assert.equal(overlap(places[i], places[j]), 0, `${places[i].letter}/${places[j].letter}`);
  }
});

test('a single bubble sits next to its anchor and the leader ends on its edge', () => {
  const [place] = placeBubbles([bubble('A', 320, 300)], area);
  // Above the anchor first.
  assert.ok(place.top + place.height <= 300);
  assert.ok(Math.abs(place.left + place.width / 2 - 320) < 1);
  const [x, y] = leaderEnd(place, 320, 300);
  assert.equal(x, 320);
  assert.equal(y, place.top + place.height);
});
