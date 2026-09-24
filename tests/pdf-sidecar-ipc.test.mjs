import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIpcAdapter } from '../src/ipc-adapter.js';
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
  let state=transition(initialState(),{type:Event.SettingsLoaded,config}).state;
  let result=transition(state,{type:Event.PdfOpenRequested,material_id:'m1'}); state=result.state;
  result=transition(state,{type:Event.PdfReady,material_id:'m1',generation:state.pdf.generation,view:{current_page:1,total_pages:2,zoom_percent:100}}); state=result.state;
  assert.equal(result.effects[0].type,Effect.LoadPdfSidecar);
  assert.deepEqual(result.effects[0].request,{material_id:'m1',pdf_identity:sidecar.pdf_identity});
  result=transition(state,{type:Event.PdfSidecarSaveRequested,sidecar});
  assert.equal(result.effects[0].type,Effect.SavePdfSidecar);
  assert.deepEqual(result.state.pdf.sidecar,sidecar);
});
