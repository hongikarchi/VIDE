import { createProvider } from '../../../src/ai/providers.mjs';
import { spawn } from 'node:child_process';
const executable = process.env.VIDE_CODEX_PATH;
if (!executable) throw new Error('Set VIDE_CODEX_PATH to the installed official Codex executable.');
const provider = createProvider({ provider: 'codex-cli', executable, spawnProcess: (...args) => {
  const child = spawn(...args);
  if (process.argv.includes('--trace-types') && args[1][0] === 'exec') {
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8'); let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try { const event = JSON.parse(line); console.log(JSON.stringify({ eventType: event.type, itemType: event.item?.type })); } catch {}
      }
    });
  }
  return child;
} });
const controller = new AbortController(), cancel = process.argv.includes('--cancel');
let timer;
try {
  console.log(JSON.stringify(await provider.status()));
  if (!process.argv.includes('--status-only')) {
    const result = await provider.run({ goal: cancel ? 'Explain matrix multiplication in detail.' : 'Reply VIDE_OK only.', revision: 1,
      items: [{ id: 'synthetic', type: 'text', label: 'Synthetic', data: 'No project data.' }], includedIds: ['synthetic'],
    }, { signal: controller.signal, onProgress: event => {
      console.log(JSON.stringify(event));
      if (cancel && event.state === 'running') timer = setTimeout(() => controller.abort(), 100);
    } });
    console.log(JSON.stringify({ exactReply: result.text.trim() === 'VIDE_OK', usage: result.usage }));
  }
} catch (error) { console.log(JSON.stringify({ code: error.code })); process.exitCode = cancel && error.code === 'CANCELLED' ? 0 : 1; }
finally { clearTimeout(timer); }
