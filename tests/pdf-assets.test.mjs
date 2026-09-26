import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

test('PDF.js worker is local and version-pinned; production CSP stays minimal', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.dependencies['pdfjs-dist'], '5.4.149');
  assert.ok(statSync(new URL('../public/assets/pdfjs/pdf.worker.min.mjs', import.meta.url)).size > 1_000_000);
  assert.ok(statSync(new URL('../public/assets/pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap', import.meta.url)).size > 1_000);
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url)));
  const csp = config.app.security.csp;
  assert.match(csp, /worker-src 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /material:/);
  assert.match(csp, /ipc: http:\/\/ipc\.localhost/);
  assert.match(csp, /http:\/\/material\.localhost/);
  assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline|https:\/\/|data:/);
});
