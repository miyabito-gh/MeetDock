import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import { PdfViewAdapter } from './pdf-view-adapter.js';

export function createProductionPdfViewAdapter(options) {
  return new PdfViewAdapter({ ...options, pdfjs });
}
