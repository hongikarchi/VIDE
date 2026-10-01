#!/usr/bin/env node
// md -> html renderer for the VIDE planning documents.
//   node tools/docs/build.mjs            build every document + index.html into human/
//   node tools/docs/build.mjs --check    render in memory only; exit 1 on broken links / front matter
//   node tools/docs/build.mjs --watch    rebuild on change
//   node tools/docs/build.mjs --quiet    print only the paths that changed
// Rules live in AI.md §4 (md is the only source; human/ is generated, git-ignored, never hand-edited).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const WATCH = args.has('--watch');
const QUIET = args.has('--quiet');

const cfg = JSON.parse(fs.readFileSync(path.join(here, 'docs.config.json'), 'utf8'));
const asset = (name) => fs.readFileSync(path.join(here, name), 'utf8');
const md = new MarkdownIt({ html: true, linkify: false, typographer: false });
const esc = md.utils.escapeHtml;
const posix = (p) => p.split(path.sep).join('/');
// Every generated file lives under this one folder, mirroring the source path (docs/plans/PLAN.md -> human/docs/plans/PLAN.html).
const OUT = cfg.outDir || 'human';
const outPath = (src) => `${OUT}/${src.replace(/\.md$/i, '.html')}`;
const INDEX_OUT = `${OUT}/${cfg.index}`;
// Repo files under these folders are copied next to the html so human/ is self-contained (images, json evidence).
const COPY_DIRS = ['docs/assets/'];
const STATUSES = new Set(['draft', 'review', 'approved', 'superseded']);
const problems = []; // { src, msg } — broken links and bad front matter; fatal under --check
let copies = new Map(); // human/<path> -> repo <path>

// ---------------------------------------------------------------- documents
function slugId(file) {
  return path.basename(file, '.md').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function discoverDocs() {
  const docs = cfg.docs.map((d) => ({ ...d, out: outPath(d.src) }));
  const seen = new Set(docs.map((d) => d.src));
  for (const rule of cfg.discover || []) {
    const dir = path.join(ROOT, rule.dir);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (!/\.md$/i.test(name)) continue;
      const src = posix(path.join(rule.dir, name));
      if (seen.has(src)) continue;
      seen.add(src);
      docs.push({ id: slugId(name), src, out: outPath(src), eyebrow: rule.eyebrow, tableLabel: rule.tableLabel, discovered: true });
    }
  }
  return docs;
}

function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].replace(/\s+#.*$/, '').trim();
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    meta[kv[1]] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}

// ---------------------------------------------------------------- renderer rules
// A relative link in doc.src: .md -> the generated .html (same relative path inside human/);
// docs/assets/** -> copied into human/ (href unchanged); the root index -> human/index.html;
// any other repo file -> a path from the html's place in human/ back to the repo file.
function rewriteTarget(doc, href, kind) {
  if (!href || /^([a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) return href;
  const cut = href.search(/[?#]/);
  const p = cut < 0 ? href : href.slice(0, cut);
  const tail = cut < 0 ? '' : href.slice(cut);
  // Only path-like targets are files: prose such as "[…](SPEC-06.12)" or "(§14.3)" renders as a link but names no file.
  if (!p || !(/\//.test(p) || /\.[a-z][a-z0-9]{0,4}$/i.test(p))) return href;
  let decoded = p;
  try { decoded = decodeURIComponent(p); } catch { /* keep raw */ }
  const target = posix(path.normalize(path.join(path.dirname(doc.src), decoded)));
  const exists = fs.existsSync(path.join(ROOT, target));
  if (/\.md$/i.test(p)) {
    if (!exists) problems.push({ src: doc.src, msg: `${kind} → ${href} (없는 MD)` });
    return p.replace(/\.md$/i, '.html') + tail;
  }
  if (target === cfg.index) return href;
  if (!exists) { problems.push({ src: doc.src, msg: `${kind} → ${href} (없는 파일)` }); return href; }
  if (COPY_DIRS.some((d) => target.startsWith(d))) { copies.set(`${OUT}/${target}`, target); return href; }
  return posix(path.relative(path.dirname(path.join(ROOT, doc.out)), path.join(ROOT, target))) + tail;
}

function makeRenderer(tableLabel, doc) {
  const r = new MarkdownIt({ html: true, linkify: false, typographer: false });
  let tableNo = 0;
  r.renderer.rules.table_open = () => {
    tableNo += 1;
    return `<div aria-label="${esc(tableLabel)} 표 ${tableNo}" class="table-scroll" role="region" tabindex="0"><table>\n`;
  };
  r.renderer.rules.table_close = () => '</table></div>\n';
  r.renderer.rules.fence = (tokens, idx) => {
    const t = tokens[idx];
    const lang = (t.info || '').trim().split(/\s+/)[0] || 'text';
    const label = lang === 'text' ? 'COPYABLE TEXT' : lang.toUpperCase();
    return `<div class="code-frame"><span class="code-label">${esc(label)}</span><button aria-label="이 텍스트 복사" class="copy-code" type="button">복사</button><pre><code class="language-${esc(lang)}">${esc(t.content)}</code></pre></div>\n`;
  };
  const defaultLink = r.renderer.rules.link_open || ((tokens, idx, opts, env, self) => self.renderToken(tokens, idx, opts));
  r.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const href = tokens[idx].attrGet('href') || '';
    tokens[idx].attrSet('href', rewriteTarget(doc, href, 'link'));
    return defaultLink(tokens, idx, opts, env, self);
  };
  const defaultImage = r.renderer.rules.image;
  r.renderer.rules.image = (tokens, idx, opts, env, self) => {
    tokens[idx].attrSet('src', rewriteTarget(doc, tokens[idx].attrGet('src') || '', 'image'));
    return defaultImage(tokens, idx, opts, env, self);
  };
  return r;
}

// ---------------------------------------------------------------- review markup (AI.md §5)
const LABEL_RE = /<strong>\[검토 · ([^·\]]+?) · (R-\d+) · (높음|중간|낮음)\]<\/strong>/g;
function markReviews(html) {
  let n = 0;
  const authors = {};
  html = html.replace(LABEL_RE, (_, agent, rid, sev) => {
    n += 1;
    const name = agent.trim().toLowerCase();
    authors[name] = (authors[name] || 0) + 1;
    return `<strong class="review-label" data-rid="${rid}" data-review-agent="${esc(name)}" id="review-${rid}"><span class="review-agent">${esc(agent.trim())}</span><span class="review-id">${rid}</span><span class="review-sev" data-sev="${sev}">${sev}</span></strong>`;
  });
  html = html.replace(/<blockquote>(\s*<p><strong class="review-label" data-rid="R-\d+" data-review-agent="([^"]+)")/g, '<blockquote class="review" data-review-agent="$2">$1');
  return { html, count: n, authors };
}

// ---------------------------------------------------------------- page assembly
function splitSections(tokens) {
  // top-level walk: h1 -> title, tokens before first h2 -> hero-meta, each h2 -> section
  let title = null, i = 0;
  const hero = [], sections = [];
  const grab = (start) => { // returns [tokens up to next h2 at level 0, nextIndex]
    let j = start;
    while (j < tokens.length && !(tokens[j].type === 'heading_open' && tokens[j].tag === 'h2' && tokens[j].level === 0)) j += 1;
    return [tokens.slice(start, j), j];
  };
  if (tokens[0] && tokens[0].type === 'heading_open' && tokens[0].tag === 'h1') {
    title = tokens[1];
    i = 3;
  }
  let [heroToks, j] = grab(i);
  hero.push(...heroToks);
  while (j < tokens.length) {
    const headingInline = tokens[j + 1];
    const [body, k] = grab(j + 3);
    sections.push({ headingInline, body });
    j = k;
  }
  return { title, hero, sections };
}

function sectionMeta(text, index) {
  const m = /^(\d+)\.\s*(.*)$/.exec(text.trim());
  if (m) return { num: m[1], display: m[1].padStart(2, '0'), title: m[2] };
  return { num: `x${index}`, display: String(index).padStart(2, '0'), title: text.trim() };
}

// AI.md §6: written documents carry a front matter header (AI.md itself is exempt).
function checkFrontMatter(doc, raw, meta) {
  if (doc.src === 'AI.md') return;
  if (!/^---\r?\n/.test(raw)) { problems.push({ src: doc.src, msg: 'front matter 없음 (AI.md §6)' }); return; }
  for (const key of ['id', 'title', 'status']) if (!meta[key]) problems.push({ src: doc.src, msg: `front matter에 ${key} 없음` });
  if (meta.status && !STATUSES.has(String(meta.status))) problems.push({ src: doc.src, msg: `알 수 없는 status: ${meta.status}` });
}

// Index 「MD 수정일」: the document's own `updated:` date, else its last commit date — never the file
// mtime, which differs per checkout and per PC.
function docDate(src, meta) {
  if (meta.updated && /^\d{4}-\d{2}-\d{2}/.test(String(meta.updated))) return String(meta.updated).slice(0, 10);
  const g = spawnSync('git', ['log', '-1', '--format=%cs', '--', src], { cwd: ROOT, encoding: 'utf8' });
  const d = (g.stdout || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '—';
}

function buildDoc(doc, allDocs) {
  const srcPath = path.join(ROOT, doc.src);
  const raw = fs.readFileSync(srcPath, 'utf8');
  const { meta, body } = parseFrontMatter(raw);
  checkFrontMatter(doc, raw, meta);
  const r = makeRenderer(doc.tableLabel || doc.tab || 'DOC', doc);
  const tokens = r.parse(body, {});
  const { title, hero, sections } = splitSections(tokens);
  const renderToks = (toks) => r.renderer.render(toks, r.options, {});

  const titleHtml = markReviews(title ? r.renderer.renderInline(title.children, r.options, {}) : esc(meta.title || doc.tab || doc.id)).html;
  const titleText = (title ? title.content : (meta.title || doc.id)).replace(/<[^>]+>/g, '');
  const heroMarked = markReviews(renderToks(hero));
  const heroHtml = heroMarked.html;
  const label = doc.tab || meta.title || titleText;
  const description = doc.description || meta.description || '';

  let reviewTotal = heroMarked.count;
  const authors = { ...heroMarked.authors };
  const appendices = {};
  const sectionHtml = sections.map((s, idx) => {
    const text = s.headingInline.content;
    const m = sectionMeta(text, idx);
    const id = `${doc.id}-section-${m.num}`;
    const headingInner = r.renderer.renderInline(s.headingInline.children, r.options, {}).replace(/^\d+\.\s*/, '');
    const bodyMarked = markReviews(renderToks(s.body));
    reviewTotal += bodyMarked.count;
    for (const [name, count] of Object.entries(bodyMarked.authors)) authors[name] = (authors[name] || 0) + count;
    const appendix = /^부록 ·\s*(.*?)\s+검토 요약/.exec(text.trim());
    const isAppendix = Boolean(appendix);
    const appendixAgent = appendix ? appendix[1].trim().toLowerCase() : '';
    if (isAppendix) appendices[appendixAgent] = id;
    return `<section class="doc-section${isAppendix ? ' review-appendix' : ''}" id="${id}"${isAppendix ? ` data-review-agent="${esc(appendixAgent)}"` : ''}><h2><span aria-hidden="true" class="section-num">${m.display} /</span> ${markReviews(headingInner).html}</h2>\n${bodyMarked.html}</section>`;
  }).join('');

  const outDir = path.dirname(path.join(ROOT, doc.out));
  const rel = (target) => posix(path.relative(outDir, path.join(ROOT, target))) || '.';
  const tabs = allDocs.filter((d) => d.tab).map((d) => (d.id === doc.id
    ? `<a class="doc-tab active" aria-current="page" data-doc="${d.id}" href="#${d.id}">${esc(d.tab)}</a>`
    : `<a class="doc-tab" href="${esc(rel(d.out))}">${esc(d.tab)}</a>`)).join('');
  const statusPill = meta.status ? `<span class="pill">${esc(String(meta.status).toUpperCase())}${meta.version ? ' · v' + esc(String(meta.version)) : ''}</span>` : '';
  const reviewPill = Object.entries(authors).map(([name, count]) => `<a class="pill review-pill" data-review-agent="${esc(name)}" href="#${appendices[name] || doc.id}" title="${esc(name.toUpperCase())} 검토 요약으로 이동">${esc(name.toUpperCase())} 검토 ${count}건</a>`).join('');
  const legend = reviewTotal ? `<div class="review-legend"><p><span><ins>초록</ins> 추가·교체 제안</span><span><del>빨강</del> 삭제·교체 대상</span><span>CLAUDE: 파란 상자 · CODEX: 보라 상자</span></p><p>검토자 필터는 코멘트·부록만 바꿉니다. ‘인라인 제안 미리보기’는 코멘트의 대안까지 합친 최종본이 아닙니다. 보기 전환은 MD 수정·수락·승인을 하지 않습니다.</p></div>` : '';
  const reviewSelect = reviewTotal ? `<label class="review-select">첨삭 <select id="review-mode" aria-label="첨삭 보기 방식"><option value="marked">표시</option><option value="original">원문만</option><option value="accepted">인라인 제안 미리보기</option></select></label>${Object.keys(authors).length > 1 ? `<label class="review-select">검토자 <select id="review-author" aria-label="검토자 필터"><option value="all">모두</option>${Object.keys(authors).map(name => `<option value="${esc(name)}">${esc(name.toUpperCase())}</option>`).join('')}</select></label>` : ''}` : '';
  const sourceData = { [doc.id]: { label, file: path.basename(doc.src), markdown: raw } };
  const json = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${esc(description || titleText)}"><meta name="generator" content="tools/docs/build.mjs — generated from ${esc(doc.src)}; do not edit"><title>${esc(cfg.siteTitle)} · ${esc(label)}</title><style>
${asset('theme.css')}
${asset('review.css')}</style></head><body>
<!-- GENERATED FILE — source: ${esc(doc.src)} — run: npm --prefix tools/docs run build -->
<a class="skip" href="#reading-main">본문으로 이동</a>
<header class="topbar"><a class="brand" href="${esc(rel(INDEX_OUT))}" aria-label="${esc(cfg.siteTitle)} 문서 모음"><b>V.</b><span>${esc(cfg.brand)}</span></a><nav class="doc-tabs" aria-label="문서 선택">${tabs}</nav><div class="top-actions">${reviewSelect}<button id="source-download" title="현재 문서의 Markdown 원문 저장">원문 ↓</button><button id="print-doc" title="현재 문서 인쇄">인쇄</button></div></header>
<div class="layout"><aside class="toc-shell" id="toc-shell" aria-label="현재 문서의 목차"><div class="toc-title"><strong>CONTENTS</strong><span id="toc-count"></span><button id="toc-toggle" aria-expanded="false" aria-controls="toc-body">목차 열기</button></div><div class="toc-body" id="toc-body"><input class="toc-search" id="toc-search" type="search" placeholder="장 제목으로 찾기" aria-label="현재 문서 목차 검색"><p class="toc-hint" id="nav-hint" role="status">장 제목으로 찾아갑니다.</p><nav class="toc-links" id="toc-links" aria-label="본문 장 이동"></nav><div class="toc-next">다음 작성할 문서<br><b>${esc(cfg.next.title)}</b><br>${esc(cfg.next.desc)}</div></div></aside><main id="reading-main" tabindex="-1"><article id="${doc.id}" class="document"><header class="doc-hero"><div class="hero-label"><span class="eyebrow">${esc(doc.eyebrow || 'DOCUMENT')}</span><span>${statusPill}<span class="pill">${sections.length} CHAPTERS</span>${reviewPill}</span></div><h1 tabindex="-1">${titleHtml}</h1>${description ? `<p class="doc-description">${esc(description)}</p>` : ''}${legend}<div class="hero-meta">
${heroHtml}</div></header>${sectionHtml}<footer class="doc-footer"><span>${esc(cfg.brand)} / PLANNING DOCUMENTS</span><span>문서 열람용 · 실제 CAD/BIM 지원은 구현·검증 후 선언</span></footer></article></main></div>
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
<script id="source-data" type="application/json">${json(sourceData)}</script>
<script id="reader-config" type="application/json">${json({ initial: doc.id, siteTitle: cfg.siteTitle })}</script>
<script>
${asset('reader.js')}</script>
<script>
${asset('review.js')}</script>
</body></html>
`.replace(/\n{3,}/g, '\n\n');
}

function buildIndex(allDocs, stats) {
  const rel = (target) => posix(path.relative(path.dirname(path.join(ROOT, INDEX_OUT)), path.join(ROOT, target)));
  const rows = allDocs.map((d) => {
    const s = stats[d.id];
    const mtime = s.date;
    const reviewLinks = Object.entries(s.authors).map(([name, count]) => `<a class="review-pill pill" data-review-agent="${esc(name)}" href="${esc(rel(d.out))}#${s.appendices[name] || d.id}">${esc(name.toUpperCase())} ${count}건</a>`).join('<br>');
    return `<tr><td><a href="${esc(rel(d.out))}">${esc(s.titleText)}</a><br><span class="micro">${esc(d.src)}</span></td><td>${esc(d.eyebrow || '')}</td><td>${s.chapters}</td><td>${reviewLinks || '—'}</td><td>${mtime}</td></tr>`;
  }).join('\n');
  const tabs = allDocs.filter((d) => d.tab).map((d) => `<a class="doc-tab" href="${esc(rel(d.out))}">${esc(d.tab)}</a>`).join('');
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="tools/docs/build.mjs — generated; do not edit"><title>${esc(cfg.siteTitle)} · 문서 목록</title><style>
${asset('theme.css')}
${asset('review.css')}
.index-main{max-width:1040px;margin:auto;padding:55px 30px 70px}.index-main h1{font-size:34px;letter-spacing:-.05em;margin:0 0 6px}.index-main .micro{font-size:11px;color:var(--muted)}.index-main table td{vertical-align:top}</style></head><body>
<!-- GENERATED FILE — run: npm --prefix tools/docs run build -->
<header class="topbar"><a class="brand" href="${esc(cfg.index)}" aria-label="${esc(cfg.siteTitle)} 문서 모음"><b>V.</b><span>${esc(cfg.brand)}</span></a><nav class="doc-tabs" aria-label="문서 선택">${tabs}</nav><div class="top-actions"></div></header>
<main class="index-main"><span class="eyebrow">PLANNING DOCUMENTS</span><h1>${esc(cfg.siteTitle)} 문서 목록</h1><p class="micro">MD가 원본이고 이 <code>human/</code> 폴더의 HTML은 <code>tools/docs/build.mjs</code>가 로컬에서 생성한다. Git에는 넣지 않는다 (AI.md §4). 첨삭 표기 규칙은 AI.md §5.</p>
<div class="table-scroll" role="region" tabindex="0" aria-label="문서 목록"><table><thead><tr><th>문서</th><th>종류</th><th>장</th><th>검토 의견</th><th>MD 수정일</th></tr></thead><tbody>
${rows}
</tbody></table></div>
<p class="micro">다음 작성할 문서: <b>${esc(cfg.next.title)}</b> — ${esc(cfg.next.desc)}</p>
<footer class="doc-footer"><span>${esc(cfg.brand)} / PLANNING DOCUMENTS</span><span>문서 열람용 · 실제 CAD/BIM 지원은 구현·검증 후 선언</span></footer></main>
</body></html>
`;
}

// ---------------------------------------------------------------- driver
function writeIfChanged(relOut, content) {
  if (CHECK) return false; // --check renders in memory only; human/ is never compared or committed
  const abs = path.join(ROOT, relOut);
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  if (fs.existsSync(abs) && fs.readFileSync(abs).equals(buf)) return false;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return true;
}

// Remove files under human/ that this build no longer produces (renamed or deleted documents).
function prune(keep) {
  const root = path.join(ROOT, OUT);
  if (CHECK || !fs.existsSync(root)) return;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); if (!fs.readdirSync(abs).length) fs.rmdirSync(abs); continue; }
      if (!keep.has(posix(path.relative(ROOT, abs)))) fs.unlinkSync(abs);
    }
  };
  walk(root);
}

function build() {
  const docs = discoverDocs();
  const stats = {};
  const changed = [];
  problems.length = 0;
  copies = new Map();
  for (const d of docs) {
    const html = buildDoc(d, docs);
    const chapters = (html.match(/<section class="doc-section/g) || []).length;
    const reviews = (html.match(/class="review-label" data-rid=/g) || []).length;
    const authors = {};
    for (const m of html.matchAll(/class="review-label" data-rid="R-\d+" data-review-agent="([^"]+)"/g)) authors[m[1]] = (authors[m[1]] || 0) + 1;
    const appendices = {};
    for (const m of html.matchAll(/<section class="doc-section review-appendix" id="([^"]+)" data-review-agent="([^"]+)"/g)) appendices[m[2]] = m[1];
    const raw = fs.readFileSync(path.join(ROOT, d.src), 'utf8');
    const { meta } = parseFrontMatter(raw);
    const titleText = meta.title || d.tab || d.id;
    stats[d.id] = { chapters, reviews, authors, appendices, titleText, date: docDate(d.src, meta) };
    if (writeIfChanged(d.out, html)) changed.push(d.out);
  }
  if (writeIfChanged(INDEX_OUT, buildIndex(docs, stats))) changed.push(INDEX_OUT);
  for (const [out, src] of copies) if (writeIfChanged(out, fs.readFileSync(path.join(ROOT, src)))) changed.push(out);
  prune(new Set([...docs.map((d) => d.out), INDEX_OUT, ...copies.keys()]));
  return { docs, changed, stats };
}

function report({ docs, changed, stats }) {
  if (QUIET) { for (const c of changed) console.log(c); return; }
  const mark = (out) => (CHECK ? 'ok    ' : changed.includes(out) ? 'wrote ' : 'same  ');
  for (const d of docs) {
    const s = stats[d.id];
    console.log(`${mark(d.out)} ${d.out}  (${s.chapters} chapters, ${s.reviews} review marks)`);
  }
  console.log(`${mark(INDEX_OUT)} ${INDEX_OUT}`);
}

function reportProblems() {
  for (const p of problems) console.error(`[docs] ${p.src}: ${p.msg}`);
}

const first = build();
report(first);
reportProblems();
if (CHECK) {
  if (problems.length) {
    console.error(`\n${problems.length} problem(s) in the Markdown sources (broken links / front matter).`);
    process.exit(1);
  }
  if (!QUIET) console.log(`\ndocs check ok — ${first.docs.length} documents render; build output goes to ${OUT}/ (git-ignored).`);
}
if (WATCH) {
  const dirs = new Set(first.docs.map((d) => path.dirname(path.join(ROOT, d.src))));
  for (const rule of cfg.discover || []) { const p = path.join(ROOT, rule.dir); if (fs.existsSync(p)) dirs.add(p); }
  let timer = null;
  const trigger = (evt, name) => {
    if (name && !/\.md$/i.test(String(name))) return;
    clearTimeout(timer);
    timer = setTimeout(() => { try { report(build()); reportProblems(); } catch (e) { console.error(e.message); } }, 150);
  };
  for (const d of dirs) fs.watch(d, trigger);
  fs.watch(here, (e, n) => { if (/\.(css|js|json|html)$/.test(String(n))) trigger(e, 'x.md'); });
  console.log('watching for .md changes … (Ctrl+C to stop)');
}
