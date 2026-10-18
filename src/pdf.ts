// Reading PDFs and drawing their pages to pictures, using PDF.js. The library is large, so it is only
// fetched the first time someone imports a PDF.
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist';
import type { ImageQuality } from './image';
import { type PageRotation, turn } from './pdfLayout';

/** A page's size in PDF points (1/72 inch) as it is meant to be viewed, i.e. with the file's own rotation applied. */
export interface PdfPageInfo {
  w: number;
  h: number;
}

/** Longest side, in pixels, of the pictures stored on the board. */
const PAGE_PIXELS: Record<ImageQuality, number> = { standard: 2000, high: 3600 };

let library: Promise<typeof import('pdfjs-dist')> | null = null;

function loadLibrary() {
  library ??= (async () => {
    const [lib, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  })().catch((err) => {
    library = null;
    throw err;
  });
  return library;
}

export function isPdfFile(file: Blob & { name?: string }): boolean {
  return file.type === 'application/pdf' || (!file.type && /\.pdf$/i.test(file.name ?? ''));
}

export class PdfFile {
  /** Page pictures are drawn one at a time: PDF.js works through one page at a time anyway, and it keeps memory low. */
  private queue: Promise<unknown> = Promise.resolve();
  private destroyed = false;

  private constructor(private doc: PDFDocumentProxy, private task: PDFDocumentLoadingTask, readonly pages: PdfPageInfo[]) {}

  static async open(file: File): Promise<PdfFile> {
    const lib = await loadLibrary();
    const task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    try {
      const doc = await task.promise;
      const pages: PdfPageInfo[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const view = (await doc.getPage(n)).getViewport({ scale: 1 });
        pages.push({ w: view.width, h: view.height });
      }
      return new PdfFile(doc, task, pages);
    } catch (err) {
      void task.destroy();
      const name = (err as { name?: string })?.name;
      if (name === 'PasswordException') throw new Error('That PDF is protected with a password. Remove the password and try again.');
      if (name === 'InvalidPDFException' || name === 'FormatError') throw new Error('Could not read that PDF');
      throw err instanceof Error ? err : new Error('Could not read that PDF');
    }
  }

  get pageCount() {
    return this.pages.length;
  }

  /**
   * Draw page `n` (1-based) on a white canvas whose longest side is `longSide` pixels, turned a
   * further `rotation` clockwise from how the file shows it.
   */
  render(n: number, rotation: PageRotation, longSide: number): Promise<HTMLCanvasElement> {
    const job = this.queue.then(async () => {
      if (this.destroyed) throw new Error('cancelled');
      const page = await this.doc.getPage(n);
      const angle = turn(((page.rotate % 360) + 360) % 360 as PageRotation, rotation / 90);
      const base = page.getViewport({ scale: 1, rotation: angle });
      const viewport = page.getViewport({ scale: longSide / Math.max(base.width, base.height), rotation: angle });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      await page.render({ canvas, viewport, background: '#ffffff' }).promise;
      page.cleanup();
      return canvas;
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** A page as it will be stored on the board. */
  async renderForBoard(n: number, rotation: PageRotation, quality: ImageQuality): Promise<{ src: string; width: number; height: number }> {
    const canvas = await this.render(n, rotation, PAGE_PIXELS[quality]);
    return { src: encodePage(canvas, quality), width: canvas.width, height: canvas.height };
  }

  destroy() {
    this.destroyed = true;
    void this.task.destroy();
  }
}

/** Pages are solid white sheets, so there is no transparency to keep. */
function encodePage(canvas: HTMLCanvasElement, quality: ImageQuality): string {
  if (quality === 'high') return canvas.toDataURL('image/png');
  const webp = canvas.toDataURL('image/webp', 0.85);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85);
}
