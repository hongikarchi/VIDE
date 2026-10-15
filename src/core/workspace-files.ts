// 작업 폴더의 안내 파일 (SPEC-01.13 7, ARCH-01 「작업 폴더(PLAN-52)」): `README.md` and `AGENTS.md` at
// the work folder root. VIDE owns only the part between `<!-- vide:start -->` and
// `<!-- vide:end -->` (project name, role path table, the one-line rule on where the originals
// are, the server memory summary, the terminal usage); text outside the markers is the person's
// and is kept as it is. A file without the markers gets the section appended at its end.
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { layoutOf, type WorkspaceConfig } from './workspace-config.ts';
import { WORKSPACE_ROLES, type WorkspaceRole } from './workspace-template.ts';

export const VIDE_BLOCK_START = '<!-- vide:start -->';
export const VIDE_BLOCK_END = '<!-- vide:end -->';
export const GUIDE_FILES = ['README.md', 'AGENTS.md'] as const;
export type GuideFile = (typeof GUIDE_FILES)[number];

/** What each role holds, in the words people read (Design SCR-35's preview tree). */
export const ROLE_USES: Record<WorkspaceRole, string> = {
  ops: '일지·회의록·할 일',
  raw: '원본 자료 · 읽기만',
  rhino: 'Rhino 모델',
  cad: 'CAD 도면',
  review: 'jig 결과·검토용 보고서',
  output: '보고용 산출물',
  snapshots: '검토본',
  references: '레퍼런스',
  tools: '프로젝트 jig·스크립트',
  archive: '이전 판 보관',
};

export interface GuideInfo {
  /** The project's name (the manifest title, else the folder name). */
  name: string;
  cfg: WorkspaceConfig;
  /** Text the template gives for this file's section (`readme` / `agents`), placed at its end. */
  extra?: string;
}

const fence = (value: string) => '`' + value.replace(/`/g, "'") + '`';

/** The VIDE-owned section of one guide file, markers included. */
export function videBlock(file: GuideFile, { name, cfg, extra }: GuideInfo): string {
  const { roles } = layoutOf(cfg);
  const lines: string[] = [VIDE_BLOCK_START];
  lines.push(
    file === 'AGENTS.md' ? `## VIDE 작업 폴더 — ${name}` : `## ${name}`,
    '',
    file === 'AGENTS.md'
      ? '이 폴더는 VIDE 프로젝트의 작업 폴더입니다. 폴더의 쓰임은 아래 역할 표가 정하며, 정본은 `project.config.json`의 `paths`입니다. 폴더 이름을 짐작하지 말고 이 표(또는 `project.config.json`)를 따르세요.'
      : '이 폴더는 VIDE가 만든 프로젝트 폴더입니다. 각 폴더의 쓰임은 아래와 같고, 정본은 `project.config.json`의 `paths`입니다.',
    '',
    '| 폴더 | 쓰임 |',
    '|---|---|',
  );
  for (const role of WORKSPACE_ROLES) {
    const path = roles[role];
    if (path) lines.push(`| ${fence(path)} | ${ROLE_USES[role]} |`);
  }
  lines.push('');
  lines.push(
    '- 원본 자료와 서버의 모델·도면은 고치지 않습니다. 모델은 체크아웃한 사본에서 작업하고, 서버에는 사람이 [서버에 반영]을 눌러 올립니다.',
  );
  const server = cfg.schema === 'vide-workspace/1' ? cfg.server : null;
  if (server?.root) {
    const remembered = WORKSPACE_ROLES.filter((role) => server.paths?.[role]).map(
      (role) => `${ROLE_USES[role]}=${fence(server.paths[role]!)}`,
    );
    lines.push(
      `- 연결된 서버 폴더: ${fence(server.root)}` +
        (remembered.length
          ? ` · 기억한 폴더 역할: ${remembered.join(', ')}`
          : ' · 아직 기억한 폴더 역할이 없습니다.'),
    );
  } else lines.push('- 연결된 서버 폴더가 없습니다.');
  if (file === 'AGENTS.md')
    lines.push(
      '- VIDE가 켜져 있으면 이 폴더의 터미널에서 `vide` 명령으로 역할 경로·jig 목록을 조회하고 jig를 실행합니다(`vide --help`). 쓰기는 이 폴더 안으로만 허용됩니다.',
    );
  if (extra?.trim()) lines.push('', extra.trim());
  lines.push(VIDE_BLOCK_END);
  return lines.join('\n');
}

/**
 * `text` with its VIDE section replaced by `block` (only the first marked section; text outside
 * kept byte for byte), or `block` appended at the end when the text has no complete section.
 */
export function upsertVideBlock(text: string, block: string): string {
  const start = text.indexOf(VIDE_BLOCK_START);
  const end = start < 0 ? -1 : text.indexOf(VIDE_BLOCK_END, start);
  if (start >= 0 && end >= 0)
    return text.slice(0, start) + block + text.slice(end + VIDE_BLOCK_END.length);
  if (!text.trim()) return block + '\n';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return text.replace(/\s*$/, '') + eol + eol + block + eol;
}

async function readText(file: string) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Writes a file through a temporary file renamed over it (no half-written guide). */
async function writeAtomic(file: string, text: string) {
  const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, text, 'utf8');
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Creates or refreshes `README.md` and `AGENTS.md` in `root`: only the VIDE section changes. A
 * file whose section is already the same is not written. Returns the files written.
 */
export async function writeGuideFiles(
  root: string,
  info: { name: string; cfg: WorkspaceConfig; readme?: string; agents?: string },
): Promise<GuideFile[]> {
  const written: GuideFile[] = [];
  for (const file of GUIDE_FILES) {
    const path = join(root, file);
    const current = await readText(path);
    const block = videBlock(file, {
      name: info.name,
      cfg: info.cfg,
      extra: file === 'README.md' ? info.readme : info.agents,
    });
    const next =
      current === null ? `# ${info.name}\n\n${block}\n` : upsertVideBlock(current, block);
    if (next === current) continue;
    await writeAtomic(path, next);
    written.push(file);
  }
  return written;
}
