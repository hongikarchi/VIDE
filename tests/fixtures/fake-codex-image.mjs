// A fake `codex` for the reference image job (SPEC-09.7, T-090 (c)): run as
// `node fake-codex-image.mjs exec --json …`. FAKE_CODEX_IMAGE_MODE picks what it does:
// ok (writes a PNG under FAKE_CODEX_GENERATED/<thread>/ and completes), hang (never ends),
// login (a failed turn: not logged in), nofile (completes without a picture), limit (usage limit),
// refused (the image tool refuses the request).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const mode = process.env.FAKE_CODEX_IMAGE_MODE ?? 'ok';
const thread = randomUUID();
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const args = process.argv.slice(2);
if (args[0] !== 'exec' || !args.includes('--enable') || !args.includes('image_generation')) {
  process.stderr.write('unexpected arguments');
  process.exit(2);
}
let prompt = '';
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
  emit({ type: 'thread.started', thread_id: thread });
  emit({ type: 'turn.started' });
  if (mode === 'hang') {
    // A partial picture that must never be used.
    const folder = join(process.env.FAKE_CODEX_GENERATED, thread);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'partial.png'), Buffer.from([137, 80, 78, 71]));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'login') {
    emit({ type: 'turn.failed', error: { message: 'Not logged in. Run codex login.' } });
    process.exit(1);
  }
  if (mode === 'refused') {
    emit({
      type: 'turn.failed',
      error: { message: 'Your request was rejected by the safety system (content policy).' },
    });
    process.exit(1);
  }
  if (mode === 'limit') {
    emit({ type: 'turn.failed', error: { message: "You've hit your usage limit." } });
    process.exit(1);
  }
  if (mode === 'ok') {
    const folder = join(process.env.FAKE_CODEX_GENERATED, thread);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, 'exec-1.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
  }
  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
});
