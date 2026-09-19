import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { batchSummary, materialIcon, noticeMessage, noticeTone, visibleMaterials } from '../src/view.js';

const group = (id, name, order) => ({ id, parent_id: null, name, order });
const material = (id, group_id, name, order) => ({ id, group_id, name, role: 'main', target_type: 'file', path: `C:\\docs\\${id}.pdf`, window_match_pattern: null, order });

test('UI-01 searches 2,000 materials with group context inside 100 ms', () => {
  const config = { groups: [group('g1', '営業会議', 1), group('g2', '開発会議', 2)], materials: [] };
  for (let i = 0; i < 2_000; i++) config.materials.push(material(`m${i}`, i % 2 ? 'g1' : 'g2', `資料 ${i}`, Math.floor(i / 2) + 1));
  const start = performance.now(); const result = visibleMaterials(config, 'g1', '開発会議'); const elapsed = performance.now() - start;
  assert.equal(result.length, 1_000); assert.ok(result.every(item => item.group_id === 'g2')); assert.ok(elapsed < 100, `${elapsed} ms`);
});

test('failure, timeout, unknown and foreground denial never receive success tone', () => {
  for (const value of [{ code: 'CONFIG_IO' }, { code: 'PATH_TIMEOUT' }, { code: 'INTERNAL_ERROR' }, { outcome: 'foreground_denied' }]) assert.equal(noticeTone(value), 'warning');
  assert.equal(noticeTone('saved'), 'success');
});

test('notices use specific messages and never show a generic fallback', () => {
  assert.equal(noticeMessage({ outcome: 'launched' }), '資料を開きました。');
  assert.equal(noticeMessage({ outcome: 'unknown-result' }), '');
  assert.equal(noticeMessage(null), '');
});

test('SEC-01 dynamic view uses textContent and does not inject markup', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  const config = { groups: [group('g1', '<svg onload=alert(1)>', 1)], materials: [material('m1', 'g1', '<img onerror=alert(1)>', 1)] };
  assert.deepEqual(visibleMaterials(config, 'g1', 'onerror').map(item => item.id), ['m1']);
});

test('UI-02 keyboard routes cover search, context menu and escape without HTML insertion', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  for (const token of ["key.toLowerCase()==='f'", "e.key==='ContextMenu'", "e.shiftKey&&e.key==='F10'", "e.key==='Escape'"]) assert.ok(source.includes(token));
  assert.ok(!source.includes('innerHTML'));
});

test('PDF preview supports Ctrl-wheel zoom and pointer drag panning', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  for (const token of ["addEventListener('wheel'", "e.ctrlKey", "'pdfZoomIn'", "'pdfZoomOut'", 'setPointerCapture', 'scrollLeft', 'scrollTop', "classList.add('panning')"]) assert.ok(source.includes(token));
  const styles = readFileSync(new URL('../src/visibility.css', import.meta.url), 'utf8');
  assert.match(styles, /\.canvas-wrap canvas\s*\{[^}]*max-width:\s*none/s);
});

test('batch summary exposes success and failure counts', () => {
  assert.equal(batchSummary([{ error: null }, { error: { code: 'LAUNCH_FAILED' } }]), '一括起動: 成功 1件 / 失敗 1件');
});

test('primary toolbar omits the redundant edit-mode button and groups PDF controls', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  assert.match(source, /editActions\.append\(discardButton,saveButton\)/);
  assert.match(source, /auxiliaryActions\.append\(sync,reorderButton,addMaterial\)/);
  assert.match(source, /primaryActions\.append\(batch\)/);
  assert.doesNotMatch(source, /actions\.append\([^)]*edit/);
  for (const token of ["'pdf-document-picker'", "'preview-actions'", "'tool-group'", "'viewer-status'"]) assert.ok(source.includes(token));
});

test('PDF toolbar owns direct page input, page total and zoom indicators', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  for (const token of ["'page-input'", "'移動先のページ'", "emit('pdfPage',page)", "`/ ${next.pdf.total_pages}`", '`${next.pdf.zoom_percent}%`', "const viewing=next.pdf.kind==='Viewing'"]) assert.ok(source.includes(token));
});

test('PDF toolbar exposes submitted text search, match navigation, counts, and PDF-aware Ctrl+F', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  for (const token of ["'pdf-search'", "'pdf-search-toggle'", "'pdf-search-close'", 'searchTools.hidden=true', 'setPdfSearchOpen(true)', "emit('pdfSearch'", "emit('pdfSearchPrevious')", "emit('pdfSearchNext')", "`${next.pdf.search_index} / ${next.pdf.search_total}`"]) assert.ok(source.includes(token));
});

test('PDF controls reflow against the resizable preview width without overflowing labels', () => {
  const styles = readFileSync(new URL('../src/mock-styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.preview\{container:pdf-preview \/ inline-size/);
  assert.match(styles, /@container pdf-preview \(max-width:420px\)/);
  assert.match(styles, /\.preview-head\{[^}]*flex-wrap:wrap/);
  assert.match(styles, /\.viewer-toolbar\{[^}]*flex-wrap:wrap/);
  assert.match(styles, /\.pdf-search\{display:grid;grid-template-columns:minmax\(0,1fr\) repeat\(4,auto\)\}/);
  assert.match(styles, /\.viewer-toolbar button\{[^}]*white-space:nowrap/);
});

test('material rows expose a persistent PDF preview action and current-row state', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  assert.ok(source.includes("if(isPdf(item))add('アプリ内でPDF表示','pdf')"));
  assert.ok(source.includes('pdf-preview-button'));
  assert.ok(source.includes("r.setAttribute('aria-current','true')"));
  assert.ok(source.includes("icon=button('','activate','file-icon')"));
  assert.ok(source.includes("acts.append(openFolder,pdfPreview,more)"));
  assert.ok(source.includes('開いていない場合は外部アプリで開きます'));
  assert.ok(source.includes("add('外部で開く','activate')"));
  assert.doesNotMatch(source, /button\('開く','activate','primary'\)/);
  const styles = readFileSync(new URL('../src/visibility.css', import.meta.url), 'utf8');
  assert.match(styles, /\[hidden\][^{]*\{\s*display:\s*none\s*!important/);
});

test('PDF header exposes previous, direct selection and next document controls', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  for (const token of ["'pdf-document-previous'", "'pdf-document-select'", "'pdf-document-next'", "emit('openPdf',documentSelect.value)", "emit('pdfDocumentPrevious')", "emit('pdfDocumentNext')"]) assert.ok(source.includes(token));
});

test('file rows expose a direct open-containing-folder action', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  assert.ok(source.includes("actionIcon('open-folder','open-folder-button'"));
  assert.ok(source.includes("else if(a==='open-folder')emit('openContainingFolder',id)"));
  assert.ok(source.includes("p.openFolder.hidden=item.target_type!=='file'"));
  assert.ok(source.includes('の保存場所を開く'));
});

test('group navigation renders a collapsible parent-child tree', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  for (const token of ['collapsedGroups', "'group-toggle'", "'aria-expanded'", "children.get(g.id)", "'group-menu'", "'＋ ルート追加'"]) assert.ok(source.includes(token));
  assert.ok(source.includes("row.setAttribute('aria-level',String(depth+1))"));
  assert.ok(source.includes("'group-label'"));
  const styles = readFileSync(new URL('../src/mock-styles.css', import.meta.url), 'utf8');
  assert.match(styles, /padding-left:calc\(var\(--group-depth\) \* 18px\)/);
  assert.doesNotMatch(styles, /\.group-row::before|\.group-row::after/);
});

test('material icons are stable by target type and common extension', () => {
  assert.deepEqual(materialIcon({ target_type: 'folder', path: 'C:\\reports' }), { label: '📁', kind: 'folder' });
  assert.deepEqual(materialIcon({ target_type: 'url', path: 'https://example.com' }), { label: '↗', kind: 'url' });
  assert.deepEqual(materialIcon({ target_type: 'file', path: 'C:\\report.xlsx' }), { label: 'X', kind: 'excel' });
  assert.deepEqual(materialIcon({ target_type: 'file', path: 'C:\\manual.pdf' }), { label: 'PDF', kind: 'pdf' });
});

test('groups and materials expose internal drag reorder affordances', () => {
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  for(const token of ["'toggle-reorder'",'reorderMode','applyReorderMode',"el('span','drag-handle','⠿')",'elementFromPoint',"addEventListener('pointerdown'","addEventListener('pointermove'",'finishReorder','reorderGroup','reorderMaterial'])assert.ok(source.includes(token));
  assert.doesNotMatch(source,/addEventListener\('dragstart'/);
});

test('unsaved state uses a title indicator and toolbar actions without a floating popup', () => {
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  assert.ok(source.includes("editState=el('span','edit-state')"));
  assert.ok(source.includes("saveButton=button('保存','save'"));
  const styles=readFileSync(new URL('../src/mock-styles.css',import.meta.url),'utf8');
  assert.match(styles,/\.title-line\{display:flex/);
  assert.match(styles,/\.edit-state\[data-state="Dirty"\]/);
});

test('Ctrl+S saves dirty state through the existing save action', () => {
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  for(const token of ["e.key.toLowerCase()==='s'","['Dirty','Conflict'].includes(model?.edit)","emit('save')"])assert.ok(source.includes(token));
});

test('saved state uses the title indicator without a persistent success notice', () => {
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  assert.ok(source.includes("next.notice==='saved'?'':"));
  assert.ok(source.includes("editState.hidden=next.edit==='Clean'"));
});

test('toolbar groups remain stable and material status is lightweight', () => {
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  assert.ok(source.includes("setAttribute('aria-label','編集操作')"));
  assert.ok(source.includes("setAttribute('aria-label','補助操作')"));
  assert.ok(source.includes("setAttribute('aria-label','主要操作')"));
  assert.ok(source.includes("p.state.setAttribute('aria-label',`状態: ${stateLabel}`)"));
  const styles=readFileSync(new URL('../src/mock-styles.css',import.meta.url),'utf8');
  assert.match(styles,/\.status\[data-tone="available"\] \.status-mark/);
  assert.match(styles,/\.row-actions\{width:auto;display:flex;align-items:center;justify-content:flex-end/);
  assert.match(styles,/grid-template-columns:minmax\(240px,1fr\) 116px 72px/);
  assert.match(styles,/\.material-row \.row-actions\{position:absolute;right:12px;top:50%;transform:translateY\(-50%\)\}/);
  assert.doesNotMatch(styles,/\.pdf-preview-button\[hidden\]\{display:block/);
});

test('DnD confirmation and PDF external fallback are explicit UI actions', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  for (const token of ["'dnd-confirm'", "'dnd-cancel'", "'confirmDroppedFiles'", "'PDF_FALLBACK_TOO_LARGE'", "'pdf-external'", "'openPdfExternal'"]) assert.ok(source.includes(token));
});
