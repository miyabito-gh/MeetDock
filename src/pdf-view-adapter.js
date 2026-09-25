import { appError } from './contracts.js';

export const PDF_WORKER_URL = '/assets/pdfjs/pdf.worker.min.mjs';

function pdfError(code) {
  return appError(code);
}

function pageReadingText(items) {
  const positioned = items.map((item, index) => ({
    index, text: String(item.str ?? ''), x: item.transform?.[4], y: item.transform?.[5],
    width: item.width, height: item.height, hasEOL: item.hasEOL,
  })).filter(item => item.text.trim());
  if (!positioned.every(item => Number.isFinite(item.x) && Number.isFinite(item.y)))
    return items.map(item => `${item.str ?? ''}${item.hasEOL ? '\n' : ' '}`).join('').trim();

  const lines = [];
  for (const item of positioned.sort((a, b) => b.y - a.y || a.x - b.x || a.index - b.index)) {
    const tolerance = Math.max(2, Math.min(6, (Number.isFinite(item.height) ? item.height : 10) * .4));
    let line = lines.find(line => Math.abs(line.y - item.y) <= tolerance);
    if (!line) { line = { y: item.y, items: [] }; lines.push(line); }
    line.items.push(item);
  }
  const separated = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x || a.index - b.index);
    let run = [];
    for (const item of line.items) {
      const previous = run.at(-1);
      const right = previous && previous.x + (Number.isFinite(previous.width) ? previous.width : previous.text.length * 5);
      if (previous && item.x - right > Math.max(32, (Number.isFinite(item.height) ? item.height : 10) * 4)) {
        separated.push({ y: line.y, items: run });
        run = [];
      }
      run.push(item);
    }
    if (run.length) separated.push({ y: line.y, items: run });
  }
  for (const line of separated) {
    line.left = Math.min(...line.items.map(item => item.x));
    line.right = Math.max(...line.items.map(item => item.x + (Number.isFinite(item.width) ? item.width : item.text.length * 5)));
    line.text = line.items.map(item => item.text).join(' ').replace(/\s+/g, ' ').trim();
  }
  separated.sort((a, b) => b.y - a.y || a.left - b.left);

  // A wide, persistent gutter with vertically overlapping text separates common two-column pages.
  const candidates = [...new Set(separated.flatMap(line => [line.left, line.right]))].sort((a, b) => a - b);
  let columns = null;
  for (let i = 0; i < candidates.length - 1; i++) {
    const gap = candidates[i + 1] - candidates[i];
    const pageWidth = Math.max(...separated.map(line => line.right)) - Math.min(...separated.map(line => line.left));
    if (gap < Math.max(18, pageWidth * .08)) continue;
    const left = separated.filter(line => line.right <= candidates[i]);
    const right = separated.filter(line => line.left >= candidates[i + 1]);
    if (left.length < 2 || right.length < 2) continue;
    const overlap = Math.min(Math.max(...left.map(line => line.y)), Math.max(...right.map(line => line.y))) -
      Math.max(Math.min(...left.map(line => line.y)), Math.min(...right.map(line => line.y)));
    if (overlap <= 0) continue;
    if (!columns || gap > columns.gap) columns = { gap, left, right };
  }
  if (!columns) return separated.map(line => line.text).join('\n');
  const used = new Set([...columns.left, ...columns.right]);
  const top = Math.max(...[...used].map(line => line.y));
  const bottom = Math.min(...[...used].map(line => line.y));
  const headers = separated.filter(line => !used.has(line) && line.y > top);
  const footers = separated.filter(line => !used.has(line) && line.y < bottom);
  const middle = separated.filter(line => !used.has(line) && line.y <= top && line.y >= bottom);
  return [...headers, ...columns.left, ...middle, ...columns.right, ...footers].map(line => line.text).join('\n');
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
  #searchToken = 0;
  #searchQuery = '';
  #searchMatches = [];
  #searchIndex = -1;
  #pageText = '';
  #pageTextNumber = null;

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
    this.#searchToken++;
    this.#searchQuery = '';
    this.#searchMatches = [];
    this.#searchIndex = -1;
    this.#pageText = '';
    this.#pageTextNumber = null;
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
      search_query: this.#searchQuery,
      search_index: this.#searchIndex < 0 ? 0 : this.#searchIndex + 1,
      search_total: this.#searchMatches.length,
      page_text: this.#pageText,
    });
  }

  async #renderPage(token = this.#generation) {
    const document = this.#document;
    if (!document || token !== this.#generation) return;
    try {
      this.#renderTask?.cancel?.();
      const pageNumber = this.#pageNumber;
      const page = await document.getPage(pageNumber);
      if (token !== this.#generation || pageNumber !== this.#pageNumber) return;
      const viewport = page.getViewport({ scale: this.#scale });
      this.#canvas.width = Math.ceil(viewport.width);
      this.#canvas.height = Math.ceil(viewport.height);
      const render = page.render({ canvasContext: this.#canvas.getContext('2d'), viewport });
      this.#renderTask = render;
      await render.promise;
      if (token !== this.#generation || pageNumber !== this.#pageNumber) return;
      if (this.#pageTextNumber !== pageNumber) {
        let content;
        try { content = await page.getTextContent(); } catch { content = { items: [] }; }
        if (token !== this.#generation || pageNumber !== this.#pageNumber) return;
        this.#pageText = pageReadingText(content.items);
        this.#pageTextNumber = pageNumber;
      }
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

  async search(query, { generation } = {}) {
    if (generation !== this.#requestGeneration || !this.#document || typeof query !== 'string') return null;
    const normalized = query.trim().toLocaleLowerCase('ja');
    const token = ++this.#searchToken;
    this.#searchQuery = query.trim();
    this.#searchMatches = [];
    this.#searchIndex = -1;
    if (!normalized) return this.#snapshot(generation);

    const matches = [];
    for (let pageNumber = 1; pageNumber <= this.#document.numPages; pageNumber++) {
      let page;
      try { page = await this.#document.getPage(pageNumber); } catch { continue; }
      if (token !== this.#searchToken || generation !== this.#requestGeneration) return null;
      let content;
      try { content = await page.getTextContent(); } catch { continue; }
      if (token !== this.#searchToken || generation !== this.#requestGeneration) return null;
      const text = content.items.map(item => `${item.str ?? ''}${item.hasEOL ? '\n' : ''}`).join('').toLocaleLowerCase('ja');
      let offset = 0;
      while ((offset = text.indexOf(normalized, offset)) >= 0) {
        matches.push({ page: pageNumber, offset });
        offset += Math.max(1, normalized.length);
      }
    }
    if (token !== this.#searchToken || generation !== this.#requestGeneration) return null;
    this.#searchMatches = matches;
    this.#searchIndex = matches.length ? 0 : -1;
    if (matches.length) {
      this.#pageNumber = matches[0].page;
      await this.#renderPage();
    }
    return this.#snapshot(generation);
  }

  async searchPrevious({ generation } = {}) { return this.#moveSearch(-1, generation); }
  async searchNext({ generation } = {}) { return this.#moveSearch(1, generation); }
  async #moveSearch(offset, generation) {
    if (generation !== this.#requestGeneration || !this.#document || !this.#searchMatches.length) return this.#snapshot(generation);
    this.#searchIndex = (this.#searchIndex + offset + this.#searchMatches.length) % this.#searchMatches.length;
    const pageNumber = this.#searchMatches[this.#searchIndex].page;
    if (pageNumber !== this.#pageNumber) {
      this.#pageNumber = pageNumber;
      await this.#renderPage();
    }
    return this.#snapshot(generation);
  }

  async close() {
    await this.#teardown();
  }
}

export function createPdfViewAdapter(options) { return new PdfViewAdapter(options); }
