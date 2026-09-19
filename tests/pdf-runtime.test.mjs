import { test } from 'node:test';
import assert from 'node:assert/strict';
import { materialPdfUrl } from '../src/material-pdf-url.js';

test('material PDF URL uses the WebView2 custom-protocol origin on HTTP pages', () => {
  assert.equal(
    materialPdfUrl('pdf_1', 'http://tauri.localhost/'),
    'http://material.localhost/pdf/pdf_1',
  );
  assert.equal(
    materialPdfUrl('pdf_1', 'http://localhost:1420/'),
    'http://material.localhost/pdf/pdf_1',
  );
});

test('material PDF URL keeps the native custom scheme on non-HTTP pages', () => {
  assert.equal(materialPdfUrl('pdf_1', 'tauri://localhost/'), 'material://pdf/pdf_1');
});
