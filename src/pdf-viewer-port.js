/** PDF.js UI is isolated from the document lifecycle and model event boundary. */
export function createPdfViewerPort({ container, viewer, PDFViewer, PDFLinkService, EventBus, annotationMode, isValidExplicitDest }) {
  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  linkService.externalLinkEnabled = false;
  const pdfViewer = new PDFViewer({
    container, viewer, eventBus, linkService,
    enablePermissions: true,
    removePageBorders: true,
    annotationMode,
    annotationEditorMode: -1,
    enableAutoLinking: false,
  });
  linkService.setViewer(pdfViewer);
  // PDF.js resolves destinations asynchronously. A link in a document that has
  // since been replaced must never navigate the newly opened document.
  linkService.goToDestination = async destination => {
    const document = linkService.pdfDocument;
    if (!document) return;
    try {
      const explicit = typeof destination === 'string' ? await document.getDestination(destination) : await destination;
      if (linkService.pdfDocument !== document || !isValidExplicitDest(explicit)) return;
      const reference = explicit[0];
      let page;
      if (reference && typeof reference === 'object') {
        page = document.cachedPageNumber(reference);
        if (!page) page = (await document.getPageIndex(reference)) + 1;
      } else if (Number.isInteger(reference)) page = reference + 1;
      if (linkService.pdfDocument !== document || !Number.isInteger(page) || page < 1 || page > document.numPages) return;
      // Outline destinations can point to pages whose placeholder uses page 1's
      // dimensions. Resolve the target and preceding geometry before XYZ/zoom math.
      for (let index = 0; index < page; index++) {
        const pageView = pdfViewer.getPageView(index);
        if (!pageView.pdfPage) {
          const pdfPage = await document.getPage(index + 1);
          if (linkService.pdfDocument !== document) return;
          if (!pageView.pdfPage) pageView.setPdfPage(pdfPage);
        }
      }
      if (linkService.pdfDocument !== document) return;
      pdfViewer.scrollPageIntoView({ pageNumber: page, destArray: explicit });
      rememberViewport();
      container.focus({ preventScroll: true });
    } catch {
      // Unresolvable or malformed PDF destinations leave the current view intact.
    }
  };
  let listener = () => {}, layoutListener = () => {}, pending = null, viewRevision = 0, lastViewport = null;
  const viewportOrigin = () => {
    const rect = container.getBoundingClientRect();
    return { left: rect.left + container.clientLeft, top: rect.top + container.clientTop };
  };
  const readViewport = () => {
    if (!pdfViewer.pdfDocument || !(pdfViewer.currentScale > 0)) return null;
    const bounds = container.getBoundingClientRect();
    if (!(bounds.width > 0 && bounds.height > 0 && container.clientWidth > 0 && container.clientHeight > 0)) return null;
    const origin = viewportOrigin();
    // Read geometry now: pagechanging/updateviewarea may still be waiting for RAF.
    for (let index = 0; index < pdfViewer.pagesCount; index++) {
      const pageView = pdfViewer.getPageView(index), rect = pageView.div.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) continue;
      if (rect.bottom <= origin.top && index < pdfViewer.pagesCount - 1) continue;
      return { page: index + 1, scale: pdfViewer.currentScale,
        x: (origin.left - rect.left) / pdfViewer.currentScale,
        y: (origin.top - rect.top) / pdfViewer.currentScale };
    }
    return null;
  };
  const rememberViewport = () => {
    const position = readViewport();
    if (position) lastViewport = position;
    return lastViewport ? { ...lastViewport } : null;
  };
  const refreshLayout = () => {
    // Keep native appearances painted. Only a nonempty destination hash denotes
    // an in-document jump: PDF.js also labels attachments and other actions as
    // "internal", but gives those an empty href. External links remain disabled.
    for (const layer of viewer.querySelectorAll('.annotationLayer')) {
      layer.inert = false;
      for (const annotation of layer.children) {
        const link = annotation.matches('.linkAnnotation[data-internal-link]') ? annotation.querySelector(':scope > a') : null;
        const href = link?.getAttribute('href');
        const internal = Boolean(href?.startsWith('#') && href.length > 1);
        annotation.inert = !internal;
        annotation.classList.toggle('pdf-internal-link', internal);
        if (internal) {
          link.tabIndex = 0;
          if (!link.hasAttribute('aria-label')) link.setAttribute('aria-label', link.title || 'PDF内のリンク');
        }
      }
    }
    layoutListener();
  };
  const changed = () => listener({ page: pdfViewer.currentPageNumber, scale: pdfViewer.currentScale });
  container.addEventListener?.('scroll', rememberViewport, { passive: true });
  eventBus.on('updateviewarea', rememberViewport);
  eventBus.on('pagechanging', changed);
  eventBus.on('scalechanging', changed);
  eventBus.on('pagerendered', refreshLayout);
  eventBus.on('annotationlayerrendered', refreshLayout);
  eventBus.on('pagesinit', () => { pending?.resolve(); pending = null; refreshLayout(); });
  return Object.freeze({
    listen(change, layout) { listener = change; layoutListener = layout; },
    async setDocument(document) {
      viewRevision++;
      lastViewport = null;
      pending?.resolve(); pending = null;
      linkService.setDocument(document);
      if (!document) { pdfViewer.setDocument(null); return; }
      const ready = new Promise((resolve, reject) => { pending = { resolve, reject }; });
      pdfViewer.setDocument(document);
      // Initialization failures reject pagesPromise, rather than emitting pagesinit.
      pdfViewer.pagesPromise.catch(error => {
        if (pdfViewer.pdfDocument === document) { pending?.reject(error); pending = null; }
      });
      await ready;
    },
    captureView() { return rememberViewport(); },
    async restoreView(position) {
      const document = pdfViewer.pdfDocument, revision = ++viewRevision;
      if (!document || !Number.isSafeInteger(position?.page) || position.page < 1 || position.page > document.numPages ||
          ![position.scale, position.x, position.y].every(Number.isFinite) || position.scale <= 0) return null;
      const current = () => revision === viewRevision && pdfViewer.pdfDocument === document;
      const loadPage = async index => {
        const pageView = pdfViewer.getPageView(index);
        if (!pageView.pdfPage) {
          const page = await document.getPage(index + 1);
          if (!current()) return false;
          if (!pageView.pdfPage) pageView.setPdfPage(page);
        }
        return current();
      };
      // pagesinit uses the first page's size for placeholders. Resolve the actual
      // prefix before scrolling so mixed-size pages cannot move the anchor later.
      for (let index = 0; index < position.page; index++) if (!await loadPage(index)) return null;
      if (!current()) return null;
      pdfViewer.currentScale = position.scale;
      const anchor = pdfViewer.getPageView(position.page - 1);
      // Resolve following geometry when needed to avoid native scroll clamping.
      // pagesPromise cannot be used here: it can depend on a first rendered page.
      for (let index = position.page; index < document.numPages; index++) {
        const bottom = pdfViewer.getPageView(index - 1).div.getBoundingClientRect().bottom;
        if (bottom - anchor.div.getBoundingClientRect().top >= position.y * position.scale + container.clientHeight) break;
        if (!await loadPage(index)) return null;
      }
      if (!current()) return null;
      const anchorRect = anchor.div.getBoundingClientRect(), before = viewportOrigin();
      const desiredLeft = container.scrollLeft + anchorRect.left - before.left + position.x * position.scale;
      // A distant wide page can create the horizontal scroll range. Resolve all
      // remaining sizes only for a panned viewport, so narrower placeholders cannot
      // temporarily clamp it before that wide page is initialized.
      if (desiredLeft > 0) {
        for (let index = position.page; index < document.numPages; index++) if (!await loadPage(index)) return null;
      }
      if (!current()) return null;
      pdfViewer.scrollPageIntoView({ pageNumber: position.page });
      const rect = anchor.div.getBoundingClientRect(), origin = viewportOrigin();
      container.scrollLeft += rect.left - origin.left + position.x * position.scale;
      container.scrollTop += rect.top - origin.top + position.y * position.scale;
      pdfViewer.update();
      rememberViewport();
      return { page: pdfViewer.currentPageNumber, scale: pdfViewer.currentScale };
    },
    showPage(page) { pdfViewer.scrollPageIntoView({ pageNumber: page }); rememberViewport(); },
    setScale(scale) { pdfViewer.currentScale = scale; rememberViewport(); },
    zoom(scale, origin) {
      pdfViewer.updateScale({ scaleFactor: scale / pdfViewer.currentScale, origin, drawingDelay: 100 });
      rememberViewport();
      return pdfViewer.currentScale;
    },
    async goToDestination(destination) {
      const document = pdfViewer.pdfDocument;
      await linkService.goToDestination(destination);
      if (!document || pdfViewer.pdfDocument !== document) return null;
      return { page: pdfViewer.currentPageNumber, scale: pdfViewer.currentScale };
    },
    async fitHeight() {
      const document = pdfViewer.pdfDocument, pageNumber = pdfViewer.currentPageNumber;
      if (!document) return null;
      const pageView = pdfViewer.getPageView(pageNumber - 1);
      if (!pageView.pdfPage) {
        const page = await document.getPage(pageNumber);
        if (pdfViewer.pdfDocument !== document || pdfViewer.currentPageNumber !== pageNumber) return null;
        if (!pageView.pdfPage) pageView.setPdfPage(page);
      }
      pdfViewer.currentScaleValue = 'page-height';
      pdfViewer.scrollPageIntoView({ pageNumber });
      rememberViewport();
      return pdfViewer.currentScale;
    },
    fit() {
      pdfViewer.currentScaleValue = 'page-width';
      // Use the same limits as button/wheel zoom, so the next zoom never reverses direction.
      pdfViewer.currentScale = Math.max(.5, Math.min(3, pdfViewer.currentScale));
      rememberViewport();
      return pdfViewer.currentScale;
    },
  });
}
