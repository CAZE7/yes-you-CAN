/**
 * Minimal PDF writer.
 *
 * Produces a valid, uncompressed PDF 1.4 document with Helvetica text and simple
 * filled rectangles — enough for a diagnostic report without pulling in a PDF
 * library. Compression is deliberately skipped: reports are small and a stored
 * stream keeps this code reviewable.
 */

export interface PdfStyle {
  fontSize?: number;
  bold?: boolean;
  color?: [number, number, number];
}

export interface PdfLine {
  text: string;
  x: number;
  y: number;
  fontSize: number;
  bold: boolean;
  color: [number, number, number];
}

export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
  color: [number, number, number];
}

export interface PdfPage {
  lines: PdfLine[];
  rects: PdfRect[];
}

export const A4 = { width: 595, height: 842 } as const;

export class PdfDocument {
  readonly pages: PdfPage[] = [];
  private current: PdfPage = { lines: [], rects: [] };

  constructor(private readonly size: { width: number; height: number } = { width: A4.width, height: A4.height }) {
    this.pages.push(this.current);
  }

  addPage(): void {
    this.current = { lines: [], rects: [] };
    this.pages.push(this.current);
  }

  text(text: string, x: number, y: number, style: PdfStyle = {}): void {
    this.current.lines.push({
      text: sanitize(text),
      x,
      y,
      fontSize: style.fontSize ?? 10,
      bold: style.bold ?? false,
      color: style.color ?? [0, 0, 0],
    });
  }

  rect(x: number, y: number, width: number, height: number, color: [number, number, number] = [0.9, 0.9, 0.9]): void {
    this.current.rects.push({ x, y, width, height, color });
  }

  get width(): number {
    return this.size.width;
  }

  get height(): number {
    return this.size.height;
  }

  /** Render to PDF bytes. */
  toBytes(): Uint8Array {
    const objects: string[] = [];
    const pageCount = this.pages.length;
    // Object layout: 1 catalog, 2 pages, 3 regular font, 4 bold font,
    // then pairs of (page, content stream) starting at 5.
    const FONT_REGULAR_ID = 3;
    const FONT_BOLD_ID = 4;
    const firstPageObjectId = 5;

    objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
    const pageIds = Array.from({ length: pageCount }, (_, index) => firstPageObjectId + index * 2);
    objects[2] = `<< /Type /Pages /Count ${pageCount} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
    objects[FONT_REGULAR_ID] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
    objects[FONT_BOLD_ID] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`;

    this.pages.forEach((page, index) => {
      const pageId = firstPageObjectId + index * 2;
      const contentId = pageId + 1;
      objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.size.width} ${this.size.height}] /Resources << /Font << /F1 ${FONT_REGULAR_ID} 0 R /F2 ${FONT_BOLD_ID} 0 R >> >> /Contents ${contentId} 0 R >>`;
      const stream = renderContent(page);
      // /Length must be the byte length of the stream, not the UTF-16 string length.
      objects[contentId] = `<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`;
    });

    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    const offsets: number[] = [0];
    let offset = 0;
    const header = `%PDF-1.4\n%âãÏÓ\n`;
    chunks.push(encoder.encode(header));
    offset += byteLength(header, encoder);

    for (let i = 1; i < objects.length; i++) {
      const body = objects[i] ?? '';
      offsets[i] = offset;
      const text = `${i} 0 obj\n${body}\nendobj\n`;
      chunks.push(encoder.encode(text));
      offset += byteLength(text, encoder);
    }

    const xrefOffset = offset;
    const xref = [`xref`, `0 ${objects.length}`, `0000000000 65535 f `];
    for (let i = 1; i < objects.length; i++) {
      xref.push(`${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n `);
    }
    const xrefText = `${xref.join('\n')}\ntrailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    chunks.push(encoder.encode(xrefText));

    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let position = 0;
    for (const chunk of chunks) {
      out.set(chunk, position);
      position += chunk.length;
    }
    return out;
  }
}

function renderContent(page: PdfPage): string {
  const parts: string[] = [];
  for (const rect of page.rects) {
    const [r, g, b] = rect.color;
    parts.push(`${num(r)} ${num(g)} ${num(b)} rg ${num(rect.x)} ${num(rect.y)} ${num(rect.width)} ${num(rect.height)} re f`);
  }
  for (const line of page.lines) {
    const [r, g, b] = line.color;
    parts.push('BT');
    parts.push(`/${line.bold ? 'F2' : 'F1'} ${num(line.fontSize)} Tf`);
    parts.push(`${num(r)} ${num(g)} ${num(b)} rg`);
    parts.push(`1 0 0 1 ${num(line.x)} ${num(line.y)} Tm`);
    parts.push(`(${escapePdf(line.text)}) Tj`);
    parts.push('ET');
  }
  return parts.join('\n');
}

function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.00$/, '');
}

/** Structural type: `TextEncoder` is a value here, not a type (no DOM lib). */
interface TextLikeEncoder {
  encode(input: string): Uint8Array;
}

function byteLength(text: string, encoder: TextLikeEncoder): number {
  return encoder.encode(text).length;
}

/** PDF strings are Latin-1; anything outside is replaced so offsets stay valid. */
export function sanitize(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0x3f;
    out += code > 0xff ? mapUnicode(code) : char;
  }
  return out;
}

function mapUnicode(code: number): string {
  switch (code) {
    case 0x00b0: return '\u00b0'; // degree sign is representable
    case 0x2192: return '->';
    case 0x2022: return '-';
    case 0x2265: return '>=';
    case 0x2264: return '<=';
    case 0x20ac: return 'EUR';
    default: return '?';
  }
}

function escapePdf(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
