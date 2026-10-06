import * as Y from 'yjs';

/**
 * Shared project notes (SPEC-10, ADR-034): the Yjs document of one note and what the site, the
 * PC and the AI read from it. The editor (TipTap Collaboration) keeps its ProseMirror tree in the
 * XML fragment `default`: an element per block node (`paragraph`, `heading` {level},
 * `bulletList`, `orderedList`, `listItem`, `taskList`, `taskItem` {checked}, `blockquote`,
 * `codeBlock`, `horizontalRule`, `hardBreak`) and text with its marks as formatting attributes.
 */
export const NOTE_FIELD = 'default';
export const NOTE_KINDS = ['note', 'discussion', 'journal'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_KIND_LABEL: Record<NoteKind, string> = {
  note: '노트',
  discussion: '협의 사항',
  journal: '일지',
};
/** Markdown kept in D1 and the PC copy is cut here (a D1 row stays far below its 2 MB limit). */
export const NOTE_SNAPSHOT_MAX = 400_000;

export interface NoteMeta {
  id: string;
  projectId: string;
  title: string;
  kind: NoteKind;
  journalDate: string | null;
  updatedAt: number;
  updatedBy: string | null;
  updatedByName?: string | null;
  createdAt: number;
  revision: number;
  deleted?: boolean;
}

type Attrs = Record<string, unknown>;
interface Delta {
  insert?: unknown;
  attributes?: Attrs;
}

function inline(text: Y.XmlText) {
  return (text.toDelta() as Delta[])
    .map(({ insert, attributes = {} }) => {
      if (typeof insert !== 'string') return '';
      let value = insert;
      if (attributes.code) value = '`' + value + '`';
      if (attributes.bold) value = `**${value}**`;
      if (attributes.italic) value = `*${value}*`;
      if (attributes.strike) value = `~~${value}~~`;
      const link = attributes.link as { href?: unknown } | undefined;
      if (link && typeof link.href === 'string') value = `[${value}](${link.href})`;
      return value;
    })
    .join('');
}
/** The text of a block's children (text runs and hard breaks). */
function textOf(element: Y.XmlElement | Y.XmlFragment): string {
  return element
    .toArray()
    .map((child) =>
      child instanceof Y.XmlText
        ? inline(child)
        : child instanceof Y.XmlElement && child.nodeName === 'hardBreak'
          ? '\n'
          : child instanceof Y.XmlElement
            ? textOf(child)
            : '',
    )
    .join('');
}
function blocks(nodes: Array<Y.XmlElement | Y.XmlText | Y.XmlHook>, indent: string): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node instanceof Y.XmlText) {
      const value = inline(node);
      if (value) out.push(indent + value);
      continue;
    }
    if (!(node instanceof Y.XmlElement)) continue;
    const children = node.toArray();
    switch (node.nodeName) {
      case 'heading': {
        const level = Math.min(6, Math.max(1, Number(node.getAttribute('level' as never)) || 1));
        out.push(indent + '#'.repeat(level) + ' ' + textOf(node));
        break;
      }
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        children.forEach((item, index) => {
          if (!(item instanceof Y.XmlElement)) return;
          const checked = item.getAttribute('checked' as never) as unknown;
          const mark =
            node.nodeName === 'orderedList'
              ? `${index + 1}. `
              : node.nodeName === 'taskList' || item.nodeName === 'taskItem'
                ? `- [${checked === true || checked === 'true' ? 'x' : ' '}] `
                : '- ';
          const inner = blocks(item.toArray(), indent + '  ');
          const [first = '', ...rest] = inner;
          out.push(indent + mark + first.slice(indent.length + 2), ...rest);
        });
        break;
      case 'blockquote':
        for (const line of blocks(children, '')) out.push(indent + '> ' + line);
        break;
      case 'codeBlock':
        out.push(
          indent + '```',
          ...textOf(node)
            .split('\n')
            .map((l) => indent + l),
          indent + '```',
        );
        break;
      case 'horizontalRule':
        out.push(indent + '---');
        break;
      case 'paragraph':
        out.push(indent + textOf(node).replace(/\n/g, '\n' + indent));
        break;
      default:
        out.push(...blocks(children, indent));
    }
  }
  return out;
}

/** The note as Markdown (for listing, search, the PC copy and the AI). */
export function noteMarkdown(doc: Y.Doc): string {
  const fragment = doc.getXmlFragment(NOTE_FIELD);
  const lines = blocks(fragment.toArray(), '');
  // Blocks are separated by one empty line, list items stay together.
  const text = lines
    .reduce<string[]>((all, line, index) => {
      const list = /^\s*(- |\d+\. )/;
      if (index > 0 && !(list.test(line) && list.test(lines[index - 1]))) all.push('');
      all.push(line);
      return all;
    }, [])
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > NOTE_SNAPSHOT_MAX ? text.slice(0, NOTE_SNAPSHOT_MAX) : text;
}

/**
 * A new note's first, empty paragraph, made once by the server. An editor bound to an empty
 * document makes its own empty paragraph, and every client doing so would leave one each.
 */
export function ensureFirstBlock(doc: Y.Doc, origin?: unknown) {
  const fragment = doc.getXmlFragment(NOTE_FIELD);
  if (fragment.length) return false;
  doc.transact(() => fragment.insert(0, [new Y.XmlElement('paragraph')]), origin);
  return true;
}

/** Appends one paragraph per non-empty line at the end of the note (one Yjs transaction). */
export function appendParagraphs(doc: Y.Doc, text: string, origin?: unknown) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  if (!lines.length) return 0;
  doc.transact(() => {
    const fragment = doc.getXmlFragment(NOTE_FIELD);
    fragment.insert(
      fragment.length,
      lines.map((line) => {
        const paragraph = new Y.XmlElement('paragraph');
        const run = new Y.XmlText();
        run.insert(0, line);
        paragraph.insert(0, [run]);
        return paragraph;
      }),
    );
  }, origin);
  return lines.length;
}

/**
 * The open action items of a 협의 사항 note: its unchecked check-list items (`- [ ] …`), each
 * one line. Checked items and plain text are left out.
 */
export function actionItems(markdown: string): string[] {
  const items: string[] = [];
  for (const line of markdown.split('\n')) {
    const match = /^\s*- \[ \] (.+)$/.exec(line);
    const text = match?.[1].replace(/[*`~]/g, '').trim();
    if (text && !items.includes(text)) items.push(text.slice(0, 500));
  }
  return items;
}

/** A journal title: '10월 6일 (화) 일지'. */
export function journalTitle(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  const day = '일월화수목금토'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}월 ${d}일 (${day}) 일지`;
}
export const isDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value + 'T00:00:00Z'));
