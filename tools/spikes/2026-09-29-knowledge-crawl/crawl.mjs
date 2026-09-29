// Usage: node tools/spikes/2026-09-29-knowledge-crawl/crawl.mjs --root <project folder> --project <VIDE project id|name> [--stages inventory,names,...]
// Builds the project's knowledge DB from a read-only server folder. Spike code (PLAN-08 K0).
import { findProject, knowledgePath, openKnowledge } from './db.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = option('--root');
const project = option('--project');
if (!root || !project) {
  console.error('Usage: crawl.mjs --root <folder> --project <VIDE project id|name> [--stages a,b]');
  process.exit(2);
}
const ALL = ['inventory', 'names', 'extract', 'dwg', 'link', 'select', 'audit', 'statements', 'verify', 'query', 'issues'];
const stages = (option('--stages') ?? ALL.join(',')).split(',');
const { id, name } = findProject(project);
const path = knowledgePath(id);
const db = openKnowledge(path);
db.prepare('insert or replace into meta(key, value) values(?, ?)').run('project_id', id);
db.prepare('insert or replace into meta(key, value) values(?, ?)').run('project_name', name);
db.prepare('insert or replace into meta(key, value) values(?, ?)').run('root', root);
console.log(`knowledge DB: ${path}`);
for (const stage of stages) {
  const module = await import(`./${stage}.mjs`);
  const result = await module[stage](db, root, args, path);
  console.log(stage, JSON.stringify(result));
}
db.close();
