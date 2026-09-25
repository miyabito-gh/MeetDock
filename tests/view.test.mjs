import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { batchButtonAction, batchSummary, displayPath, materialIcon, noticeMessage, noticeTone, pdfArrowBoundaryDirection, pdfPageKeyDirection, placeStableRow, reorderAvailable, reorderDropAction, reorderPlacement, snapshotMaterialTarget, visibleMaterials } from '../src/view.js';

test('collapsed sidebar plus maximized PDF removes width limit and background focus', () => {
  const css = readFileSync(new URL('../src/mock-styles.css', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  assert.match(css, /\.app-shell\.sidebar-collapsed \.preview\.maximized\{max-width:none;flex-basis:100%;\}/);
  for (const region of ['sidebar', 'listPane', 'toolbar', 'split']) assert.match(view, new RegExp(`${region}\\.inert=`));
  assert.match(view, /pdfMaxButton\.setAttribute\('aria-pressed',String\(next\.layout\.pdf_maximized\)\)/);
  assert.match(view, /sidebarToggle\.setAttribute\('aria-expanded',String\(!next\.layout\.sidebar_collapsed\)\)/);
});

test('marker pointer capture cannot enter the pan handler and can be released', () => {
  const view = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/mock-styles.css', import.meta.url), 'utf8');
  assert.match(view, /overlay\.addEventListener\('pointerdown'.*e\.stopPropagation\(\);overlay\.setPointerCapture/s);
  assert.match(view, /wrap\.addEventListener\('pointerdown'.*\|\|markerTool\|\|/s);
  assert.match(view, /overlay\.addEventListener\('lostpointercapture'/);
  assert.match(css, /\.annotation-overlay\{pointer-events:none\}\.annotation-overlay\.drawing\{pointer-events:auto\}/);
});

test('pointer release dispatches reorder, role move and empty drop correctly',()=>{
  const source={group_id:'g1',role:'main'};
  assert.deepEqual(reorderDropAction('group','g2',null,{beforeId:'g1'}),{action:'reorderGroup',args:['g2','g1']});
  assert.deepEqual(reorderDropAction('material','m2',source,{beforeId:'m1',groupId:'g1',role:'main'}),{action:'reorderMaterial',args:['m2','m1']});
  assert.deepEqual(reorderDropAction('material','m2',source,{beforeId:null,groupId:'g1',role:'reference'}),{action:'moveMaterial',args:['m2','g1','reference',null]});
  assert.equal(reorderDropAction('material','m2',source,null),null);
});

test('keyboard placement covers each boundary and matches pointer insertion targets',()=>{
  const peers=[{id:'a'},{id:'b'},{id:'c'},{id:'d'}];
  assert.deepEqual(reorderPlacement(peers,'c','first'),{beforeId:'a'});
  assert.deepEqual(reorderPlacement(peers,'c','up'),{beforeId:'b'});
  assert.deepEqual(reorderPlacement(peers,'b','down'),{beforeId:'d'});
  assert.deepEqual(reorderPlacement(peers,'c','down'),{beforeId:null});
  assert.deepEqual(reorderPlacement(peers,'a','last'),{beforeId:null});
  assert.equal(reorderPlacement(peers,'a','up'),null);
  assert.equal(reorderPlacement(peers,'d','down'),null);
});

test('reorder entry follows edit, search and snapshot states',()=>{
  const state={can_edit:true,edit:'Clean',query:'',selected_group_id:'g1'};
  assert.equal(reorderAvailable(state),true);
  for(const changed of [{can_edit:false},{edit:'Saving'},{query:'report'},{selected_group_id:'window-snapshot'}])assert.equal(reorderAvailable({...state,...changed}),false);
});

test('search heading and role panels follow the visible result set',()=>{
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  assert.ok(source.includes("title.textContent=next.query?'検索結果':selected?.name??'資料'"));
  assert.ok(source.includes('mainRole.s.hidden=!mainCount&&!(reorderMode&&source.length);refRole.s.hidden=!referenceCount&&!(reorderMode&&source.length);emptyState.hidden=!noResults'));
  assert.ok(source.includes('mainRole.s.hidden=!items.length'));
  assert.ok(source.includes('if(next.selected_group_id!==WINDOW_SNAPSHOT_GROUP_ID||next.query)'));
});

test('stop button targets the running batch after navigation',()=>{
  const model={selected_group_id:'g2',launch:{batch:{group_id:'g1'}}};
  assert.deepEqual(batchButtonAction(model),{action:'cancelBatch',groupId:'g1'});
  assert.deepEqual(batchButtonAction({...model,launch:{batch:null}}),{action:'batch',groupId:'g2'});
});

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

test('Windows extended paths are normalized for display', () => {
  assert.equal(displayPath('\\\\?\\C:\\資料\\folder'), 'C:\\資料\\folder');
  assert.equal(displayPath('\\\\?\\unc\\server\\share\\folder'), '\\\\server\\share\\folder');
  assert.equal(displayPath('D:/資料/folder'), 'D:\\資料\\folder');
  const longUnc = `\\\\?\\UNC\\server\\share\\${'資料'.repeat(8000)}`;
  assert.equal(displayPath(longUnc), `\\\\server\\share\\${'資料'.repeat(8000)}`);
});

test('notices use specific messages and never show a generic fallback', () => {
  assert.equal(noticeMessage({ outcome: 'launched' }), '資料を開きました。');
  assert.equal(noticeMessage({ outcome: 'unknown-result' }), '');
  assert.equal(noticeMessage(null), '');
});

test('focus refresh keeps an ordered material row attached so the first icon click survives',()=>{
  const first={},second={};first.nextSibling=second;second.nextSibling=null;
  const insertions=[],container={firstChild:first,insertBefore:(row,before)=>insertions.push([row,before])};
  assert.equal(placeStableRow(container,first,null),first);
  assert.equal(placeStableRow(container,second,first),second);
  assert.deepEqual(insertions,[]);
  const moved={};placeStableRow(container,moved,first);
  assert.deepEqual(insertions,[[moved,second]]);
});

test('SEC-01 dynamic view uses textContent and does not inject markup', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  const config = { groups: [group('g1', '<svg onload=alert(1)>', 1)], materials: [material('m1', 'g1', '<img onerror=alert(1)>', 1)] };
  assert.deepEqual(visibleMaterials(config, 'g1', 'onerror').map(item => item.id), ['m1']);
});

test('modal key handling is isolated from document shortcuts', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  assert.match(source, /for\(const modal of \[dialog,operationDialog,issue,dndDialog,windowsDialog\]\) modal\.addEventListener\('keydown',e=>e\.stopPropagation\(\)\)/);
  assert.match(source, /const modalOpen=dialog\.open\|\|issue\.open\|\|dndDialog\.open\|\|windowsDialog\.open;if\(modalOpen\)return/);
});

test('window inventory dialog balances context and workspace while keeping settings outside the list scroll', () => {
  const styles = readFileSync(new URL('../src/mock-styles.css', import.meta.url), 'utf8');
  assert.match(styles, /dialog\.modal\.windows-dialog\[open\]\{display:flex;width:min\(1080px,calc\(100vw - 64px\)\);max-width:min\(1080px,calc\(100vw - 64px\)\);height:min\(760px,calc\(100vh - 48px\)\)/);
  assert.match(styles, /\.windows-dialog:not\(\[open\]\)\{display:none\}/);
  assert.doesNotMatch(styles, /\.windows-dialog\{[^}]*width:/);
  assert.match(styles, /\.windows-list\{flex:1 1 auto;min-height:0;max-height:none;overflow:auto/);
  assert.match(styles, /\.window-exclusions\{flex:0 0 auto;max-height:180px;overflow:auto/);
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  assert.ok(source.includes("windowsRefresh=button('↻ 更新','refresh-windows','secondary')"));
  assert.ok(source.includes("action==='refresh-windows'"));
  assert.doesNotMatch(source,/windowsDialog\.addEventListener\('close'/);
});
test('saved windows appear as a sidebar group with launch and registration actions',()=>{
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  for(const token of ["'一時保存したウィンドウ'","openMenu({kind:'snapshot'","add('グループへ登録','register-window-snapshot',model.can_edit)","renderSnapshotMaterials(next)","emit('launchAllWindowSnapshot')","emit('registerWindowSnapshot')","emit('launchWindowSnapshot',index)"])assert.ok(source.includes(token));
  assert.ok(source.includes("button('現在を一時保存','save-window-snapshot','secondary')"));
  assert.ok(source.includes('windowsHeadActions.insertBefore(snapshotSave,windowsRefresh)'));
  for(const duplicate of ['window-snapshot-list','window-snapshot-row','保存一覧を表示',"'launch-all-window-snapshot'"])assert.ok(!source.includes(duplicate));
});

test('window inventory groups applications and sorts groups and titles without usage history', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../src/mock-styles.css', import.meta.url), 'utf8');
  for (const token of ["new Intl.Collator('ja'", "key=`${item.app_name}\\u0000${item.executable_name}`", "'window-app-group'", "'window-app-head'", "`${group.items.length}件`", "group.items.sort((a,b)=>collator.compare(a.title,b.title))"]) assert.ok(source.includes(token));
  assert.ok(source.includes("windowsList.querySelectorAll('.window-row')"));
  assert.match(styles, /\.window-app-group\{[^}]*border:1px solid var\(--line\)/);
  assert.match(styles, /\.window-app-head\{[^}]*min-height:40px/);
  assert.match(styles, /\.window-app-items \.window-row\{min-height:42px;padding:5px 10px 5px 44px\}/);
  assert.match(styles, /\.window-app-group\{margin:5px 0 8px/);
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

test('PDF preview keyboard paging maps supported keys and ignores unsafe key events', () => {
  assert.equal(pdfPageKeyDirection({ key: 'PageUp' }), -1);
  assert.equal(pdfPageKeyDirection({ key: 'PageDown' }), 1);
  for (const key of ['ArrowUp', 'ArrowDown', ' ']) assert.equal(pdfPageKeyDirection({ key }), 0);
  assert.equal(pdfArrowBoundaryDirection({ key: 'ArrowUp' }, 0, 300, 900), -1);
  assert.equal(pdfArrowBoundaryDirection({ key: 'ArrowDown' }, 600, 300, 900), 1);
  assert.equal(pdfArrowBoundaryDirection({ key: 'ArrowDown' }, 598, 300, 900), 0);
  assert.equal(pdfArrowBoundaryDirection({ key: 'ArrowDown', repeat: true }, 600, 300, 900), 0);
  for (const blocked of ['repeat', 'isComposing', 'ctrlKey', 'metaKey', 'altKey']) assert.equal(pdfPageKeyDirection({ key: 'PageDown', [blocked]: true }), 0);
  assert.equal(pdfPageKeyDirection({ key: 'PageDown', keyCode: 229 }), 0);
  assert.equal(pdfPageKeyDirection({ key: 'Home' }), 0);
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  for (const token of ["wrap.tabIndex=0", "'PDFプレビュー本文'", "'aria-describedby'", "'aria-live','polite'", "interactive=e.target.closest?.('input,textarea,select,button,[contenteditable]", 'dialog.open||issue.open||dndDialog.open', '!menu.hidden||panning||resizing', "emit('pdfPrevious')", "emit('pdfNext')", 'wrap.focus({preventScroll:true})', "pendingPdfScrollPosition='end'", "pendingPdfScrollPosition='start'", "wrap.scrollTop=pendingPdfScrollPosition==='end'?wrap.scrollHeight:0"]) assert.ok(source.includes(token));
  const styles = readFileSync(new URL('../src/visibility.css', import.meta.url), 'utf8');
  assert.match(styles, /\.canvas-wrap:focus-visible\s*\{[^}]*outline:/s);
});

test('batch summary exposes success and failure counts', () => {
  assert.equal(batchSummary([{ error: null }, { error: { code: 'LAUNCH_FAILED' } }]), '一括起動: 成功 1件 / 失敗 1件');
});

test('primary toolbar omits the redundant edit-mode button and groups PDF controls', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  assert.match(source, /editActions\.append\(discardButton,saveButton\)/);
  assert.match(source, /runtimeActions\.append\(sync,windowsButton\)/);
  assert.match(source, /auxiliaryActions\.append\(runtimeActions,addMaterial,moreActions\)/);
  assert.match(source, /primaryActions\.append\(batch\)/);
  assert.doesNotMatch(source, /actions\.append\([^)]*edit/);
  for (const token of ["'pdf-document-picker'", "'preview-actions'", "'tool-group'", "'viewer-status'"]) assert.ok(source.includes(token));
});

test('runtime actions use consistent labeled icons and low-frequency reorder lives in overflow', () => {
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  const styles=readFileSync(new URL('../src/mock-styles.css',import.meta.url),'utf8');
  assert.ok(source.includes("sync=button('','sync','secondary toolbar-icon-button')"));
  assert.ok(source.includes("windowsButton=button('','open-windows','secondary toolbar-icon-button')"));
  assert.ok(source.includes("windowsButton.setAttribute('aria-label','ウィンドウ一覧を開く')"));
  assert.ok(source.includes("runtimeActions.setAttribute('aria-label','状態とウィンドウ')"));
  assert.ok(source.includes("moreSummary.setAttribute('aria-label','その他の操作')"));
  assert.ok(source.includes("morePanel.append(el('div','toolbar-menu-heading','配置'),reorderButton)"));
  assert.ok(source.includes("el('div','toolbar-menu-heading','データ')"));
  assert.ok(source.includes("reorderControls.append(reorderHint,reorderDone,reorderCancel)"));
  assert.ok(source.includes('if(!moreActions.contains(e.target))moreActions.open=false'));
  assert.ok(source.includes('moreActions.open=false;if(pdfSearchOpen)'));
  assert.match(styles,/\.toolbar-icon-button\{width:32px;height:30px!important/);
  assert.match(styles,/\.toolbar-more-panel\{position:absolute/);
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
  assert.match(styles, /\.app-shell\.sidebar-collapsed \.preview\{max-width:calc\(1200px \+ var\(--sidebar-w,250px\)\)\}/);
  assert.match(styles, /@container pdf-preview \(max-width:520px\)/);
  assert.match(styles, /\.preview-head\{[^}]*flex-wrap:wrap/);
  assert.match(styles, /\.viewer-toolbar\{[^}]*flex-wrap:wrap/);
  assert.match(styles, /\.pdf-search\{display:grid;grid-template-columns:minmax\(0,1fr\) repeat\(4,auto\)\}/);
  assert.match(styles, /\.viewer-toolbar button\{[^}]*white-space:nowrap/);
});

test('material rows expose a persistent PDF preview action and current-row state', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  assert.ok(source.includes("if(isPdf(item))add('アプリ内でPDF表示','pdf',runnable)"));
  assert.ok(source.includes('pdf-preview-button'));
  assert.ok(source.includes("r.setAttribute('aria-current','true')"));
  assert.ok(source.includes("icon=button('','activate','file-icon')"));
  assert.ok(source.includes("acts.append(openFolder,pdfPreview,remove,more)"));
  assert.ok(source.includes('開いていない場合は外部アプリで開きます'));
  assert.ok(source.includes("add('外部で開く','activate',runnable)"));
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

test('saved window rows reuse material icons and the left icon owns activate-or-launch',()=>{
  assert.deepEqual(materialIcon(snapshotMaterialTarget({executable_name:'explorer.exe',executable_path:'C:\\Windows\\explorer.exe',document_path:'C:\\Meetings'})),{label:'📁',kind:'folder'});
  assert.deepEqual(materialIcon(snapshotMaterialTarget({executable_name:'WINWORD.EXE',executable_path:'C:\\Office\\WINWORD.EXE',document_path:'C:\\Meetings\\agenda.docx'})),{label:'W',kind:'word'});
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  assert.ok(source.includes("button('','launch-window-snapshot','file-icon')"));
  assert.ok(source.includes('snapshotRows=new Map()'));
  assert.ok(source.includes('placeStableRow(mainRole.list,row,previous)'));
  assert.ok(source.includes('開いていない場合は外部アプリで開きます'));
  assert.ok(!source.includes("next.window_snapshot_running.includes(index)?'起動中…':'開く'"));
});

test('groups and materials expose internal drag reorder affordances', () => {
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  const styles=readFileSync(new URL('../src/mock-styles.css',import.meta.url),'utf8');
  for(const token of ["'toggle-reorder'",'reorderMode','applyReorderMode',"el('button','drag-handle','⠿')",'elementFromPoint',"addEventListener('pointerdown'","addEventListener('pointermove'",'finishReorder','reorderGroup','reorderMaterial','reorderPlacement','cancelReorder'])assert.ok(source.includes(token));
  assert.doesNotMatch(source,/addEventListener\('dragstart'/);
  assert.match(styles,/\.drag-handle\{[^}]*width:24px;[^}]*flex:0 0 24px/);
});

test('reorder mode deletes material registration without confirmation',()=>{
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  const styles=readFileSync(new URL('../src/mock-styles.css',import.meta.url),'utf8');
  assert.ok(source.includes("actionIcon('delete-material','reorder-delete-button danger'"));
  assert.match(source,/else if\(a==='delete-material'\)emit\('deleteMaterial',id,true\)/);
  assert.ok(source.includes("else if(a==='delete-material')openOperation({title:'資料の登録を削除'"));
  assert.match(styles,/\.reorder-delete-button\{display:none\}/);
  assert.match(styles,/\.reorder-mode \.material-row\[data-material-id\]/);
  assert.match(styles,/\.reorder-mode \.reorder-delete-button\{display:grid\}/);
});

test('temporary window group stays separated at the bottom and never exposes reorder affordance',()=>{
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  const styles=readFileSync(new URL('../src/mock-styles.css',import.meta.url),'utf8');
  assert.ok(source.includes("row.classList.contains('snapshot-group')"));
  assert.ok(source.includes('groups.append(row)'));
  assert.ok(source.includes("previousEdit==='Saving'&&next.edit==='Clean'"));
  assert.ok(source.includes('for(const row of snapshotRows.values())row.remove()'));
  assert.match(styles,/\.snapshot-group\{[^}]*border-top:1px solid var\(--line\)/);
  assert.match(styles,/\.reorder-mode \.snapshot-group\{[^}]*grid-template-columns:26px minmax\(0,1fr\) 28px/);
});

test('material pointer reorder can move across roles at an explicit position or section tail', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../src/mock-styles.css', import.meta.url), 'utf8');
  for (const token of ["s.dataset.role=role", "closest('.role-section')", "beforeId:before?.dataset.materialId??null", "reorderDropAction(kind,sourceId,source,target)", "'drop-tail'"])
    assert.ok(source.includes(token), token);
  assert.ok(source.includes("ratio=index===candidates.length-1 ? .35 : .5"));
  assert.ok(source.includes("y>=rect.bottom&&y<=rect.bottom+14"));
  assert.ok(source.includes("before=tailSection?null:"));
  assert.match(styles,/\.reorder-mode \.materials\{[^}]*min-height:10px;[^}]*padding-bottom:10px/);
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

test('Explorer opening mode remains internal and is not exposed as a UI setting', () => {
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/button\('Explorerの開き方'/);
  assert.doesNotMatch(source,/group-explorer-mode/);
  assert.match(source,/button\('全体をエクスポート'/);
  assert.match(source,/button\('選択グループをエクスポート'/);
  const styles=readFileSync(new URL('../src/mock-styles.css',import.meta.url),'utf8');
  assert.match(styles,/\.toolbar-more-panel\{width:max-content;min-width:180px/);
  assert.match(styles,/\.toolbar-menu-button\{white-space:nowrap\}/);
});

test('empty search results provide a clear recovery action', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  assert.ok(source.includes("'empty-state'"));
  assert.ok(source.includes("'clear-search'"));
  assert.ok(source.includes("emit('search','')"));
  assert.ok(source.includes("検索語やグループ名を変えてお試しください。"));
});

test('DnD confirmation and PDF external fallback are explicit UI actions', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  for (const token of ["'dnd-confirm'", "'dnd-cancel'", "'confirmDroppedFiles'", "'PDF_FALLBACK_TOO_LARGE'", "'pdf-external'", "'openPdfExternal'"]) assert.ok(source.includes(token));
  for (const token of ['droppedFailureText',"'dnd-failure'",'件は登録できませんでした','failure.path']) assert.ok(source.includes(token));
});

test('group and material operations use an accessible in-app dialog with explicit contracts', () => {
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  const styles=readFileSync(new URL('../src/mock-styles.css',import.meta.url),'utf8');
  for(const token of ["'modal operation-dialog'","'子グループと資料を含めて複製'","'別のグループへ移動'","'登録のみ削除（実ファイルは残す）'","emit('duplicateGroup',item.id)","emit('moveGroup',item.id,parentId||null)","emit('moveMaterial',item.id,item.group_id,item.role==='main'?'reference':'main')",'groupDescendants(item.id)',"operationDialog.addEventListener('cancel'","operationSubmit.type='submit'"])assert.ok(source.includes(token));
  assert.doesNotMatch(source,/prompt\('(新しいグループ名|子グループ名|グループ名)'/);
  assert.doesNotMatch(source,/confirm\('(未保存の変更|空のグループ|資料を削除)/);
  assert.match(styles,/\.operation-dialog-text\{[^}]*line-height:1\.6/);
  assert.match(styles,/\.operation-dialog \.field\[hidden\]\{display:none!important\}/);
  assert.match(styles,/\.danger-button\{[^}]*background:var\(--danger\)/);
});

test('confirmation-only operations do not leave a hidden required input blocking submit',()=>{
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  assert.ok(source.includes('operationInput.hidden=Boolean(options)||!label'));
  assert.ok(source.includes('operationInput.required=Boolean(label&&!options)'));
  assert.ok(source.includes('(options?operationSelect:label?operationInput:operationSubmit).focus()'));
});

test('data transfer and save-before-create stay inside the existing operation UI',()=>{
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  for(const token of ["exportBundle(model.config","showSaveFilePicker({suggestedName","handle.createWritable()","writable.write(JSON.stringify(bundle,null,2))","error?.name==='AbortError'","'export-all'","'export-group'","'import-data'","requestGroupCreate(null)","pendingGroupCreation&&next.edit==='Clean'","pendingGroupCreation={parentId,name}","parent_id:pending.parentId,name:pending.name","既存データは置き換えません"])assert.ok(source.includes(token));
  assert.doesNotMatch(source,/anchor\.download=/);
  assert.doesNotMatch(source,/prompt\([^)]*(?:グループ|インポート|エクスポート)/);
});
