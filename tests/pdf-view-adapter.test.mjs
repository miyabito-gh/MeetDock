import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PdfViewAdapter, PDF_WORKER_URL } from '../src/pdf-view-adapter.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function canvas(log) { return { _w: 1, _h: 1, get width() { return this._w; }, set width(v) { this._w=v; log.push(`width:${v}`); }, get height() { return this._h; }, set height(v) { this._h=v; log.push(`height:${v}`); }, getContext: () => ({}) }; }
function page(log, pending = Promise.resolve()) { return { getViewport: () => ({ width: 10, height: 20 }), render: () => ({ promise: pending, cancel: () => log.push('cancel') }) }; }
function document(log, renderPromise) { return { getPage: async () => page(log, renderPromise), cleanup: () => log.push('cleanup'), destroy: async () => log.push('destroy-document') }; }
function loading(doc, log) { return { promise: Promise.resolve(doc), destroy: async () => log.push('destroy-loading'), onPassword: null }; }

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
