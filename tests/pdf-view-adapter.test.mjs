import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PdfViewAdapter, PDF_CMAP_URL, PDF_WORKER_URL } from '../src/pdf-view-adapter.js';

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
  let loadedOptions = null;
  const pdfjs = {
    GlobalWorkerOptions: {},
    getDocument(options) {
      loadedOptions = options;
      return loading(document([], Promise.resolve()), []);
    },
  };
  const adapter = new PdfViewAdapter({
    canvas: canvas([]),
    pdfjs,
    resolveUrl: (_url, materialId) => `http://material.localhost/pdf/${materialId}`,
  });
  await adapter.replace({ url:'material://pdf/m1', material_id:'m1', generation:1 });
  assert.deepEqual(loadedOptions, {
    url: 'http://material.localhost/pdf/m1',
    cMapUrl: PDF_CMAP_URL,
    cMapPacked: true,
  });
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

test('button and wheel zoom preserve direction after PDF links specify scales beyond normal limits', async () => {
  let changed;
  const zooms=[],origin=[120,240];
  const viewerPort={listen(listener){changed=listener},async setDocument(){},setScale(){},showPage(){},zoom(scale,point){zooms.push({scale,point});return scale}};
  const adapter=new PdfViewAdapter({viewerPort,pdfjs:{GlobalWorkerOptions:{},getDocument:()=>loading(document([],Promise.resolve()),[])}});
  await adapter.replace({url:'material://pdf/m1',material_id:'m1',generation:1});
  for(const [scale,action,expected] of [
    [4,'zoomIn',4],[4,'zoomOut',3.75],
    [.25,'zoomOut',.25],[.25,'zoomIn',.5],
    [.1,'zoomOut',.1],[.1,'zoomIn',.35],
    [3,'zoomIn',3],[.5,'zoomOut',.5],
    [1,'zoomIn',1.25],[1,'zoomOut',.75],
  ]){
    await changed({page:1,scale});
    const view=await adapter[action]({generation:1,origin});
    assert.equal(view.zoom_percent,Math.round(expected*100),`${action} at ${scale}x`);
    assert.equal(zooms.at(-1).scale,expected);
    assert.deepEqual(zooms.at(-1).point,origin);
  }
  await adapter.close();
});

test('document switches and closing the preview preserve each PDF page and zoom for the app session', async () => {
  const pdfjs = {
    GlobalWorkerOptions: {},
    getDocument: ({ url }) => loading(document([], Promise.resolve(), url.endsWith('/m1') ? 4 : 2), []),
  };
  const adapter = new PdfViewAdapter({ canvas: canvas([]), pdfjs });
  await adapter.replace({ url: 'material://pdf/m1', material_id: 'm1', generation: 1 });
  await adapter.goToPage(3, { generation: 1 });
  await adapter.zoomIn({ generation: 1 });

  assert.deepEqual(await adapter.replace({ url: 'material://pdf/m2', material_id: 'm2', generation: 2 }), { current_page: 1, total_pages: 2, zoom_percent: 100, ...emptySearch });
  await adapter.goToPage(2, { generation: 2 });
  await adapter.zoomIn({ generation: 2 });
  assert.deepEqual(await adapter.replace({ url: 'material://pdf/m1', material_id: 'm1', generation: 3 }), { current_page: 3, total_pages: 4, zoom_percent: 125, ...emptySearch });

  await adapter.close();
  assert.deepEqual(await adapter.replace({ url: 'material://pdf/m2', material_id: 'm2', generation: 4 }), { current_page: 2, total_pages: 2, zoom_percent: 125, ...emptySearch });
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

test('viewer viewport is captured at detach and restored per PDF despite delayed page events and intervening snapshots', async () => {
  let viewport=null;
  const restored=[];
  const viewerPort={listen(){},async setDocument(){},setScale(){},showPage(page){viewport={page,scale:1,x:0,y:0}},
    captureView:()=>viewport,async restoreView(position){restored.push({...position});viewport={...position};return {page:position.page,scale:position.scale}}};
  const adapter=new PdfViewAdapter({viewerPort,pdfjs:{GlobalWorkerOptions:{},getDocument:()=>loading(document([],Promise.resolve()),[])}});
  const open=(id,generation)=>adapter.replace({url:`material://pdf/${id}`,material_id:id,generation});
  await open('m1',1);viewport={page:3,scale:1.5,x:17.25,y:293.125};
  await open('m2',2);viewport={page:2,scale:1,x:-20,y:50};
  const view=await open('m1',3);
  assert.equal(view.current_page,3);assert.equal(view.zoom_percent,150);
  assert.deepEqual(restored[0],{page:3,scale:1.5,x:17.25,y:293.125});
  viewport=null;await adapter.goToPage(3,{generation:3});viewport=null;
  await open('m2',4);assert.deepEqual(restored[1],{page:2,scale:1,x:-20,y:50});
  await open('m1',5);assert.deepEqual(restored[2],{page:3,scale:1.5,x:17.25,y:293.125});
  await adapter.close();
});

test('switching during a pending viewport restore keeps the prior completed viewport and ignores its stale result', async () => {
  let viewport=null,gate=null,captures=0;
  const restored=[];
  const viewerPort={listen(){},async setDocument(){},setScale(){},showPage(page){viewport={page,scale:1,x:0,y:0}},captureView(){captures++;return viewport},
    async restoreView(position){restored.push({...position});viewport={page:1,scale:1,x:0,y:0};if(gate)return gate.promise;viewport={...position};return {page:position.page,scale:position.scale}}};
  const adapter=new PdfViewAdapter({viewerPort,pdfjs:{GlobalWorkerOptions:{},getDocument:()=>loading(document([],Promise.resolve()),[])}});
  const open=(id,generation)=>adapter.replace({url:`material://pdf/${id}`,material_id:id,generation});
  await open('m1',1);viewport={page:3,scale:1.5,x:5,y:210};await open('m2',2);
  gate=deferred();const old=open('m1',3);await new Promise(resolve=>setImmediate(resolve));
  const capturesBefore=captures,newer=open('m2',4);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(captures,capturesBefore,'intermediate restored geometry must not overwrite the good saved viewport');
  const release=gate;gate=null;release.resolve({page:1,scale:1});await Promise.all([old,newer]);
  const view=await open('m1',5);assert.equal(view.current_page,3);
  assert.deepEqual(restored.at(-1),{page:3,scale:1.5,x:5,y:210});await adapter.close();
});
