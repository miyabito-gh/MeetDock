import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import { materialPdfUrl } from './material-pdf-url.js';
import { PdfViewAdapter } from './pdf-view-adapter.js';

export function createProductionPdfViewAdapter(options) {
  return new PdfViewAdapter({
    ...options,
    pdfjs,
    resolveUrl: (_url, materialId) => materialPdfUrl(materialId),
  });
}
