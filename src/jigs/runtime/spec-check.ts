// The 명세 of a package folder on disk (SPEC-07.2·07.14, ARCH-03 §2.1·§11, PLAN-54 T-353): reads
// `README.md`, tells '명세 없음' from '명세와 다름', and refuses a pin or a submission whose spec is
// missing or does not match (`SPEC_MISSING`·`SPEC_MISMATCH`, 409). The comparison itself is the
// pure `specMatch` of `../spec-readme.ts`; this module only adds the files.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError } from '../../contracts/errors.ts';
import {
  panelWritesFiles,
  parseSpecReadme,
  specMatch,
  specPurpose,
  type ParsedSpec,
  type SpecDifference,
  type SpecMark,
} from '../spec-readme.ts';

export const SPEC_FILE = 'README.md';
/** A spec larger than this is not read (it counts as missing). */
export const SPEC_MAX_BYTES = 64 * 1024;

/** The text of a small file of the folder, or null. */
function readSmall(dir: string, path: string): string | null {
  const file = join(dir, path);
  try {
    if (!existsSync(file) || statSync(file).size > SPEC_MAX_BYTES) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
/** `README.md` of a package folder, or null. */
export const readSpecText = (dir: string): string | null => readSmall(dir, SPEC_FILE);

export interface PackageSpec {
  /** 'missing': no file or a fixed section missing (명세 없음); else the comparison's verdict. */
  state: 'missing' | 'mismatch' | 'ok';
  /** Marks of the fixed sections that are missing or repeated. */
  missing: SpecMark[];
  differences: SpecDifference[];
  /** ① 목적's first paragraph. */
  purpose: string | null;
  parsed: ParsedSpec;
}
/** The spec of a package folder against its manifest (`manifest` as read from `jig.json`). */
export function packageSpec(dir: string, manifest: Record<string, unknown>): PackageSpec {
  const text = readSpecText(dir);
  const parsed = parseSpecReadme(text);
  const missing = text === null ? [...parsed.missing] : [...parsed.missing, ...parsed.duplicate];
  if (text === null || !parsed.complete)
    return { state: 'missing', missing, differences: [], purpose: specPurpose(parsed), parsed };
  const panel = typeof manifest.panel === 'string' ? readSmall(dir, manifest.panel) : null;
  const reports = Array.isArray(manifest.reports) && manifest.reports.length > 0;
  const match = specMatch(parsed, manifest, { tablePart: panelWritesFiles(panel), reports });
  return {
    state: match.ok ? 'ok' : 'mismatch',
    missing: [],
    differences: match.differences,
    purpose: specPurpose(parsed),
    parsed,
  };
}

/** The two ways to settle a refused spec; the person picks (SPEC-07.14). */
export const SPEC_CHOICES = [
  { id: 'rebuild', label: '명세대로 다시 만들기' },
  { id: 'fix-spec', label: '명세 고치기' },
] as const;

/** A pin or a submission refused for its spec (`SPEC_MISSING`·`SPEC_MISMATCH`, 409). */
export class SpecRefusedError extends DomainError {
  differences: SpecDifference[];
  missing: SpecMark[];
  constructor(
    code: 'SPEC_MISSING' | 'SPEC_MISMATCH',
    spec: Pick<PackageSpec, 'differences' | 'missing'>,
  ) {
    super(code);
    this.differences = spec.differences;
    this.missing = spec.missing;
  }
  /** The response body: the code, what differs and the two choices. */
  body() {
    return {
      code: this.code,
      ...(this.code === 'SPEC_MISMATCH'
        ? { differences: this.differences.slice(0, 100) }
        : { missing: this.missing }),
      // Without a spec only [명세 고치기] (write it from the jig) applies.
      choices: this.code === 'SPEC_MISSING' ? SPEC_CHOICES.slice(1) : SPEC_CHOICES,
    };
  }
}
/** Refuses a package whose spec is missing or differs from its manifest (pin, submission). */
export function assertSpec(dir: string, manifest: Record<string, unknown>): PackageSpec {
  const spec = packageSpec(dir, manifest);
  if (spec.state === 'missing') throw new SpecRefusedError('SPEC_MISSING', spec);
  if (spec.state === 'mismatch') throw new SpecRefusedError('SPEC_MISMATCH', spec);
  return spec;
}
/** HTTP statuses of the spec codes. */
export const specStatuses: Record<string, number> = { SPEC_MISSING: 409, SPEC_MISMATCH: 409 };

// --- 내장 jig의 명세 (ARCH-03 §2.1 「내장 jig의 명세」) ---------------------------------------------
const builtinRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'builtin-specs');
/** Built-in screen jigs that have a spec file (`src/jigs/builtin-specs/<id>.md`). */
export const BUILTIN_SPEC_IDS = ['sync', 'structure', 'knowledge'] as const;
/**
 * The spec of a built-in screen jig: whether it is missing and ① 목적's first paragraph. Built-in
 * jigs have no manifest, so they are never compared (no spec-match), copied or submitted.
 */
export function builtinSpec(id: string): {
  specMissing: boolean;
  purpose: string | null;
  parsed: ParsedSpec;
} {
  const text = /^[a-z][a-z0-9-]{0,40}$/.test(id) ? readSmall(builtinRoot, `${id}.md`) : null;
  const parsed = parseSpecReadme(text);
  return { specMissing: text === null || !parsed.complete, purpose: specPurpose(parsed), parsed };
}
