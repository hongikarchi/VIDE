import { ClaudeCli } from '../../../src/ai/claude-cli.ts';

const provider = new ClaudeCli({ executable: process.env.VIDE_CLAUDE_PATH || 'C:\\Users\\user\\.local\\bin\\claude.exe' });
const controller = new AbortController();
const cancel = process.argv.includes('--cancel');
let timer;
try {
  const result = await provider.run({ goal: cancel ? 'Write a detailed explanation of matrix multiplication.' : 'Reply VIDE_OK only.',
    revision: 1, items: [{ id: 'synthetic', label: 'Synthetic fixture', type: 'text', data: 'No project data is included.' }],
    includedIds: ['synthetic'],
  }, { signal: controller.signal, onProgress: event => {
    console.log(JSON.stringify(event));
    if (cancel && event.state === 'running') timer = setTimeout(() => controller.abort(), 100);
  } });
  console.log(JSON.stringify({ state: 'succeeded', exactReply: result.text.trim() === 'VIDE_OK', usage: result.usage }));
} catch (error) {
  console.log(JSON.stringify({ state: 'error', code: error.code }));
  process.exitCode = cancel && error.code === 'CANCELLED' ? 0 : 1;
} finally { clearTimeout(timer); }
