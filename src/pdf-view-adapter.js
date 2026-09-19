import { appError } from './contracts.js';

export const PDF_WORKER_URL = '/assets/pdfjs/pdf.worker.min.mjs';

function pdfError(code) {
  return appError(code);
}

/** Owns one PDF.js document and enforces teardown before every replacement. */
export class PdfViewAdapter {
  #pdfjs;
  #canvas;
  #requestPassword;
  #generation = 0;
  #loadingTask = null;
  #document = null;
  #renderTask = null;
  #destroying = Promise.resolve();

  constructor({ canvas, requestPassword = async () => null, pdfjs }) {
    if (!canvas?.getContext || typeof requestPassword !== 'function' || !pdfjs?.getDocument) throw new TypeError('invalid PDF adapter ports');
    this.#canvas = canvas;
    this.#requestPassword = requestPassword;
    this.#pdfjs = pdfjs;
    if (this.#pdfjs.GlobalWorkerOptions) this.#pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
  }

  async #teardown() {
    const render = this.#renderTask;
    this.#renderTask = null;
    render?.cancel?.();
    const token = ++this.#generation;
    this.#canvas.width = 0;
    this.#canvas.height = 0;
    const document = this.#document;
    this.#document = null;
    const loading = this.#loadingTask;
    this.#loadingTask = null;
    document?.cleanup?.();
    const previous = this.#destroying;
    const destroying = previous.catch(() => {}).then(async () => {
      try { await document?.destroy?.(); } finally { await loading?.destroy?.(); }
    });
    this.#destroying = destroying;
    await destroying;
    return token;
  }

  async replace({ url, material_id, generation }) {
    if (url !== `material://pdf/${material_id}` || !Number.isSafeInteger(generation) || generation < 0) {
      throw pdfError('PDF_NOT_ALLOWED');
    }
    const token = await this.#teardown();
    if (token !== this.#generation) return;

    let passwordAttempts = 0;
    const loading = this.#pdfjs.getDocument({ url });
    this.#loadingTask = loading;
    loading.onPassword = async (updatePassword, reason) => {
      if (token !== this.#generation || ++passwordAttempts > 3) {
        try { await loading.destroy?.(); } catch {}
        return;
      }
      let password = null;
      try { password = await this.#requestPassword({ material_id, reason, attempt: passwordAttempts }); } catch { password = null; }
      if (token !== this.#generation || typeof password !== 'string' || password.length === 0) {
        try { await loading.destroy?.(); } catch {}
        return;
      }
      updatePassword(password);
    };
    let document;
    try {
      document = await loading.promise;
    } catch (error) {
      if (token !== this.#generation) return;
      if (passwordAttempts > 0) throw pdfError('PDF_PASSWORD_REQUIRED');
      if (error?.name === 'MissingPDFException' || error?.name === 'UnexpectedResponseException') throw pdfError('PDF_NOT_READABLE');
      throw pdfError('PDF_CORRUPT');
    }
    if (token !== this.#generation) { await document.destroy?.(); return; }
    this.#document = document;
    try {
      const page = await document.getPage(1);
      if (token !== this.#generation) return;
      const viewport = page.getViewport({ scale: 1 });
      this.#canvas.width = Math.ceil(viewport.width);
      this.#canvas.height = Math.ceil(viewport.height);
      const render = page.render({ canvasContext: this.#canvas.getContext('2d'), viewport });
      this.#renderTask = render;
      await render.promise;
      if (token !== this.#generation) return;
    } catch (error) {
      if (token !== this.#generation || error?.name === 'RenderingCancelledException') return;
      throw pdfError('PDF_CORRUPT');
    }
  }

  async close() {
    await this.#teardown();
  }
}

export function createPdfViewAdapter(options) { return new PdfViewAdapter(options); }
