#!/usr/bin/env node
// Reads the opt-in error/performance reports from the account site (ADR-036, PLAN-34 T-158) for
// developers and Claude: it pulls them through the admin API and prints what happened per version
// (installs, failures by kind, engine exits, slow steps), or writes the raw list or a CSV.
//
//   VIDE_TELEMETRY_ADMIN_TOKEN=… node tools/diagnostics/reports.mjs [--site <url>] [--day YYYY-MM-DD]
//        [--days N] [--version v] [--install <id>] [--json] [--csv <file>] [--out <file>]
//
// The token is the site's TELEMETRY_ADMIN_TOKEN secret; keep it in the environment (or a local
// .env that git ignores), never in the repository.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULT_SITE = 'https://vide-sharing-staging.archivibe.workers.dev';
const args = process.argv.slice(2);
const value = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const usage =
  'VIDE_TELEMETRY_ADMIN_TOKEN=… node tools/diagnostics/reports.mjs [--site <url>] [--day YYYY-MM-DD] [--days N] [--version v] [--install <id>] [--json] [--csv <file>] [--out <file>]';
if (args.includes('--help')) {
  console.log(usage);
  process.exit(0);
}

/** Merged view of many reports: per version, failures by kind, exits and timing medians. */
export function digestReports(reports) {
  const versions = new Map();
  for (const report of reports) {
    const payload = report.payload ?? {};
    let row = versions.get(report.version);
    if (!row) {
      row = {
        version: report.version,
        reports: 0,
        installs: new Set(),
        errors: new Map(),
        exits: new Map(),
        timings: new Map(),
        os: new Map(),
      };
      versions.set(report.version, row);
    }
    row.reports++;
    row.installs.add(report.install_id);
    if (payload.os) row.os.set(payload.os, (row.os.get(payload.os) ?? 0) + 1);
    for (const error of payload.errors ?? []) {
      const fields = error.fields ?? {};
      const key = [
        `${error.part}:${error.event}`,
        fields.code ?? fields.status ?? '',
        fields.path ?? fields.tool ?? fields.method ?? '',
        fields.message ?? '',
      ]
        .filter((part) => part !== '')
        .join(' · ');
      const entry = row.errors.get(key) ?? { count: 0, installs: new Set(), stack: fields.stack };
      entry.count += Number(error.count) || 0;
      entry.installs.add(report.install_id);
      row.errors.set(key, entry);
    }
    for (const exit of payload.exits ?? []) {
      const key = exit.hex ?? String(exit.code);
      row.exits.set(key, (row.exits.get(key) ?? 0) + 1);
    }
    for (const [name, timing] of Object.entries(payload.timings ?? {})) {
      const list = row.timings.get(name) ?? [];
      list.push(timing);
      row.timings.set(name, list);
    }
  }
  return [...versions.values()]
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
    .map((row) => ({
      version: row.version,
      reports: row.reports,
      installs: row.installs.size,
      os: Object.fromEntries(row.os),
      errors: [...row.errors]
        .map(([key, entry]) => ({
          key,
          count: entry.count,
          installs: entry.installs.size,
          ...(entry.stack ? { stack: entry.stack } : {}),
        }))
        .sort((a, b) => b.installs - a.installs || b.count - a.count),
      exits: Object.fromEntries(row.exits),
      timings: Object.fromEntries(
        [...row.timings].map(([name, list]) => {
          const p50 = list.map((t) => t.p50).sort((a, b) => a - b);
          const p90 = list.map((t) => t.p90).sort((a, b) => a - b);
          return [
            name,
            {
              reports: list.length,
              n: list.reduce((sum, t) => sum + (t.n ?? 0), 0),
              p50: p50[Math.floor(p50.length / 2)],
              p90: p90[Math.floor(p90.length / 2)],
              max: Math.max(...list.map((t) => t.max ?? 0)),
            },
          ];
        }),
      ),
    }));
}

async function main() {
  const token = process.env.VIDE_TELEMETRY_ADMIN_TOKEN;
  if (!token) {
    console.error('VIDE_TELEMETRY_ADMIN_TOKEN is not set (the site secret TELEMETRY_ADMIN_TOKEN).');
    console.error(usage);
    process.exit(2);
  }
  const site = new URL(value('--site') ?? process.env.VIDE_TELEMETRY_SITE ?? DEFAULT_SITE).origin;
  const params = new URLSearchParams();
  const days = Number(value('--days') ?? 0);
  if (value('--day')) params.set('day', value('--day'));
  else if (days > 0)
    params.set('from', new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10));
  if (value('--version')) params.set('version', value('--version'));
  if (value('--install')) params.set('install', value('--install'));
  const headers = { Authorization: `Bearer ${token}` };
  if (value('--csv')) {
    const response = await fetch(`${site}/api/admin/telemetry/reports.csv?${params}`, { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${await response.text()}`);
    writeFileSync(value('--csv'), Buffer.from(await response.arrayBuffer()));
    console.log(`CSV saved: ${value('--csv')}`);
    return;
  }
  const reports = [];
  let before;
  for (let page = 0; page < 50; page++) {
    const query = new URLSearchParams(params);
    query.set('limit', '500');
    if (before) query.set('before', String(before));
    const response = await fetch(`${site}/api/admin/telemetry/reports?${query}`, { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${await response.text()}`);
    const body = await response.json();
    reports.push(...body.reports);
    if (!body.next) break;
    before = body.next;
  }
  if (value('--out')) writeFileSync(value('--out'), JSON.stringify(reports, null, 2));
  if (args.includes('--json')) {
    console.log(JSON.stringify(digestReports(reports), null, 2));
    return;
  }
  console.log(`${reports.length} reports from ${site}`);
  for (const row of digestReports(reports)) {
    console.log(`\n== ${row.version}: ${row.reports} reports, ${row.installs} installs`);
    for (const error of row.errors.slice(0, 15))
      console.log(`  ${error.installs} installs · ${error.count}× ${error.key}`);
    if (Object.keys(row.exits).length)
      console.log(
        '  exits: ' +
          Object.entries(row.exits)
            .map(([code, count]) => `${code} ×${count}`)
            .join(', '),
      );
    for (const name of ['request.totalMs', 'request.firstOutputMs', 'sync.ms', 'live-sync.ms']) {
      const timing = row.timings[name];
      if (timing)
        console.log(`  ${name}: p50 ${timing.p50} · p90 ${timing.p90} · max ${timing.max}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
