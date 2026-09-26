import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { runInNewContext } from 'node:vm';
import { createFocusSync } from '../src/focus-sync.js';
import { accumulatePdfWheel, createPdfWheelState } from '../src/pdf-wheel.js';
import { annotationSessionChange, commitAnnotations, createAnnotationHistory, createStroke, redoAnnotations, undoAnnotations } from '../src/pdf-annotations.js';
import { batchButtonAction, batchSummary, displayPath, groupTreeRenderKey, materialIcon, menuNextIndex, noticeMessage, noticeTone, pdfArrowBoundaryDirection, pdfOverlayBounds, pdfPageKeyDirection, placeStableRow, reorderAvailable, reorderDropAction, reorderPlacement, snapshotMaterialTarget, visibleMaterials } from '../src/view.js';

test('PDF annotation canvas follows the rendered page and stays transparent',()=>{
  assert.deepEqual(pdfOverlayBounds({offsetLeft:24,offsetTop:24,clientWidth:712,clientHeight:1007}),{left:24,top:24,width:712,height:1007});
  assert.deepEqual(pdfOverlayBounds({offsetLeft:163,offsetTop:24,clientWidth:390,clientHeight:552}),{left:163,top:24,width:390,height:552});
  const view=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  const styles=readFileSync(new URL('../src/mock-styles.css',import.meta.url),'utf8');
  assert.match(view,/overlay\.style\.left=`\$\{bounds\.left\}px`/);
  assert.match(view,/overlay\.style\.top=`\$\{bounds\.top\}px`/);
  assert.match(view,/new ResizeObserver\(\(\)=>drawAnnotations\(\)\)\.observe\(canvas\)/);
  assert.match(styles,/\.canvas-wrap \.annotation-overlay\{[^}]*background:transparent;box-shadow:none/);
});

test('PDF marker and bookmark controls use the standard menu background',()=>{
  const styles=readFileSync(new URL('../src/mock-styles.css',import.meta.url),'utf8');
  assert.match(styles,/\.annotation-toolbar\{[^}]*background:#fff/);
  assert.match(styles,/\.bookmark-panel\{[^}]*background:#fff/);
  assert.match(styles,/\.toolbar-more-panel\{[^}]*background:#fff/);
});

test('PDF marker and bookmark controls are collapsible and bookmarks use a scrolling left rail',()=>{
  const view=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  const styles=readFileSync(new URL('../src/mock-styles.css',import.meta.url),'utf8');
  assert.match(view,/annotationTools\.hidden=true;bookmarkPanel\.hidden=true/);
  assert.ok(view.indexOf("const markerToolsToggle=pdfIconButton('marker-tools-toggle'")<view.indexOf('utilityGroup.append('));
  assert.ok(view.indexOf("bookmarkToolsToggle=pdfIconButton('bookmark-tools-toggle'")<view.indexOf('utilityGroup.append('));
  assert.match(view,/a==='marker-tools-toggle'.*annotationTools\.hidden=!annotationTools\.hidden/s);
  assert.match(view,/a==='bookmark-tools-toggle'.*bookmarkPanel\.hidden=!bookmarkPanel\.hidden/s);
  assert.match(view,/pdfViewerBody=el\('div','pdf-viewer-body'\)/);
  assert.match(view,/pdfViewerBody\.insertBefore\(bookmarkPanel,wrap\)/);
  assert.match(styles,/\.pdf-viewer-body\{[^}]*display:flex;flex:1;[^}]*min-height:0;overflow:hidden/);
  assert.match(styles,/\.bookmark-panel\{[^}]*flex:0 0 min\(210px,42%\);[^}]*border-right:1px solid var\(--line\);[^}]*display:flex;flex-direction:column;overflow:hidden/);
  assert.match(styles,/\.bookmark-list\{[^}]*flex:1;min-height:0;[^}]*overflow-y:auto;overscroll-behavior:contain/);
  assert.match(styles,/\.bookmark-list:empty\{display:none\}/);
});

test('bookmark rendering preserves the user collapsed state while viewing',()=>{
  const view=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  const render=view.slice(view.indexOf('  function renderBookmarks(')).split('\n')[0];
  const scope={bookmarks:[],bookmarkList:{replaceChildren(){}},bookmarkPanel:{hidden:true},model:{pdf:{kind:'Viewing'}},el(){},button(){}};
  runInNewContext(render,scope);
  scope.renderBookmarks();
  assert.equal(scope.bookmarkPanel.hidden,true);
  scope.bookmarkPanel.hidden=false;
  scope.renderBookmarks();
  assert.equal(scope.bookmarkPanel.hidden,false);
  scope.model.pdf.kind='Closed';
  scope.renderBookmarks();
  assert.equal(scope.bookmarkPanel.hidden,true);
});

test('bookmark rows keep navigation visible and put edit actions behind one compact menu',()=>{
  const view=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  const render=view.slice(view.indexOf('  function renderBookmarks(')).split('\n')[0];
  const node=(tag,cls,text)=>({tag,cls,text,children:[],dataset:{},attributes:{},append(...children){this.children.push(...children)},setAttribute(name,value){this.attributes[name]=value}});
  const list={rows:[],replaceChildren(){this.rows=[]},append(row){this.rows.push(row)}};
  const scope={bookmarks:[{id:'b1',name:'Agenda',page:2},{id:'b2',name:'Notes',page:5}],bookmarkList:list,bookmarkPanel:{hidden:false},model:{pdf:{kind:'Viewing'}},el:node,button:(label,action,cls)=>Object.assign(node('button',cls,label),{action}),pdfIconButton:(action,label,paths,cls)=>Object.assign(node('button',cls,label),{action})};
  runInNewContext(render,scope);
  scope.renderBookmarks();
  assert.equal(list.rows.length,2);
  const [jump,more]=list.rows[0].children[0].children;
  assert.equal(jump.action,'bookmark-jump');
  assert.equal(jump.text,'Agenda');
  assert.equal(more.action,'bookmark-menu');
  assert.equal(more.attributes['aria-expanded'],'false');
  const actions=list.rows[0].children[1];
  assert.equal(actions.hidden,true);
  assert.deepEqual(Array.from(actions.children,button=>button.action),['bookmark-rename','bookmark-up','bookmark-down','bookmark-delete']);
  assert.equal(actions.children[1].disabled,true);
  assert.equal(list.rows[1].children[1].children[2].disabled,true);
});

test('opening one bookmark action menu closes the other and keeps the control state in sync',()=>{
  const view=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  const handlerSource=view.slice(view.indexOf("  bookmarkPanel.addEventListener('click'" )).split('\n')[0];
  const makeMenu=hidden=>{
    const actions={hidden};
    const row={querySelector:()=>actions};
    const menu={disabled:false,dataset:{action:'bookmark-menu'},attributes:{},closest:()=>row,setAttribute(name,value){this.attributes[name]=value}};
    return {actions,menu};
  };
  const first=makeMenu(true),second=makeMenu(false);
  const scope={bookmarkPanel:{addEventListener:(type,handler)=>{scope.click=handler}},bookmarkList:{querySelectorAll:()=>[first.menu,second.menu]},model:{pdf:{kind:'Viewing'}}};
  runInNewContext(handlerSource,scope);
  scope.click({target:{closest:()=>first.menu}});
  assert.equal(first.actions.hidden,false);
  assert.equal(first.menu.attributes['aria-expanded'],'true');
  assert.equal(second.actions.hidden,true);
  assert.equal(second.menu.attributes['aria-expanded'],'false');
  scope.click({target:{closest:()=>first.menu}});
  assert.equal(first.actions.hidden,true);
  assert.equal(first.menu.attributes['aria-expanded'],'false');
});

test('PDF reading toolbar separates primary controls and keeps narrow bookmark rail over the canvas',()=>{
  const view=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  const styles=readFileSync(new URL('../src/mock-styles.css',import.meta.url),'utf8');
  assert.match(view,/zoomGroup\.append\([^;]+\);utilityGroup\.append\(pdfSearchToggle,markerToolsToggle,bookmarkToolsToggle\);ptools\.append\(pageGroup,zoomGroup,utilityGroup\)/);
  for(const action of ['pdf-search-toggle','marker-tools-toggle','bookmark-tools-toggle','pdf-fit','bookmark-add']) assert.ok(view.includes(`pdfIconButton('${action}'`));
  assert.match(styles,/\.viewer-toolbar \.pdf-zoom-group,\.viewer-toolbar \.pdf-utility-group\{[^}]*border-left:1px solid/);
  assert.match(styles,/@container pdf-preview \(max-width:520px\)\{[^\n]*\.bookmark-panel\{position:absolute;inset:0 auto 0 0/);
});

test('PDF marker colors visibly expose selection and retain toggle and eraser behavior',()=>{
  const view=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  const styles=readFileSync(new URL('../src/mock-styles.css',import.meta.url),'utf8');
  const control=color=>({dataset:{color},setAttribute(name,value){this[name]=value}});
  const colors=['yellow','green','pink'].map(control),eraser=control();
  const handlers={};
  const scope={selectSidecar(){},annotationUndo:{},annotationRedo:{},clearMarkers:{},bookmarkAdd:{},overlay:{classList:{toggle(){}}},colorTools:{querySelectorAll:()=>colors},eraser,drawAnnotations(){},renderBookmarks(){},annotationHistory:createAnnotationHistory(),markerTool:null,markerColor:'yellow',model:{pdf:{kind:'Viewing'}},annotationTools:{addEventListener:(type,handler)=>{handlers[type]=handler}},widthSelect:{addEventListener(){}}};
  const update=view.slice(view.indexOf('  function updateAnnotations(')).split('\n')[0];
  runInNewContext(update,scope);
  const start=view.indexOf("annotationTools.addEventListener('click'");
  runInNewContext(view.slice(start,view.indexOf('const overlayPoint=',start)),scope);
  const pressed=()=>colors.map(item=>item['aria-pressed']);
  const click=(action,color)=>handlers.click({target:{closest:()=>({dataset:{action,color}})}});
  scope.updateAnnotations(scope.model);
  assert.deepEqual(pressed(),['false','false','false']);
  for(const [index,color] of ['yellow','green','pink'].entries()){
    click('marker-color',color);
    assert.deepEqual(pressed(),colors.map((_,i)=>String(i===index)));
    assert.equal(eraser['aria-pressed'],'false');
    click('marker-color',color);
    assert.deepEqual(pressed(),['false','false','false']);
    assert.equal(scope.markerTool,null);
  }
  click('marker-color','yellow');
  click('marker-color','green');
  assert.deepEqual(pressed(),['false','true','false']);
  click('marker-eraser');
  assert.deepEqual(pressed(),['false','false','false']);
  assert.equal(eraser['aria-pressed'],'true');
  click('marker-color','pink');
  assert.deepEqual(pressed(),['false','false','true']);
  assert.equal(eraser['aria-pressed'],'false');
  assert.match(styles,/\.marker-color\[aria-pressed="true"\]\{[^}]*box-shadow:inset/);
  assert.match(styles,/\.marker-color::before\{[^}]*content:'✓'[^}]*visibility:hidden/);
  assert.match(styles,/\.marker-color\[aria-pressed="true"\]::before\{visibility:visible\}/);
});

test('PDF marker pointer and toolbar events retain Undo across model renders and reset tools on preview changes',()=>{
  const view=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  const handlers={},saved=[];
  const scope={annotationTools:{addEventListener:(type,handler)=>{handlers[type]=handler}},widthSelect:{addEventListener(){}},markerTool:'marker',markerColor:'yellow',markerWidth:'standard',drawing:{pointerId:7,points:[{x:.2,y:.3}]},newId:()=> 'stroke',createStroke,annotationHistory:createAnnotationHistory(),undoAnnotations,redoAnnotations,commitAnnotations,persistSidecar(){saved.push(scope.annotationHistory.present)},updateAnnotations(){},model:{pdf:{current_page:1}},overlay:{addEventListener:(type,handler)=>{handlers[type]=handler}}};
  const start=view.indexOf("annotationTools.addEventListener('click'");
  const end=view.indexOf('const overlayPoint=',start);
  assert.ok(start>=0&&end>start);
  runInNewContext(view.slice(start,end),scope);
  const click=action=>handlers.click({target:{closest:()=>({dataset:{action}})}});
  const finishStart=view.indexOf('const finishStroke=e=>');
  const finishEnd=view.indexOf("overlay.addEventListener('pointercancel'",finishStart);
  assert.ok(finishStart>=0&&finishEnd>finishStart);
  runInNewContext(view.slice(finishStart,finishEnd),scope);
  handlers.pointerup({pointerId:7,stopPropagation(){}});
  assert.equal(scope.annotationHistory.past.length,1);
  click('marker-undo');
  assert.deepEqual(scope.annotationHistory.present,[]);
  assert.equal(scope.annotationHistory.future.length,1);
  click('marker-redo');
  assert.deepEqual(scope.annotationHistory.present.map(item=>item.id),['stroke']);
  assert.deepEqual(saved.map(value=>Array.from(value,item=>item.id)),[['stroke'],[],['stroke']]);
  assert.match(view,/function selectSidecar\(\).*annotationSessionChange\(.*if\(change==='keep'\)return;if\(change==='reset'\)\{markerTool=null;drawing=null;annotationDirty=false/s);
  assert.match(view,/function persistSidecar\(\).*annotationDirty=true/);
});

test('collapsed sidebar plus maximized PDF removes width limit and background focus', () => {
  const css = readFileSync(new URL('../src/mock-styles.css', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  assert.match(css, /\.app-shell\.sidebar-collapsed \.preview\.maximized\{max-width:none;flex-basis:100%;\}/);
  for (const region of ['sidebar', 'listPane', 'toolbar', 'split']) assert.match(view, new RegExp(`${region}\\.inert=`));
  assert.match(view, /const pdfMode=next\.layout\.pdf_maximized\?'screen':next\.layout\.pdf_window_expanded\?'window':'pane'/);
  assert.match(view, /control\.setAttribute\('aria-pressed',String\(pdfMode===mode\)\)/);
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

test('focus refresh keeps the sidebar group tree attached until its rendered inputs change',()=>{
  const config={groups:[group('g1','Group',1)],materials:[]};
  const initial=groupTreeRenderKey(config,'g1',new Set(),false);
  assert.equal(groupTreeRenderKey(structuredClone(config),'g1',new Set(),false),initial);
  assert.notEqual(groupTreeRenderKey(config,'g1',new Set(['g1']),false),initial);
  assert.notEqual(groupTreeRenderKey(config,'g1',new Set(),true),initial);
  assert.notEqual(groupTreeRenderKey({groups:[group('g1','Renamed',1)]},'g1',new Set(),false),initial);
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  assert.match(source,/if\(renderKey===renderedGroupTreeKey\)return/);
  assert.match(source,/if\(groups\.querySelector\('\.snapshot-group'\)\)return/);
});

test('focus refresh between press and release preserves the real row and dispatches one first click',()=>{
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  const calls=[],insertions=[],listeners={};
  function node(){return {dataset:{},style:{},children:[],classList:{toggle(){}},setAttribute(){},removeAttribute(){},addEventListener(type,handler){this[type]=handler},append(...children){this.children.push(...children)},insertBefore(child,before){insertions.push(child);const index=before?this.children.indexOf(before):this.children.length;this.children.splice(index,0,child);this.firstChild=this.children[0];this.children.forEach((value,i)=>{value.nextSibling=this.children[i+1]??null})}}}
  const config={groups:[group('g1','Group',1)],materials:[material('m1','g1','First',1),{...material('m2','g1','Second',2),role:'reference'}]};
  const role=()=>({list:node(),s:node(),badge:node()});
  const scope={model:{config,selected_group_id:'g1',query:'',pdf:{kind:'Closed'},statuses:[],can_launch:true,can_edit:true,runnable_material_ids:['m1','m2'],launch:{running:[]}},rows:new Map(),mainRole:role(),refRole:role(),emptyState:node(),emptyTitle:node(),emptyText:node(),clearSearch:node(),reorderMode:false,visibleMaterials,materialIcon,displayPath,placeStableRow,isPdf:()=>true,statusText:{exists:'利用可能'},el:node,button:(text,action)=>Object.assign(node(),{dataset:{action}}),actionIcon:(action)=>Object.assign(node(),{dataset:{action}}),host:{addEventListener:(type,handler)=>{listeners[type]=handler}},emit:(...args)=>calls.push(args),openMenu:()=>calls.push(['menu'])};
  const start=source.indexOf('  function makeRow('),end=source.indexOf('  function renderWindows(',start);
  assert.ok(start>=0&&end>start);
  runInNewContext(source.slice(start,end),scope);
  const clickLine=source.split('\n').find(line=>line.startsWith("  host.addEventListener('click',e=>{const t=e.target.closest('[data-action]')"));
  assert.ok(clickLine);
  runInNewContext(clickLine,scope);
  scope.renderRows(config);
  insertions.length=0;
  for(const id of ['m1','m2']){
    const pressedRow=scope.rows.get(id),pressedIcon=pressedRow._p.icon;
    const focus=createFocusSync({requestId:()=>`sync-${id}`,sync:()=>{
      scope.model.refreshing=true;scope.renderRows(config);
      scope.model.statuses=config.materials.map(item=>({material_id:item.id,path_state:'exists',open_state:'closed'}));
      scope.model.refreshing=false;scope.renderRows(config);
    }});
    assert.equal(focus(),true);
    assert.equal(scope.rows.get(id),pressedRow);
    assert.equal(pressedRow._p.icon,pressedIcon);
    assert.equal(pressedIcon.disabled,false);
    listeners.click({target:{closest:()=>pressedIcon}});
  }
  assert.deepEqual(insertions,[]);
  assert.deepEqual(calls,[['activate','m1'],['activate','m2']]);
  // Opening the row menu stops bubbling; closing it from an outside click
  // neither prevents nor repeats the material's delegated action.
  const row=scope.rows.get('m1'),more=row.children[2].children.at(-1);
  let stopped=false;
  more.click({stopPropagation(){stopped=true}});
  assert.equal(stopped,true);
  assert.deepEqual(calls.at(-1),['menu']);
  let closed=0;
  scope.document={addEventListener:(type,handler)=>{listeners.documentClick=handler}};
  scope.menu={contains:()=>false};scope.moreActions={contains:()=>false,open:true};scope.closeMenu=()=>{closed++};
  const documentClick=source.slice(source.indexOf("document.addEventListener('click',e=>{if(!menu.contains"));
  runInNewContext(documentClick.split('\n')[0],scope);
  listeners.click({target:{closest:()=>row._p.icon}});
  listeners.documentClick({target:row._p.icon});
  assert.equal(closed,1);
  assert.deepEqual(calls.slice(-1),[['activate','m1']]);
  assert.equal(calls.length,4);
});

test('SEC-01 dynamic view uses textContent and does not inject markup', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  const config = { groups: [group('g1', '<svg onload=alert(1)>', 1)], materials: [material('m1', 'g1', '<img onerror=alert(1)>', 1)] };
  assert.deepEqual(visibleMaterials(config, 'g1', 'onerror').map(item => item.id), ['m1']);
});

test('modal key handling is isolated from document shortcuts', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  assert.match(source, /for\(const modal of \[dialog,operationDialog,issue,dndDialog,windowsDialog,exitDialog\]\) modal\.addEventListener\('keydown',e=>e\.stopPropagation\(\)\)/);
  assert.match(source, /const modalOpen=dialog\.open\|\|operationDialog\.open\|\|issue\.open\|\|dndDialog\.open\|\|windowsDialog\.open\|\|exitDialog\.open;if\(modalOpen\)return/);
});

test('dialogs are named, focus their contents, restore the trigger, and keep pending issues open on Escape', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  for (const name of ['material', 'operation', 'issue', 'dnd', 'windows', 'exit']) assert.ok(source.includes(`${name}-dialog-title`));
  assert.match(source, /modal\.setAttribute\('aria-labelledby',id\)/);
  assert.match(source, /modal\.addEventListener\('close',\(\)=>restoreFocus\(dialogOrigins\.get\(modal\)\)\)/);
  assert.match(source, /\['RecoveryPending','MigrationPending'\]\.includes\(model\?\.lifecycle\)\)e\.preventDefault\(\)/);
  for (const focus of ['fields.name.focus()', 'operationSubmit).focus()', 'dndRole.focus()', 'windowsRefresh.focus()']) assert.ok(source.includes(focus));
});

test('context actions use a button popup with keyboard traversal and focus return', () => {
  const source = readFileSync(new URL('../src/view.js', import.meta.url), 'utf8');
  assert.match(source, /menu\.setAttribute\('role','group'\)/);
  assert.deepEqual(['ArrowDown', 'ArrowUp', 'Home', 'End'].map(key => menuNextIndex(key, 2, 4)), [3, 1, 0, 3]);
  assert.equal(menuNextIndex('ArrowDown', 3, 4), 0);
  assert.equal(menuNextIndex('ArrowUp', 0, 4), 3);
  assert.equal(menuNextIndex('ArrowUp', -1, 4), 3);
  assert.equal(menuNextIndex('ArrowDown', 0, 0), -1);
  assert.equal(menuNextIndex('Escape', 0, 4), -1);
  for (const key of ['Escape', 'Tab']) assert.ok(source.includes(`e.key==='${key}'`));
  assert.match(source, /e\.key==='ContextMenu'\|\|\(e\.shiftKey&&e\.key==='F10'\)/);
  assert.match(source, /if\(!menu\.contains\(e\.target\)\)closeMenu\(\)/);
  assert.match(source, /if\(!menu\.hidden\)\{e\.preventDefault\(\);closeMenu\(true\);return\}/);
  assert.match(source, /queueMicrotask\(\(\)=>\{if\(!\[dialog,operationDialog,issue,dndDialog,windowsDialog,exitDialog\]/);
});

test('exit confirmation stays inside MeetDock and resolves save, discard, cancel, and Escape once',async()=>{
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  for(const token of ["'MeetDockを終了しますか？'","'保存して終了'","'保存せずに終了'","'キャンセル'","settleExitChoice('save')","settleExitChoice('discard')","settleExitChoice('cancel')","exitCancel.focus()",'if(exitChoicePromise)return exitChoicePromise'])assert.ok(source.includes(token));
  assert.match(source,/exitDialog\.addEventListener\('cancel',e=>\{e\.preventDefault\(\);settleExitChoice\('cancel'\)\}\)/);
  assert.match(source,/requestCloseChoice\(edit\).*edit==='Saving'.*保存完了後に終了/s);
  assert.doesNotMatch(source,/window\.confirm/);
  const listeners={},exitText={},exitSave={},exitDiscard={},exitCancel={focusCount:0,focus(){this.focusCount++}};
  const exitDialog={open:false,showCount:0,addEventListener(type,handler){listeners[type]=handler},showModal(){this.open=true;this.showCount++},close(){if(!this.open)return;this.open=false;listeners.close?.()}};
  const scope={exitDialog,exitText,exitSave,exitDiscard,exitCancel,rememberDialog(){}};
  const declarations=source.slice(source.indexOf('  let exitChoiceResolve='),source.indexOf('  const closeOperation='));
  const eventStart=source.indexOf("  exitDialog.addEventListener('click'");
  const events=source.slice(eventStart,source.indexOf('  for(const modal of',eventStart));
  runInNewContext(`${declarations}${events}globalThis.requestCloseChoiceTest=requestCloseChoice;`,scope);
  const click=action=>listeners.click({target:{closest:()=>({dataset:{action}})}});

  const save=scope.requestCloseChoiceTest('Dirty'),duplicate=scope.requestCloseChoiceTest('Saving');
  assert.equal(save,duplicate);
  assert.equal(exitDialog.showCount,1);
  assert.equal(exitCancel.focusCount,1);
  assert.equal(exitText.textContent,'未保存の変更があります。終了方法を選択してください。');
  click('exit-save');
  click('exit-discard');
  assert.equal(await save,'save');

  const discard=scope.requestCloseChoiceTest('Saving');
  assert.equal(exitText.textContent,'保存処理が完了してから終了します。');
  assert.equal(exitSave.textContent,'保存完了後に終了');
  click('exit-discard');
  assert.equal(await discard,'discard');

  const cancel=scope.requestCloseChoiceTest('Dirty');
  click('exit-cancel');
  assert.equal(await cancel,'cancel');

  const escape=scope.requestCloseChoiceTest('Dirty');
  let prevented=false;
  listeners.cancel({preventDefault(){prevented=true}});
  assert.equal(prevented,true);
  assert.equal(await escape,'cancel');

  const externallyClosed=scope.requestCloseChoiceTest('Dirty');
  exitDialog.close();
  assert.equal(await externallyClosed,'cancel');
  assert.equal(exitDialog.showCount,5);
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

test('PDF wheel scrolls within a page and only pages at vertical boundaries',()=>{
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  const events=[],handlers={};
  const wrap={scrollTop:100,clientHeight:400,scrollHeight:1000,addEventListener:(type,handler)=>{handlers[type]=handler}};
  const scope={wrap,model:{pdf:{kind:'Viewing',current_page:2,total_pages:3}},pdfWheel:createPdfWheelState(),createPdfWheelState,accumulatePdfWheel,pendingPdfScrollPosition:null,emit:action=>events.push(action)};
  const start=source.indexOf("  wrap.addEventListener('wheel'");
  runInNewContext(source.slice(start,source.indexOf("  annotationTools.addEventListener",start)),scope);
  const wheel=(deltaY,extra={})=>{let prevented=false;handlers.wheel({deltaY,deltaX:0,preventDefault(){prevented=true},...extra});return prevented};
  assert.equal(wheel(120),false);
  assert.equal(wheel(-120),false);
  assert.deepEqual(events,[]);
  wrap.scrollTop=600;
  assert.equal(wheel(60),false);
  wrap.scrollTop=500;
  assert.equal(wheel(120),false); // Native scroll must also discard prior boundary input.
  wrap.scrollTop=600;
  assert.equal(wheel(60),false);
  assert.equal(wheel(40),true);
  assert.deepEqual(events,['pdfNext']);
  assert.equal(scope.pendingPdfScrollPosition,'start');
  wrap.scrollTop=0;
  assert.equal(wheel(-100),true);
  assert.equal(events.at(-1),'pdfPrevious');
  assert.equal(scope.pendingPdfScrollPosition,'end');
  const count=events.length;
  for(const extra of [{shiftKey:true},{deltaX:140}])assert.equal(wheel(-120,extra),false);
  assert.equal(wheel(0,{deltaX:120}),false);
  assert.equal(events.length,count);
  scope.model.pdf.current_page=1;
  assert.equal(wheel(-100),false);
  wrap.scrollTop=600;scope.model.pdf.current_page=3;
  assert.equal(wheel(100),false);
  assert.equal(events.length,count);
  assert.equal(wheel(-50,{ctrlKey:true}),true);
  assert.equal(events.at(-1),'pdfZoomIn');
  assert.equal(wheel(50,{ctrlKey:true}),true);
  assert.equal(events.at(-1),'pdfZoomOut');
  scope.model.pdf.kind='Closed';
  assert.equal(wheel(120),false);
});

test('PDF preview keyboard paging maps supported keys and ignores unsafe key events', () => {
  assert.equal(pdfPageKeyDirection({ key: 'PageUp', ctrlKey: true }), -1);
  assert.equal(pdfPageKeyDirection({ key: 'PageDown', ctrlKey: true }), 1);
  assert.equal(pdfPageKeyDirection({ key: 'PageUp' }), 0);
  assert.equal(pdfPageKeyDirection({ key: 'PageDown' }), 0);
  for (const key of ['ArrowUp', 'ArrowDown', ' ']) assert.equal(pdfPageKeyDirection({ key }), 0);
  assert.equal(pdfArrowBoundaryDirection({ key: 'ArrowUp' }, 0, 300, 900), -1);
  assert.equal(pdfArrowBoundaryDirection({ key: 'ArrowDown' }, 600, 300, 900), 1);
  assert.equal(pdfArrowBoundaryDirection({ key: 'PageUp' }, 0, 300, 900), -1);
  assert.equal(pdfArrowBoundaryDirection({ key: 'PageDown' }, 600, 300, 900), 1);
  assert.equal(pdfArrowBoundaryDirection({ key: 'PageUp' }, 1, 300, 900), 0);
  assert.equal(pdfArrowBoundaryDirection({ key: 'PageDown' }, 598, 300, 900), 0);
  assert.equal(pdfArrowBoundaryDirection({ key: 'ArrowDown' }, 598, 300, 900), 0);
  assert.equal(pdfArrowBoundaryDirection({ key: 'ArrowDown', repeat: true }, 600, 300, 900), 0);
  for (const blocked of ['repeat', 'isComposing', 'metaKey', 'altKey']) assert.equal(pdfPageKeyDirection({ key: 'PageDown', ctrlKey: true, [blocked]: true }), 0);
  assert.equal(pdfPageKeyDirection({ key: 'PageDown', ctrlKey: true, keyCode: 229 }), 0);
  assert.equal(pdfPageKeyDirection({ key: 'Home', ctrlKey: true }), 0);
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
  assert.ok(source.includes("if(isPdf(item)){add('アプリ内でPDF表示','pdf',runnable)"));
  assert.ok(source.includes('pdf-preview-button'));
  assert.ok(source.includes("r.setAttribute('aria-current','true')"));
  assert.ok(source.includes("icon=button('','activate','file-icon')"));
  assert.ok(source.includes("acts.append(pdfPreview,openFolder,remove,more)"));
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
  assert.match(styles,/\.list-pane\{container:material-list \/ inline-size\}/);
  assert.match(styles,/\.list-header,\.material-row\{grid-template-columns:minmax\(0,1fr\) 116px 90px\}/);
  assert.match(styles,/\.material-row \.row-actions\{position:static;right:auto;top:auto;transform:none/);
  assert.match(styles,/@container material-list \(max-width:540px\)\{/);
  assert.match(styles,/\.material-row \.row-actions\{grid-column:2!important;grid-row:2;margin-left:0;justify-self:end\}/);
  assert.match(styles,/\.material-row \.row-actions\{[^}]*width:90px;display:grid;grid-template-columns:repeat\(3,30px\);gap:0\}/);
  assert.match(styles,/\.material-row \.pdf-preview-button\{grid-column:1\}/);
  assert.match(styles,/\.material-row \.open-folder-button\{grid-column:2\}/);
  assert.match(styles,/\.material-row \.more-button,\.material-row \.reorder-delete-button\{grid-column:3\}/);
  assert.match(styles,/\.material-row \.material-name-line\{flex-wrap:wrap/);
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


test('material list shows saved bookmark badges and confirmed removal uses the selected identity',()=>{
  const view=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  assert.match(view,/bookmarkBadge=el\('span','marker-badge bookmark-badge','しおり'\)/);
  assert.match(view,/row\._p\.bookmarkBadge\.hidden=!annotations\?\.bookmarks\?\.length/);
  const item={id:'one',name:'資料',target_type:'file',path:'C:\\one.pdf'},key=`one\0file:${item.path}`;
  const calls=[],scope={model:{pdf_sidecars:{[key]:{bookmarks:[{id:'b'}]}}},legacySidecars:{[key]:{strokes:[{id:'old'}]}},sidecarIdentity:item=>`${item.target_type}:${item.path}`,emit:(...args)=>calls.push(args),openOperation:options=>{scope.operation=options}};
  for(const name of ['materialSidecar','requestAnnotationRemoval'])runInNewContext(view.slice(view.indexOf(`  function ${name}(`)).split('\n')[0],scope);
  assert.equal(scope.materialSidecar(item).bookmarks.length,1);
  scope.requestAnnotationRemoval(item);
  assert.equal(calls.length,0); // opening or cancelling never deletes
  assert.match(scope.operation.text,/マーカーとしおり/);
  scope.operation.onConfirm();
  assert.deepEqual(calls,[['clearPdfAnnotations','one',`file:${item.path}`]]);
  scope.model.pdf_sidecars[key]=null;
  assert.equal(scope.materialSidecar(item),null); // deletion never revives legacy badges
});

test('successful list deletion resets dirty current annotations and Undo while failure retains them',()=>{
  const view=readFileSync(new URL('../src/view.js',import.meta.url),'utf8'),item={id:'one',target_type:'file',path:'C:\\one.pdf'},key=`one\0file:${item.path}`,stroke={id:'stroke'},history=commitAnnotations(createAnnotationHistory(),[stroke]);
  const scope={model:{config:{materials:[item]},pdf:{kind:'Viewing',material_id:'one',generation:3,sidecar:null},pdf_sidecars:{[key]:null}},sidecarIdentity:item=>`${item.target_type}:${item.path}`,legacySidecars:{},activeSidecarKey:key,activePdfGeneration:3,activeSidecarValue:null,activeRemovalRevision:undefined,annotationDirty:true,annotationHistory:history,bookmarks:[{id:'b'}],drawing:{},markerTool:'marker',annotationSessionChange,createAnnotationHistory,structuredClone};
  runInNewContext(view.slice(view.indexOf('  function selectSidecar(')).split('\n')[0],scope);
  scope.selectSidecar();
  assert.equal(scope.annotationHistory,history);
  scope.model.pdf.sidecar_removal_revision=2;
  scope.selectSidecar();
  assert.equal(scope.annotationHistory.present.length,0);
  assert.equal(scope.annotationHistory.past.length,0);
  assert.equal(scope.bookmarks.length,0);
  assert.equal(scope.drawing,null);
  assert.equal(scope.annotationDirty,false);
});

test('popup key handler traverses enabled actions and consumes keys before document shortcuts',()=>{
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  let keydown;const document={activeElement:null},closed=[];
  const items=Array.from({length:3},()=>({focus(){document.activeElement=this}}));
  const menu={querySelectorAll(selector){assert.equal(selector,'button:not(:disabled)');return items},addEventListener(type,handler){keydown=handler}};
  runInNewContext(source.slice(source.indexOf("  menu.addEventListener('keydown'")).split('\n')[0],{menu,document,menuNextIndex,closeMenu:restore=>closed.push(restore)});
  for(const [key,index] of [['End',2],['Home',0],['ArrowUp',2],['ArrowDown',0]]){
    let prevented=false,stopped=false;keydown({key,preventDefault(){prevented=true},stopPropagation(){stopped=true}});
    assert.equal(document.activeElement,items[index]);assert.equal(prevented,true);assert.equal(stopped,true);
  }
  for(const key of ['Escape','Tab','ContextMenu','F10']){
    let prevented=false,stopped=false;keydown({key,shiftKey:key==='F10',preventDefault(){prevented=true},stopPropagation(){stopped=true}});
    assert.equal(prevented,true);assert.equal(stopped,true);
  }
  assert.deepEqual(closed,[true,true]);
});

test('keyboard context keys open the focused material, group or snapshot menu with the focus origin',()=>{
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  const line=source.slice(source.indexOf("  search.addEventListener('input'")).split('\n')[0];
  let keydown;const opened=[],document={activeElement:null,addEventListener(type,handler){keydown=handler}};
  const scope={search:{addEventListener(){}},document,dialog:{},operationDialog:{},issue:{},dndDialog:{},windowsDialog:{},exitDialog:{},host:{contains:()=>true},WINDOW_SNAPSHOT_GROUP_ID:'snapshot',openMenu:(target,event)=>opened.push({target,event})};
  runInNewContext(line,scope);
  for(const key of ['ContextMenu','F10'])for(const [dataset,kind,id] of [[{materialId:'m'},'material','m'],[{groupId:'g'},'group','g'],[{groupId:'snapshot'},'snapshot','snapshot']]){
    const row={dataset,getBoundingClientRect:()=>({left:30,top:50})},origin={closest:()=>row};document.activeElement=origin;
    let prevented=false,stopped=false;keydown({key,shiftKey:key==='F10',preventDefault(){prevented=true},stopPropagation(){stopped=true}});
    const result=opened.at(-1);assert.equal(result.target.kind,kind);assert.equal(result.target.id,id);assert.equal(result.event.target,origin);assert.equal(result.event.clientX,50);assert.equal(result.event.clientY,70);assert.equal(prevented,true);assert.equal(stopped,true);
  }
  const count=opened.length;keydown({key:'F10',shiftKey:false});assert.equal(opened.length,count);
  scope.dialog.open=true;keydown({key:'ContextMenu'});assert.equal(opened.length,count);
});

test('group tree redraw restores the focused group control for keyboard context menus',()=>{
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  const line=source.slice(source.indexOf('  function tree(')).split('\n')[0];
  const document={activeElement:null},rows=[];
  const makeNode=(tag,action)=>({tag,dataset:action?{action}:{},style:{setProperty(){}},classList:{},children:[],setAttribute(){},addEventListener(){},append(...children){this.children.push(...children)},querySelectorAll(selector){assert.equal(selector,'[data-action]');return this.children.filter(child=>child.dataset?.action)},focus(){document.activeElement=this}});
  const groups={replaceChildren(){rows.length=0},append(row){rows.push(row)},querySelectorAll(selector){assert.equal(selector,'.group-row');return rows}};
  const oldRow={dataset:{groupId:'g1'}},oldControl={dataset:{action:'group'},closest:()=>oldRow};document.activeElement=oldControl;
  const scope={document,groups,collapsedGroups:new Set(),renderedGroupTreeKey:null,groupTreeRenderKey,model:{selected_group_id:'g1',window_snapshot:null},el:tag=>makeNode(tag),button:(_,action)=>makeNode('button',action),svgIcon:()=>makeNode('svg'),openMenu(){}};
  runInNewContext(line,scope);scope.tree({groups:[{id:'g1',parent_id:null,name:'Group',order:1}]});
  assert.equal(document.activeElement.dataset.action,'group');
  assert.equal(document.activeElement.dataset.id,'g1');
  assert.equal(rows[0].dataset.groupId,'g1');
});

test('PDF header directly selects and identifies all three display modes', () => {
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  const styles=readFileSync(new URL('../src/mock-styles.css',import.meta.url),'utf8');
  for(const label of ['ペインに表示','ウィンドウ全体に表示','全画面表示']) assert.ok(source.includes(label));
  assert.doesNotMatch(source,/pdfStage/);
  assert.ok(source.includes("pdfModes.setAttribute('aria-label','PDFの表示範囲')"));
  assert.ok(source.includes("else if(a==='pdf-display-pane')emit('pdfDisplayMode','pane')"));
  assert.ok(source.includes("else if(a==='pdf-display-window')emit('pdfDisplayMode','window')"));
  assert.ok(source.includes("else if(a==='pdf-display-screen')emit('pdfDisplayMode','screen')"));
  assert.ok(source.includes("pdfModes.append(pdfPaneButton,pdfWindowButton,pdfScreenButton)"));
  assert.ok(source.includes("control.disabled=next.layout.pdf_fullscreen_pending!=null"));
  assert.match(styles,/\.preview-actions \.pdf-display-button\{width:30px;height:30px/);
  assert.match(styles,/\.pdf-display-modes \.pdf-display-button\[aria-pressed="true"\]/);
  assert.match(styles,/\.preview-actions \[hidden\],\.row-action-button\[hidden\]\{display:none!important\}/);
});
