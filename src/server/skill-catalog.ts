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
import { OFFICIAL_JIG_ROUTING, OFFICIAL_TOOL_ROUTING } from '../ui/request-route.ts';
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
import { parseSpecReadme, skillFieldsFromSpec, specPurpose } from '../jigs/spec-readme.ts';
import { builtinSpec, readSpecText } from '../jigs/runtime/spec-check.ts';

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
  const pins = new JigStore(workspace.store).pinned(projectId);
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
    // A jig with a spec takes `examples`·`words`·`not_for` from its ② (ARCH-03 §5.3): they are
    // written in one place only; without a complete spec skill.md is read as written.
    const spec = parseSpecReadme(readSpecText(jig.dir));
    if (spec.complete) {
      const fields = skillFieldsFromSpec(spec);
      if (fields.examples.length) front.examples = fields.examples;
      else delete front.examples;
      if (fields.words.length) front.words = fields.words;
      else delete front.words;
      if (fields.notFor.length) front.not_for = fields.notFor;
      else delete front.not_for;
      front.description ??= specPurpose(spec)?.slice(0, 500);
    }
    // An official tool jig's own routing words join those of its skill.md (SPEC-07.18).
    const routing = entry.stage === 'official' ? OFFICIAL_TOOL_ROUTING[jig.id] : undefined;
    const words = [...new Set([...(front.words ?? []), ...(routing?.words ?? [])])];
    const notFor = [...new Set([...(front.not_for ?? []), ...(routing?.notFor ?? [])])];
    const intent = front.intent_en ?? routing?.intent;
    out.push({
      id: jig.id,
      name: front.name ?? jig.manifest.name,
      kind: 'instance',
      scope: pinned.has(jig.id) || used.has(jig.id) ? 'project' : 'available',
      version: jig.version,
      ...(jig.manifest.icon ? { icon: jig.manifest.icon } : {}),
      description: front.description ?? jig.manifest.summary,
      ...(front.examples ? { examples: front.examples } : {}),
      ...(intent ? { intent } : {}),
      ...(words.length ? { words } : {}),
      ...(notFor.length ? { notFor } : {}),
      invocation: front.invocation,
      ...openingOf(jig.manifest),
    });
  }
  for (const legacy of JIGS) {
    const routing = OFFICIAL_JIG_ROUTING[legacy.id];
    if (legacy.status !== 'available' || !routing) continue;
    // A built-in jig's spec gives its examples and not-for cases (ARCH-03 §5.3); its words are
    // the routing words unless the spec lists its own.
    const spec = builtinSpec(legacy.id);
    const fields = spec.specMissing ? undefined : skillFieldsFromSpec(spec.parsed);
    out.push({
      id: legacy.id,
      name: legacy.name,
      kind: 'legacy',
      scope: 'official',
      ...(LEGACY_JIG_ICONS[legacy.id] ? { icon: LEGACY_JIG_ICONS[legacy.id] } : {}),
      description: legacy.summary,
      ...(fields?.examples.length ? { examples: fields.examples } : {}),
      intent: routing.intent,
      words: fields?.words.length ? fields.words : routing.words,
      ...(fields?.notFor.length ? { notFor: fields.notFor } : {}),
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
