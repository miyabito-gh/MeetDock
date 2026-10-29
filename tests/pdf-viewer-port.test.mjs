import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPdfViewerPort } from '../src/pdf-viewer-port.js';

const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return {promise,resolve}; };
function harness() {
  let instance;
  const events={},moves=[],handlers={};
  let hidden=false;
  const container={clientLeft:2,clientTop:3,clientHeight:400,clientWidth:600,addEventListener:(name,handler)=>handlers[name]=handler,getBoundingClientRect:()=>({left:10,top:20,width:hidden?0:600,height:hidden?0:400})};
  let scrollLeft=0;
  Object.defineProperty(container,'scrollLeft',{get:()=>scrollLeft,set:value=>{const width=Math.max(600,...instance.pages.map(p=>p.width*instance.currentScale+60));scrollLeft=Math.max(0,Math.min(value,width-container.clientWidth));}});
  let scrollTop=0;
  Object.defineProperty(container,'scrollTop',{get:()=>scrollTop,set:value=>{const height=instance.pages.reduce((n,p)=>n+p.height*instance.currentScale+16,0)+32;scrollTop=Math.max(0,Math.min(value,height-container.clientHeight));}});
  class EventBus {on(name,fn){events[name]=fn}}
  class PDFLinkService {setViewer(){}setDocument(doc){this.pdfDocument=doc}}
  class PDFViewer {
    currentScale=1;currentPageNumber=1;pages=[];pagesPromise=Promise.resolve();
    constructor(){instance=this}
    set currentScaleValue(value){assert.equal(value,'page-height');this.currentScale=container.clientHeight/this.pages[this.currentPageNumber-1].height}
    get pagesCount(){return this.pages.length}
    getPageView(index){return this.pages[index]}
    setDocument(doc){
      this.pdfDocument=doc;this.currentPageNumber=1;this.pages=[];scrollTop=0;
      if(!doc)return;
      this.pages=doc.heights.map((height,index)=>{
        const page={height:doc.heights[0],width:doc.widths[0],pdfPage:index===0?{height,width:doc.widths[0]}:null,setPdfPage(value){this.pdfPage=value;this.height=value.height;this.width=value.width}};
        page.div={getBoundingClientRect:()=>{const top=23+16+this.pages.slice(0,index).reduce((n,p)=>n+p.height*this.currentScale+16,0)-scrollTop;return hidden?{top:0,bottom:0,left:0,width:0,height:0}:{top,bottom:top+page.height*this.currentScale,left:12+30-container.scrollLeft,width:page.width*this.currentScale,height:page.height*this.currentScale}}};
        return page;
      });
      queueMicrotask(()=>events.pagesinit());
    }
    scrollPageIntoView({pageNumber}){moves.push(pageNumber);this.currentPageNumber=pageNumber;container.scrollTop+=this.pages[pageNumber-1].div.getBoundingClientRect().top-23}
    update(){const page=this.pages.findIndex(p=>p.div.getBoundingClientRect().bottom>23);this.currentPageNumber=page+1}
  }
  const port=createPdfViewerPort({container,viewer:{querySelectorAll:()=>[]},PDFViewer,PDFLinkService,EventBus,annotationMode:1,isValidExplicitDest:dest=>Array.isArray(dest)&&dest.length>=2&&typeof dest[1]?.name==='string'});
  const document=(heights,widths=heights.map(()=>800))=>({numPages:heights.length,heights,widths,getPage:async number=>({height:heights[number-1],width:widths[number-1]})});
  return {port,container,moves,document,handlers,hide(){hidden=true},show(){hidden=false},get viewer(){return instance}};
}

test('viewport capture uses current scroll geometry before pagechanging RAF and preserves fractional pan and whitespace',async()=>{
  const h=harness();await h.port.setDocument(h.document([600,600,600]));
  h.viewer.currentScale=1.5;h.container.scrollTop=1040.75;h.container.scrollLeft=0;
  const position=h.port.captureView();
  assert.equal(h.viewer.currentPageNumber,1,'the page event is intentionally stale');
  assert.equal(position.page,2);assert.equal(position.x,-20);assert.equal(position.y,72.5);
  await h.port.setDocument(h.document([600,600,600]));
  await h.port.restoreView(position);
  assert.equal(h.container.scrollTop,1040.75);assert.equal(h.container.scrollLeft,0);
  assert.equal(h.viewer.currentPageNumber,2);
});

test('restoration resolves mixed page dimensions and following pages before restoring near a page bottom',async()=>{
  const h=harness(),doc=h.document([200,1000,700]);await h.port.setDocument(doc);
  for(let i=1;i<3;i++)h.viewer.pages[i].setPdfPage(await doc.getPage(i+1));
  h.viewer.currentScale=1.25;h.container.scrollLeft=63.25;h.container.scrollTop=16+250+16+1000;
  const expected={top:h.container.scrollTop,left:h.container.scrollLeft},position=h.port.captureView();
  assert.equal(position.page,2);
  await h.port.setDocument(h.document([200,1000,700]));
  const restored=await h.port.restoreView(position);
  assert.deepEqual(restored,{page:2,scale:1.25});
  assert.equal(h.viewer.pages[1].height,1000);assert.equal(h.viewer.pages[2].height,700);
  assert.equal(h.container.scrollTop,expected.top);assert.equal(h.container.scrollLeft,expected.left);
});

test('a restoration waiting for page geometry cannot scroll or resize a replacement document',async()=>{
  const h=harness(),gate=deferred(),doc=h.document([200,800,900]);
  doc.getPage=number=>number===2?gate.promise:Promise.resolve({height:doc.heights[number-1]});
  await h.port.setDocument(doc);
  const pending=h.port.restoreView({page:2,scale:2,x:5,y:30});
  await new Promise(resolve=>setImmediate(resolve));
  await h.port.setDocument(h.document([500]));
  gate.resolve({height:800});assert.equal(await pending,null);
  assert.deepEqual(h.moves,[]);assert.equal(h.viewer.currentScale,1);assert.equal(h.container.scrollTop,0);
});


test('closing a hidden preview captures its last scroll position instead of zero-sized last-page geometry',async()=>{
  const h=harness();await h.port.setDocument(h.document([600,600,600]));
  h.port.showPage(2);h.container.scrollTop+=75.5;h.container.scrollLeft=40.25;
  h.handlers.scroll();const expected=h.port.captureView();
  h.hide();assert.deepEqual(h.port.captureView(),expected);
  await h.port.setDocument(null);assert.equal(h.port.captureView(),null);
  h.show();await h.port.setDocument(h.document([600,600,600]));
  await h.port.restoreView(expected);assert.deepEqual(h.port.captureView(),expected);
});

test('horizontal pan restores after resolving a distant wide page rather than clamping to narrow placeholders',async()=>{
  const h=harness(),doc=h.document([600,600,600],[1000,100,1200]);await h.port.setDocument(doc);
  for(let index=1;index<3;index++)h.viewer.pages[index].setPdfPage(await doc.getPage(index+1));
  h.container.scrollTop=46;h.container.scrollLeft=550;
  const expected=h.port.captureView();assert.equal(expected.page,1);
  await h.port.setDocument(h.document([600,600,600],[1000,100,1200]));
  assert.equal(h.viewer.pages[2].width,1000);
  await h.port.restoreView(expected);
  assert.equal(h.viewer.pages[2].width,1200);assert.equal(h.container.scrollLeft,550);
  assert.deepEqual(h.port.captureView(),expected);
});


test('height fit resolves the current page size and aligns its top even below normal zoom limits',async()=>{
  const h=harness();await h.port.setDocument(h.document([200,2000,800]));
  h.port.showPage(2);h.container.scrollTop+=150;
  assert.equal(h.viewer.pages[1].height,200,'the second page still has first-page placeholder dimensions');
  assert.equal(await h.port.fitHeight(),.2);
  assert.equal(h.viewer.pages[1].height,2000);assert.equal(h.moves.at(-1),2);
  assert.equal(h.viewer.pages[1].div.getBoundingClientRect().top,23);
});

test('height fit ignores a pending page-size load after page or document changes',async()=>{
  for(const replaceDocument of [false,true]){
    const h=harness(),doc=h.document([200,2000,800]),gate=deferred();
    doc.getPage=()=>gate.promise;await h.port.setDocument(doc);h.port.showPage(2);
    const pending=h.port.fitHeight();
    if(replaceDocument)await h.port.setDocument(h.document([500]));else h.port.showPage(3);
    gate.resolve({height:2000,width:800});assert.equal(await pending,null);
    assert.equal(h.viewer.currentScale,1);
  }
});


test('named and explicit outline destinations resolve real target and preceding mixed-page geometry',async()=>{
  for(const named of [false,true]){
    const h=harness(),doc=h.document([200,900,1600]);
    const destination=[2,{name:'XYZ'},45,800,1.75];
    doc.getDestination=async()=>destination;
    await h.port.setDocument(doc);
    const result=await h.port.goToDestination(named?'chapter':destination);
    assert.equal(h.viewer.pages[1].height,900);assert.equal(h.viewer.pages[2].height,1600);
    assert.equal(result.page,3);assert.equal(h.moves.at(-1),3);
    assert.equal(h.container.scrollTop,16+200+16+900+16);
  }
});

test('outline geometry loading cannot scroll a document opened while its destination was pending',async()=>{
  const h=harness(),doc=h.document([200,900,1600]),gate=deferred();
  doc.getPage=number=>number===2?gate.promise:Promise.resolve({height:doc.heights[number-1],width:800});
  await h.port.setDocument(doc);
  const pending=h.port.goToDestination([2,{name:'XYZ'},20,300,1.5]);
  await new Promise(resolve=>setImmediate(resolve));
  await h.port.setDocument(h.document([500]));gate.resolve({height:900,width:800});
  assert.equal(await pending,null);assert.deepEqual(h.moves,[]);
});
