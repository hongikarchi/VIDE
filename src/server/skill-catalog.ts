// The skill catalog of one project (RESEARCH-12 §6.3, user decision 2026-10-01): every tool jig
// this VIDE can run for the project — installed ones pinned to it and, in a checkout, the sources
// under extensions/jigs — with its skill.md front matter and jig.json opening fields, then the
// older official screens (src/jigs/catalog.ts) as the fallback. The screen's fast path
// (GET /api/v1/projects/:id/skills) and the Jev router (/route) both read it, so a project jig
// is offered before the official one for the same words.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { JigStore } from '../core/jig-store.ts';
import type { Workspace } from '../core/workspace.ts';
import { JIGS } from '../jigs/catalog.ts';
import { LEGACY_JIG_ICONS } from '../contracts/jig-icons.ts';
import { OFFICIAL_JIG_ROUTING } from '../ui/request-route.ts';
import {
  DEFAULT_OPEN,
  FIRST_HARD,
  openingOf,
  orderSkills,
  skillFront,
  skillIntent,
  skillRouteJigs,
  type SkillEntry,
} from '../ui/skill-catalog.ts';
import type { RouteJigQuery } from '../ai/request-router.ts';
import { jigRuntimeFor } from './jig-routes.ts';

const MAX_SKILL_BYTES = 64 * 1024;
function readSkill(dir: string, file: string) {
  const path = join(dir, file);
  try {
    if (!existsSync(path) || statSync(path).size > MAX_SKILL_BYTES) return '';
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** The project's catalog in routing order (this project's jigs, other available ones, official). */
export async function skillCatalog(
  workspace: Workspace,
  dataDirectory: string,
  projectId: string,
): Promise<SkillEntry[]> {
  const runtime = jigRuntimeFor(workspace, dataDirectory);
  const pins = new JigStore(workspace.store.db).pinned(projectId);
  const pinned = new Map(pins.map((row) => [row.jigId, row.version]));
  const used = new Set(runtime.list(projectId).map((row) => row.jigId));
  const out: SkillEntry[] = [];
  for (const entry of await runtime.registry.list()) {
    if (entry.kind !== 'tool' || entry.corrupt || out.some((known) => known.id === entry.id))
      continue;
    // Installed jigs belong to the projects they are pinned to (the JIG list's rule).
    if (entry.stage === 'project' && !pinned.has(entry.id)) continue;
    let jig;
    try {
      jig = await runtime.registry.resolve(entry.id, pinned.get(entry.id));
    } catch {
      continue;
    }
    const front = skillFront(readSkill(jig.dir, jig.manifest.skill));
    out.push({
      id: jig.id,
      name: front.name ?? jig.manifest.name,
      kind: 'instance',
      scope: pinned.has(jig.id) || used.has(jig.id) ? 'project' : 'available',
      version: jig.version,
      ...(jig.manifest.icon ? { icon: jig.manifest.icon } : {}),
      description: front.description ?? jig.manifest.summary,
      ...(front.examples ? { examples: front.examples } : {}),
      ...(front.intent_en ? { intent: front.intent_en } : {}),
      ...(front.words ? { words: front.words } : {}),
      ...(front.not_for ? { notFor: front.not_for } : {}),
      invocation: front.invocation,
      ...openingOf(jig.manifest),
    });
  }
  for (const legacy of JIGS) {
    const routing = OFFICIAL_JIG_ROUTING[legacy.id];
    if (legacy.status !== 'available' || !routing) continue;
    out.push({
      id: legacy.id,
      name: legacy.name,
      kind: 'legacy',
      scope: 'official',
      ...(LEGACY_JIG_ICONS[legacy.id] ? { icon: LEGACY_JIG_ICONS[legacy.id] } : {}),
      description: legacy.summary,
      intent: routing.intent,
      words: routing.words,
      invocation: 'auto',
      open: DEFAULT_OPEN,
      fromRequest: [],
      autorun: { until: FIRST_HARD },
    });
  }
  return orderSkills(out);
}

/** The catalog as Jev's jig list: auto-invocable entries only, in order, words kept for the rules. */
export function routeJigsOf(entries: readonly SkillEntry[]): RouteJigQuery[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return skillRouteJigs(entries).map((jig) => ({
    ...jig,
    intent: skillIntent(byId.get(jig.id)!),
  }));
}
