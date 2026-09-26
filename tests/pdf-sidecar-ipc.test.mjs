import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIpcAdapter } from '../src/ipc-adapter.js';
import { createEffectRunner } from '../src/effect-runner.js';
import { Event, Effect, initialState, transition } from '../src/model.js';

const config = { schema_version:3, app_version:'1', revision:0, last_updated:'2026-09-25T00:00:00Z',
  groups:[{id:'g1',parent_id:null,name:'G',order:1,explorer_open_mode:'inherit'}],
  materials:[{id:'m1',group_id:'g1',name:'PDF',role:'main',target_type:'file',path:'C:\\docs\\a.pdf',window_match_pattern:null,order:1}],
  explorer_open_mode:'new_window' };
const sidecar = { format:'meetdock-pdf-sidecar', version:1, material_id:'m1', pdf_identity:'file:C:\\docs\\a.pdf', strokes:[], bookmarks:[] };

test('PDF sidecar IPC uses strict wrapped requests and validates responses', async () => {
  const calls=[];
  const api=createIpcAdapter(async(command,args)=>{calls.push([command,args]);return command==='load_pdf_sidecar'?null:command==='remove_pdf_sidecar'?true:sidecar});
  assert.equal(await api.call('load_pdf_sidecar',{material_id:'m1',pdf_identity:sidecar.pdf_identity}),null);
  assert.deepEqual(await api.call('save_pdf_sidecar',sidecar),sidecar);
  assert.equal(await api.call('remove_pdf_sidecar',{material_id:'m1',pdf_identity:sidecar.pdf_identity}),true);
  assert.deepEqual(calls,[['load_pdf_sidecar',{request:{material_id:'m1',pdf_identity:sidecar.pdf_identity}}],['save_pdf_sidecar',{request:sidecar}],['remove_pdf_sidecar',{request:{material_id:'m1',pdf_identity:sidecar.pdf_identity}}]]);
  await assert.rejects(api.call('load_pdf_sidecar',{material_id:'../bad',pdf_identity:'x'}),{code:'INVALID_REQUEST'});
});

test('opening a PDF loads its native sidecar and edits save by material plus identity', () => {
  const loaded=transition(initialState(),{type:Event.SettingsLoaded,config});
  let state=loaded.state;
  let result=transition(state,{type:Event.PdfOpenRequested,material_id:'m1'}); state=result.state;
  result=transition(state,{type:Event.PdfReady,material_id:'m1',generation:state.pdf.generation,view:{current_page:1,total_pages:2,zoom_percent:100}}); state=result.state;
  const load=loaded.effects.find(f=>f.type===Effect.LoadPdfSidecar);
  assert.deepEqual(load.request,{material_id:'m1',pdf_identity:sidecar.pdf_identity});
  assert.equal(result.effects.length,0); // the list load is already in flight
  result=transition(state,{type:Event.PdfSidecarSaveRequested,sidecar});
  assert.equal(result.effects[0].type,Effect.SavePdfSidecar);
  assert.deepEqual(result.state.pdf.sidecar,sidecar);
});

test('late load and save responses cannot replace newer annotation edits', () => {
  const loaded=transition(initialState(),{type:Event.SettingsLoaded,config});
  let state=loaded.state;
  state=transition(state,{type:Event.PdfOpenRequested,material_id:'m1'}).state;
  const ready=transition(state,{type:Event.PdfReady,material_id:'m1',generation:state.pdf.generation,view:{current_page:1,total_pages:2,zoom_percent:100}});
  state=ready.state;
  const stroke={id:'one',page:1,color:'yellow',width:'standard',points:[{x:.2,y:.3}]};
  const first={...sidecar,strokes:[stroke]};
  const saveOne=transition(state,{type:Event.PdfSidecarSaveRequested,sidecar:first});state=saveOne.state;
  assert.equal(saveOne.effects[0].sidecar_revision,1);
  const load=loaded.effects.find(f=>f.type===Effect.LoadPdfSidecar);
  state=transition(state,{type:Event.PdfSidecarLoaded,background:true,material_id:'m1',pdf_identity:sidecar.pdf_identity,generation:load.generation,sidecar_revision:load.sidecar_revision,sidecar}).state;
  assert.deepEqual(state.pdf.sidecar,first);
  const undone={...sidecar,strokes:[]};
  const remove=transition(state,{type:Event.PdfSidecarRemoveRequested,material_id:'m1',pdf_identity:sidecar.pdf_identity});state=remove.state;
  assert.equal(remove.effects[0].sidecar_revision,2);
  state=transition(state,{type:Event.PdfSidecarSaved,sidecar:first,sidecar_revision:1}).state;
  assert.equal(state.pdf.sidecar,null);
  assert.equal(state.pdf_sidecars[`m1\0${sidecar.pdf_identity}`],undefined);
  const redo=transition(state,{type:Event.PdfSidecarSaveRequested,sidecar:first});state=redo.state;
  state=transition(state,{type:Event.PdfSidecarRemoved,material_id:'m1',pdf_identity:sidecar.pdf_identity,sidecar_revision:remove.effects[0].sidecar_revision}).state;
  assert.deepEqual(state.pdf.sidecar,first);
  state=transition(state,{type:Event.PdfSidecarSaved,sidecar:first,sidecar_revision:redo.effects[0].sidecar_revision}).state;
  assert.deepEqual(state.pdf_sidecars[`m1\0${sidecar.pdf_identity}`],first);
});

test('sidecar writes for one PDF complete in edit order', async () => {
  const calls=[],events=[];
  let releaseFirst;
  const first=new Promise(resolve=>{releaseFirst=resolve});
  const runner=createEffectRunner({pdfSidecars:{save:async request=>{calls.push('save');await first;return request},remove:async()=>{calls.push('remove');return true}}},event=>events.push(event));
  runner.run([{type:Effect.SavePdfSidecar,request:sidecar,sidecar_revision:1},{type:Effect.RemovePdfSidecar,request:{material_id:'m1',pdf_identity:sidecar.pdf_identity},sidecar_revision:2}]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,['save']);
  releaseFirst();
  await runner.settled();
  assert.deepEqual(calls,['save','remove']);
  assert.deepEqual(events.map(event=>event.sidecar_revision),[1,2]);
});


test('list loads persisted bookmarks before preview and ignores replaced targets',()=>{
  const loaded=transition(initialState(),{type:Event.SettingsLoaded,config}),load=loaded.effects.find(f=>f.type===Effect.LoadPdfSidecar);
  const bookmarkSidecar={...sidecar,bookmarks:[{id:'bookmark',page:1,name:'見出し'}]};
  const event={type:Event.PdfSidecarLoaded,...load.request,generation:load.generation,sidecar_revision:load.sidecar_revision,background:true,sidecar:bookmarkSidecar};
  let state=transition(loaded.state,event).state;
  assert.deepEqual(state.pdf_sidecars[`m1\0${sidecar.pdf_identity}`],bookmarkSidecar);
  assert.equal(state.pdf.kind,'Closed');
  assert.deepEqual(state.pdf_sidecar_loads,{});
  const replaced={...loaded.state,saved_config:{...config,materials:[{...config.materials[0],path:'C:\\docs\\other.pdf'}]}};
  assert.equal(transition(replaced,event).state,replaced);
  state=transition(state,{type:Event.PdfOpenRequested,material_id:'m1'}).state;
  const ready=transition(state,{type:Event.PdfReady,material_id:'m1',generation:state.pdf.generation,view:{current_page:1,total_pages:2,zoom_percent:100}});
  assert.equal(ready.effects.length,0);
  assert.deepEqual(ready.state.pdf.sidecar,bookmarkSidecar);
});

test('confirmed list removal preserves annotations on failure and only clears its target on success',()=>{
  const key=`m1\0${sidecar.pdf_identity}`,other={...sidecar,material_id:'m2'},original={...sidecar,bookmarks:[{id:'b',page:1,name:'見出し'}]};
  let state=transition(initialState(),{type:Event.SettingsLoaded,config}).state;
  state={...state,pdf_sidecars:{[key]:original,other},pdf:{kind:'Viewing',material_id:'m1',pdf_identity:sidecar.pdf_identity,sidecar:original}};
  const request={type:Event.PdfSidecarRemoveRequested,material_id:'m1',pdf_identity:sidecar.pdf_identity,preserve_until_removed:true};
  const pending=transition(state,request),effect=pending.effects[0];
  assert.deepEqual(effect.request,{material_id:'m1',pdf_identity:sidecar.pdf_identity});
  assert.deepEqual(pending.state.pdf_sidecars,state.pdf_sidecars);
  const failed=transition(pending.state,{type:Event.PdfSidecarFailed,error:{code:'IO_ERROR'}});
  assert.deepEqual(failed.state.pdf.sidecar,original);
  const done=transition(pending.state,{type:Event.PdfSidecarRemoved,...effect.request,sidecar_revision:effect.sidecar_revision,preserve_until_removed:true});
  assert.equal(done.state.pdf_sidecars[key],null);
  assert.deepEqual(done.state.pdf_sidecars.other,other);
  assert.equal(done.state.pdf.sidecar,null);
  assert.equal(done.state.pdf.sidecar_removal_revision,effect.sidecar_revision);
  assert.equal(done.state.saved_config,state.saved_config);
  assert.equal(transition(state,{...request,pdf_identity:'file:C:\\different.pdf'}).effects.length,0);
  const newer=transition(pending.state,{type:Event.PdfSidecarSaveRequested,sidecar:original}).state;
  assert.equal(transition(newer,{type:Event.PdfSidecarRemoved,...effect.request,sidecar_revision:effect.sidecar_revision,preserve_until_removed:true}).state,newer);
});

test('sidecar runner carries list load and confirmed removal metadata without changing IPC requests',async()=>{
  const events=[],calls=[];
  const runner=createEffectRunner({pdfSidecars:{load:async request=>{calls.push(request);return sidecar},remove:async request=>{calls.push(request);return true}}},event=>events.push(event));
  const request={material_id:'m1',pdf_identity:sidecar.pdf_identity};
  runner.run([{type:Effect.LoadPdfSidecar,request,background:true,generation:2,sidecar_revision:0},{type:Effect.RemovePdfSidecar,request,preserve_until_removed:true,sidecar_revision:1}]);
  await runner.settled();
  assert.deepEqual(calls,[request,request]);
  assert.equal(events.find(event=>event.type===Event.PdfSidecarLoaded).background,true);
  assert.equal(events.find(event=>event.type===Event.PdfSidecarRemoved).preserve_until_removed,true);
});
