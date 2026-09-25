import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PdfViewAdapter, PDF_WORKER_URL } from '../src/pdf-view-adapter.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function canvas(log) { return { _w: 1, _h: 1, get width() { return this._w; }, set width(v) { this._w=v; log.push(`width:${v}`); }, get height() { return this._h; }, set height(v) { this._h=v; log.push(`height:${v}`); }, getContext: () => ({}) }; }
function page(log, pending = Promise.resolve(), baseWidth = 10, text = '') { return { getViewport: ({ scale = 1 } = {}) => ({ width: baseWidth * scale, height: 20 * scale }), render: () => ({ promise: pending, cancel: () => log.push('cancel') }), getTextContent: async () => ({ items: [{ str: text }] }) }; }
function document(log, renderPromise, numPages = 4, baseWidth = 10) { return { numPages, getPage: async () => page(log, renderPromise, baseWidth), cleanup: () => log.push('cleanup'), destroy: async () => log.push('destroy-document') }; }
function loading(doc, log) { return { promise: Promise.resolve(doc), destroy: async () => log.push('destroy-loading'), onPassword: null }; }

test('only the visible page text is exposed and zoom reuses its extraction', async () => {
  const reads = [];
  const doc = { numPages: 3, getPage: async number => ({
    getViewport: ({ scale }) => ({ width: 10 * scale, height: 20 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel() {} }),
    getTextContent: async () => { reads.push(number); return { items: [{ str: `page ${number}` }] }; },
  }), async destroy() {} };
  const adapter = new PdfViewAdapter({ canvas: canvas([]), pdfjs: { GlobalWorkerOptions: {}, getDocument: () => loading(doc, []) } });
  const first = await adapter.replace({ url: 'material://pdf/m1', material_id: 'm1', generation: 1 });
  assert.equal(first.page_text, 'page 1');
  assert.deepEqual(reads, [1]);
  assert.equal((await adapter.zoomIn({ generation: 1 })).page_text, 'page 1');
  assert.deepEqual(reads, [1]);
  assert.equal((await adapter.next({ generation: 1 })).page_text, 'page 2');
  assert.deepEqual(reads, [1, 2]);
  await adapter.close();
});

test('positioned PDF text follows rows on one column and columns on a two-column page', async () => {
  const item = (str, x, y, width = 80) => ({ str, transform: [1, 0, 0, 1, x, y], width, height: 10 });
  const pages = [
    [item('second', 40, 80), item('first', 40, 100), item('third', 40, 60)],
    [item('right 2', 300, 80), item('left 1', 40, 100), item('right 1', 300, 100), item('left 2', 40, 80)],
    [],
  ];
  const reads = [];
  const doc = { numPages: pages.length, getPage: async number => ({
    getViewport: ({ scale }) => ({ width: 500 * scale, height: 200 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel() {} }),
    getTextContent: async () => { reads.push(number); return { items: pages[number - 1] }; },
  }), async destroy() {} };
  const adapter = new PdfViewAdapter({ canvas: canvas([]), pdfjs: { GlobalWorkerOptions: {}, getDocument: () => loading(doc, []) } });
  assert.equal((await adapter.replace({ url: 'material://pdf/m1', material_id: 'm1', generation: 1 })).page_text, 'first\nsecond\nthird');
  assert.equal((await adapter.next({ generation: 1 })).page_text, 'left 1\nleft 2\nright 1\nright 2');
  assert.equal((await adapter.next({ generation: 1 })).page_text, '');
  assert.equal((await adapter.previous({ generation: 1 })).page_text, 'left 1\nleft 2\nright 1\nright 2');
  assert.equal((await adapter.zoomIn({ generation: 1 })).page_text, 'left 1\nleft 2\nright 1\nright 2');
  assert.deepEqual(reads, [1, 2, 3, 2]);
});

test('PDF replace cancels, resets Canvas, cleans and destroys before loading next document', async () => {
  const log = [], firstRender = deferred(), loads = [];
  const pdfjs = { GlobalWorkerOptions: {}, getDocument: ({url}) => { log.push(`load:${url}`); const item = loading(document(log, loads.length ? Promise.resolve() : firstRender.promise), log); loads.push(item); return item; } };
  const adapter = new PdfViewAdapter({ canvas: canvas(log), pdfjs });
  const first = adapter.replace({ url:'material://pdf/m1', material_id:'m1', generation:1 });
  await new Promise(resolve => setImmediate(resolve));
  const second = adapter.replace({ url:'material://pdf/m2', material_id:'m2', generation:2 });
  firstRender.reject(Object.assign(new Error(), { name:'RenderingCancelledException' }));
  await Promise.all([first, second]);
  const cancel = log.indexOf('cancel'), reset = log.indexOf('width:0', cancel), cleanup = log.indexOf('cleanup', reset), destroy = log.indexOf('destroy-document', cleanup), load = log.indexOf('load:material://pdf/m2');
  assert.ok(cancel >= 0 && cancel < reset && reset < cleanup && cleanup < destroy && destroy < load, log.join(','));
  assert.equal(pdfjs.GlobalWorkerOptions.workerSrc, PDF_WORKER_URL);
});

test('stale load completion is destroyed and cannot draw', async () => {
  const log = [], old = deferred(); let loads = 0;
  const staleDoc = document(log, Promise.resolve());
  const pdfjs = { GlobalWorkerOptions: {}, getDocument: () => ++loads === 1 ? { promise: old.promise, destroy: async()=>log.push('destroy-old-loading') } : loading(document(log, Promise.resolve()), log) };
  const adapter = new PdfViewAdapter({ canvas: canvas(log), pdfjs });
  const first = adapter.replace({url:'material://pdf/m1', material_id:'m1', generation:1});
  await new Promise(resolve => setImmediate(resolve));
  const second = adapter.replace({url:'material://pdf/m2', material_id:'m2', generation:2});
  old.resolve(staleDoc);
  await Promise.all([first, second]);
  assert.ok(log.includes('destroy-old-loading'));
  assert.ok(log.includes('destroy-document'));
});

test('password callback is ephemeral, capped, cancellable, and errors are normalized', async () => {
  const log = [], gate = deferred(), attempts = [];
  const task = { promise: gate.promise, destroy: async () => { log.push('destroy-password'); gate.reject(Object.assign(new Error(), { name:'PasswordException' })); }, onPassword: null };
  const pdfjs = { GlobalWorkerOptions: {}, getDocument: () => task };
  const adapter = new PdfViewAdapter({ canvas: canvas(log), pdfjs, requestPassword: async value => { attempts.push(value); return value.attempt < 3 ? 'secret' : null; } });
  const result = adapter.replace({url:'material://pdf/m1', material_id:'m1', generation:1});
  await new Promise(resolve => setImmediate(resolve));
  const supplied = [];
  await task.onPassword(value => supplied.push(value), 1);
  await task.onPassword(value => supplied.push(value), 2);
  await task.onPassword(value => supplied.push(value), 2);
  await assert.rejects(result, error => error.code === 'PDF_PASSWORD_REQUIRED');
  assert.deepEqual(supplied, ['secret','secret']); assert.equal(attempts.length, 3);
});

test('invalid URL binding is rejected before PDF.js', async () => {
  let called = false;
  const adapter = new PdfViewAdapter({ canvas: canvas([]), pdfjs: { GlobalWorkerOptions:{}, getDocument(){ called=true; } } });
  await assert.rejects(adapter.replace({url:'material://pdf/m2', material_id:'m1', generation:1}), e => e.code === 'PDF_NOT_ALLOWED');
  assert.equal(called, false);
});

test('URL resolver can translate the custom scheme for WebView2', async () => {
  let loadedUrl = null;
  const pdfjs = {
    GlobalWorkerOptions: {},
    getDocument({ url }) {
      loadedUrl = url;
      return loading(document([], Promise.resolve()), []);
    },
  };
  const adapter = new PdfViewAdapter({
    canvas: canvas([]),
    pdfjs,
    resolveUrl: (_url, materialId) => `http://material.localhost/pdf/${materialId}`,
  });
  await adapter.replace({ url:'material://pdf/m1', material_id:'m1', generation:1 });
  assert.equal(loadedUrl, 'http://material.localhost/pdf/m1');
});

test('HTTP 413 and unreadable or unsupported PDF failures expose fallback codes', async () => {
  for (const [raw, code] of [
    [Object.assign(new Error(), { name: 'UnexpectedResponseException', status: 413 }), 'PDF_FALLBACK_TOO_LARGE'],
    [Object.assign(new Error(), { name: 'UnknownErrorException' }), 'PDF_NOT_READABLE'],
  ]) {
    const pdfjs = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.reject(raw), destroy: async () => {} }) };
    const adapter = new PdfViewAdapter({ canvas: canvas([]), pdfjs });
    await assert.rejects(adapter.replace({ url: 'material://pdf/m1', material_id: 'm1', generation: 1 }), error => error.code === code);
  }
});

const emptySearch = { search_query: '', search_index: 0, search_total: 0, page_text: '' };

test('view snapshot starts at page 1 and 100%, follows navigation and zoom, fits computed width, and clamps page boundaries', async () => {
  const adapter = new PdfViewAdapter({ canvas: canvas([]), pdfjs: { GlobalWorkerOptions: {}, getDocument: () => loading(document([], Promise.resolve(), 2, 200), []) } });
  assert.deepEqual(await adapter.replace({ url: 'material://pdf/m1', material_id: 'm1', generation: 7 }), { current_page: 1, total_pages: 2, zoom_percent: 100, ...emptySearch });
  assert.deepEqual(await adapter.previous({ generation: 7 }), { current_page: 1, total_pages: 2, zoom_percent: 100, ...emptySearch });
  assert.equal((await adapter.next({ generation: 7 })).current_page, 2);
  assert.equal((await adapter.next({ generation: 7 })).current_page, 2);
  assert.equal((await adapter.previous({ generation: 7 })).current_page, 1);
  assert.equal((await adapter.goToPage(2, { generation: 7 })).current_page, 2);
  assert.equal(await adapter.goToPage(3, { generation: 7 }), null);
  assert.equal((await adapter.zoomIn({ generation: 7 })).zoom_percent, 125);
  assert.equal((await adapter.zoomOut({ generation: 7 })).zoom_percent, 100);
  assert.equal((await adapter.fit(432, { generation: 7 })).zoom_percent, 200);
});

test('superseded generation cannot report view information for the replacement PDF', async () => {
  const adapter = new PdfViewAdapter({ canvas: canvas([]), pdfjs: { GlobalWorkerOptions: {}, getDocument: () => loading(document([], Promise.resolve()), []) } });
  await adapter.replace({ url: 'material://pdf/m1', material_id: 'm1', generation: 1 });
  await adapter.replace({ url: 'material://pdf/m2', material_id: 'm2', generation: 2 });
  assert.equal(await adapter.next({ generation: 1 }), null);
  assert.deepEqual(await adapter.next({ generation: 2 }), { current_page: 2, total_pages: 4, zoom_percent: 100, ...emptySearch });
});

test('PDF text search counts matches, opens the first page, wraps navigation, and clears', async () => {
  const log = [], pages = ['Agenda agenda', 'notes', 'agenda'];
  const doc = { numPages: pages.length, getPage: async number => page(log, Promise.resolve(), 10, pages[number - 1]), cleanup() {}, async destroy() {} };
  const adapter = new PdfViewAdapter({ canvas: canvas(log), pdfjs: { GlobalWorkerOptions: {}, getDocument: () => loading(doc, log) } });
  await adapter.replace({ url: 'material://pdf/m1', material_id: 'm1', generation: 3 });
  assert.deepEqual(await adapter.search('AGENDA', { generation: 3 }), { current_page: 1, total_pages: 3, zoom_percent: 100, search_query: 'AGENDA', search_index: 1, search_total: 3, page_text: 'Agenda agenda' });
  assert.equal((await adapter.searchNext({ generation: 3 })).search_index, 2);
  assert.equal((await adapter.searchNext({ generation: 3 })).current_page, 3);
  assert.equal((await adapter.searchNext({ generation: 3 })).search_index, 1);
  assert.equal((await adapter.searchPrevious({ generation: 3 })).search_index, 3);
  assert.deepEqual(await adapter.search('', { generation: 3 }), { current_page: 3, total_pages: 3, zoom_percent: 100, ...emptySearch, page_text: 'agenda' });
});
