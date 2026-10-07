// Document text into excerpts without Python (SPEC-08.9 2, PLAN-42 기본값 3): plain text, mail
// (eml), DOCX·PPTX·XLSX·HWPX (ZIP + XML), HWP 5.x (CFB records) and the PDF text layer. Each file
// ends in a status kept on its source row; one bad file never stops the run.
import { readFile, stat } from 'node:fs/promises';
import { Zip, ZipError } from './zip.ts';
import { CFB_SIGNATURE } from './cfb.ts';
import { HwpError, hwpSections } from './hwp.ts';
import { PdfError, pdfPages } from './pdf.ts';
import { readMail, type Mail } from './mail.ts';

export interface Excerpt {
  locator: string;
  text: string;
  kind: string;
}
/**
 * The result of one file: `done` (read; may have no excerpts), `size` (over the size limit),
 * `encrypted`, `distribution` (HWP 배포용), `no-text` (a scan), `unsupported` (old or unknown
 * format), `no-reader` (the reader is not installed), `error`.
 */
export type FileStatus =
  | 'done'
  | 'size'
  | 'encrypted'
  | 'distribution'
  | 'no-text'
  | 'unsupported'
  | 'no-reader'
  | 'no-zwcad'
  | 'timeout'
  | 'error';
export interface Extracted {
  status: FileStatus;
  excerpts: Excerpt[];
  mail?: Mail;
  error?: string;
}

/** Files larger than this are not read (status `size`). */
export const DOCUMENT_MAX_BYTES = 100 * 1024 * 1024;
const MAX = 1200;

/** Splits on blank lines and packs paragraphs up to 1,200 characters (the spike's chunks). */
export function chunk(text: string, locator: string, kind = 'text', head = ''): Excerpt[] {
  const out: string[] = [];
  let buf = '';
  const max = MAX - head.length;
  for (let p of text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    while (p.length > max) {
      const cut = Math.max(p.lastIndexOf('. ', max), p.lastIndexOf('\n', max), max >> 1);
      out.push(p.slice(0, cut + 1).trim());
      p = p.slice(cut + 1).trim();
    }
    if (buf && buf.length + p.length + 1 > max) {
      out.push(buf);
      buf = '';
    }
    buf = buf ? buf + '\n' + p : p;
  }
  if (buf) out.push(buf);
  const parts = out.filter((c) => c.replace(/\s/g, '').length >= 4);
  return parts.map((t, i) => ({
    locator: parts.length > 1 ? `${locator}#${i + 1}` : locator,
    text: head ? `${head}\n${t}` : t,
    kind,
  }));
}

const entities = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
/** The text of an XML fragment: tags dropped, entities decoded. */
const plainXml = (xml: string) => entities(xml.replace(/<[^>]+>/g, ''));

/** Word-like XML (w: or hp: or a:) → paragraphs; table cells kept on one line with ' | '. */
function wordText(xml: string, ns: 'w' | 'hp' | 'a') {
  let s = xml
    .replace(new RegExp(`<${ns}:(instrText|delText)\\b[\\s\\S]*?</${ns}:\\1>`, 'g'), '')
    .replace(new RegExp(`<${ns}:tab\\b[^>]*/>`, 'g'), '\t')
    .replace(new RegExp(`<${ns}:(br|lineBreak)\\b[^>]*/>`, 'g'), '\n');
  // Inside a cell, paragraphs are joined by spaces; cells by ' | ', rows end a line.
  s = s.replace(new RegExp(`<${ns}:tc\\b[\\s\\S]*?</${ns}:tc>`, 'g'), (cell) =>
    cell.replace(new RegExp(`</${ns}:p>`, 'g'), ' ').concat(' | '),
  );
  s = s.replace(new RegExp(`</${ns}:tr>`, 'g'), '\n\n');
  s = s.replace(new RegExp(`</${ns}:p>`, 'g'), '\n\n');
  return plainXml(s)
    .replace(/[ \t]+\|/g, ' |')
    .replace(/[ \t]*\|\s*\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function docx(zip: Zip): Excerpt[] {
  const out = chunk(wordText(zip.text('word/document.xml'), 'w'), 'body', 'text');
  if (zip.has('word/comments.xml'))
    for (const line of wordText(zip.text('word/comments.xml'), 'w').split(/\n\n/))
      if (line.trim()) out.push({ locator: 'comment', text: line.trim(), kind: 'comment' });
  return out;
}
function pptx(zip: Zip): Excerpt[] {
  const slides = zip
    .names()
    .map((name) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(name))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  const out: Excerpt[] = [];
  for (const [name, number] of slides) {
    out.push(...chunk(wordText(zip.text(name), 'a'), `slide${number}`, 'slide'));
    const notes = `ppt/notesSlides/notesSlide${number}.xml`;
    if (zip.has(notes))
      out.push(...chunk(wordText(zip.text(notes), 'a'), `slide${number}/notes`, 'notes'));
  }
  return out;
}
function hwpx(zip: Zip): Excerpt[] {
  if (zip.has('META-INF/manifest.xml') && /encryption-data/.test(zip.text('META-INF/manifest.xml')))
    throw new ZipError('ENCRYPTED');
  return zip
    .names()
    .map((name) => /^Contents\/section(\d+)\.xml$/.exec(name))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .flatMap(([name, n]) => chunk(wordText(zip.text(name), 'hp'), `section${n}`, 'text'));
}

const column = (ref: string) => {
  let n = 0;
  for (const c of /^[A-Z]+/.exec(ref)?.[0] ?? 'A') n = n * 26 + c.charCodeAt(0) - 64;
  return n - 1;
};
/**
 * XLSX: shared strings, inline strings and cached formula values; a row keeps its column places
 * (empty cells stay as empty places), and every excerpt of a sheet starts with its first row.
 */
function xlsx(zip: Zip): Excerpt[] {
  const shared = zip.has('xl/sharedStrings.xml')
    ? [...zip.text('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
        [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => entities(t[1])).join(''),
      )
    : [];
  const rels = new Map(
    zip.has('xl/_rels/workbook.xml.rels')
      ? [...zip.text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
          /Id="([^"]+)"/.exec(m[0])?.[1] ?? '',
          (/Target="([^"]+)"/.exec(m[0])?.[1] ?? '').replace(/^\/?(xl\/)?/, 'xl/'),
        ])
      : [],
  );
  const sheets = [...zip.text('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)].map((m, i) => ({
    name: entities(/name="([^"]*)"/.exec(m[0])?.[1] ?? `Sheet${i + 1}`),
    path: rels.get(/r:id="([^"]+)"/.exec(m[0])?.[1] ?? '') ?? `xl/worksheets/sheet${i + 1}.xml`,
  }));
  const out: Excerpt[] = [];
  for (const sheet of sheets) {
    if (!zip.has(sheet.path)) continue;
    const rows: string[][] = [];
    for (const row of zip.text(sheet.path).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attributes = cell[1],
          inner = cell[2] ?? '';
        const ref = /r="([A-Z]+)\d+"/.exec(attributes)?.[1];
        const type = /t="([^"]+)"/.exec(attributes)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let value =
          type === 's'
            ? (shared[Number(v)] ?? '')
            : type === 'inlineStr'
              ? plainXml(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '')
              : type === 'b'
                ? v === '1'
                  ? 'TRUE'
                  : 'FALSE'
                : entities(v ?? '');
        value = value.replace(/\s+/g, ' ').trim();
        const at = ref ? column(ref) : cells.length;
        while (cells.length < at) cells.push('');
        cells[at] = value;
      }
      if (cells.some(Boolean)) rows.push(cells);
    }
    if (!rows.length) continue;
    const first = Math.min(...rows.map((r) => r.findIndex(Boolean)));
    const lines = rows.map((r) =>
      r
        .slice(first)
        .join(' | ')
        .replace(/[ |]+$/, ''),
    );
    const [head, ...body] = lines;
    out.push(
      ...(body.length
        ? chunk(body.join('\n\n'), `sheet:${sheet.name}`, 'sheet', head)
        : chunk(head, `sheet:${sheet.name}`, 'sheet')),
    );
  }
  return out;
}

function plainText(bytes: Buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    try {
      return new TextDecoder('euc-kr').decode(bytes);
    } catch {
      return bytes.toString('utf8');
    }
  }
}

/** Formats read here, by file extension. */
export const READABLE = new Set([
  'txt',
  'md',
  'csv',
  'eml',
  'docx',
  'docm',
  'pptx',
  'xlsx',
  'xlsm',
  'hwpx',
  'hwp',
  'pdf',
]);
/** Recorded but not read: old Office formats and Outlook messages. */
export const UNREAD = new Set(['doc', 'ppt', 'xls', 'msg']);

/** Reads one file (read only) into excerpts and a status. Never throws. */
export async function extractFile(path: string, ext: string): Promise<Extracted> {
  try {
    const info = await stat(path);
    if (info.size > DOCUMENT_MAX_BYTES) return { status: 'size', excerpts: [] };
    if (!READABLE.has(ext)) return { status: 'unsupported', excerpts: [] };
    return await extractBytes(await readFile(path), ext);
  } catch (error) {
    return { status: 'error', excerpts: [], error: String((error as Error)?.message ?? error) };
  }
}

/** Reads one document's bytes; the status says what happened. Never throws. */
export async function extractBytes(bytes: Buffer, ext: string): Promise<Extracted> {
  try {
    switch (ext) {
      case 'txt':
      case 'md':
      case 'csv':
        return { status: 'done', excerpts: chunk(plainText(bytes), 'body') };
      case 'eml': {
        const mail = readMail(bytes);
        return { status: 'done', excerpts: chunk(mail.body, 'body', 'mail'), mail };
      }
      case 'hwp': {
        const sections = hwpSections(bytes);
        return {
          status: 'done',
          excerpts: sections.flatMap((s) => chunk(s.text, `section${s.section}`)),
        };
      }
      case 'pdf': {
        const pages = await pdfPages(bytes);
        if (!pages.some((page) => page.replace(/\s/g, '').length))
          return { status: 'no-text', excerpts: [] };
        return {
          status: 'done',
          excerpts: pages.flatMap((text, i) => chunk(text, `p.${i + 1}`, 'page')),
        };
      }
      default: {
        // A password-protected Office file is a CFB container, not a ZIP.
        if (bytes.subarray(0, 8).equals(CFB_SIGNATURE))
          return { status: 'encrypted', excerpts: [] };
        const zip = new Zip(bytes);
        const excerpts =
          ext === 'pptx'
            ? pptx(zip)
            : ext === 'xlsx' || ext === 'xlsm'
              ? xlsx(zip)
              : ext === 'hwpx'
                ? hwpx(zip)
                : docx(zip);
        return { status: 'done', excerpts };
      }
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (error instanceof HwpError)
      return {
        status:
          code === 'ENCRYPTED' ? 'encrypted' : code === 'DISTRIBUTION' ? 'distribution' : 'error',
        excerpts: [],
        error: code,
      };
    if (error instanceof PdfError)
      return {
        status: code === 'ENCRYPTED' ? 'encrypted' : code === 'NO_READER' ? 'no-reader' : 'error',
        excerpts: [],
        error: code,
      };
    if (error instanceof ZipError && code === 'ENCRYPTED')
      return { status: 'encrypted', excerpts: [] };
    return { status: 'error', excerpts: [], error: String((error as Error)?.message ?? error) };
  }
}
