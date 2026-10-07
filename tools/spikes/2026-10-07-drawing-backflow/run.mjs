// T-225 spike driver (PLAN-47). Starts its own hidden ZWCAD 2023 per batch (launchHiddenZwcad: the
// crash-report prompt of an earlier crash is answered only in the PID started here), loads
// BackflowProbe.dll and runs VIDEBACKFLOW over a job list. A native crash ends the process without
// `<out>.done`: the memory-mapped trace names the last step, a crashing `sweep` property is added to
// the skip list and the remaining jobs run again. Only PIDs started here are stopped.
//
//   node run.mjs synthetic            synthetic drawings: write/version/handles/xdata/xref (Q1–Q3, Q5)
//   node run.mjs real <copy-folder>   COPIES of real drawings: sweep (Q4), title blocks/layouts (Q5),
//                                     side-DB write + xref child write on the copies (Q1–Q2)
// Work files: .vide/spikes/drawing-backflow/ (git-ignored). Summaries: summary-*.json (counts only).
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { launchHiddenZwcad } from '../../../hosts/zwcad/crash-prompt.ts';

const ZWCAD = 'C:\\Program Files\\ZWSOFT\\ZWCAD 2023\\ZWCAD.exe';
const PROBE = resolve('.vide/build/drawing-backflow/VIDE.BackflowProbe.dll');
const work = resolve('.vide/spikes/drawing-backflow');
const crashFolder = join(process.env.APPDATA ?? '', 'ZWSOFT', 'ZWCAD', '2023', 'ko-KR', 'CrashReport');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function crashFiles() {
  try { return (await readdir(crashFolder)).length; } catch { return 0; }
}

function readTrace(file) {
  try {
    const b = readFileSync(file);
    const n = b.readInt32LE(0);
    return n > 0 && n < 1000 ? b.subarray(4, 4 + n).toString('utf8') : '';
  } catch { return ''; }
}

/** Runs jobs ([op, ...args]) in hidden ZWCAD launches until all have a result line. */
async function batch(name, jobs, { timeoutMs = 15 * 60000, stallMs = 90000 } = {}) {
  const dir = join(work, 'runs', name);
  await mkdir(dir, { recursive: true });
  const out = join(dir, 'out.jsonl'), skipFile = join(work, 'sweep-skip.txt'), crashes = [];
  await rm(out, { force: true });
  const numbered = jobs.map((job, i) => [String(i), ...job]);
  for (let launch = 0; launch < 15; launch++) {
    const doneIds = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).job) : []);
    const left = numbered.filter((j) => !doneIds.has(j[0]));
    if (left.length === 0) break;
    const jobsFile = join(dir, 'jobs.tsv'), trace = join(dir, 'trace.bin'), script = join(dir, 'start.scr');
    await writeFile(jobsFile, left.map((j) => j.join('\t')).join('\n'), 'utf8');
    await rm(trace, { force: true }); await rm(out + '.done', { force: true });
    await writeFile(script, `(command "_NETLOAD" ${JSON.stringify(PROBE.replaceAll('\\', '/'))})\nVIDEBACKFLOW\n`);
    let exitCode = null, exited = false;
    const owner = await launchHiddenZwcad({
      executable: ZWCAD, args: ['/b', script],
      environment: { ...process.env, VIDE_BF_JOBS: jobsFile, VIDE_BF_OUT: out, VIDE_BF_TRACE: trace, VIDE_BF_SKIP: skipFile },
      spawnProcess: (file, args, options) => { const c = spawn(file, args, options); c.once('exit', (code) => { exited = true; exitCode = code; }); return c; },
    });
    const pid = owner.identity.pid;
    console.log(`[${name}] launch ${launch} pid ${pid}, ${left.length} job(s)`);
    const deadline = Date.now() + timeoutMs;
    // A getter can also hang (no CPU, no progress): the same step for `stallMs` counts as a hang.
    let last = '', since = Date.now(), hung = false;
    while (!existsSync(out + '.done') && !exited && Date.now() < deadline) {
      await sleep(1000);
      const now = readTrace(trace);
      if (now !== last) { last = now; since = Date.now(); }
      else if (Date.now() - since > stallMs && !/^job \d+ (fixture|edit|resolve|open)$|^dump handles|^edit saveas/.test(now)) { hung = true; break; }
    }
    const finished = existsSync(out + '.done');
    owner.settled();
    await owner.stop().catch((e) => console.log('stop:', e.message));
    if (finished) break;
    const step = readTrace(trace);
    const doneNow = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).job) : []);
    const job = left.find((j) => !doneNow.has(j[0]));
    const crash = { launch, pid, exitCode: hung ? 'hang' : exited ? exitCode : 'timeout', job: job?.[0], op: job?.[1], step };
    crashes.push(crash);
    console.log(`[${name}] crashed`, JSON.stringify(crash));
    const m = /^sweep (\S+) /.exec(step);
    if (m) await appendFile(skipFile, m[1] + '\n');
    else if (job) await appendFile(out, JSON.stringify({ job: job[0], op: job[1], error: 'HOST_CRASH', step }) + '\n');
  }
  const rows = existsSync(out) ? (await readFile(out, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { rows: rows.sort((a, b) => Number(a.job) - Number(b.job)), crashes };
}

const json = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

/** Handle map / digests / tables before vs after a side-DB edit. */
function compare(before, after, edit) {
  const b = json(before), a = json(after);
  const missing = Object.keys(b.handles).filter((h) => !(h in a.handles));
  const classChanged = Object.keys(b.handles).filter((h) => h in a.handles && a.handles[h] !== b.handles[h]);
  const added = Object.keys(a.handles).filter((h) => !(h in b.handles));
  const digestChanged = Object.keys(b.digests).filter((h) => h in a.digests && a.digests[h] !== b.digests[h]);
  const same = (k) => JSON.stringify(b[k]) === JSON.stringify(a[k]);
  return {
    version: [b.version, a.version], handles: Object.keys(b.handles).length,
    missingHandles: missing.length, classChanged: classChanged.length, addedHandles: added.length,
    addedClasses: [...new Set(added.map((h) => a.handles[h]))],
    digestChanged: digestChanged.length, onlyMovedChanged: digestChanged.every((h) => h === edit?.moved),
    layers: same('layers'), textStyles: same('textStyles'), dimStyles: same('dimStyles'), linetypes: same('linetypes'),
    blocks: same('blocks'), layouts: same('layouts'), titleBlocks: same('titleBlocks'),
    xrefPaths: JSON.stringify(b.blocks.filter((x) => x.xref)) === JSON.stringify(a.blocks.filter((x) => x.xref)),
    regAppAdded: a.regApps.length - b.regApps.length, markedAfter: Object.keys(a.marked).length,
  };
}

/** Q5 numbers of one dump (no names, no values). */
function sheets(file) {
  const d = json(file);
  const paper = d.layouts.filter((l) => !l.model);
  const inPaper = d.titleBlocks.filter((t) => t.paperSpace);
  const ratio = (t) => { if (!t.extents) return null; const w = t.extents[2] - t.extents[0], h = t.extents[3] - t.extents[1]; return Math.max(w, h) / Math.min(w, h); };
  const paperRatio = (t) => { const [w, h] = t.paper; return w && h ? Math.max(w, h) / Math.min(w, h) : null; };
  const near = (x, y) => x && y && Math.abs(x - y) / y < 0.03;
  const model = d.layouts.filter((l) => l.model);
  const xrefNames = new Set(d.blocks.filter((b) => b.xref).map((b) => b.name));
  const frames = Object.entries(d.plainInserts ?? {}).filter(([name, v]) => !xrefNames.has(name) && v.isoRatio > 0);
  return {
    version: d.version, layouts: paper.length,
    modelWindowPlot: model.filter((l) => l.plotType === 'Window' && l.window.some((v) => v !== 0)).length,
    modelStyleSheet: model.filter((l) => l.styleSheet).length,
    modelMediaIsoA: model.filter((l) => /A[0-4]/i.test(l.media ?? '')).length,
    plainFrameBlocks: frames.length, plainFrameInserts: frames.reduce((n, [, v]) => n + v.isoRatio, 0),
    layoutsWithAttribInsert: new Set(inPaper.map((t) => t.space)).size,
    attribInsertsPaper: inPaper.length, attribInsertsModelOrBlock: d.titleBlocks.length - inPaper.length,
    attribValues: d.titleBlocks.reduce((n, t) => n + t.attributes.length, 0),
    mtextAttribs: d.titleBlocks.reduce((n, t) => n + t.attributes.filter((a) => a.mtext).length, 0),
    insertsMatchingPaperRatio: inPaper.filter((t) => near(ratio(t), paperRatio(t))).length,
    insertsNearIsoRatio: d.titleBlocks.filter((t) => near(ratio(t), Math.SQRT2)).length,
    distinctAttribBlocks: new Set(d.titleBlocks.map((t) => t.block)).size,
    plotTypes: paper.reduce((m, l) => ((m[l.plotType] = (m[l.plotType] ?? 0) + 1), m), {}),
    styleSheetSet: paper.filter((l) => l.styleSheet).length,
    styleSheetKinds: [...new Set(paper.map((l) => extname(l.styleSheet ?? '').toLowerCase() || 'none'))],
    windowSet: paper.filter((l) => l.window.some((v) => v !== 0)).length,
    mediaSet: paper.filter((l) => l.media).length,
    xrefs: d.blocks.filter((b) => b.xref).length,
    xrefPathKinds: d.blocks.filter((b) => b.xref).reduce((m, b) => { const k = !b.path ? 'empty' : /^[a-z]:|^\\\\/i.test(b.path) ? 'absolute' : 'relative'; m[k] = (m[k] ?? 0) + 1; return m; }, {}),
  };
}

async function synthetic() {
  const root = join(work, 'synthetic');
  await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true });
  const fx = await batch('syn-fixture', [['fixture', root]]);
  const versions = ['2007', '2013', '2018'];
  const jobs = [];
  for (const v of versions) {
    for (const [file, tag] of [[join(root, `root-${v}.dwg`), `root-${v}`], [join(root, 'xref', `child-${v}.dwg`), `child-${v}`]]) {
      const edited = file.replace(/\.dwg$/, '-vide-edit.dwg');
      jobs.push(['dump', file, join(root, `${tag}.before.json`)], ['edit', file, edited, `rhino:synthetic-${tag}`], ['dump', edited, join(root, `${tag}.after.json`)], ['open', edited]);
    }
  }
  await mkdir(join(root, 'xdata'), { recursive: true });
  jobs.push(['xdataops', join(root, 'root-2018-vide-edit.dwg'), join(root, 'xdata')]);
  jobs.push(['sweep', join(root, 'root-2018.dwg'), '200']);
  for (const v of versions) jobs.push(['resolve', join(root, `root-${v}.dwg`), '', root]); // baseline: no marks
  const main = await batch('syn-main', jobs);
  // The user (not VIDE) replaces the xref child with the reflected file; then the root resolves it.
  for (const v of versions) {
    await rename(join(root, 'xref', `child-${v}.dwg`), join(root, 'xref', `child-${v}.orig.dwg`));
    await copyFile(join(root, 'xref', `child-${v}-vide-edit.dwg`), join(root, 'xref', `child-${v}.dwg`));
  }
  const res = await batch('syn-resolve', versions.map((v) => ['resolve', join(root, `root-${v}.dwg`), '', root]));
  const xrefRows = (rows) => rows.map((r) => r.result?.xrefs?.map((x) => ({ status: x.status, entities: x.entities, marked: x.marked })) ?? r.error);
  const summary = { fixture: fx.rows[0], crashes: [...fx.crashes, ...main.crashes, ...res.crashes], compare: {}, sheets: {}, open: [], xdata: null,
    resolveBefore: xrefRows(main.rows.filter((r) => r.op === 'resolve')), resolveAfter: xrefRows(res.rows), sweep: null };
  for (const v of versions) for (const tag of [`root-${v}`, `child-${v}`]) {
    const editRow = main.rows.find((r) => r.op === 'edit' && jobs[Number(r.job)][2].includes(tag + '-vide-edit'));
    summary.compare[tag] = { edit: editRow?.result ?? editRow?.error, ...compare(join(root, `${tag}.before.json`), join(root, `${tag}.after.json`), editRow?.result) };
    if (tag.startsWith('root')) summary.sheets[tag] = sheets(join(root, `${tag}.before.json`));
  }
  summary.open = main.rows.filter((r) => r.op === 'open').map((r) => r.result ?? r.error);
  summary.xdata = main.rows.find((r) => r.op === 'xdataops')?.result ?? main.rows.find((r) => r.op === 'xdataops')?.error;
  const sw = main.rows.find((r) => r.op === 'sweep');
  summary.sweep = sw?.result ? { entities: sw.result.entities, properties: sw.result.properties, failed: sw.result.failed } : sw?.error;
  await writeFile(join(work, 'summary-synthetic.json'), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
}

async function real(copyFolder) {
  const input = resolve(copyFolder);
  const original = process.env.VIDE_BF_ORIGINAL_FOLDER ?? '';
  const files = [];
  const walk = async (d) => { for (const e of await readdir(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) await walk(p); else if (/\.dwg$/i.test(e.name) && !/-vide-edit\.dwg$|^__vide/i.test(e.name)) files.push(p); } };
  await walk(input);
  const tag = (f) => relative(input, f).replace(/[\\/]/g, '__').replace(/\.dwg$/i, '');
  const dumps = join(work, 'real-dumps'); await mkdir(dumps, { recursive: true });
  const phase = process.argv[4] ?? 'all';
  const summary = existsSync(join(work, 'summary-real.json')) ? json(join(work, 'summary-real.json')) : {};
  summary.files = { total: files.length, roots: files.filter((f) => dirname(f) === input).length, xrefFolder: files.filter((f) => dirname(f) !== input).length };
  if (phase === 'all' || phase === 'read') {
    const jobs = [];
    for (const f of files) jobs.push(['sweep', f, '300'], ['dump', f, join(dumps, tag(f) + '.json')]);
    const r = await batch('real-read', jobs, { timeoutMs: 40 * 60000 });
    const failed = {}, ok = new Set(); let entities = 0; const errors = [];
    for (const row of r.rows) {
      if (row.op === 'sweep' && row.result) { entities += row.result.entities; for (const k of Object.keys(row.result.ok)) ok.add(k); for (const [k, m] of Object.entries(row.result.failed)) (failed[k] ??= new Set()).add(m.split(':')[0]); }
      else if (row.error) errors.push({ op: row.op, error: row.error.split(':')[0], step: row.step?.replace(/ [0-9A-F]+$/i, '') });
    }
    summary.read = {
      crashes: r.crashes.map((c) => ({ op: c.op, exitCode: c.exitCode, step: c.step.replace(/ [0-9A-F]+$/i, '') })),
      skipped: existsSync(join(work, 'sweep-skip.txt')) ? readFileSync(join(work, 'sweep-skip.txt'), 'utf8').split('\n').filter(Boolean) : [],
      sweptEntities: entities, propertiesReadOk: ok.size,
      managedFailures: Object.fromEntries(Object.entries(failed).map(([k, v]) => [k, [...v]])), errors,
      sheets: files.filter((f) => existsSync(join(dumps, tag(f) + '.json'))).map((f) => ({ root: dirname(f) === input, ...sheets(join(dumps, tag(f) + '.json')) })),
    };
    await writeFile(join(work, 'summary-real.json'), JSON.stringify(summary, null, 1));
  }
  if (phase === 'all' || phase === 'write') {
    const roots = files.filter((f) => dirname(f) === input);
    // xref children referenced by the roots and present in the copy folder (by file name).
    const referenced = new Set();
    for (const f of roots) { const d = json(join(dumps, tag(f) + '.json')); for (const b of d.blocks) if (b.xref && b.path) referenced.add(basename(b.path.replaceAll('\\', '/')).toLowerCase()); }
    // A child without xrefs of its own: loading it never follows a nested (server) path.
    const children = files.filter((f) => dirname(f) !== input && dirname(dirname(f)) === input && referenced.has(basename(f).toLowerCase()) &&
      json(join(dumps, tag(f) + '.json')).blocks.every((b) => !b.xref));
    const smallest = (await Promise.all(children.map(async (f) => [f, (await stat(f)).size]))).sort((a, b) => a[1] - b[1]);
    const child = smallest[0]?.[0];
    const targets = [...roots, ...(child ? [child] : [])];
    const jobs = [];
    for (const f of targets) {
      const edited = f.replace(/\.dwg$/i, '-vide-edit.dwg');
      await rm(edited, { force: true });
      // `resolve` (not `open`): a document open of the edited root would follow absolute xref paths.
      jobs.push(['edit', f, edited, 'rhino:spike'], ['dump', edited, join(dumps, tag(f) + '.after.json')], ['resolve', edited, original, input, '-']);
    }
    const keep = child ? basename(child) : '-';
    for (const f of roots) jobs.push(['resolve', f, original, input, keep]); // baseline before the child swap
    const r = await batch('real-write', jobs, { timeoutMs: 30 * 60000 });
    const results = [];
    for (const f of targets) {
      const e = r.rows.find((x) => x.op === 'edit' && jobs[Number(x.job)][1] === f);
      const o = r.rows.find((x) => x.op === 'resolve' && jobs[Number(x.job)][1] === f.replace(/\.dwg$/i, '-vide-edit.dwg'));
      const after = join(dumps, tag(f) + '.after.json');
      const opened = o?.result ? { opened: o.result.opened, version: o.result.version, objects: o.result.objects, xrefStatuses: o.result.xrefs.reduce((m, x) => ((m[x.status] = (m[x.status] ?? 0) + 1), m), {}) } : o?.error;
      results.push({ root: f !== child, edit: e?.error ?? { originalVersion: e?.result.originalVersion, savedVersion: e?.result.savedVersion, moved: !!e?.result.moved }, open: opened,
        ...(existsSync(after) ? compare(join(dumps, tag(f) + '.json'), after, e?.result) : {}) });
    }
    // Q2: put the reflected child in place of the copy's child (as the user would), resolve the roots.
    let resolve2 = null;
    if (child) {
      await rename(child, child.replace(/\.dwg$/i, '.orig.dwg'));
      await copyFile(child.replace(/\.dwg$/i, '-vide-edit.dwg'), child);
      const rr = await batch('real-resolve', roots.map((f) => ['resolve', f, original, input, keep]));
      await rm(child); await rename(child.replace(/\.dwg$/i, '.orig.dwg'), child);
      const name = basename(child).toLowerCase();
      const view = (row) => {
        if (!row.result?.xrefs) return { error: row.error };
        const all = row.result.xrefs;
        const mine = all.filter((x) => basename((x.path ?? '').replaceAll('\\', '/')).toLowerCase() === name);
        return { xrefs: all.length, statuses: all.reduce((m, x) => ((m[x.status] = (m[x.status] ?? 0) + 1), m), {}), editedChild: mine.map((x) => ({ status: x.status, entities: x.entities, marked: x.marked, pathKind: /^[a-z]:/i.test(x.path) ? 'absolute' : 'relative' })) };
      };
      resolve2 = { before: r.rows.filter((x) => x.op === 'resolve' && roots.includes(jobs[Number(x.job)][1])).map(view), after: rr.rows.map(view) };
    }
    summary.write = { results, resolve: resolve2, crashes: r.crashes.map((c) => ({ op: c.op, exitCode: c.exitCode, step: c.step.replace(/ [0-9A-F]+$/i, '') })) };
    await writeFile(join(work, 'summary-real.json'), JSON.stringify(summary, null, 1));
  }
  console.log(JSON.stringify(summary, null, 1));
}

const before = await crashFiles();
if (process.argv[2] === 'synthetic') await synthetic();
else if (process.argv[2] === 'real') await real(process.argv[3]);
else console.log('usage: node run.mjs synthetic | real <copy-folder> [read|write]');
console.log('crash report files before/after:', before, await crashFiles());
