// jig = skill (RESEARCH-12 §6.3, user decision 2026-10-01): a jig says when it is used in its
// `skill.md` front matter (`description`, `examples`, `invocation`, `words`, `not_for`,
// `intent_en`) and how it opens in `jig.json` (`open`, `from_request`, `autorun`). This module is
// the pure part shared by the screen and the engine: the front-matter parser, the catalog order
// (this project's jigs first, the hard-coded official list last) and the routing candidates.
// No DOM and no Node imports; the engine reads the files (src/server/skill-catalog.ts).

import type { RouteJig } from './request-route.ts';

export type Invocation = 'auto' | 'user-only';
/** Where a catalog entry comes from, in routing order (RESEARCH-10 §8.8: project jig first). */
export type SkillScope = 'project' | 'available' | 'official';

/** What `skill.md` says about when a jig is used (ARCH-03 §5.3 plus the RESEARCH-12 fields). */
export interface SkillFront {
  name?: string;
  /** Korean: what it does and when (Jev reads it when there is no `intent_en`). */
  description?: string;
  examples?: string[];
  /** `user-only`: never opened by the router or the AI, only by the person. Default `auto`. */
  invocation: Invocation;
  intent_en?: string;
  words?: string[];
  not_for?: string[];
  limits?: string[];
}

/** How a jig opens and runs when it is started from a request (jig.json, all optional). */
export interface SkillOpen {
  /** `last`: the project's latest instance of the jig; `new`: always a new one. */
  reuse: 'last' | 'new';
  /**
   * The output layer offered first when the instance asks for one at Rhino에 만들기. A jig
   * opened from a request has no output layer until then (ADR-026): computing needs none.
   */
  layerRoot?: string;
}

export interface SkillEntry {
  id: string;
  name: string;
  /** `instance`: a v3 jig with instances; `legacy`: an older screen opened as it is. */
  kind: 'instance' | 'legacy';
  scope: SkillScope;
  version?: string;
  /** The jig's icon (PLAN-26 T-100): `jig.json` `icon`, or the fixed one of a built-in screen. */
  icon?: string;
  description?: string;
  examples?: string[];
  intent?: string;
  words?: string[];
  notFor?: string[];
  invocation: Invocation;
  open: SkillOpen;
  /** Settings a request may set when it starts the jig ("구조 분석 해줘, 경간 11로"). */
  fromRequest: string[];
  /**
   * Run until this step (inclusive), or `first-hard`: the first human step that blocks others.
   * `step` is the step id it resolves to for this version (none: every step no person waits on).
   */
  autorun: { until: string; step?: string };
}

export const DEFAULT_OPEN: SkillOpen = { reuse: 'last' };
export const FIRST_HARD = 'first-hard';

// ── Front matter ────────────────────────────────────────────────────────────────────────────
const unquote = (value: string) => {
  const text = value.trim();
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  )
    return text.slice(1, -1);
  return text;
};
/** `[a, "b, c", d]` → ['a', 'b, c', 'd'] (quotes keep commas). */
function flowList(value: string): string[] {
  const inner = value.trim().slice(1, -1);
  const out: string[] = [];
  let current = '',
    quote = '';
  for (const char of inner) {
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ',') {
      out.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

/**
 * The YAML front matter of a `skill.md` as far as skills use it: `key: value`, `key: [a, b]`,
 * block lists (`key:` then `- item` lines) and block text (`key: |` or `key: >`). Anything else is
 * ignored; a file without front matter gives an empty object.
 */
export function parseFrontMatter(text: string): Record<string, string | string[]> {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return {};
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return {};
  const out: Record<string, string | string[]> = {};
  const body = lines.slice(1, end);
  for (let i = 0; i < body.length; i++) {
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(body[i]);
    if (!match) continue;
    const [, key, raw] = match;
    const value = raw.trim();
    if (value.startsWith('[') && value.endsWith(']')) out[key] = flowList(value);
    else if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const block: string[] = [];
      while (i + 1 < body.length && (/^\s+\S/.test(body[i + 1]) || !body[i + 1].trim()))
        block.push(body[++i].trim());
      out[key] = value.startsWith('|') ? block.join('\n').trim() : block.join(' ').trim();
    } else if (!value) {
      const items: string[] = [];
      while (i + 1 < body.length && /^\s*-\s+/.test(body[i + 1]))
        items.push(unquote(body[++i].replace(/^\s*-\s+/, '')));
      out[key] = items;
    } else out[key] = unquote(value);
  }
  return out;
}

const listOf = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && !!item.trim())
    : typeof value === 'string' && value.trim()
      ? [value.trim()]
      : undefined;
const textOf = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

/** The skill fields of a `skill.md` (missing or odd fields are left out; invocation is `auto`). */
export function skillFront(text: string): SkillFront {
  const raw = parseFrontMatter(text);
  const front: SkillFront = {
    invocation: raw.invocation === 'user-only' ? 'user-only' : 'auto',
  };
  const name = textOf(raw.name, 100);
  if (name) front.name = name;
  const description = textOf(raw.description, 500);
  if (description) front.description = description;
  const intent = textOf(raw.intent_en, 600);
  if (intent) front.intent_en = intent;
  for (const key of ['examples', 'words', 'not_for', 'limits'] as const) {
    const list = listOf(raw[key])?.slice(0, 60);
    if (list?.length) front[key] = list;
  }
  return front;
}

// ── The manifest's opening fields ───────────────────────────────────────────────────────────
/** `open`, `from_request` and `autorun` of a jig.json, with the defaults filled in. */
export function openingOf(manifest: {
  open?: { reuse?: string; layerRoot?: string };
  from_request?: string[];
  autorun?: { until?: string };
  steps?: readonly { id: string; kind: string; blocks?: readonly string[] }[];
}): Pick<SkillEntry, 'open' | 'fromRequest' | 'autorun'> {
  const until = manifest.autorun?.until || FIRST_HARD;
  const step = autorunUntil(until, manifest.steps ?? []);
  return {
    open: {
      reuse: manifest.open?.reuse === 'new' ? 'new' : 'last',
      ...(manifest.open?.layerRoot?.trim() ? { layerRoot: manifest.open.layerRoot.trim() } : {}),
    },
    fromRequest: [...(manifest.from_request ?? [])],
    autorun: { until, ...(step ? { step } : {}) },
  };
}

/**
 * The step a start runs until: the declared one, or for `first-hard` the first human step that
 * blocks others (the person's checkpoint, e.g. 해석 확정). Undefined runs every step that does not
 * wait on a person.
 */
export function autorunUntil(
  until: string,
  steps: readonly { id: string; kind: string; blocks?: readonly string[] }[],
): string | undefined {
  if (until !== FIRST_HARD) return steps.some((step) => step.id === until) ? until : undefined;
  return steps.find((step) => step.kind === 'human' && (step.blocks?.length ?? 0) > 0)?.id;
}

// ── Order and routing candidates ────────────────────────────────────────────────────────────
const SCOPE_RANK: Record<SkillScope, number> = { project: 0, available: 1, official: 2 };
/** The catalog in routing order: this project's jigs, other available ones, then the official list. */
export function orderSkills(entries: readonly SkillEntry[]): SkillEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => SCOPE_RANK[a.entry.scope] - SCOPE_RANK[b.entry.scope] || a.index - b.index)
    .map(({ entry }) => entry);
}
/** The jigs a request may open on its own: `user-only` ones never are. */
export function skillRouteJigs(entries: readonly SkillEntry[]): RouteJig[] {
  return orderSkills(entries)
    .filter((entry) => entry.invocation === 'auto')
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      ...(entry.words?.length ? { words: entry.words } : {}),
      ...(entry.notFor?.length ? { notFor: entry.notFor } : {}),
      source: entry.kind === 'legacy' ? ('legacy' as const) : ('skill' as const),
    }));
}
/** The one line Jev judges a jig by: its English intent, else its description. */
export const skillIntent = (entry: Pick<SkillEntry, 'intent' | 'description' | 'name'>) =>
  entry.intent ?? entry.description ?? entry.name;
