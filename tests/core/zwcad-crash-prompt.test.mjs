import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import {
  DISMISSED_NOTE,
  isNoButton,
  launchHiddenZwcad,
  watchCrashPrompt,
} from '../../hosts/zwcad/crash-prompt.ts';

const OWNED = 4100,
  USER = 22796;
const dialog = (hwnd, pid, buttons, className = '#32770') => ({
  hwnd,
  pid,
  className,
  buttons: buttons.map(([id, text]) => ({ hwnd: id, text })),
});

/** A fake window list; a clicked dialog disappears like the real modal. */
function fakeAccess(windows) {
  const calls = { scans: [], clicks: [], closed: 0 };
  let list = [...windows];
  return {
    calls,
    access: () => ({
      async scan(pid) {
        calls.scans.push(pid);
        // The real helper already filters by PID; the fake returns everything to prove the
        // watcher's own guard.
        return list;
      },
      async click(button, pid) {
        calls.clicks.push([button, pid]);
        const owner = list.find((w) => w.buttons.some((b) => b.hwnd === button));
        if (!owner || owner.pid !== pid) return false;
        list = list.filter((w) => w !== owner);
        return true;
      },
      close() {
        calls.closed++;
      },
    }),
  };
}
const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
};

test('isNoButton accepts the Korean No labels with mnemonics only', () => {
  for (const text of ['아니오', '아니오(&N)', '&아니오', ' 아니요(N) '])
    assert.ok(isNoButton(text));
  for (const text of ['예', 'No', '취소', '아니오 보내기', '']) assert.ok(!isNoButton(text));
});

test('the watcher clicks 아니오 only in dialogs of the owned PID and logs once', async () => {
  const { access, calls } = fakeAccess([
    dialog('10', USER, [
      ['11', '예'],
      ['12', '아니오'],
    ]),
    dialog('20', OWNED, [
      ['21', '예'],
      ['22', '아니오'],
    ]),
    dialog('30', OWNED, [['31', '아니오']], 'ZwMainFrame'),
  ]);
  const logs = [];
  const { now, sleep } = clock();
  const watch = watchCrashPrompt(OWNED, {
    access,
    now,
    sleep,
    durationMs: 5000,
    log: (fields) => logs.push(fields),
  });
  assert.equal(await watch.done, 1);
  assert.deepEqual(calls.clicks, [['22', OWNED]]);
  assert.ok(calls.scans.every((pid) => pid === OWNED));
  assert.deepEqual(logs, [{ pid: OWNED, note: DISMISSED_NOTE }]);
  assert.equal(calls.closed, 1);
});

test('the watcher stops at its deadline and on stop()', async () => {
  const empty = fakeAccess([]);
  const { now, sleep } = clock();
  assert.equal(
    await watchCrashPrompt(OWNED, {
      access: empty.access,
      now,
      sleep,
      intervalMs: 500,
      durationMs: 3000,
    }).done,
    0,
  );
  assert.equal(empty.calls.scans.length, 6);
  assert.equal(empty.calls.closed, 1);

  const stopped = fakeAccess([]);
  let watch;
  watch = watchCrashPrompt(OWNED, {
    access: stopped.access,
    durationMs: 60_000,
    sleep: async () => watch.stop(),
  });
  assert.equal(await watch.done, 0);
  assert.equal(stopped.calls.scans.length, 1);
});

test('a failing helper ends the watch quietly', async () => {
  let closed = 0;
  const watch = watchCrashPrompt(OWNED, {
    access: () => ({
      scan: async () => {
        throw new Error('HELPER_ENDED');
      },
      click: async () => false,
      close: () => closed++,
    }),
  });
  assert.equal(await watch.done, 0);
  assert.equal(closed, 1);
});

test('launchHiddenZwcad watches only hidden launches and ends the watch on settle/stop', async () => {
  const executable = resolve('synthetic-zwcad.exe');
  const launch = (visible) => {
    const child = new EventEmitter();
    child.pid = OWNED;
    child.kill = () => {
      queueMicrotask(() => child.emit('exit', 0));
      return true;
    };
    return {
      executable,
      visible,
      spawnProcess: () => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
      inspect: async (pid) => ({ pid, startTicks: '1', executable, listeners: [] }),
    };
  };
  const watched = [];
  const watch = (pid) => {
    const entry = { pid, stops: 0 };
    watched.push(entry);
    return { stop: () => entry.stops++, done: Promise.resolve(0) };
  };
  const hidden = await launchHiddenZwcad(launch(false), watch);
  assert.deepEqual(
    watched.map((w) => w.pid),
    [OWNED],
  );
  hidden.settled();
  await hidden.stop();
  assert.equal(watched[0].stops, 2);
  const visible = await launchHiddenZwcad(launch(true), watch);
  assert.equal(watched.length, 1);
  await visible.stop();
});

test(
  'the Windows helper answers a real No prompt in the watched process only',
  { skip: process.platform !== 'win32' && 'Windows only' },
  async () => {
    // A YesNo message box (#32770, 아니요) in a PowerShell this test starts stands in for the
    // ZWCAD prompt; the real ZWCAD path was verified in SPIKE-2026-10-07-drawing-export.
    const box = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Add-Type -AssemblyName System.Windows.Forms; [Console]::Out.WriteLine([System.Windows.Forms.MessageBox]::Show('VIDE crash prompt test','VIDE test','YesNo'))",
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    box.stdout.on('data', (data) => (out += data));
    const exited = new Promise((accept) => box.once('exit', accept));
    const logs = [];
    const watch = watchCrashPrompt(box.pid, {
      durationMs: 30_000,
      log: (fields) => logs.push(fields),
    });
    try {
      await Promise.race([exited, watch.done]);
      await Promise.race([exited, new Promise((accept) => setTimeout(accept, 5000))]);
    } finally {
      watch.stop();
      if (box.exitCode === null) box.kill();
    }
    assert.equal(await watch.done, 1);
    assert.equal(out.trim(), 'No');
    assert.deepEqual(logs, [{ pid: box.pid, note: DISMISSED_NOTE }]);
  },
);
