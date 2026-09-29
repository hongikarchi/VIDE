// Jev-based locator: which files and which parts to change for a development request.
// Follows TypeSafe's skill-suggestion (rank → verify) and line-by-line search recipes.
import { readFileSync } from 'node:fs';
import { systemOne, choice, noul } from './jev.mjs';

export const MAX_OPTIONS = 255;
const CONTEXT =
  'Repository: VIDE — AI design workspace for architects. TypeScript/React/Vite web UI (src/ui), ' +
  'Node server (src/server, src/core, src/ai, src/contracts), Rhino and ZWCAD C# plugins (hosts/*), ' +
  'tests (tests/*), product docs in Korean (docs/*, Design.md, AI.md).';

/** Split items into chunks of at most `size` while keeping sorted neighbours (same folder) together. */
export function chunk(items, size = 200) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Line blocks for line-level search: start at structural lines, 6–60 lines each, ≤ MAX_OPTIONS. */
export function lineBlocks(text, { min = 6, max = 60 } = {}) {
  const lines = text.split('\n');
  const starts = [0];
  const boundary =
    /^\s*(export\s|function\s|async\s+function|class\s|interface\s|type\s|const\s+\w+\s*=\s*(async\s*)?\(|(public|private|internal|protected)\s[^=;]*\(|#{1,3}\s|test\(|describe\(|\$\(|\.[\w-]+\s*\{|[\w.#-]+\s*\{)/;
  for (let i = 1; i < lines.length; i++) {
    const since = i - starts.at(-1);
    if ((since >= min && boundary.test(lines[i])) || since >= max) starts.push(i);
  }
  let blocks = starts.map((start, index) => [
    start + 1,
    index + 1 < starts.length ? starts[index + 1] : lines.length,
  ]);
  // Merge neighbours until the Choice option limit fits.
  while (blocks.length > MAX_OPTIONS - 5) {
    const merged = [];
    for (let i = 0; i < blocks.length; i += 2)
      merged.push(i + 1 < blocks.length ? [blocks[i][0], blocks[i + 1][1]] : blocks[i]);
    blocks = merged;
  }
  return blocks.map(([from, to]) => ({ id: `L${from}-L${to}`, from, to }));
}

const numbered = (text, from = 1) =>
  text
    .split('\n')
    .map((line, index) => `L${from + index}| ${line}`)
    .join('\n');

/** Stage 1+2: rank files. Returns [{path, fits, probability}] sorted by fit. */
export async function rankFiles(config, request, index, { perChunk = 6, verify = 16 } = {}) {
  const usage = { input_tokens: 0, calls: 0, ms: [] };
  const track = (result) => {
    usage.input_tokens += result.usage?.input_tokens ?? 0;
    usage.calls++;
    usage.ms.push(result.ms);
    return result;
  };
  const files = [...index].sort((a, b) => a.path.localeCompare(b.path));
  const state = `${CONTEXT}\n\nDevelopment request:\n${request}`;
  // Stage 1: rank every file by short summary, chunks in parallel.
  const stage1 = await Promise.all(
    chunk(files).map(async (group) => {
      const criteria = Object.fromEntries(
        group.map((file, i) => [`f${i}`, `${file.path} — ${file.summary}`]),
      );
      const result = track(
        await systemOne(config, state, {
          file: choice(
            'Which file most likely needs to be edited to implement the development request?',
            criteria,
          ),
        }),
      );
      const probabilities = result.answers.file?.probabilities ?? {};
      return Object.entries(probabilities)
        .sort((a, b) => b[1] - a[1])
        .slice(0, perChunk)
        .map(([id, p]) => ({ ...group[Number(id.slice(1))], stage1: p }));
    }),
  );
  const shortlist = stage1
    .flat()
    .sort((a, b) => b.stage1 - a.stage1)
    .slice(0, verify);
  // Stage 2: verify the shortlist with fuller context; one Noul per candidate plus a Choice.
  const questions = {
    best: choice(
      'Which file is the primary place to edit for this development request?',
      Object.fromEntries(shortlist.map((file, i) => [`c${i}`, `${file.path} — ${file.summary}`])),
    ),
  };
  shortlist.forEach((file, i) => {
    questions[`n${i}`] = noul(
      `Would implementing the development request require editing the file ${file.path} (${file.summary})?`,
      'Yes, this file must change to implement the request',
      'No, this file is unrelated or only indirectly related',
    );
  });
  const result = track(await systemOne(config, state, questions));
  const best = result.answers.best?.probabilities ?? {};
  const ranked = shortlist
    .map((file, i) => ({
      path: file.path,
      fits: result.answers[`n${i}`]?.noul ?? 0,
      probability: best[`c${i}`] ?? 0,
      stage1: file.stage1,
      score: (best[`c${i}`] ?? 0) + file.stage1,
    }))
    // Measured 2026-09-29 (SPIKE-2026-09-29-jev-locate): stage-2 probability + stage-1 probability
    // ranked best across English and Korean requests; the per-file Noul is shown but not used to sort.
    .sort((a, b) => b.score - a.score);
  return { ranked, usage, bestConfidence: result.answers.best?.confidence ?? null };
}

/** Stage 3: line blocks in one file. Large files are windowed (state ≤ ~60k chars). */
export async function locateLines(config, request, path, { top = 3, windowChars = 60000 } = {}) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const windows = [];
  for (let start = 0; start < lines.length; ) {
    let end = start,
      size = 0;
    while (end < lines.length && size + lines[end].length + 8 < windowChars)
      size += lines[end++].length + 8;
    if (end === start) end = start + 1;
    windows.push([start, end]);
    start = end;
  }
  const results = await Promise.all(
    windows.map(async ([start, end]) => {
      const part = lines.slice(start, end).join('\n');
      const blocks = lineBlocks(part).map((block) => ({
        ...block,
        from: block.from + start,
        to: block.to + start,
        id: `L${block.from + start}-L${block.to + start}`,
      }));
      const result = await systemOne(
        config,
        `Development request: ${request}\n\nFile ${path}:\n${numbered(part, start + 1)}`,
        {
          where: choice(
            'Which line range contains the code or text that must be edited to implement the development request?',
            Object.fromEntries(blocks.map((block) => [block.id, null])),
          ),
          present: noul(
            'Does this excerpt contain a place that must be edited to implement the development request?',
            'At least one line range here must change',
            'Nothing here needs to change',
          ),
        },
      );
      const probabilities = result.answers.where?.probabilities ?? {};
      return {
        present: result.answers.present?.noul ?? 0,
        tokens: result.usage?.input_tokens ?? 0,
        ms: result.ms,
        ranges: Object.entries(probabilities)
          .sort((a, b) => b[1] - a[1])
          .slice(0, top)
          .map(([id, p]) => ({ id, probability: p })),
      };
    }),
  );
  results.sort((a, b) => b.present - a.present);
  return {
    present: results[0]?.present ?? 0,
    ranges: results[0]?.ranges ?? [],
    tokens: results.reduce((sum, r) => sum + r.tokens, 0),
    ms: Math.max(...results.map((r) => r.ms)),
  };
}
