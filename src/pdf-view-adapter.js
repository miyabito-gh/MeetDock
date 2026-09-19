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
  #resolveUrl;
  #generation = 0;
  #loadingTask = null;
  #document = null;
  #renderTask = null;
  #destroying = Promise.resolve();
  #pageNumber = 1;
  #scale = 1;
  #requestGeneration = null;

  constructor({ canvas, requestPassword = async () => null, resolveUrl = url => url, pdfjs }) {
    if (!canvas?.getContext || typeof requestPassword !== 'function' || typeof resolveUrl !== 'function' || !pdfjs?.getDocument) throw new TypeError('invalid PDF adapter ports');
    this.#canvas = canvas;
    this.#requestPassword = requestPassword;
    this.#resolveUrl = resolveUrl;
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
    this.#requestGeneration = null;
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
    this.#requestGeneration = generation;

    let passwordAttempts = 0;
    const resolvedUrl = this.#resolveUrl(url, material_id);
    if (typeof resolvedUrl !== 'string' || resolvedUrl.length === 0) throw pdfError('PDF_NOT_ALLOWED');
    const loading = this.#pdfjs.getDocument({ url: resolvedUrl });
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
      if (error?.status === 413) throw pdfError('PDF_FALLBACK_TOO_LARGE');
      if (error?.name === 'MissingPDFException' || error?.name === 'UnexpectedResponseException' || error?.name === 'UnknownErrorException') throw pdfError('PDF_NOT_READABLE');
      throw pdfError('PDF_CORRUPT');
    }
    if (token !== this.#generation) { await document.destroy?.(); return; }
    this.#document = document;
    this.#pageNumber = 1;
    this.#scale = 1;
    await this.#renderPage(token);
    return this.#snapshot(generation);
  }

  #snapshot(generation) {
    if (!this.#document || generation !== this.#requestGeneration) return null;
    return Object.freeze({
      current_page: this.#pageNumber,
      total_pages: this.#document.numPages,
      zoom_percent: Math.round(this.#scale * 100),
    });
  }

  async #renderPage(token = this.#generation) {
    const document = this.#document;
    if (!document || token !== this.#generation) return;
    try {
      this.#renderTask?.cancel?.();
      const page = await document.getPage(this.#pageNumber);
      if (token !== this.#generation) return;
      const viewport = page.getViewport({ scale: this.#scale });
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

  async previous({ generation } = {}) { if (generation !== this.#requestGeneration) return null; if (this.#document && this.#pageNumber > 1) { this.#pageNumber--; await this.#renderPage(); } return this.#snapshot(generation); }
  async next({ generation } = {}) { if (generation !== this.#requestGeneration) return null; if (this.#document && this.#pageNumber < this.#document.numPages) { this.#pageNumber++; await this.#renderPage(); } return this.#snapshot(generation); }
  async goToPage(pageNumber, { generation } = {}) {
    if (generation !== this.#requestGeneration || !Number.isSafeInteger(pageNumber) || !this.#document || pageNumber < 1 || pageNumber > this.#document.numPages) return null;
    if (pageNumber !== this.#pageNumber) { this.#pageNumber = pageNumber; await this.#renderPage(); }
    return this.#snapshot(generation);
  }
  async zoomIn({ generation } = {}) { if (generation !== this.#requestGeneration) return null; if (this.#document) { this.#scale = Math.min(3, this.#scale + .25); await this.#renderPage(); } return this.#snapshot(generation); }
  async zoomOut({ generation } = {}) { if (generation !== this.#requestGeneration) return null; if (this.#document) { this.#scale = Math.max(.5, this.#scale - .25); await this.#renderPage(); } return this.#snapshot(generation); }
  async fit(viewportWidth, { generation } = {}) {
    if (generation !== this.#requestGeneration || !this.#document || !Number.isFinite(viewportWidth) || viewportWidth <= 0) return null;
    const page = await this.#document.getPage(this.#pageNumber), base = page.getViewport({ scale: 1 });
    this.#scale = Math.max(.5, Math.min(3, (viewportWidth - 32) / base.width)); await this.#renderPage();
    return this.#snapshot(generation);
  }

  async close() {
    await this.#teardown();
  }
}

export function createPdfViewAdapter(options) { return new PdfViewAdapter(options); }
