// Usage: npm run locate -- "개발 요청 문장" [--files 5] [--lines 3] [--json]
// Suggests which files and line ranges to edit. Suggestions only: verify before editing.
import { loadLocalEnv } from './jev.mjs';
import { buildIndex } from './index.mjs';
import { rankFiles, locateLines } from './core.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const json = args.includes('--json');
const request = args
  .filter((a, i) => !a.startsWith('--') && !['--files', '--lines'].includes(args[i - 1]))
  .join(' ')
  .trim();
if (!request) {
  console.error('Usage: npm run locate -- "개발 요청" [--files 5] [--lines 3] [--json]');
  process.exit(2);
}
const config = loadLocalEnv();
if (!config.key) {
  console.error(
    'TYPESAFE_API_KEY가 .env에 없습니다. 저장소 루트 .env에 TYPESAFE_API_KEY=... 한 줄을 넣으세요(Git 무시 파일).',
  );
  process.exit(2);
}
const started = performance.now();
const index = buildIndex();
const { ranked, usage, bestConfidence } = await rankFiles(config, request, index);
const fileCount = flag('--files', 5),
  lineFiles = flag('--lines', 3);
const top = ranked.slice(0, fileCount);
const detailed = await Promise.all(
  top
    .slice(0, lineFiles)
    .map(async (file) => ({ ...file, lines: await locateLines(config, request, file.path) })),
);
const result = {
  request,
  model: config.model,
  files: [...detailed, ...top.slice(lineFiles)],
  indexedFiles: index.length,
  confidence: bestConfidence,
  inputTokens: usage.input_tokens + detailed.reduce((s, f) => s + (f.lines?.tokens ?? 0), 0),
  jevCalls: usage.calls + detailed.length,
  totalMs: Math.round(performance.now() - started),
};
if (json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`요청: ${request}`);
  console.log(
    `파일 ${index.length}개 색인 · Jev 호출 ${result.jevCalls}회 · 입력 ${result.inputTokens} 토큰 · ${result.totalMs} ms`,
  );
  for (const [rank, file] of result.files.entries()) {
    console.log(
      `\n${rank + 1}. ${file.path}  (순위 점수 ${file.score.toFixed(2)} · 수정 필요 판정 ${file.fits.toFixed(2)})`,
    );
    if (file.lines)
      for (const range of file.lines.ranges)
        console.log(
          `    ${range.id}  ${range.probability.toFixed(2)}${file.lines.present < 0.35 ? '  (이 파일에 수정 위치가 없을 수 있음)' : ''}`,
        );
  }
  console.log('\n제안일 뿐입니다. 편집 전에 해당 위치를 직접 확인하세요.');
}
