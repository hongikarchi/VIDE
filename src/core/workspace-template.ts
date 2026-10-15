// The local tree a new project folder gets (PLAN-52 「로컬 트리」, ARCH-01 「작업 폴더(PLAN-52)」):
// `<데이터>/workspace-template.json` names one folder per role key. Only the names can change; the
// role keys are fixed, and a project already made keeps the `paths` of its own manifest.
import { readFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';

/** The ten role keys (SPEC-01.13 7). Code knows these, never the folder names. */
export const WORKSPACE_ROLES = [
  'ops',
  'raw',
  'rhino',
  'cad',
  'review',
  'output',
  'snapshots',
  'references',
  'tools',
  'archive',
] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export const isWorkspaceRole = (value: unknown): value is WorkspaceRole =>
  typeof value === 'string' && (WORKSPACE_ROLES as readonly string[]).includes(value);

export interface WorkspaceTemplate {
  name: string;
  version: number;
  folders: Record<WorkspaceRole, string>;
  /** Text of the README.md section VIDE owns, when the template gives one. */
  readme?: string;
  /** Text of the AGENTS.md section VIDE owns, when the template gives one. */
  agents?: string;
}

export interface EffectiveTemplate {
  template: WorkspaceTemplate;
  /** `file` when `<데이터>/workspace-template.json` was read, `default` otherwise. */
  source: 'file' | 'default';
  /** Why the file was not used (it exists but could not be read as a template). */
  error?: 'WORKSPACE_TEMPLATE_INVALID';
  /** Roles the file left out or named badly; they keep the default name. */
  filled?: WorkspaceRole[];
}

export const WORKSPACE_TEMPLATE_FILE = 'workspace-template.json';

const DEFAULT_FOLDERS: Record<WorkspaceRole, string> = {
  ops: '01_운영',
  raw: '02_자료',
  rhino: '03_모델',
  cad: '04_도면',
  review: '05_검토',
  output: '06_산출물',
  snapshots: '07_검토본',
  references: '08_레퍼런스',
  tools: '09_도구',
  archive: '10_아카이브',
};

export function defaultTemplate(): WorkspaceTemplate {
  return { name: 'vide-default', version: 1, folders: { ...DEFAULT_FOLDERS } };
}

/**
 * Whether `name` can be a folder below the project root: a relative path of plain segments (no
 * drive, no UNC, no `..`, no characters Windows refuses, no trailing dot or space).
 */
export function safeRelativeFolder(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  const value = name.trim();
  if (!value || value.length > 200 || value !== name) return false;
  if (win32.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) return false;
  const parts = value.split(/[\\/]+/);
  return parts.every(
    (part) =>
      part.length > 0 &&
      part !== '.' &&
      part !== '..' &&
      !/[<>:"|?*\u0000-\u001f]/.test(part) &&
      !/[. ]$/.test(part),
  );
}

/**
 * The template in `<dataDir>/workspace-template.json`, checked: a bad or missing role name keeps
 * the default name, a file that is not a template object falls back to the default whole. Never
 * throws; `dataDir` undefined (an in-memory store) is the default.
 */
export async function loadTemplate(dataDir: string | undefined): Promise<EffectiveTemplate> {
  if (!dataDir) return { template: defaultTemplate(), source: 'default' };
  let text: string;
  try {
    text = await readFile(join(dataDir, WORKSPACE_TEMPLATE_FILE), 'utf8');
  } catch {
    return { template: defaultTemplate(), source: 'default' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { template: defaultTemplate(), source: 'default', error: 'WORKSPACE_TEMPLATE_INVALID' };
  }
  const parsed = parseTemplate(value);
  return parsed
    ? {
        template: parsed.template,
        source: 'file',
        ...(parsed.filled.length ? { filled: parsed.filled } : {}),
      }
    : { template: defaultTemplate(), source: 'default', error: 'WORKSPACE_TEMPLATE_INVALID' };
}

/** A template object read from JSON, or null when it is not one. Unknown keys are dropped. */
export function parseTemplate(
  value: unknown,
): { template: WorkspaceTemplate; filled: WorkspaceRole[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const folders = input.folders;
  if (!folders || typeof folders !== 'object' || Array.isArray(folders)) return null;
  const given = folders as Record<string, unknown>;
  const filled: WorkspaceRole[] = [];
  const names = {} as Record<WorkspaceRole, string>;
  for (const role of WORKSPACE_ROLES) {
    if (safeRelativeFolder(given[role])) names[role] = given[role];
    else {
      names[role] = DEFAULT_FOLDERS[role];
      filled.push(role);
    }
  }
  // Two roles in one folder would make the tree ambiguous: not a template.
  const keys = new Set(WORKSPACE_ROLES.map((role) => win32.normalize(names[role]).toLowerCase()));
  if (keys.size !== WORKSPACE_ROLES.length) return null;
  const template: WorkspaceTemplate = {
    name:
      typeof input.name === 'string' && input.name.trim()
        ? input.name.trim().slice(0, 100)
        : 'custom',
    version:
      typeof input.version === 'number' && Number.isInteger(input.version) && input.version > 0
        ? input.version
        : 1,
    folders: names,
  };
  if (typeof input.readme === 'string') template.readme = input.readme;
  if (typeof input.agents === 'string') template.agents = input.agents;
  return { template, filled };
}

/** The template's folder names as the `paths` of a new `vide-workspace/1` manifest (relative). */
export function templateToPaths(template: WorkspaceTemplate): Record<WorkspaceRole, string> {
  const paths = {} as Record<WorkspaceRole, string>;
  for (const role of WORKSPACE_ROLES) paths[role] = template.folders[role];
  return paths;
}
