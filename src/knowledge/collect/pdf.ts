// PDF text layer through pdfjs-dist's legacy build (SPEC-08.9 2): text per page, no rendering, no
// fonts, no eval. A document with no text on any page is a scan (no OCR). pdfjs-dist is loaded on
// first use; an install without it counts PDFs as not read.

interface TextItem {
  str?: string;
  hasEOL?: boolean;
}
interface PdfPage {
  getTextContent(): Promise<{ items: TextItem[] }>;
  cleanup(): void;
}
interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
interface Pdfjs {
  getDocument(options: Record<string, unknown>): { promise: Promise<PdfDocument> };
}

// A variable specifier: the type check does not need the package (it is loaded only here).
const PDFJS = 'pdfjs-dist/legacy/build/pdf.mjs';
let loading: Promise<Pdfjs | null> | undefined;
export function loadPdfjs(): Promise<Pdfjs | null> {
  // pdfjs builds a DOMMatrix when it loads; without its optional canvas package Node has none.
  // Reading text never draws, so an inert stand-in is enough.
  const scope = globalThis as { DOMMatrix?: unknown };
  scope.DOMMatrix ??= class DOMMatrix {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;
    constructor(init?: number[]) {
      if (Array.isArray(init) && init.length >= 6)
        [this.a, this.b, this.c, this.d, this.e, this.f] = init;
    }
    multiplySelf() {
      return this;
    }
    preMultiplySelf() {
      return this;
    }
    translate() {
      return this;
    }
    scale() {
      return this;
    }
    invertSelf() {
      return this;
    }
  };
  loading ??= (import(PDFJS) as Promise<Pdfjs>).catch(() => null);
  return loading;
}

export class PdfError extends Error {
  readonly code: 'ENCRYPTED' | 'NO_READER' | 'NOT_PDF';
  constructor(code: PdfError['code']) {
    super(code);
    this.code = code;
  }
}

/** The text of each page (1-based), empty strings for pages without a text layer. */
export async function pdfPages(bytes: Buffer): Promise<string[]> {
  const pdfjs = await loadPdfjs();
  if (!pdfjs) throw new PdfError('NO_READER');
  let document: PdfDocument;
  try {
    document = await pdfjs.getDocument({
      data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
      verbosity: 0,
    }).promise;
  } catch (error) {
    const name = (error as Error)?.name ?? '';
    if (name === 'PasswordException') throw new PdfError('ENCRYPTED');
    if (name === 'InvalidPDFException') throw new PdfError('NOT_PDF');
    throw error;
  }
  try {
    const pages: string[] = [];
    for (let n = 1; n <= document.numPages; n++) {
      const page = await document.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        text += item.str ?? '';
        if (item.hasEOL) text += '\n';
      }
      pages.push(text.replace(/[ \t]+\n/g, '\n').trim());
      page.cleanup();
    }
    return pages;
  } finally {
    await document.destroy();
  }
}
