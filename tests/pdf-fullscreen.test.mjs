import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
const helper=source.slice(source.indexOf('  function capturePdfViewport(){'),source.indexOf('  return Object.freeze({pdfContainer:wrap'));
const state=(overrides={})=>({pdf:{kind:'Viewing'},layout:{pdf_maximized:true,pdf_window_expanded:true,pdf_fullscreen_recovery:false,...overrides}});
function setup(){
  const classes=new Set(),focus=[],scopes=[];
  let fullscreen=false;
  const page={isConnected:true,getBoundingClientRect:()=>({left:(fullscreen?0:30)-wrap.scrollLeft,top:(fullscreen?0:30)-wrap.scrollTop,bottom:(fullscreen?0:30)-wrap.scrollTop+1200,width:800,height:1200})};
  const wrap={clientWidth:600,clientHeight:400,clientLeft:0,clientTop:0,scrollTop:300,scrollLeft:90,classList:{remove(){}},getBoundingClientRect:()=>({left:0,top:0}),focus:()=>focus.push('body')};
  const controls=Array.from({length:6},()=>({hidden:false,inert:false})),[ph,ptools,searchTools,annotationTools,bookmarkPanel,menu]=controls;
  const scope={pdfContentOnly:false,host:{classList:{toggle(name,value){if(value)classes.add(name);else classes.delete(name);fullscreen=value}}},wrap,pdfViewer:{querySelectorAll:()=>[page]},ph,ptools,searchTools,annotationTools,bookmarkPanel,menu,moreActions:{open:true},drawing:{},panning:{},spacePan:true,markerTool:'marker',closeMenu(){menu.hidden=true},pdfWindowButton:{disabled:false,focus:()=>focus.push('window')},pdfPaneButton:{disabled:false,focus:()=>focus.push('pane')}};
  runInNewContext(helper,scope);return {scope,classes,focus,page,wrap,controls};
}

test('native content fullscreen hides chrome inertly, preserves panels and page-relative view, and restores visible exit focus',()=>{
  const h=setup(),before=h.scope.capturePdfViewport();
  h.scope.searchTools.hidden=false;h.scope.annotationTools.hidden=true;h.scope.bookmarkPanel.hidden=false;
  h.scope.updatePdfContentOnly(state(),before);
  assert.equal(h.classes.has('pdf-content-only'),true);assert.equal(h.controls.every(item=>item.inert),true);
  assert.equal(h.scope.searchTools.hidden,false);assert.equal(h.scope.annotationTools.hidden,true);assert.equal(h.scope.bookmarkPanel.hidden,false);
  assert.equal(h.scope.drawing,null);assert.equal(h.scope.panning,null);assert.equal(h.scope.spacePan,false);assert.equal(h.scope.markerTool,'marker');
  assert.deepEqual(h.focus,['body']);assert.equal(h.scope.moreActions.open,false);
  assert.equal(h.scope.capturePdfViewport().y,before.y);assert.equal(h.scope.capturePdfViewport().x,before.x);
  h.scope.updatePdfContentOnly(state({pdf_maximized:false}),h.scope.capturePdfViewport());
  assert.equal(h.classes.has('pdf-content-only'),false);assert.equal(h.controls.every(item=>!item.inert),true);
  assert.deepEqual(h.focus,['body','window']);assert.equal(h.wrap.scrollTop,300);assert.equal(h.wrap.scrollLeft,90);
  assert.equal(h.scope.searchTools.hidden,false);assert.equal(h.scope.annotationTools.hidden,true);
});

test('expanded window, pending native entry, closed/failed PDF and fullscreen recovery retain accessible controls',()=>{
  const h=setup();
  for(const next of [state({pdf_maximized:false}),{...state(),pdf:{kind:'Closed'}},{...state(),pdf:{kind:'Failed'}},state({pdf_fullscreen_recovery:true})]){
    h.scope.updatePdfContentOnly(next,null);assert.equal(h.classes.size,0);assert.equal(h.controls.every(item=>!item.inert),true);
  }
  h.scope.updatePdfContentOnly(state(),null);h.scope.updatePdfContentOnly(state({pdf_fullscreen_recovery:true}),h.scope.capturePdfViewport());
  assert.equal(h.classes.size,0);assert.equal(h.controls.every(item=>!item.inert),true);
});

function keyboard(){
  let handler;const actions=[],searches=[];
  const scope={model:{...state(),edit:'Dirty'},search:{addEventListener(){},focus(){},select(){}},document:{addEventListener:(name,fn)=>handler=fn},dialog:{},operationDialog:{},issue:{},dndDialog:{},windowsDialog:{},exitDialog:{},reorderSaveDialog:{},menu:{hidden:true},moreActions:{open:false},pdfSearchOpen:true,setPdfSearchOpen:value=>searches.push(value),emit:(...args)=>actions.push(args)};
  const start=source.indexOf("  search.addEventListener('input'");runInNewContext(source.slice(start).split('\n')[0],scope);
  return {scope,actions,searches,press(key,extra={}){const event={key,prevented:false,stopped:false,preventDefault(){this.prevented=true},stopPropagation(){this.stopped=true},...extra};handler(event);return event}};
}

test('Escape exits content fullscreen on its first press even with a preserved open search panel',()=>{
  const h=keyboard(),event=h.press('Escape');
  assert.equal(event.prevented,true);assert.deepEqual(h.actions,[['pdfDisplayMode','window']]);assert.deepEqual(h.searches,[]);
});

test('fullscreen blocks search/save/context menu shortcuts and normal window mode restores search',()=>{
  const h=keyboard();
  for(const [key,extra] of [['f',{ctrlKey:true}],['s',{metaKey:true}],['ContextMenu',{}],['F10',{shiftKey:true}]]){
    const event=h.press(key,extra);assert.equal(event.prevented,true);assert.equal(event.stopped,true);
  }
  assert.deepEqual(h.actions,[]);assert.deepEqual(h.searches,[]);
  h.scope.model.layout.pdf_maximized=false;h.press('f',{ctrlKey:true});assert.deepEqual(h.searches,[true]);
});

test('right-click menus and marker pointer editing stay inactive in content-only fullscreen',()=>{
  let contextmenu;const model={...state(),pdf:{kind:'Viewing',material_id:'m1',generation:2}};
  const contextLine=source.slice(source.indexOf("  host.addEventListener('contextmenu'")).split('\n')[0];
  runInNewContext(contextLine,{model,host:{addEventListener:(name,fn)=>contextmenu=fn}});
  let prevented=false;contextmenu({preventDefault(){prevented=true},target:{closest(){throw new Error('hidden menu target must not be inspected')}}});assert.equal(prevented,true);
  const handlers={},overlay={addEventListener:(name,fn)=>handlers[name]=fn,getBoundingClientRect:()=>({left:0,top:0,width:100,height:100})};
  const start=source.indexOf('  function bindAnnotationOverlay('),end=source.indexOf("  bookmarkPanel.addEventListener('click'",start);
  const scope={model,markerTool:'marker',spacePan:false,handTool:false,drawing:null,wrap:{focus(){}},overlay};
  runInNewContext(source.slice(start,end),scope);scope.bindAnnotationOverlay(overlay,1);
  const pointer={button:0,pointerId:1,clientX:20,clientY:30,stopPropagation(){},preventDefault(){}};
  handlers.pointerdown(pointer);assert.equal(scope.drawing,null);
  model.layout.pdf_maximized=false;handlers.pointerdown(pointer);assert.equal(scope.drawing.page,1);
});

test('content-only CSS fills the viewport and has no hover-revealing menus while internal links remain enabled',()=>{
  const css=readFileSync(new URL('../src/visibility.css',import.meta.url),'utf8');
  const fullscreen=css.slice(css.indexOf('/* Native PDF fullscreen'));
  assert.match(fullscreen,/\.preview > :not\(\.pdf-viewer-body\)/);assert.match(fullscreen,/\.bookmark-panel/);assert.match(fullscreen,/display:\s*none !important/);
  assert.match(fullscreen,/\.preview\.maximized\s*\{[^}]*inset:\s*0;[^}]*border:\s*0;/s);
  assert.match(fullscreen,/\.canvas-wrap\s*\{\s*padding:\s*0;/);assert.doesNotMatch(fullscreen,/:hover/);
  assert.match(css,/\.pdf-internal-link > a\s*\{\s*pointer-events:\s*auto !important/);
});
