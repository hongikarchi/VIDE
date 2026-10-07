// A minimal MIME reader for .eml files (SPEC-08.9 2), ported from the knowledge-crawl spike
// (tools/spikes/2026-09-29-knowledge-crawl/mail.mjs): headers, the readable body without the
// quoted reply history, and attachment names and hashes.
import { createHash } from 'node:crypto';

const decoderFor = (charset = 'utf-8') => {
  try {
    return new TextDecoder(charset.toLowerCase().replace(/^3d/, ''));
  } catch {
    return new TextDecoder('utf-8');
  }
};
const qp = (text: string) =>
  Buffer.from(
    text
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
    'latin1',
  );

/** RFC 2047 encoded words (=?charset?B|Q?...?=) inside a header value. */
export const decodeWords = (value = '') =>
  // Some mail programs send raw UTF-8 in headers (read here as latin1 bytes).
  (/[\x80-\xff]/.test(value) ? Buffer.from(value, 'latin1').toString('utf8') : value)
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(
      /=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi,
      (_, charset: string, encoding: string, text: string) =>
        decoderFor(charset).decode(
          encoding.toUpperCase() === 'B'
            ? Buffer.from(text, 'base64')
            : qp(text.replace(/_/g, ' ')),
        ),
    );

function headers(block: string) {
  const out: Record<string, string> = {};
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] ??= line.slice(i + 1).trim();
  }
  return out;
}
const param = (value = '', name: string) => {
  const star = value.match(new RegExp(`${name}\\*=([^;]+)`, 'i'));
  if (star) {
    const [, charset, , text] =
      star[1]
        .trim()
        .replace(/^"|"$/g, '')
        .match(/^([^']*)'([^']*)'(.*)$/) ?? [];
    if (text !== undefined)
      try {
        return decoderFor(charset || 'utf-8').decode(
          Buffer.from(decodeURIComponent(text), 'latin1'),
        );
      } catch {
        /* A malformed value: the plain parameter below. */
      }
  }
  const plain = value.match(new RegExp(`${name}=("([^"]*)"|[^;\\s]+)`, 'i'));
  return plain ? decodeWords(plain[2] ?? plain[1]) : undefined;
};

interface Part {
  type: string;
  charset?: string;
  disposition: string;
  filename?: string;
  bytes: Buffer;
}
function parts(raw: string, out: Part[] = [], depth = 0): Part[] {
  const split = raw.search(/\r?\n\r?\n/);
  const head = headers(split < 0 ? raw : raw.slice(0, split));
  const body = split < 0 ? '' : raw.slice(split).replace(/^\r?\n\r?\n/, '');
  const type = head['content-type'] ?? 'text/plain';
  const boundary = param(type, 'boundary');
  if (/^multipart\//i.test(type) && boundary && depth < 20) {
    for (const piece of body.split('--' + boundary).slice(1))
      if (!piece.startsWith('--')) parts(piece.replace(/^\r?\n/, ''), out, depth + 1);
    return out;
  }
  const encoding = (head['content-transfer-encoding'] ?? '').toLowerCase();
  const bytes =
    encoding === 'base64'
      ? Buffer.from(body.replace(/\s+/g, ''), 'base64')
      : encoding === 'quoted-printable'
        ? qp(body)
        : Buffer.from(body, 'latin1');
  out.push({
    type: type.split(';')[0].trim().toLowerCase(),
    charset: param(type, 'charset'),
    disposition: head['content-disposition'] ?? '',
    filename: param(head['content-disposition'], 'filename') ?? param(type, 'name'),
    bytes,
  });
  return out;
}

const htmlText = (html: string) =>
  html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const address = (value = '') =>
  decodeWords(value)
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((a) => {
      const m = a.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
      return m
        ? { name: m[1].trim(), addr: m[2].trim().toLowerCase() }
        : { name: '', addr: a.trim().toLowerCase() };
    })
    .filter((a) => a.addr);

// Reply history starts at these markers; forwarded bodies keep everything.
const QUOTE =
  /^\s*(-{2,}\s*(Original Message|원본 메시지|Forwarded message)|보낸 사람\s*:|From\s*:\s|.{0,80}(wrote|작성)\s*:\s*$)/im;

export interface Mail {
  messageId: string;
  inReplyTo: string;
  refs: string;
  thread: string;
  sentAt: string | null;
  from: { name: string; addr: string };
  to: { name: string; addr: string }[];
  cc: { name: string; addr: string }[];
  subject: string;
  body: string;
  attachments: { filename: string; size: number; sha256: string }[];
}

export function readMail(buffer: Buffer): Mail {
  const raw = buffer.toString('latin1');
  const split = raw.search(/\r?\n\r?\n/);
  const head = headers(split < 0 ? raw : raw.slice(0, split));
  const leaves = parts(raw);
  const plain = leaves.find((p) => p.type === 'text/plain' && !/attachment/i.test(p.disposition));
  const html = leaves.find((p) => p.type === 'text/html' && !/attachment/i.test(p.disposition));
  let body = plain ? decoderFor(plain.charset).decode(plain.bytes).trim() : '';
  if (body.length < 20 && html) body = htmlText(decoderFor(html.charset).decode(html.bytes));
  const subject = decodeWords(head.subject ?? '');
  const isReply = /^\s*(re|회신|답장)\s*:/i.test(subject);
  const quote = body.slice(1).search(QUOTE);
  const own = isReply && quote > 0 ? body.slice(0, quote + 1).trim() : body;
  const refs = (head.references ?? '').match(/<[^>]+>/g) ?? [];
  const messageId = (head['message-id'] ?? '').match(/<[^>]+>/)?.[0] ?? '';
  const inReplyTo = (head['in-reply-to'] ?? '').match(/<[^>]+>/)?.[0] ?? '';
  const date = new Date(head.date ?? '');
  return {
    messageId,
    inReplyTo,
    refs: refs.join(' '),
    thread: refs[0] ?? (inReplyTo || messageId),
    sentAt: Number.isNaN(date.getTime()) ? null : date.toISOString(),
    from: address(head.from)[0] ?? { name: '', addr: '' },
    to: address(head.to),
    cc: address(head.cc),
    subject,
    body: own,
    attachments: leaves
      .filter((p) => p.filename || /attachment/i.test(p.disposition))
      .filter((p) => !(p.type.startsWith('image/') && /inline/i.test(p.disposition)))
      .map((p) => ({
        filename: p.filename ?? '',
        size: p.bytes.length,
        sha256: createHash('sha256').update(p.bytes).digest('hex'),
      })),
  };
}
