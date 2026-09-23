import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../../src/server/report.ts';
test('portable report escapes input and labels geometric quantities without claiming floor area', () => {
  const request = {
    id: 'request',
    createdAt: '2026-09-20',
    input: { body: '<script>alert(1)</script>' },
    result: {
      hostExecuted: true,
      verified: true,
      text: 'result',
      objects: [{ id: 'a', name: '<img onerror=evil>' }],
      scene: [{ id: 'a', nativeId: 'guid', area: 376, volume: 480 }],
    },
  };
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const html = renderReport({ name: 'A & B' }, request, image);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('376.000'));
  assert.ok(html.includes('표면적'));
  assert.throws(() => renderReport({ name: 'A' }, request, 'javascript:evil'), {
    code: 'INVALID_INPUT',
  });
});
