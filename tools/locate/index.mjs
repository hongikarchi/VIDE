// Repository index for the locator: tracked source/doc files with short, deterministic summaries.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const INCLUDE = /\.(ts|tsx|mjs|js|cs|css|md|ps1|py)$|(^|\/)package\.json$|^src\/.*\.html$/;
const EXCLUDE =
  /(^|\/)node_modules\/|^tests\/fixtures\/|^tools\/spikes\/|^tools\/mockups\/|\.d\.ts$|^dist\//;
const CACHE = '.vide/locate/index.json';

export function candidateFiles(listing) {
  return listing.filter((entry) => INCLUDE.test(entry.path) && !EXCLUDE.test(entry.path));
}

function trackedFiles() {
  // `git ls-files -s` gives the blob hash, used as the cache key for summaries.
  return execFileSync('git', ['ls-files', '-s', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split('\t');
      return { path, blob: meta.split(' ')[1] };
    });
}

const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

/** Short summary from what the file itself declares: header comment, title/headings, exported names. */
export function summarize(path, text) {
  const parts = [];
  if (path.endsWith('.html')) {
    const title = text.match(/<title>([^<]+)<\/title>/i)?.[1];
    if (title) parts.push(title.trim());
    const ids = [...text.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]);
    if (ids.length) parts.push('elements: ' + [...new Set(ids)].slice(0, 40).join(', '));
  } else if (path.endsWith('.md')) {
    // Title only from the leading front matter, never from YAML examples inside the body.
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
    const title = front.match(/^title:\s*(.+)$/m)?.[1] ?? text.match(/^#\s+(.+)$/m)?.[1];
    if (title) parts.push(title.trim());
    const headings = [...text.matchAll(/^##\s+(.+)$/gm)].slice(0, 8).map((m) => m[1].trim());
    if (headings.length) parts.push('sections: ' + headings.join('; '));
  } else {
    // First explanatory comment within the opening lines (after imports/usings).
    const head = text.split('\n').slice(0, 60).join('\n');
    const header = head.match(/(?:^[ \t]*\/\/[^\n]*\n?)+|\/\*\*?[\s\S]*?\*\//m)?.[0];
    if (header)
      parts.push(
        header
          .replace(/\/\*\*?|\*\/|^\s*\/\/|^\s*\*/gm, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 160),
      );
    const names = new Set();
    for (const m of text.matchAll(
      /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type|enum)\s+([A-Za-z_]\w*)/g,
    ))
      names.add(m[1]);
    for (const m of text.matchAll(
      /(?:public|internal)\s+(?:sealed\s+|static\s+)*class\s+([A-Za-z_]\w*)/g,
    ))
      names.add(m[1]);
    for (const m of text.matchAll(/\btest\(\s*'([^']{3,80})'/g))
      if (names.size < 14) names.add(`test: ${m[1]}`);
    for (const m of text.matchAll(/CommandMethod\("([^"]+)"|EnglishName\s*=>\s*"([^"]+)"/g))
      names.add('command ' + (m[1] || m[2]));
    for (const m of text.matchAll(/url\.pathname === '([^']+)'/g))
      if (names.size < 20) names.add('route ' + m[1]);
    // Function and method names carry most of the meaning in code files.
    const functions = new Set();
    for (const m of text.matchAll(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)/gm))
      functions.add(m[1]);
    for (const m of text.matchAll(
      /^\s*(?:public|internal|private|protected)\s+(?:static\s+|override\s+|async\s+)*[\w<>[\],.?]+\s+([A-Z]\w*)\s*\(/gm,
    ))
      functions.add(m[1]);
    for (const name of names) functions.delete(name);
    if (names.size) parts.push('defines: ' + [...names].slice(0, 20).join(', '));
    if (functions.size) parts.push('functions: ' + [...functions].slice(0, 24).join(', '));
  }
  return clip(parts.join(' | ') || 'no summary', 480);
}

/** Load or refresh the cached index. Summaries are recomputed only for changed blobs. */
export function buildIndex({ cache = CACHE } = {}) {
  const previous = existsSync(cache) ? JSON.parse(readFileSync(cache, 'utf8')) : {};
  const next = {};
  const files = candidateFiles(trackedFiles());
  for (const { path, blob } of files) {
    const cached = previous[path];
    if (cached && cached.blob === blob) next[path] = cached;
    else {
      let text = '';
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      next[path] = { blob, summary: summarize(path, text), lines: text.split('\n').length };
    }
  }
  mkdirSync(dirname(cache), { recursive: true });
  writeFileSync(cache, JSON.stringify(next));
  return Object.entries(next).map(([path, value]) => ({ path, ...value }));
}
