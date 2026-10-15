/**
 * 메일 `.eml`·`.mbox` (PLAN-53 T-330, ARCH-01 §5 「프로젝트 기록」 '가져오기'). Pure, no node
 * imports (`atob`, `TextDecoder` only). One `.eml` is one mail; an `.mbox` is split at its
 * `From ` lines. Headers are unfolded and their encoded words (`=?charset?B|Q?…?=`) decoded; a
 * body in base64 or quoted-printable is decoded in its charset (utf-8, euc-kr/cp949 and what
 * `TextDecoder` knows; another charset reads as `(글자 깨짐)`). A multipart mail gives its
 * `text/plain` part, else its `text/html` as text; attachments give their names only. Quoted
 * text (`>` lines, below "On … wrote:", "-----Original Message-----", "보낸 사람:") and the
 * signature below `-- ` are folded away. `line` is the first line of the mail in the file.
 */

export interface MailMessage {
  /** Message-ID without the angle brackets; null when the mail has none. */
  messageId: string | null;
  /** The first id of In-Reply-To without the angle brackets. */
  inReplyTo: string | null;
  /** 'YYYY-MM-DD' local (the import day when the Date header is missing or unreadable). */
  date: string;
  /** 'HH:MM' local, or null when the Date header is missing or unreadable. */
  time: string | null;
  from: string;
  subject: string;
  /** The first paragraph of the body (quotes and signature removed). */
  text: string;
  /** The body with quotes and signature removed. */
  full: string;
  attachmentsNames: string[];
  /** The mail's first line in the file (1-based). */
  line: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
const localTime = (at: Date) => `${pad(at.getHours())}:${pad(at.getMinutes())}`;

// ---- bytes and charsets ----

const CHARSET_ALIAS: Record<string, string> = {
  cp949: 'euc-kr',
  ms949: 'euc-kr',
  'x-windows-949': 'euc-kr',
  'ks_c_5601-1987': 'euc-kr',
  utf8: 'utf-8',
};
/** Bytes in a charset → text; null when the charset is unknown. */
function decodeBytes(bytes: Uint8Array, charset: string | undefined): string | null {
  const name = (charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  try {
    return new TextDecoder(CHARSET_ALIAS[name] ?? name).decode(bytes);
  } catch {
    return null;
  }
}
/** A JS string whose characters are bytes (latin1) → bytes; other characters as UTF-8. */
function bytesOf(text: string): Uint8Array {
  const out: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x100) out.push(code);
    else out.push(...new TextEncoder().encode(char));
  }
  return Uint8Array.from(out);
}
function base64Bytes(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/=]/g, '');
  const padded = clean.replace(/=+$/, '');
  try {
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}
function quotedPrintableBytes(text: string, header = false): Uint8Array {
  const source = header ? text.replace(/_/g, ' ') : text.replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    const hex = char === '=' ? /^[0-9A-Fa-f]{2}/.exec(source.slice(i + 1, i + 3)) : null;
    if (hex) {
      out.push(parseInt(hex[0], 16));
      i += 2;
    } else out.push(...bytesOf(char));
  }
  return Uint8Array.from(out);
}
const BROKEN = '(글자 깨짐)';

/** `=?charset?B|Q?…?=` words of a header; adjacent words join without the space between. */
export function decodeWords(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(
      /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
      (_all, charset: string, mode: string, data: string) => {
        const bytes = /b/i.test(mode) ? base64Bytes(data) : quotedPrintableBytes(data, true);
        return decodeBytes(bytes, charset.replace(/\*.*$/, '')) ?? BROKEN;
      },
    );
}

// ---- headers ----

interface Part {
  headers: Map<string, string>;
  body: string;
}
function splitPart(text: string): Part {
  const at = /\r?\n\r?\n/.exec(text);
  const head = at ? text.slice(0, at.index) : text;
  const body = at ? text.slice(at.index + at[0].length) : '';
  const headers = new Map<string, string>();
  let last: string | null = null;
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && last) {
      headers.set(last, headers.get(last)! + ' ' + line.trim());
      continue;
    }
    const field = /^([!-9;-~]+):\s?(.*)$/.exec(line);
    if (!field) continue;
    last = field[1]!.toLowerCase();
    // The first of a repeated header stands (Received … repeats; the ones read here do not).
    if (!headers.has(last)) headers.set(last, field[2]!.trim());
    else last = null;
  }
  return { headers, body };
}
/** `text/plain; charset="utf-8"` → {type, params}. */
function contentType(value: string | undefined) {
  const [type = 'text/plain', ...rest] = (value ?? 'text/plain').split(';');
  const params: Record<string, string> = {};
  for (const item of rest) {
    const eq = item.indexOf('=');
    if (eq < 0) continue;
    const key = item.slice(0, eq).trim().toLowerCase();
    params[key] = item
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
  }
  return { type: type.trim().toLowerCase(), params };
}
/** An RFC 2231 `filename*=utf-8''…` value. */
function extendedValue(value: string) {
  const parts = /^([^']*)'[^']*'(.*)$/.exec(value);
  if (!parts) return value;
  try {
    return decodeBytes(quotedPrintableBytes(parts[2]!.replace(/%/g, '=')), parts[1]) ?? value;
  } catch {
    return value;
  }
}
function fileName(part: Part): string | null {
  const disposition = contentType(part.headers.get('content-disposition'));
  const type = contentType(part.headers.get('content-type'));
  const raw =
    (disposition.params['filename*'] && extendedValue(disposition.params['filename*'])) ||
    disposition.params.filename ||
    (type.params['name*'] && extendedValue(type.params['name*'])) ||
    type.params.name;
  return raw ? decodeWords(raw) : null;
}

/** A leaf part's body as text in its charset. */
function bodyText(part: Part): string {
  const encoding = (part.headers.get('content-transfer-encoding') ?? '').trim().toLowerCase();
  const { params } = contentType(part.headers.get('content-type'));
  if (encoding === 'base64' || encoding === 'quoted-printable') {
    const bytes = encoding === 'base64' ? base64Bytes(part.body) : quotedPrintableBytes(part.body);
    return decodeBytes(bytes, params.charset) ?? BROKEN;
  }
  // 7bit/8bit: already text (the page read the file as UTF-8).
  return part.body;
}

/** The text/plain and text/html bodies and the attachment names of a part, depth first. */
function walk(part: Part, found: { plain?: string; html?: string; names: string[] }, depth = 0) {
  const type = contentType(part.headers.get('content-type'));
  const disposition = (part.headers.get('content-disposition') ?? '').toLowerCase();
  const name = fileName(part);
  if (type.type.startsWith('multipart/') && type.params.boundary && depth < 10) {
    const boundary = '--' + type.params.boundary;
    const pieces = part.body.split(/\r?\n/);
    let current: string[] | null = null;
    const children: string[] = [];
    for (const line of pieces) {
      if (line.startsWith(boundary)) {
        if (current) children.push(current.join('\n'));
        if (line.startsWith(boundary + '--')) {
          current = null;
          break;
        }
        current = [];
      } else if (current) current.push(line);
    }
    if (current) children.push(current.join('\n'));
    for (const child of children) walk(splitPart(child), found, depth + 1);
    return;
  }
  if (type.type === 'message/rfc822') {
    if (name) found.names.push(name);
    return;
  }
  if (disposition.startsWith('attachment') || (name && !type.type.startsWith('text/'))) {
    if (name) found.names.push(name);
    return;
  }
  if (type.type === 'text/plain' && found.plain === undefined) found.plain = bodyText(part);
  else if (type.type === 'text/html' && found.html === undefined) found.html = bodyText(part);
  else if (name) found.names.push(name);
}

/** HTML → its text (no tags, scripts or styles; blocks on their own lines). */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_all, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_all, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** Where quoted text starts (the reply's own text is above it). */
const QUOTE_START = [
  /^On\b.*\bwrote:\s*$/i,
  /^-{2,}\s*(?:Original Message|원본 메시지|Forwarded message|전달된 메시지)\s*-{2,}\s*$/i,
  /^(?:보낸 사람|From)\s*:\s*\S/,
  /^\d{4}[.\-/년].*(?:작성|wrote)[:：]?\s*$/,
];
/** The body without quoted lines, the quoted tail and the signature. */
export function ownText(body: string): string {
  const lines = body.replace(/\r/g, '').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (line === '-- ' || line === '--') break;
    if (QUOTE_START.some((rule) => rule.test(line.trim()))) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line.replace(/\s+$/, ''));
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
const firstParagraph = (text: string) =>
  (text.split(/\n\s*\n/).find((block) => block.trim()) ?? '').trim();

const angle = (value: string | undefined) => {
  if (!value) return null;
  const inside = /<([^>]+)>/.exec(value);
  const id = (inside ? inside[1]! : value).trim().replace(/\s+/g, '');
  return id ? id.slice(0, 500) : null;
};

function readMail(text: string, line: number, now: Date): MailMessage {
  const part = splitPart(text);
  const found: { plain?: string; html?: string; names: string[] } = { names: [] };
  walk(part, found);
  const body = found.plain ?? (found.html !== undefined ? htmlText(found.html) : '');
  const full = ownText(body);
  const sent = part.headers.get('date');
  const at = sent ? new Date(sent.replace(/\s*\([^)]*\)\s*$/, '')) : null;
  const valid = at && !Number.isNaN(at.getTime()) ? at : null;
  return {
    messageId: angle(part.headers.get('message-id')),
    inReplyTo: angle(part.headers.get('in-reply-to')),
    date: localDay(valid ?? now),
    time: valid ? localTime(valid) : null,
    from: decodeWords(part.headers.get('from') ?? '').trim(),
    subject: decodeWords(part.headers.get('subject') ?? '').trim(),
    text: firstParagraph(full),
    full,
    attachmentsNames: found.names,
    line,
  };
}

/** One `.eml` (or every mail of an `.mbox`, split at its `From ` lines). */
export function parseMail(input: string, name = '', now: Date = new Date()): MailMessage[] {
  const text = input.replace(/^\uFEFF/, '');
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  const mbox = /\.mbox$/i.test(name) || /^From \S/.test(lines[0] ?? '');
  const mails: MailMessage[] = [];
  if (!mbox) {
    const start = lines.findIndex((line) => line.trim());
    if (start < 0) return [];
    const mail = readMail(lines.slice(start).join('\n'), start + 1, now);
    return mail.from || mail.subject || mail.full ? [mail] : [];
  }
  let from = -1;
  const flush = (end: number) => {
    if (from < 0) return;
    // `>From ` inside a body is mboxrd quoting.
    const body = lines
      .slice(from + 1, end)
      .map((line) => line.replace(/^>(>*From )/, '$1'))
      .join('\n');
    if (body.trim()) {
      const mail = readMail(body, from + 1, now);
      if (mail.from || mail.subject || mail.full) mails.push(mail);
    }
  };
  lines.forEach((line, index) => {
    if (/^From \S/.test(line) && (index === 0 || !lines[index - 1]!.trim() || from < 0)) {
      flush(index);
      from = index;
    }
  });
  flush(lines.length);
  return mails;
}
