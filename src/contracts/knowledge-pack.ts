// The organized project knowledge as the account site keeps it (ADR-037 3, ARCH-01 「팀 공유
// 프로젝트 층」): the crawler DB's tables the 자료 workspace and the AI's knowledge tools read, row by
// row. The PC that crawled uploads them; other PCs rebuild a knowledge DB of the same columns from
// them. Shared by the Worker (which accepts only these tables and columns) and the PC engine.

export interface KnowledgeTable {
  /** The column that identifies a row (its value is the row key on the site). */
  key: string;
  columns: readonly string[];
  /** Columns that hold integers or reals (the rest are text or null). */
  numbers: readonly string[];
}
export const KNOWLEDGE_TABLES = {
  meta: { key: 'key', columns: ['key', 'value'], numbers: [] },
  source: { key: 'id', columns: ['id', 'rel_path', 'skip'], numbers: ['id'] },
  excerpt: {
    key: 'id',
    columns: ['id', 'source_id', 'locator', 'text'],
    numbers: ['id', 'source_id'],
  },
  statement: {
    key: 'id',
    columns: [
      'id',
      'excerpt_id',
      'kind',
      'party',
      'subject',
      'content',
      'said_on',
      'quote',
      'quote_ok',
      'support_prob',
    ],
    numbers: ['id', 'excerpt_id', 'quote_ok', 'support_prob'],
  },
  party_alias: { key: 'alias', columns: ['alias', 'party'], numbers: [] },
  issue: {
    key: 'id',
    columns: ['id', 'discipline', 'title', 'status', 'summary', 'statements', 'note'],
    numbers: ['id', 'statements'],
  },
  statement_issue: {
    key: 'statement_id',
    columns: ['statement_id', 'issue_id', 'discipline'],
    numbers: ['statement_id', 'issue_id'],
  },
  brief: { key: 'scope', columns: ['scope', 'body'], numbers: [] },
} as const satisfies Record<string, KnowledgeTable>;
export type KnowledgeTableName = keyof typeof KNOWLEDGE_TABLES;
export const KNOWLEDGE_TABLE_NAMES = Object.keys(KNOWLEDGE_TABLES) as KnowledgeTableName[];
/** Rows per upload request, characters kept of one excerpt, text kept of one cell. */
export const KNOWLEDGE_ROWS_PER_REQUEST = 200;
export const KNOWLEDGE_EXCERPT_MAX = 20_000;
export const KNOWLEDGE_CELL_MAX = 60_000;
/** The site's limit of one project's AI instructions (src/ai/instructions/index.ts). */
export const SHARED_INSTRUCTIONS_MAX_BYTES = 8 * 1024;

export type KnowledgeRow = Record<string, string | number | null>;

/**
 * A row reduced to the table's columns, or undefined when it is not one: unknown columns, a key
 * missing, or a value of the wrong kind.
 */
export function knowledgeRow(table: KnowledgeTableName, value: unknown): KnowledgeRow | undefined {
  const spec: KnowledgeTable = KNOWLEDGE_TABLES[table];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !spec.columns.includes(key))) return undefined;
  const row: KnowledgeRow = {};
  for (const column of spec.columns) {
    const cell = input[column] ?? null;
    if (cell === null) row[column] = null;
    else if (spec.numbers.includes(column)) {
      if (typeof cell !== 'number' || !Number.isFinite(cell)) return undefined;
      row[column] = cell;
    } else {
      if (typeof cell !== 'string' || cell.length > KNOWLEDGE_CELL_MAX) return undefined;
      row[column] = cell;
    }
  }
  if (row[spec.key] === null) return undefined;
  return row;
}
