import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import { PDFViewer, PDFLinkService, EventBus } from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import { materialPdfUrl } from './material-pdf-url.js';
import { PdfViewAdapter } from './pdf-view-adapter.js';
import { createPdfViewerPort } from './pdf-viewer-port.js';

export function createProductionPdfViewAdapter(options) {
  return new PdfViewAdapter({
    ...options,
    pdfjs,
    viewerPort: createPdfViewerPort({ ...options, PDFViewer, PDFLinkService, EventBus, annotationMode: pdfjs.AnnotationMode.ENABLE, isValidExplicitDest: pdfjs.isValidExplicitDest }),
    resolveUrl: (_url, materialId) => materialPdfUrl(materialId),
  });
}
