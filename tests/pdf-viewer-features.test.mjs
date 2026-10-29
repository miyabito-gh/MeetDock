import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { PdfViewAdapter } from '../src/pdf-view-adapter.js';
import { initialState,transition,Event,Effect } from '../src/model.js';
import { createPresenter } from '../src/presenter.js';
import { createEffectRunner } from '../src/effect-runner.js';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {resolve,promise}};
function fixture(outline){
  let listener;const destinations=[];
  const doc={numPages:3,getOutline:async()=>outline,getPage:async()=>({getViewport:()=>({width:600,height:3000}),getTextContent:async()=>({items:[]})}),destroy:async()=>{}};
  const viewerPort={listen(fn){listener=fn},async setDocument(){},setScale(){},showPage(){},fitHeight:async()=>.2,
    async goToDestination(dest){destinations.push(dest);await listener({page:2,scale:1.75});return {page:2,scale:1.75}}};
  const adapter=new PdfViewAdapter({viewerPort,pdfjs:{getDocument:()=>({promise:Promise.resolve(doc),destroy:async()=>{}})}});
  const open=generation=>adapter.replace({url:'material://pdf/m1',material_id:'m1',generation});
  return {doc,adapter,viewerPort,destinations,open};
}

test('embedded outline exposes nested safe headings and generation IDs while raw destinations remain private',async()=>{
  const explicit=[1,{name:'XYZ'},25,400,1.75];
  const f=fixture([{title:'<script>chapter</script>',dest:'chapter',items:[{title:'Subsection',dest:explicit}]},{title:'Group',items:[{title:'External',url:'https://example.com'},{title:'Action',action:'NextPage'}]}]);
  const view=await f.open(10);
  assert.equal(view.outline_status,'ready');assert.equal(view.outline[0].title,'<script>chapter</script>');
  assert.equal(view.outline[0].children[0].navigable,true);assert.equal(view.outline[1].navigable,false);
  assert.equal(view.outline[1].children[0].navigable,false);assert.equal(view.outline[1].children[1].navigable,false);
  assert.equal('dest' in view.outline[0],false);
  assert.equal(await f.adapter.goToOutline('unknown',{generation:10}),null);
  assert.equal(await f.adapter.goToOutline(view.outline[0].id,{generation:9}),null);
  assert.equal(await f.adapter.goToOutline(view.outline[1].id,{generation:10}),null);
  const navigated=await f.adapter.goToOutline(view.outline[0].children[0].id,{generation:10});
  assert.equal(navigated.current_page,2);assert.equal(navigated.zoom_percent,175);assert.equal(f.destinations[0],explicit);
  await f.adapter.goToOutline(view.outline[0].id,{generation:10});assert.equal(f.destinations[1],'chapter');
  await f.open(11);assert.equal(await f.adapter.goToOutline(view.outline[0].id,{generation:11}),null);
});

test('absent or unreadable embedded outlines remain nonfatal and report useful empty states',async()=>{
  for(const fail of [false,true]){
    const f=fixture(null);if(fail)f.doc.getOutline=async()=>{throw new Error('outline damaged')};
    const view=await f.open(1);assert.equal(view.current_page,1);assert.deepEqual(view.outline,[]);
    assert.equal(view.outline_status,fail?'unavailable':'empty');
  }
});

test('outline retrieval and destination completion cannot update a replacement document',async()=>{
  const f=fixture([{title:'Chapter',dest:'chapter'}]),gate=deferred();
  const view=await f.open(1);f.viewerPort.goToDestination=()=>gate.promise;
  const pending=f.adapter.goToOutline(view.outline[0].id,{generation:1});
  await f.open(2);gate.resolve({page:2,scale:2});assert.equal(await pending,null);
  const load=deferred();f.doc.getOutline=()=>load.promise;
  const old=f.open(3);await new Promise(resolve=>setImmediate(resolve));
  f.doc.getOutline=async()=>null;await f.open(4);load.resolve([{title:'Old',dest:'chapter'}]);
  assert.equal(await old,undefined);
});

test('height fit accepts tall pages below 50 percent and rejects a stale request',async()=>{
  const f=fixture(null);await f.open(1);
  assert.equal((await f.adapter.fitHeight(500,{generation:1})).zoom_percent,20);
  assert.equal(await f.adapter.fitHeight(500,{generation:0}),null);
  assert.equal(await f.adapter.fitHeight(0,{generation:1}),null);
});

test('height fit and outline requests pass through presenter, model and effects with identity and generation',async()=>{
  let state={...initialState(),lifecycle:'Ready',state_generation:3,pdf:{kind:'Viewing',material_id:'m1',generation:3,current_page:1,total_pages:3,zoom_percent:100}};
  const calls=[],events=[],services={pdf:{fitHeight:async(height,request)=>{calls.push({height,request});return {current_page:1,total_pages:3,zoom_percent:25}},goToOutline:async(id,request)=>{calls.push({id,request});return {current_page:2,total_pages:3,zoom_percent:100}}}};
  const runner=createEffectRunner(services,event=>{events.push(event);state=transition(state,event).state});
  const presenter=createPresenter({},event=>{const next=transition(state,event);state=next.state;runner.run(next.effects)});
  presenter.pdfFitHeight(600);await runner.settled();assert.equal(state.pdf.zoom_percent,25);
  presenter.pdfOutline('3:1');await runner.settled();assert.equal(state.pdf.current_page,2);
  assert.equal(calls[0].height,600);assert.equal(calls[1].id,'3:1');
  for(const call of calls){assert.equal(call.request.material_id,'m1');assert.equal(call.request.generation,3)}
  assert.equal(events.every(event=>event.type===Event.PdfViewChanged),true);
  assert.equal(transition(state,{type:Event.PdfOutlineRequested,outline_id:5}).effects.length,0);
  assert.equal(transition({...state,pdf:{kind:'Closed'}},{type:Event.PdfFitHeightRequested,viewport_height:600}).effects.length,0);
});

test('outline UI safely renders nested navigable and nonnavigable labels, preserves collapse state, and owns bounded scrolling',()=>{
  const source=readFileSync(new URL('../src/view.js',import.meta.url),'utf8');
  const css=readFileSync(new URL('../src/visibility.css',import.meta.url),'utf8');
  const el=(tag,className='',text='')=>({tag,className,text,children:[],dataset:{},append(...items){this.children.push(...items)},replaceChildren(){this.children=[]}});
  const list=el('ol'),empty=el('p'),scope={model:{pdf:{kind:'Viewing',outline_status:'ready',outline:[{id:'3:1',title:'<img src=x>',navigable:true,children:[{id:'3:2',title:'Group',navigable:false,children:[]}]}]}},renderedOutlineKey:null,pdfOutlineList:list,pdfOutlineEmpty:empty,el,button:(text,action,className)=>{const item=el('button',className,text);item.dataset.action=action;return item}};
  const start=source.indexOf('  function renderPdfOutline(){'),end=source.indexOf('  function renderBookmarks(){',start);
  runInNewContext(`${source.slice(start,end)};renderPdfOutline();`,scope);
  const branch=list.children[0].children[0],label=branch.children[0].children[0];
  assert.equal(label.text,'<img src=x>');assert.equal(label.dataset.outlineId,'3:1');assert.equal(branch.children[1].children[0].children[0].tag,'span');
  branch.open=false;scope.model.pdf.outline=structuredClone(scope.model.pdf.outline);scope.renderPdfOutline();
  assert.equal(list.children[0].children[0],branch,'structured-cloned view events must not rebuild the tree');assert.equal(branch.open,false);
  assert.match(source,/PDFのしおり/);assert.match(source,/追加したしおり/);assert.match(source,/高さに合わせる/);
  assert.match(css,/\.pdf-outline-section\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*auto/s);
});
