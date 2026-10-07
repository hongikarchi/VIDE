// Synthetic documents for the knowledge collector tests (SPEC-08.9): a small ZIP writer (DOCX,
// XLSX, PPTX, HWPX), a CFB writer with a mini stream (HWP 5.x), a one-page PDF with a text object,
// an .eml, and a fake AI runner that answers each collector prompt in its JSON shape.
import { crc32, deflateRawSync } from 'node:zlib';

/** A ZIP of `{name: text}` entries, deflated. */
export function zip(entries) {
  const locals = [],
    central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text, 'utf8');
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x800, 8);
    head.writeUInt16LE(8, 10);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(packed.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBytes.length, 28);
    head.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    central.push(head, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const xmlText = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
export const docx = (paragraphs, table) =>
  zip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml':
      `<?xml version="1.0"?><w:document ${W}><w:body>` +
      paragraphs
        .map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlText(p)}</w:t></w:r></w:p>`)
        .join('') +
      (table
        ? `<w:tbl>${table
            .map(
              (row) =>
                `<w:tr>${row.map((c) => `<w:tc><w:tcPr/><w:p><w:r><w:t>${xmlText(c)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`,
            )
            .join('')}</w:tbl>`
        : '') +
      '</w:body></w:document>',
  });
/** Rows of cells (null = empty); strings go to the shared strings, numbers stay numbers. */
export function xlsx(sheetName, rows) {
  const shared = [];
  const cells = rows
    .map(
      (row, r) =>
        `<row r="${r + 1}">${row
          .map((value, c) => {
            if (value === null) return '';
            const ref = String.fromCharCode(65 + c) + (r + 1);
            if (typeof value === 'number') return `<c r="${ref}"><f>1+1</f><v>${value}</v></c>`;
            shared.push(value);
            return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
          })
          .join('')}</row>`,
    )
    .join('');
  return zip({
    'xl/workbook.xml': `<workbook><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst>${shared.map((s) => `<si><t>${xmlText(s)}</t></si>`).join('')}</sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${cells}</sheetData></worksheet>`,
  });
}
export const pptx = (slides) =>
  zip(
    Object.fromEntries(
      slides.map((text, i) => [
        `ppt/slides/slide${i + 1}.xml`,
        `<p:sld><a:p><a:r><a:t>${xmlText(text)}</a:t></a:r></a:p></p:sld>`,
      ]),
    ),
  );
export const hwpx = (paragraphs) =>
  zip({
    mimetype: 'application/hwp+zip',
    'Contents/section0.xml': `<hs:sec>${paragraphs.map((p) => `<hp:p><hp:run><hp:t>${xmlText(p)}</hp:t></hp:run></hp:p>`).join('')}</hs:sec>`,
  });

// --- CFB (MS-CFB, version 3, 512-byte sectors) with a mini stream, for HWP 5.x ---------------
const END = 0xfffffffe,
  FREE = 0xffffffff,
  FATSECT = 0xfffffffd;
/**
 * A compound file of `streams` ({'FileHeader': Buffer, 'BodyText/Section0': Buffer}); one
 * storage level. Streams under 4,096 bytes live in the mini stream, as in real files.
 */
export function cfb(streams) {
  const entries = [{ name: 'Root Entry', type: 5, children: [] }];
  const storages = new Map();
  for (const [path, data] of Object.entries(streams)) {
    const [first, second] = path.split('/');
    let parent = entries[0];
    if (second) {
      if (!storages.has(first)) {
        const storage = { name: first, type: 1, children: [] };
        entries.push(storage);
        entries[0].children.push(storage);
        storages.set(first, storage);
      }
      parent = storages.get(first);
    }
    const stream = { name: second ?? first, type: 2, data, children: [] };
    entries.push(stream);
    parent.children.push(stream);
  }
  // Mini stream: small streams in 64-byte mini sectors.
  const mini = [],
    miniFat = [];
  for (const e of entries)
    if (e.type === 2 && e.data.length < 4096) {
      e.start = mini.length;
      const count = Math.max(1, Math.ceil(e.data.length / 64));
      for (let i = 0; i < count; i++) {
        mini.push(e.data.subarray(i * 64, i * 64 + 64));
        miniFat.push(i === count - 1 ? END : e.start + i + 1);
      }
    }
  const pad = (buffer, size) =>
    Buffer.concat([buffer, Buffer.alloc((size - (buffer.length % size)) % size)]);
  const miniStream = pad(Buffer.concat(mini.map((m) => pad(m, 64))), 512);
  const sectors = []; // { data, next }
  const chain = (buffer) => {
    if (!buffer.length) return END;
    const start = sectors.length;
    const count = Math.ceil(buffer.length / 512);
    for (let i = 0; i < count; i++)
      sectors.push({
        data: pad(buffer.subarray(i * 512, i * 512 + 512), 512),
        next: i === count - 1 ? END : start + i + 1,
      });
    return start;
  };
  // Sector 0 is the FAT (one sector is enough for these sizes).
  sectors.push({ data: null, next: FATSECT });
  const miniFatBytes = Buffer.alloc(miniFat.length * 4);
  miniFat.forEach((v, i) => miniFatBytes.writeUInt32LE(v, i * 4));
  const miniFatStart = chain(miniFatBytes);
  entries[0].start = chain(miniStream);
  entries[0].size = miniStream.length;
  for (const e of entries) if (e.type === 2 && e.data.length >= 4096) e.start = chain(e.data);
  // Directory: siblings as a right-leaning list under each parent.
  const index = new Map(entries.map((e, i) => [e, i]));
  const directory = Buffer.alloc(Math.ceil(entries.length / 4) * 512);
  entries.forEach((e, i) => {
    const at = i * 128;
    const name = Buffer.from(e.name + '\0', 'utf16le');
    name.copy(directory, at);
    directory.writeUInt16LE(name.length, at + 64);
    directory[at + 66] = e.type;
    directory[at + 67] = 1;
    directory.writeUInt32LE(FREE, at + 68);
    directory.writeUInt32LE(FREE, at + 72);
    directory.writeUInt32LE(e.children.length ? index.get(e.children[0]) : FREE, at + 76);
    directory.writeUInt32LE(e.start ?? END, at + 116);
    directory.writeUInt32LE(e.type === 2 ? e.data.length : (e.size ?? 0), at + 120);
  });
  for (const e of entries)
    e.children.forEach((child, k) => {
      const next = e.children[k + 1];
      if (next) directory.writeUInt32LE(index.get(next), index.get(child) * 128 + 72);
    });
  for (let i = entries.length; i < directory.length / 128; i++)
    directory.writeUInt32LE(FREE, i * 128 + 68);
  const directoryStart = chain(directory);
  const fat = Buffer.alloc(512, 0xff);
  sectors.forEach((s, i) => fat.writeUInt32LE(s.next, i * 4));
  sectors[0].data = fat;
  const header = Buffer.alloc(512);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(header, 0);
  header.writeUInt16LE(0x3e, 0x18);
  header.writeUInt16LE(3, 0x1a);
  header.writeUInt16LE(0xfffe, 0x1c);
  header.writeUInt16LE(9, 0x1e);
  header.writeUInt16LE(6, 0x20);
  header.writeUInt32LE(1, 0x2c);
  header.writeUInt32LE(directoryStart, 0x30);
  header.writeUInt32LE(4096, 0x38);
  header.writeUInt32LE(miniFat.length ? miniFatStart : END, 0x3c);
  header.writeUInt32LE(Math.ceil(miniFatBytes.length / 512), 0x40);
  header.writeUInt32LE(END, 0x44);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i === 0 ? 0 : FREE, 0x4c + i * 4);
  return Buffer.concat([header, ...sectors.map((s) => s.data)]);
}

/** An HWP 5.x document of paragraphs; `flags` 2 = encrypted, 4 = 배포용. */
export function hwp(paragraphs, { flags = 0, compressed = true } = {}) {
  const header = Buffer.alloc(256);
  header.write('HWP Document File', 0, 'latin1');
  header.writeUInt32LE(0x05000300, 32);
  header.writeUInt32LE(flags | (compressed ? 1 : 0), 36);
  const records = paragraphs.map((text) => {
    // A paragraph begins with an extended control (8 WCHARs) to check that it is skipped.
    const control = Buffer.alloc(16);
    control.writeUInt16LE(11, 0);
    control.writeUInt16LE(11, 14);
    const body = Buffer.concat([control, Buffer.from(text, 'utf16le'), Buffer.from([13, 0])]);
    const head = Buffer.alloc(4);
    head.writeUInt32LE((67 & 0x3ff) | (0 << 10) | (body.length << 20), 0);
    return Buffer.concat([head, body]);
  });
  const section = Buffer.concat(records);
  return cfb({
    FileHeader: header,
    'BodyText/Section0': compressed ? deflateRawSync(section) : section,
  });
}

/** A one-page PDF whose text layer is `text` (ASCII), with a correct cross-reference table. */
export function pdf(text) {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export const eml = ({ subject, from = '김 대리 <kim@example.com>', date, body }) =>
  Buffer.from(
    [
      `From: ${from}`,
      'To: team@example.com',
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      `Date: ${date}`,
      'Message-ID: <m1@example.com>',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(body).toString('base64'),
      '',
    ].join('\r\n'),
    'utf8',
  );

/**
 * A fake AI runner: labels every excerpt 'decision', makes one statement per excerpt from its
 * first line, puts every statement in one issue, and proposes what `proposals(statements)` returns.
 */
export function fakeRunner({ proposals = () => [] } = {}) {
  const calls = [];
  return {
    calls,
    async run({ role, choice, prompt }) {
      calls.push({ role, model: choice.model, prompt });
      const blocks = prompt.split(/\n### (\d+)\n/).slice(1);
      let reply;
      if (role === 'filter') {
        reply = [];
        for (let i = 0; i < blocks.length; i += 2)
          reply.push({ i: Number(blocks[i]), label: 'decision', structural: false });
      } else if (role === 'extract') {
        reply = [];
        for (let i = 0; i < blocks.length; i += 2) {
          const text = blocks[i + 1].split('\n---\n')[1] ?? '';
          for (const line of text.split('\n').filter((l) => l.trim()))
            reply.push({
              i: Number(blocks[i]),
              kind: 'decision',
              party: '',
              subject: '테스트',
              content: line.trim(),
              quote: line.trim().slice(0, 100),
              structural: false,
            });
        }
      } else if (role === 'issues' && prompt.includes('이슈 제목을 정하라')) {
        reply = [...prompt.matchAll(/^S(\d+) \|/gm)].map((m) => ({
          id: Number(m[1]),
          d: 'design',
          t: '시험 이슈',
        }));
      } else if (role === 'issues') {
        const ids = [...prompt.matchAll(/^S(\d+) \|/gm)].map((m) => Number(m[1]));
        reply = {
          status: 'open',
          summary: `진술 ${ids.length}개`,
          conclusions: [{ text: '결론', cite: ids.slice(0, 1) }],
          conditions: [],
          open: [],
          history: [],
        };
      } else {
        const statements = [
          ...prompt.matchAll(/^S(\d+) \| [^|]* \| [^|]* \| [^|]* \| [^|]* \| ([^|]*) \|/gm),
        ].map((m) => ({ id: Number(m[1]), content: m[2].trim() }));
        reply = proposals(statements);
      }
      return {
        text: '```json\n' + JSON.stringify(reply) + '\n```',
        inputTokens: prompt.length,
        outputTokens: 10,
      };
    },
  };
}
