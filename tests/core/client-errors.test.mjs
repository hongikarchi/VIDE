import test from 'node:test';
import assert from 'node:assert/strict';
import { clientError, pageBuild, reportClientErrors } from '../../src/ui/client-errors.ts';

const page = () => {
  const target = new EventTarget();
  target.location = { pathname: '/', search: '?project=p1', hash: '#secret-token' };
  target.document = {
    querySelector: () => ({ src: 'http://127.0.0.1:4/assets/index-Ab12.js?v=1' }),
  };
  return target;
};
const errorEvent = (fields) => Object.assign(new Event('error'), fields);
const rejection = (reason) => Object.assign(new Event('unhandledrejection'), { reason });

test('an error event becomes message, stack, script, line, column, route and build only', async () => {
  const target = page(),
    sent = [];
  const stop = reportClientErrors(target, async (report) => sent.push(report));
  const error = new TypeError('x is undefined');
  target.dispatchEvent(
    errorEvent({
      message: 'Uncaught TypeError: x is undefined',
      error,
      filename: 'http://127.0.0.1:4/assets/index-Ab12.js?token=abc#frag',
      lineno: 12,
      colno: 34,
    }),
  );
  stop();
  assert.equal(sent.length, 1);
  const [report] = sent;
  assert.deepEqual(Object.keys(report).sort(), [
    'column',
    'kind',
    'line',
    'message',
    'route',
    'source',
    'stack',
    'version',
  ]);
  assert.equal(report.kind, 'error');
  assert.equal(report.message, 'TypeError: x is undefined');
  assert.equal(report.source, 'http://127.0.0.1:4/assets/index-Ab12.js');
  assert.equal(report.line, 12);
  assert.equal(report.column, 34);
  // Never the query or hash (the connect token rides in the hash).
  assert.equal(report.route, '/');
  assert.equal(report.version, 'index-Ab12.js');
  assert.ok(!JSON.stringify(report).includes('secret-token'));
});

test('rejections are sent, repeats and floods are not, and a failing send stays quiet', async () => {
  const target = page(),
    sent = [];
  let t = 0;
  const stop = reportClientErrors(
    target,
    async (report) => {
      sent.push(report);
      throw new Error('offline');
    },
    () => t,
  );
  target.dispatchEvent(rejection(new Error('load failed')));
  target.dispatchEvent(rejection(new Error('load failed')));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'rejection');
  for (let i = 0; i < 30; i++) target.dispatchEvent(rejection(new Error('e' + i)));
  assert.equal(sent.length, 10);
  t = 61_000;
  target.dispatchEvent(rejection(new Error('load failed')));
  assert.equal(sent.length, 11);
  stop();
  target.dispatchEvent(rejection(new Error('after stop')));
  assert.equal(sent.length, 11);
  await new Promise((resolve) => setImmediate(resolve));
});

test('an error raised while reporting is not reported again (no loop)', () => {
  const target = page();
  let calls = 0;
  const stop = reportClientErrors(target, () => {
    calls++;
    // An error event fired from inside the report is dropped.
    target.dispatchEvent(errorEvent({ message: 'inner', error: new Error('inner') }));
    throw new Error('sync failure');
  });
  target.dispatchEvent(errorEvent({ message: 'outer', error: new Error('outer') }));
  stop();
  assert.equal(calls, 1);
});

test('opaque cross-origin errors and empty reasons send nothing; plain reasons are named', () => {
  assert.equal(clientError({ type: 'error', message: 'Script error.' }, '/'), undefined);
  assert.equal(clientError({ type: 'unhandledrejection', reason: undefined }, '/'), undefined);
  assert.equal(clientError({ type: 'unhandledrejection', reason: 'boom' }, '/').message, 'boom');
  assert.equal(
    clientError({ type: 'unhandledrejection', reason: { code: 'X' } }, '/').message,
    '[object Object]',
  );
  assert.equal(pageBuild({ querySelector: () => null }), undefined);
});
