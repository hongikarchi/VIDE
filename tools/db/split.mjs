#!/usr/bin/env node
// Splits <data>/vide.sqlite into app.sqlite + projects/<id>/project.sqlite (ADR-032, T-124 phase 1).
// For a manual trial on a COPY of the data folder; the engine does not call this yet.
//
//   node tools/db/split.mjs --data <folder> [--dry-run] [--staging <folder>]
//
// --dry-run builds and verifies in a temporary folder and changes nothing in <folder>.
// Without it the old files stay as vide.sqlite.migrated and knowledge/<id>.sqlite.migrated.
import { resolve } from 'node:path';
import { splitProjectDatabase } from '../../src/core/project-split.ts';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const data = option('--data');
if (!data || args.includes('--help')) {
  console.log('node tools/db/split.mjs --data <folder> [--dry-run] [--staging <folder>]');
  process.exit(data ? 0 : 1);
}
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB';
try {
  const report = await splitProjectDatabase(resolve(data), {
    dryRun: args.includes('--dry-run'),
    stagingRoot: option('--staging'),
  });
  console.log(`${report.status} in ${report.ms} ms${report.reason ? ` (${report.reason})` : ''}`);
  if (report.sourceBytes !== undefined)
    console.log(`source vide.sqlite(+wal): ${mb(report.sourceBytes)}`);
  if (report.backup) console.log(`backup: ${report.backup}`);
  if (report.app)
    console.log(`app.sqlite ${mb(report.app.bytes)}`, JSON.stringify(report.app.rows));
  for (const project of report.projects) {
    const rows = Object.entries(project.rows).filter(([, count]) => count > 0);
    console.log(`project ${project.id} "${project.name}" ${mb(project.bytes)}`);
    console.log('  ' + rows.map(([name, count]) => `${name}=${count}`).join(' '));
    if (project.knowledge) console.log(`  knowledge.sqlite ${mb(project.knowledge.bytes)}`);
  }
  for (const file of report.skippedKnowledge)
    console.log(`knowledge left in place (no project): ${file}`);
} catch (error) {
  console.error(error.code ?? 'SPLIT_FAILED', error.message);
  process.exit(1);
}
