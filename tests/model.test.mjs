import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transition, initialState, renderModel, Event, Effect, Lifecycle, Edit, Pdf, WINDOW_SNAPSHOT_GROUP_ID } from '../src/model.js';
import { appError, MAX_SAFE } from '../src/contracts.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/contracts.json', import.meta.url))).fixtures;
export const config = structuredClone(fixtures.find(f => f.name === 'AppConfig: valid').value);
config.groups.push({ id: 'g2', parent_id: null, name: '会議2', order: 2 });
config.materials.push({ ...config.materials[0], id: 'm2', role: 'reference', path: 'C:\\Fixtures\\second.PDF' });
export const request1 = '12345678-1234-4234-8234-123456789abc', request2 = '12345678-1234-4234-8234-123456789abd';
export const run = (s, type, fields = {}) => transition(s, { type, ...fields });
export const ready = () => {
  let state = run(initialState(), Event.SettingsLoaded, { config }).state;
  const request_id = state.sync.request_id;
  state = run(state, Event.SyncSucceeded, { request_id, results: [], completed_at: 1 }).state;
  return run(state, Event.WindowSyncSucceeded, { request_id, response: { request_id, windows: [], exclusions: [] }, completed_at: 1 }).state;
};
const dirty = () => run(ready(), Event.EditRequested).state;
const saving = () => run(dirty(), Event.SaveRequested).state;
const sync = () => run(ready(), Event.SyncRequested, { request_id: request1 }).state;
const launch = () => run(ready(), Event.ActivateRequested, { material_id: 'm1' }).state;
const batch = () => run(ready(), Event.BatchLaunchRequested, { group_id: 'g1' }).state;
const loading = () => run(ready(), Event.PdfOpenRequested, { material_id: 'm1' }).state;
const pdfView = { current_page: 1, total_pages: 4, zoom_percent: 100 };
const viewing = () => run(loading(), Event.PdfReady, { material_id: 'm1', generation: 2, view: pdfView }).state;
const candidate = { candidate_id: 'candidate1', kind: 'backup', revision: 12, last_updated: null };
const pending = lifecycle => ({ ...initialState(), lifecycle, candidates: [{ ...candidate, kind: lifecycle === Lifecycle.MigrationPending ? 'legacy' : 'backup' }] });
const response = mode => ({ mode, config: null, source_schema_version: mode === 'read_only_future_schema' ? 4 : 3, candidates: [{ ...candidate, kind: mode === 'migration_required' ? 'legacy' : 'backup' }], notice_code: null });
const io = appError('CONFIG_IO'), conflict = appError('CONFIG_CONFLICT'), pdfError = appError('PDF_CORRUPT');
const saved = { revision: 13, last_updated: '2026-09-19T10:00:00Z' };
const launched = { material_id: 'm1', outcome: 'launched', error: null };

test('draft target changes block launch and PDF until saved while unchanged targets remain usable',()=>{
  let state=dirty();
  const draft=structuredClone(state.draft);
  draft.materials.find(m=>m.id==='m1').path='C:\\Fixtures\\new.pdf';
  state=run(state,Event.DraftChanged,{config:draft}).state;
  assert.ok(!renderModel({state,notice:null}).runnable_material_ids.includes('m1'));
  for(const [type,fields] of [[Event.ActivateRequested,{material_id:'m1'}],[Event.OpenContainingFolderRequested,{material_id:'m1'}],[Event.PdfOpenRequested,{material_id:'m1'}],[Event.BatchLaunchRequested,{group_id:'g1'}]]){
    const outcome=run(state,type,fields);assert.equal(outcome.state,state);assert.deepEqual(outcome.effects,[]);
  }
  assert.ok(renderModel({state,notice:null}).runnable_material_ids.includes('m2'));
});
test('a role change cannot silently launch a former main item in a batch',()=>{
  const draft=dirty(),changed=structuredClone(draft.draft);
  changed.materials.find(m=>m.id==='m1').role='reference';
  const state=run(draft,Event.DraftChanged,{config:changed}).state;
  const outcome=run(state,Event.BatchLaunchRequested,{group_id:'g1'});
  assert.equal(outcome.state,state);assert.deepEqual(outcome.effects,[]);
});

test('all failed drops remain visible but cannot be confirmed',()=>{
  const state=run(ready(),Event.DroppedFilesPrepared,{group_id:'g1',response:{candidates:[],failures:[{path:'C:\\missing',reason:'not_found'}]}}).state;
  assert.equal(state.dropped_files.failures.length,1);
  assert.equal(run(state,Event.DroppedFilesConfirmed,{group_id:'g1',role:'main'}).state,state);
});

test('individual results stay in notices and new launches clear stale batch details',()=>{
  let state={...ready(),launch_results:[launched]};
  const request=run(state,Event.ActivateRequested,{material_id:'m1'});state=request.state;
  assert.deepEqual(state.launch_results,[]);
  const done=run(state,Event.LaunchSucceeded,{material_id:'m1',generation:state.state_generation,response:launched});
  assert.deepEqual(done.state.launch_results,[]);assert.deepEqual(done.notice,launched);
});
test('batch progress advances only for the active group and generation',()=>{
  const started=run(ready(),Event.BatchLaunchRequested,{group_id:'g1'}).state;
  const first=run(started,Event.BatchLaunchProgressed,{group_id:'g1',generation:started.state_generation,completed:1}).state;
  assert.equal(first.launch.batch.completed,1);
  assert.equal(run(first,Event.BatchLaunchProgressed,{group_id:'g2',generation:first.state_generation,completed:2}).state,first);
  assert.equal(run(first,Event.BatchLaunchProgressed,{group_id:'g1',generation:first.state_generation,completed:1}).state,first);
});

// IDs map 1:1 to the rows in MEDIATOR_STATE_TRANSITIONS.md.
// Each row includes success/effect count and an independent failed guard.
const rows = [
  ['M01 settings', initialState, Event.SettingsLoaded, { config }, 3, s => s.lifecycle === Lifecycle.Ready && s.sync.kind === 'Running' && s.windowing.sync.kind === 'Running', { config: { ...config, schema_version: 4 } }],
  ['M02 future', initialState, Event.FutureSchemaFound, { response: response('read_only_future_schema') }, 0, s => s.lifecycle === Lifecycle.ReadOnly, { response: { ...response('read_only_future_schema'), source_schema_version: 3 } }],
  ['M03 legacy', initialState, Event.LegacySettingsFound, { response: response('migration_required') }, 0, s => s.lifecycle === Lifecycle.MigrationPending, { response: { ...response('migration_required'), candidates: [] } }],
  ['M04 corrupt', initialState, Event.CorruptSettingsFound, { response: response('recovery_required') }, 0, s => s.lifecycle === Lifecycle.RecoveryPending, { response: {} }],
  ['M05 migration approve', () => pending(Lifecycle.MigrationPending), Event.MigrationApproved, { candidate_id: 'candidate1' }, 1, s => s.lifecycle === Lifecycle.Ready && s.resolution === 'migration', { candidate_id: 'unknown' }],
  ['M06 migration reject', () => pending(Lifecycle.MigrationPending), Event.MigrationRejected, {}, 0, s => s.lifecycle === Lifecycle.ReadOnly, {}, ready],
  ['M07 restore', () => pending(Lifecycle.RecoveryPending), Event.RestoreSelected, { candidate_id: 'candidate1' }, 1, s => s.lifecycle === Lifecycle.Booting, { candidate_id: 'unknown' }],
  ['M08 initialize', () => pending(Lifecycle.RecoveryPending), Event.InitializeSelected, { confirmed: true }, 1, s => s.lifecycle === Lifecycle.Booting, { confirmed: false }],
  ['M09 readonly', () => pending(Lifecycle.RecoveryPending), Event.ReadOnlySelected, {}, 0, s => s.lifecycle === Lifecycle.ReadOnly, {}, ready],
  ['M10 edit', ready, Event.EditRequested, {}, 0, s => s.edit === Edit.Dirty, {}, initialState],
  ['M11 save', dirty, Event.SaveRequested, {}, 1, s => s.edit === Edit.Saving, {}, () => ({ ...dirty(), draft: { bad: true } })],
  ['M12 saved', saving, Event.SaveSucceeded, { response: saved, generation: 1 }, 0, s => s.edit === Edit.Clean && s.config_revision === 13, { response: saved, generation: 0 }],
  ['M13 conflict', saving, Event.SaveConflict, { error: conflict, generation: 1 }, 0, s => s.edit === Edit.Conflict, { error: conflict, generation: 0 }],
  ['M14 save failed', saving, Event.SaveFailed, { error: io, generation: 1 }, 0, s => s.edit === Edit.Dirty, { error: io, generation: 0 }],
  ['M15 discard', dirty, Event.EditDiscarded, { confirmed: true }, 0, s => s.edit === Edit.Clean && s.state_generation === 2, { confirmed: false }],
  ['M16 sync idle', ready, Event.SyncRequested, { request_id: request1 }, 2, s => s.sync.request_id === request1 && s.windowing.sync.request_id === request1, { request_id: 'bad' }],
  ['M17 sync replace', sync, Event.SyncRequested, { request_id: request2, manual: true }, 2, s => s.sync.request_id === request2 && s.windowing.sync.request_id === request2, { request_id: request2 }],
  ['M18 sync success', sync, Event.SyncSucceeded, { request_id: request1, results: [] }, 0, s => s.sync.kind === 'Idle', { request_id: request2, results: [] }],
  ['M19 stale sync', sync, Event.SyncFailed, { request_id: request2, error: io }, 0, s => s.sync.kind === 'Running', { request_id: request2, error: io }],
  ['M20 activate', ready, Event.ActivateRequested, { material_id: 'm1' }, 1, s => s.launch.running.length === 1, { material_id: 'unknown' }],
  ['M21 duplicate launch', launch, Event.ActivateRequested, { material_id: 'm1' }, 0, s => s.launch.running.length === 1, { material_id: 'm1' }],
  ['M22 launch complete', launch, Event.LaunchSucceeded, { material_id: 'm1', generation: 1, response: launched }, 0, s => s.launch.running.length === 0, { material_id: 'm2', generation: 1 }],
  ['M23 batch', ready, Event.BatchLaunchRequested, { group_id: 'g1' }, 1, s => s.launch.batch.group_id === 'g1', { group_id: 'missing' }],
  ['M24 batch complete', batch, Event.BatchLaunchCompleted, { group_id: 'g1', generation: 1, response: { results: [launched] } }, 0, s => s.launch.batch === null, { group_id: 'g2', generation: 1 }],
  ['M25 pdf open', ready, Event.PdfOpenRequested, { material_id: 'm1' }, 1, s => s.pdf.kind === Pdf.Loading && s.state_generation === 2, { material_id: 'missing' }],
  ['M26 pdf ready', loading, Event.PdfReady, { material_id: 'm1', generation: 2, view: pdfView }, 1, s => s.pdf.kind === Pdf.Viewing && s.pdf.current_page === 1 && s.pdf.total_pages === 4 && s.pdf.zoom_percent === 100, { material_id: 'm2', generation: 2, view: pdfView }],
  ['M27 pdf switch', viewing, Event.PdfOpenRequested, { material_id: 'm2' }, 1, s => s.pdf.material_id === 'm2' && s.state_generation === 3, { material_id: 'm1' }],
  ['M28 pdf password', loading, Event.PdfPasswordRequired, { material_id: 'm1', generation: 2, error: appError('PDF_PASSWORD_REQUIRED') }, 0, s => s.pdf.kind === Pdf.PasswordRequired, { material_id: 'm1', generation: 1 }],
  ['M29 pdf fail', viewing, Event.PdfFailed, { material_id: 'm1', generation: 2, error: pdfError }, 0, s => s.pdf.kind === Pdf.Failed, { material_id: 'm1', generation: 1, error: pdfError }],
  ['M30 stale pdf', loading, Event.PdfReady, { material_id: 'm1', generation: 1, view: pdfView }, 0, s => s.pdf.kind === Pdf.Loading, { material_id: 'm1', generation: 1, view: pdfView }],
  ['M31 readonly forbidden', () => ({ ...dirty(), lifecycle: Lifecycle.ReadOnly }), Event.SaveRequested, {}, 0, s => s.lifecycle === Lifecycle.ReadOnly, {}],
  ['M32 fatal', ready, Event.FatalError, {}, 0, s => s.lifecycle === Lifecycle.FatalError, null],
];
for (const [name, setup, type, fields, effects, check, failed, failedSetup] of rows) {
  test(`${name}: transition and effect count`, () => {
    const before = setup(), snapshot = structuredClone(before), result = run(before, type, fields);
    assert.deepEqual(before, snapshot, 'pure function must not mutate input');
    assert.equal(result.effects.length, effects); assert.ok(check(result.state));
  });
  if (failed) test(`${name}: guard gives zero effects and identical state`, () => {
    const before = (failedSetup ?? setup)(), result = run(before, type, failed);
    assert.equal(result.state, before); assert.deepEqual(result.effects, []);
  });
}
test('all documented event alternatives and independent regions', () => {
  for (const type of [Event.SaveFailed, Event.SaveConflict]) {
    const s = saving(), result = run(s, type, { generation: 1, error: io });
    assert.deepEqual(result.state.draft, s.draft); assert.equal(result.state.pdf, s.pdf);
  }
  assert.equal(run(sync(), Event.SyncFailed, { request_id: request1, error: io }).state.sync.kind, 'Idle');
  for (const type of [Event.LaunchFailed, Event.ForegroundDenied]) {
    const r = run(launch(), type, { material_id: 'm1', generation: 1, error: appError('FOREGROUND_DENIED') });
    assert.equal(r.state.launch.running.length, 0); assert.equal(r.notice.code, 'FOREGROUND_DENIED');
  }
  assert.equal(run(batch(), Event.BatchLaunchCancelled, { group_id: 'g1', generation: 1 }).state.launch.batch, null);
  for (const type of [Event.SaveRequested, Event.ActivateRequested, Event.BatchLaunchRequested]) {
    const s = { ...ready(), lifecycle: Lifecycle.ReadOnly }, r = run(s, type, { material_id: 'm1', group_id: 'g1' });
    assert.equal(r.state, s); assert.equal(r.notice.code, 'READ_ONLY_SCHEMA'); assert.equal(r.effects.length, 0);
  }
  assert.equal(run({ ...ready(), lifecycle: Lifecycle.ReadOnly }, Event.SyncRequested, { request_id: request1 }).effects.length, 2);
  assert.equal(run(sync(), Event.SyncRequested, { request_id: request2, new_auto: true }).effects.length, 2);
  assert.equal(run({ ...dirty(), edit: Edit.Conflict }, Event.SaveRequested).effects.length, 1);
  assert.equal(run({ ...dirty(), edit: Edit.Conflict }, Event.EditDiscarded, { confirmed: true }).state.edit, Edit.Clean);
});
test('duplicate save, restore, batch, and overlapping individual/batch cannot issue effects', () => {
  assert.equal(run(saving(), Event.SaveRequested).effects.length, 0);
  const restoring = run(pending(Lifecycle.RecoveryPending), Event.RestoreSelected, { candidate_id: 'candidate1' }).state;
  assert.equal(run(restoring, Event.RestoreSelected, { candidate_id: 'candidate1' }).effects.length, 0);
  assert.equal(run(batch(), Event.BatchLaunchRequested, { group_id: 'g1' }).effects.length, 0);
  assert.equal(run(batch(), Event.ActivateRequested, { material_id: 'm1' }).effects.length, 0);
  assert.equal(run(launch(), Event.BatchLaunchRequested, { group_id: 'g1' }).effects.length, 0);
});
test('saved window snapshot supports individual/all launch and group registration', () => {
  const snapshot={schema_version:1,saved_at_unix_ms:Date.UTC(2026,8,25),items:[
    {app_name:'Editor',title:'Agenda',executable_name:'editor.exe',executable_path:'C:\\Apps\\editor.exe',restorability:'restorable',reason:null},
    {app_name:'Browser',title:'Reference',executable_name:'browser.exe',executable_path:'C:\\Apps\\browser.exe',restorability:'conditional',reason:'state may differ'},
    {app_name:'エクスプローラー',title:'資料',executable_name:'explorer.exe',executable_path:'C:\\Windows\\explorer.exe',document_path:'C:\\Meetings\\資料',restorability:'restorable',reason:null},
  ]};
  const loaded=run(ready(),Event.WindowSnapshotLoaded,{response:snapshot}).state;
  const one=run(loaded,Event.WindowSnapshotLaunchRequested,{index:0});
  assert.equal(one.effects[0].type,Effect.LaunchWindowSnapshotItem);assert.deepEqual(one.effects[0].request,{index:0});assert.deepEqual(one.state.windowing.snapshot_running,[0]);
  assert.equal(run(one.state,Event.WindowSnapshotLaunchRequested,{index:0}).effects.length,0);
  assert.deepEqual(run(one.state,Event.WindowSnapshotLaunchSucceeded,{index:0}).state.windowing.snapshot_running,[]);
  const all=run(loaded,Event.WindowSnapshotLaunchAllRequested);assert.equal(all.effects[0].type,Effect.BatchLaunchWindowSnapshot);assert.deepEqual(all.effects[0].request.indices,[0,1,2]);
  assert.equal(run(all.state,Event.WindowSnapshotLaunchAllCompleted).state.windowing.snapshot_batch,false);
  const registered=run(loaded,Event.WindowSnapshotRegisterRequested);assert.equal(registered.state.edit,Edit.Dirty);assert.equal(registered.state.draft.groups.length,config.groups.length+1);
  const added=registered.state.draft.materials.slice(config.materials.length);assert.deepEqual(added.map(item=>item.path),snapshot.items.map(item=>item.document_path??item.executable_path));assert.ok(added.every(item=>item.role==='main'));assert.deepEqual(added.map(item=>item.target_type),['file','file','folder']);
  assert.equal(registered.state.windowing.snapshot,null);assert.equal(registered.effects[0].type,Effect.ClearWindowSnapshot);assert.equal(registered.state.selected_group_id,registered.state.draft.groups.at(-1).id);
  assert.equal(run(registered.state,Event.WindowSnapshotClearSucceeded,{removed:true}).state.windowing.snapshot,null);
});
test('window snapshot load, launch all, and registration share normalized restoration target deduplication', () => {
  const item=(title,executable_path,document_path)=>({app_name:'Editor',title,executable_name:'editor.exe',executable_path,...(document_path?{document_path}:{}),restorability:'restorable',reason:null});
  const existingPath=config.materials[0].path;
  const snapshot={schema_version:1,saved_at_unix_ms:Date.UTC(2026,8,25),items:[
    item('Fallback A','C:\\Apps\\Editor.exe'),
    item('Fallback B','\\\\?\\C:/APPS/EDITOR.EXE\\'),
    item('Existing','C:\\Apps\\Editor.exe',existingPath.replaceAll('\\','/').toUpperCase()),
    item('Agenda A','C:\\Apps\\Editor.exe','C:\\Docs\\Agenda.docx'),
    item('Agenda duplicate','c:/apps/editor.exe/','\\\\?\\C:\\DOCS\\AGENDA.DOCX\\'),
    item('Minutes','C:\\Apps\\Editor.exe','C:\\Docs\\Minutes.docx'),
  ]};
  const loaded=run(ready(),Event.WindowSnapshotLoaded,{response:snapshot}).state;
  assert.deepEqual(loaded.windowing.snapshot.items.map(item=>item.title),['Fallback A','Existing','Agenda A','Minutes']);
  const all=run(loaded,Event.WindowSnapshotLaunchAllRequested);
  assert.deepEqual(all.effects[0].request.indices,[0,1,2,3]);
  const registered=run(loaded,Event.WindowSnapshotRegisterRequested);
  const added=registered.state.draft.materials.slice(config.materials.length);
  assert.deepEqual(added.map(item=>item.path),['C:\\Apps\\Editor.exe','C:\\Docs\\Agenda.docx','C:\\Docs\\Minutes.docx']);
});
test('snapshot registration does not create an empty group when every confirmed target already exists', () => {
  const existing=config.materials[0],snapshot={schema_version:1,saved_at_unix_ms:1,items:[{
    app_name:'Existing',title:'Different title',executable_name:'reader.exe',executable_path:'C:\\Apps\\reader.exe',
    document_path:`\\\\?\\${existing.path.toUpperCase()}\\`,restorability:'restorable',reason:null,
  }]};
  const registered=run(run(ready(),Event.WindowSnapshotLoaded,{response:snapshot}).state,Event.WindowSnapshotRegisterRequested);
  assert.equal(registered.state.edit,Edit.Clean);
  assert.equal(registered.state.saved_config.groups.length,config.groups.length);
  assert.equal(registered.state.windowing.snapshot,null);
  assert.equal(registered.effects[0].type,Effect.ClearWindowSnapshot);
});

test('snapshot registration never converts a Shell location into a normal material path',()=>{
  const snapshot={schema_version:1,saved_at_unix_ms:1,items:[{app_name:'Explorer',title:'PC',executable_name:'explorer.exe',executable_path:'C:\\Windows\\explorer.exe',shell_location:'::{20D04FE0-3AEA-1069-A2D8-08002B30309D}',restorability:'restorable',reason:null}]};
  const registered=run(run(ready(),Event.WindowSnapshotLoaded,{response:snapshot}).state,Event.WindowSnapshotRegisterRequested);
  assert.equal(registered.state.edit,Edit.Clean);
  assert.equal(registered.state.saved_config.materials.length,config.materials.length);
  assert.equal(registered.effects[0].type,Effect.ClearWindowSnapshot);
});
test('saving a window snapshot closes the dialog, reloads it, and selects its virtual group',()=>{
  const started=run({...ready(),windowing:{...ready().windowing,dialog_open:true}},Event.WindowSnapshotSaveRequested);
  const saved=run(started.state,Event.WindowSnapshotSaved,{response:{saved:true,saved_count:1,excluded_count:0,exclusion_reasons:[]}});
  assert.equal(saved.state.windowing.dialog_open,false);assert.equal(saved.effects[0].type,Effect.LoadWindowSnapshot);
  const snapshot={schema_version:1,saved_at_unix_ms:1,items:[{app_name:'Editor',title:'Agenda',executable_name:'editor.exe',executable_path:'C:\\Apps\\editor.exe',restorability:'restorable',reason:null}]};
  const loaded=run(saved.state,Event.WindowSnapshotLoaded,{response:snapshot});
  assert.equal(loaded.state.selected_group_id,WINDOW_SNAPSHOT_GROUP_ID);assert.deepEqual(loaded.state.windowing.snapshot,snapshot);
});
test('revision, request_id and generation cannot substitute for one another', () => {
  const s = sync();
  const switched = run(s, Event.PdfOpenRequested, { material_id: 'm1' }).state;
  assert.equal(run(switched, Event.SyncSucceeded, { request_id: request1, results: [] }).state.sync.kind, 'Idle');
  assert.equal(run(s, Event.SyncSucceeded, { request_id: s.config_revision, results: [] }).state, s);
  assert.equal(run(saving(), Event.SaveSucceeded, { generation: 1, response: { ...saved, revision: 99 } }).state.edit, Edit.Saving);
});
test('late save after screen switch releases operation, keeps input and suppresses toast', () => {
  const switched = run(saving(), Event.GroupSelected, { group_id: 'g2' }).state;
  const result = run(switched, Event.SaveSucceeded, { generation: 1, response: saved });
  assert.equal(result.state.edit, Edit.Dirty); assert.equal(result.state.config_revision, 13);
  assert.equal(result.state.draft.materials[0].name, config.materials[0].name); assert.equal(result.notice, null);
  assert.equal(run(result.state, Event.SaveRequested).effects[0].request.expected_revision, 13);
});
test('late launch clears running set but has no screen notification', () => {
  const switched = run(launch(), Event.GroupSelected, { group_id: 'g2' }).state;
  const result = run(switched, Event.LaunchSucceeded, { material_id: 'm1', generation: 1, response: launched });
  assert.equal(result.state.launch.running.length, 0); assert.equal(result.notice, null);
});
test('rapid PDF switching ignores old ready, failure, and password callbacks', () => {
  const latest = run(loading(), Event.PdfOpenRequested, { material_id: 'm2' }).state;
  for (const type of [Event.PdfReady, Event.PdfFailed, Event.PdfPasswordRequired]) {
    const r = run(latest, type, { material_id: 'm1', generation: 2, error: pdfError });
    assert.equal(r.state, latest); assert.equal(r.effects.length, 0);
  }
  assert.equal(run(latest, Event.PdfReady, { material_id: 'm2', generation: 3, view: pdfView }).state.pdf.kind, Pdf.Viewing);
});
test('PDF document navigation follows visible list order without wrapping and remains available after failure', () => {
  const current = viewing();
  const next = run(current, Event.PdfDocumentNextRequested);
  assert.equal(next.effects[0].type, Effect.ReplacePdf); assert.equal(next.effects[0].request.material_id, 'm2');
  assert.equal(next.state.pdf.kind, Pdf.Loading);
  assert.equal(run(current, Event.PdfDocumentPreviousRequested).state, current);
  const failed = run(current, Event.PdfFailed, { material_id: 'm1', generation: 2, error: pdfError }).state;
  assert.equal(run(failed, Event.PdfDocumentNextRequested).effects[0].request.material_id, 'm2');
});
test('search context limits PDF document navigation candidates', () => {
  const searched = run(viewing(), Event.SearchChanged, { value: 'second' }).state;
  assert.equal(run(searched, Event.PdfDocumentNextRequested).state, searched);
  const opened = run(searched, Event.PdfOpenRequested, { material_id: 'm2' }).state;
  assert.equal(run(opened, Event.PdfDocumentPreviousRequested).state, opened);
});
test('direct page requests are bounded and ID-only', () => {
  const current = viewing(), result = run(current, Event.PdfPageRequested, { page: 4 });
  assert.deepEqual(result.effects[0].request, { material_id: 'm1', generation: 2, viewport_width: null, page: 4 });
  assert.equal(result.effects[0].type, Effect.PdfGoToPage);
  for (const page of [0, 5, 1.5, '2']) assert.equal(run(current, Event.PdfPageRequested, { page }).state, current);
});
test('PDF text search is mediated, reports counts, navigates matches, and rejects stale completion', () => {
  const requested = run(viewing(), Event.PdfSearchRequested, { query: ' agenda ' });
  assert.equal(requested.effects[0].type, Effect.PdfSearch);
  assert.deepEqual(requested.effects[0].request, { material_id: 'm1', generation: 2, search_generation: 1, query: 'agenda' });
  assert.equal(requested.state.pdf.search_status, 'searching');
  const view = { current_page: 2, total_pages: 4, zoom_percent: 100, search_query: 'agenda', search_index: 1, search_total: 3 };
  const completed = run(requested.state, Event.PdfSearchCompleted, { material_id: 'm1', generation: 2, search_generation: 1, view });
  assert.equal(completed.state.pdf.search_status, 'ready');
  assert.equal(completed.state.pdf.search_total, 3);
  assert.equal(run(completed.state, Event.PdfSearchNextRequested).effects[0].type, Effect.PdfSearchNext);
  assert.equal(run(completed.state, Event.PdfSearchPreviousRequested).effects[0].type, Effect.PdfSearchPrevious);
  assert.equal(run(requested.state, Event.PdfSearchCompleted, { material_id: 'm1', generation: 2, search_generation: 0, view }).state, requested.state);
});
test('generation never overflows; reset requires idle runner and idle state', () => {
  const s = { ...ready(), state_generation: MAX_SAFE };
  assert.equal(run(s, Event.PdfOpenRequested, { material_id: 'm1' }).state, s);
  assert.equal(run(s, Event.GenerationResetRequested, { quiescent: false }).state, s);
  assert.equal(run(s, Event.GenerationResetRequested, { quiescent: true }).state.state_generation, 0);
  const active = { ...saving(), state_generation: MAX_SAFE };
  assert.equal(run(active, Event.GenerationResetRequested, { quiescent: true }).state, active);
});
test('migration remains gated until service result, and failure permits explicit retry', () => {
  const s = run(pending(Lifecycle.MigrationPending), Event.MigrationApproved, { candidate_id: 'candidate1' }).state;
  assert.equal(run(s, Event.EditRequested).effects.length, 0);
  assert.equal(run(s, Event.BatchLaunchRequested, { group_id: 'g1' }).effects.length, 0);
  const failure = run(s, Event.ResolutionFailed, { error: io }).state;
  assert.equal(failure.lifecycle, Lifecycle.MigrationPending);
  assert.equal(run(failure, Event.MigrationApproved, { candidate_id: 'candidate1' }).effects.length, 1);
  assert.equal(run(s, Event.SettingsLoaded, { config }).state.lifecycle, Lifecycle.Ready);
});
test('execution effects contain only saved IDs and fixed modes, never a path or arbitrary URL', () => {
  const activate = run(ready(), Event.ActivateRequested, { material_id: 'm1' }).effects[0]; assert.deepEqual(activate.request, { material_id: 'm1', explorer_open_mode: 'new_window' });
  const batch = run(ready(), Event.BatchLaunchRequested, { group_id: 'g1' }).effects[0]; assert.deepEqual(batch.request, { group_id: 'g1', material_ids: ['m1'], explorer_open_mode: 'new_window' });
  const f = run(ready(), Event.PdfOpenRequested, { material_id: 'm1' }).effects[0];
  assert.equal(f.request.url, 'material://pdf/m1'); assert.equal(f.type, Effect.ReplacePdf);
});
test('context changes close invalidated PDF instead of leaving stale Loading forever', () => {
  const s = { ...loading(), edit: Edit.Dirty, draft: structuredClone(config) };
  for (const [type, fields] of [[Event.GroupSelected, { group_id: 'g2' }], [Event.EditDiscarded, { confirmed: true }]]) {
    const result = run(s, type, fields);
    assert.equal(result.state.pdf.kind, Pdf.Closed); assert.equal(result.effects.length, 1);
    assert.equal(result.effects[0].type, Effect.ClosePdf);
    assert.equal(run(result.state, Event.PdfReady, { material_id: 'm1', generation: 2 }).state, result.state);
  }
});
test('ordinary PDF failure preserves editing and synchronization', () => {
  let s = run(dirty(), Event.SyncRequested, { request_id: request1 }).state;
  s = run(s, Event.PdfOpenRequested, { material_id: 'm1' }).state;
  const result = run(s, Event.PdfFailed, { material_id: 'm1', generation: 2, error: pdfError });
  assert.equal(result.state.edit, Edit.Dirty); assert.equal(result.state.sync.request_id, request1);
  assert.equal(result.state.lifecycle, Lifecycle.Ready); assert.equal(result.state.pdf.kind, Pdf.Failed);
});
test('PDF view information updates only for the current generation and clears outside Viewing', () => {
  const current = viewing();
  const changed = run(current, Event.PdfViewChanged, { material_id: 'm1', generation: 2, view: { current_page: 2, total_pages: 4, zoom_percent: 125 } }).state;
  assert.deepEqual(changed.pdf, { ...current.pdf, current_page: 2, total_pages: 4, zoom_percent: 125 });
  assert.equal(run(changed, Event.PdfViewChanged, { material_id: 'm1', generation: 1, view: pdfView }).state, changed);
  const switched = run(changed, Event.PdfOpenRequested, { material_id: 'm2' }).state;
  assert.deepEqual(switched.pdf, { kind: Pdf.Loading, material_id: 'm2', generation: 3 });
  const failed = run(current, Event.PdfFailed, { material_id: 'm1', generation: 2, error: pdfError }).state;
  assert.equal(Object.hasOwn(failed.pdf, 'total_pages'), false);
  assert.equal(Object.hasOwn(failed.pdf, 'zoom_percent'), false);
});
test('guard matrix: every non-ready lifecycle blocks edits/save/launch/batch', () => {
  for (const lifecycle of Object.values(Lifecycle).filter(x => x !== Lifecycle.Ready)) {
    for (const [type, fields, base] of [
      [Event.EditRequested, {}, ready()], [Event.SaveRequested, {}, dirty()],
      [Event.ActivateRequested, { material_id: 'm1' }, ready()], [Event.BatchLaunchRequested, { group_id: 'g1' }, ready()],
    ]) {
      const s = { ...base, lifecycle }, r = run(s, type, fields);
      assert.equal(r.state, s, `${lifecycle}/${type}`); assert.equal(r.effects.length, 0);
    }
  }
});
test('guard matrix: invalid edit phases reject edit/save/discard/completions', () => {
  for (const edit of Object.values(Edit)) {
    const s = { ...saving(), edit };
    const events = [];
    if (edit !== Edit.Clean) events.push([Event.EditRequested, {}]);
    if (![Edit.Dirty, Edit.Conflict].includes(edit)) events.push([Event.SaveRequested, {}], [Event.EditDiscarded, { confirmed: true }]);
    if (edit !== Edit.Saving) events.push([Event.SaveSucceeded, { generation: 1, response: saved }], [Event.SaveConflict, { generation: 1, error: conflict }], [Event.SaveFailed, { generation: 1, error: io }]);
    for (const [type, fields] of events) { const r = run(s, type, fields); assert.equal(r.state, s); assert.equal(r.effects.length, 0); }
  }
});
test('guard matrix: loading events and pending decisions require their lifecycle', () => {
  const events = [
    [Event.SettingsLoaded, { config }], [Event.FutureSchemaFound, { response: response('read_only_future_schema') }],
    [Event.LegacySettingsFound, { response: response('migration_required') }], [Event.CorruptSettingsFound, { response: response('recovery_required') }],
  ];
  for (const lifecycle of Object.values(Lifecycle).filter(x => x !== Lifecycle.Booting)) {
    const s = { ...ready(), lifecycle };
    for (const [type, fields] of events) { const r = run(s, type, fields); assert.equal(r.state, s); assert.equal(r.effects.length, 0); }
  }
  const s = ready();
  for (const [type, fields] of [[Event.MigrationApproved, { candidate_id: 'candidate1' }], [Event.RestoreSelected, { candidate_id: 'candidate1' }], [Event.InitializeSelected, { confirmed: true }]]) {
    const r = run(s, type, fields); assert.equal(r.state, s); assert.equal(r.effects.length, 0);
  }
});
test('guard matrix: sync invalid lifecycle, repeated UUID, bad result, idle completion', () => {
  for (const lifecycle of Object.values(Lifecycle).filter(x => ![Lifecycle.Ready, Lifecycle.ReadOnly].includes(x))) {
    const s = { ...ready(), lifecycle }; assert.equal(run(s, Event.SyncRequested, { request_id: request1 }).state, s);
  }
  let s = sync();
  assert.equal(run(s, Event.SyncRequested, { request_id: request1, manual: true }).state, s);
  assert.equal(run(s, Event.SyncSucceeded, { request_id: request1, results: [{}] }).state, s);
  s = ready();
  for (const type of [Event.SyncSucceeded, Event.SyncFailed]) assert.equal(run(s, type, { request_id: request1, results: [], error: io }).state, s);
});
test('guard matrix: PDF state/target restrictions and mismatched batch/launch generation', () => {
  for (const kind of Object.values(Pdf)) {
    const s = { ...loading(), pdf: { ...loading().pdf, kind } };
    if (kind !== Pdf.Loading) for (const type of [Event.PdfReady, Event.PdfPasswordRequired])
      assert.equal(run(s, type, { material_id: 'm1', generation: 2 }).state, s);
    if (![Pdf.Loading, Pdf.Viewing].includes(kind))
      assert.equal(run(s, Event.PdfFailed, { material_id: 'm1', generation: 2, error: pdfError }).state, s);
  }
  for (const m of [{ ...config.materials[0], target_type: 'folder' }, { ...config.materials[0], path: 'C:\\Fixtures\\file.txt' }]) {
    const s = { ...ready(), saved_config: { ...config, materials: [m] } };
    assert.equal(run(s, Event.PdfOpenRequested, { material_id: 'm1' }).state, s);
  }
  const l = launch(), b = batch();
  assert.equal(run(l, Event.LaunchSucceeded, { material_id: 'm1', generation: 0, response: launched }).state, l);
  assert.equal(run(b, Event.BatchLaunchCompleted, { group_id: 'g1', generation: 0 }).state, b);
  assert.equal(run(b, Event.BatchLaunchRequested, { group_id: 'g2' }).state, b);
});

test('Phase 7 CRUD keeps hierarchy and schema 3 order contiguous', () => {
  let state = ready();
  state = run(state, Event.GroupAdded, { group: { id: 'child', parent_id: 'g1', name: '子', order: 1 } }).state;
  assert.equal(state.edit, Edit.Dirty); assert.equal(state.draft.groups.find(g => g.id === 'child').parent_id, 'g1');
  state = run(state, Event.MaterialAdded, { material: { id: 'm3', group_id: 'child', name: '資料', role: 'reference', target_type: 'file', path: 'C:\\Fixtures\\third.pdf', window_match_pattern: null, order: 99 } }).state;
  assert.deepEqual(state.draft.materials.filter(m => m.group_id === 'child').map(m => m.order), [1]);
  state = run(state, Event.MaterialUpdated, { material: { ...state.draft.materials.find(m => m.id === 'm3'), group_id: 'g1', role: 'main' } }).state;
  assert.deepEqual(state.draft.materials.filter(m => m.group_id === 'g1' && m.role === 'main').map(m => m.order).sort(), [1, 2]);
  state = run(state, Event.GroupDeleted, { group_id: 'g1', confirmed: true }).state;
  assert.ok(!state.draft.groups.some(g => ['g1', 'child'].includes(g.id)));
  assert.ok(!state.draft.materials.some(m => ['m1', 'm3'].includes(m.id)));
});

test('group duplication deep-copies descendants and registrations with fresh IDs', () => {
  const state = ready(), source = structuredClone(state.saved_config);
  source.groups.push({ id: 'child', parent_id: 'g1', name: '子', order: 1 });
  source.materials.push({ ...source.materials[0], id: 'm3', group_id: 'child', name: '子資料' });
  const result = run({ ...state, saved_config: source }, Event.GroupDuplicated, { group_id: 'g1' }).state;
  const copiedRoot = result.draft.groups.find(g => g.name === '会議（コピー）');
  const copiedChild = result.draft.groups.find(g => g.parent_id === copiedRoot.id);
  assert.ok(copiedRoot); assert.equal(copiedRoot.parent_id, null); assert.equal(copiedRoot.order, 3);
  assert.equal(copiedChild.name, '子'); assert.notEqual(copiedChild.id, 'child');
  const copiedMaterials = result.draft.materials.filter(m => [copiedRoot.id, copiedChild.id].includes(m.group_id));
  assert.equal(copiedMaterials.length, 3);
  assert.ok(copiedMaterials.every(m => !['m1', 'm3'].includes(m.id)));
  assert.deepEqual(copiedMaterials.map(m => m.path).sort(), source.materials.filter(m => ['g1', 'child'].includes(m.group_id)).map(m => m.path).sort());
});

test('groups move to root or child tail and reject descendant cycles', () => {
  const state = ready(), source = structuredClone(state.saved_config);
  source.groups.push({ id: 'child', parent_id: 'g1', name: '子', order: 1 }, { id: 'peer', parent_id: 'g1', name: '同階層', order: 2 });
  let moved = run({ ...state, saved_config: source }, Event.GroupMoved, { group_id: 'g2', parent_id: 'g1' }).state;
  assert.deepEqual(moved.draft.groups.filter(g => g.parent_id === 'g1').sort((a,b)=>a.order-b.order).map(g=>g.id), ['child', 'peer', 'g2']);
  const blocked = run(moved, Event.GroupMoved, { group_id: 'g1', parent_id: 'child' });
  assert.equal(blocked.state, moved);
  moved = run(moved, Event.GroupMoved, { group_id: 'child', parent_id: null }).state;
  assert.equal(moved.draft.groups.find(g => g.id === 'child').order, 2);
});

test('materials move across roles at menu tail or an explicit drop position', () => {
  const state = ready(), source = structuredClone(state.saved_config);
  source.materials.push({ ...source.materials[0], id: 'm3', role: 'reference', order: 2 });
  let moved = run({ ...state, saved_config: source }, Event.MaterialMoved, { material_id: 'm1', group_id: 'g1', role: 'reference' }).state;
  assert.deepEqual(moved.draft.materials.filter(m => m.group_id === 'g1' && m.role === 'reference').sort((a,b)=>a.order-b.order).map(m=>m.id), ['m2', 'm3', 'm1']);
  moved = run(moved, Event.MaterialMoved, { material_id: 'm1', group_id: 'g1', role: 'reference', before_material_id: 'm3' }).state;
  assert.deepEqual(moved.draft.materials.filter(m => m.group_id === 'g1' && m.role === 'reference').sort((a,b)=>a.order-b.order).map(m=>m.id), ['m2', 'm1', 'm3']);
});

test('Saving rejects every config edit event', () => {
  const state = saving();
  for (const [type, fields] of [
    [Event.DraftChanged, { config }], [Event.GroupAdded, { group: { id: 'g3', parent_id: null, name: '追加' } }],
    [Event.GroupRenamed, { group_id: 'g1', name: '変更' }], [Event.GroupDuplicated, { group_id: 'g1' }],
    [Event.GroupMoved, { group_id: 'g1', parent_id: 'g2' }], [Event.GroupDeleted, { group_id: 'g1', confirmed: true }],
    [Event.GroupMovedToEnd, { group_id: 'g1' }], [Event.ReorderCancelled, { groups: [], materials: [], edit: Edit.Clean }],
    [Event.MaterialAdded, { material: { ...config.materials[0], id: 'm3' } }], [Event.MaterialUpdated, { material: config.materials[0] }],
    [Event.MaterialMoved, { material_id: 'm1', group_id: 'g1', role: 'reference' }], [Event.MaterialDeleted, { material_id: 'm1', confirmed: true }],
  ]) assert.equal(run(state, type, fields).state, state, type);
});

test('DnD is draft-only and execution effects remain ID-only', () => {
  const requested = run(ready(), Event.NativeFilesDropped, { group_id: 'g1', paths: ['C:\\Drop\\drop.pdf'] });
  assert.equal(requested.effects[0].type, Effect.PrepareDroppedFiles);
  const prepared = run(requested.state, Event.DroppedFilesPrepared, { group_id: 'g1', response: { candidates: [{ name: 'drop.pdf', path: 'C:\\Drop\\drop.pdf', target_type: 'file' }, { name: 'Folder', path: 'C:\\Drop\\Folder', target_type: 'folder' }], failures: [{ path: 'C:\\Drop\\missing.pdf', reason: 'not_found' }] } });
  assert.equal(prepared.state.edit, Edit.Clean); assert.equal(prepared.state.dropped_files.candidates.length, 2); assert.deepEqual(prepared.state.dropped_files.failures,[{path:'C:\\Drop\\missing.pdf',reason:'not_found'}]);
  const dropped = run(prepared.state, Event.DroppedFilesConfirmed, { group_id: 'g1', role: 'main' });
  assert.equal(dropped.effects.length, 0); assert.equal(dropped.state.edit, Edit.Dirty);
  const added = dropped.state.draft.materials.find(m => m.path === 'C:\\Drop\\drop.pdf');
  assert.equal(added.role, 'main'); assert.equal(added.group_id, 'g1');
  const addedFolder = dropped.state.draft.materials.find(m => m.path === 'C:\\Drop\\Folder');
  assert.equal(addedFolder.target_type, 'folder');
  const unsavedOpen = run(dropped.state, Event.OpenContainingFolderRequested, { material_id: added.id });
  assert.equal(unsavedOpen.effects.length, 0, 'unsaved dropped paths cannot reach execution IPC');
  const open = run(dropped.state, Event.OpenContainingFolderRequested, { material_id: 'm1' });
  assert.deepEqual(open.effects[0].request, { material_id: 'm1', explorer_open_mode: 'new_window' });
});

test('PDF fallback opens only its saved material ID through Activate', () => {
  const failed = { ...viewing(), pdf: { kind: 'Failed', material_id: 'm1', generation: 1, code: 'PDF_FALLBACK_TOO_LARGE' } };
  const result = run(failed, Event.PdfOpenExternalRequested);
  assert.equal(result.effects[0].type, Effect.Activate);
  assert.deepEqual(result.effects[0].request, { material_id: 'm1' });
  const unsupported = run({ ...failed, pdf: { ...failed.pdf, code: 'PDF_PASSWORD_REQUIRED' } }, Event.PdfOpenExternalRequested);
  assert.equal(unsupported.effects.length, 0);
});

test('layout boundaries and PDF controls are mediated', () => {
  let state = ready(); state = run(state, Event.SidebarWidthChanged, { value: 5 }).state; assert.equal(state.layout.sidebar_width, 180);
  state = run(state, Event.PdfWidthChanged, { value: 9999 }).state; assert.equal(state.layout.pdf_width, 1200);
  state = run(state, Event.SidebarToggled).state;
  state = run(state, Event.PdfWidthChanged, { value: 9999 }).state; assert.equal(state.layout.pdf_width, 1380);
  const pdf = viewing(); assert.equal(run(pdf, Event.PdfNextRequested).effects[0].type, Effect.PdfNext);
  assert.equal(run(pdf, Event.PdfFitRequested, { viewport_width: 400 }).effects[0].request.viewport_width, 400);
});

test('drag reorder is draft-only and limited to the same parent or material section', () => {
  const s=ready(),withPeers={...s,saved_config:structuredClone(s.saved_config)};
  withPeers.saved_config.groups.push({id:'g3',parent_id:null,name:'会議3',order:3});
  withPeers.saved_config.materials.push({...withPeers.saved_config.materials[0],id:'m3',order:2});
  const groups=run(withPeers,Event.GroupReordered,{group_id:'g3',before_group_id:'g1'}).state;
  assert.deepEqual(groups.draft.groups.filter(g=>g.parent_id===null).sort((a,b)=>a.order-b.order).map(g=>g.id),['g3','g1','g2']);
  const materials=run(withPeers,Event.MaterialReordered,{material_id:'m3',before_material_id:'m1'}).state;
  assert.deepEqual(materials.draft.materials.filter(m=>m.group_id==='g1'&&m.role==='main').sort((a,b)=>a.order-b.order).map(m=>m.id),['m3','m1']);
  const tail=run(materials,Event.MaterialMoved,{material_id:'m3',group_id:'g1',role:'main',before_material_id:null}).state;
  assert.deepEqual(tail.draft.materials.filter(m=>m.group_id==='g1'&&m.role==='main').sort((a,b)=>a.order-b.order).map(m=>m.id),['m1','m3']);
  assert.equal(run(withPeers,Event.MaterialReordered,{material_id:'m2',before_material_id:'m1'}).state,withPeers);
});

test('keyboard and pointer reorder use the same model boundary and cancel restores placement',()=>{
  const s=ready(),base={...s,saved_config:structuredClone(s.saved_config)};
  base.saved_config.groups.push({id:'g3',parent_id:null,name:'会議3',order:3});
  base.saved_config.materials.push({...base.saved_config.materials[0],id:'m3',order:2});
  const groups=base.saved_config.groups.map(({id,parent_id,order})=>({id,parent_id,order}));
  const materials=base.saved_config.materials.map(({id,group_id,role,order})=>({id,group_id,role,order}));
  const moved=run(base,Event.GroupReordered,{group_id:'g3',before_group_id:'g1'}).state;
  const tail=run(moved,Event.GroupMovedToEnd,{group_id:'g3'}).state;
  assert.deepEqual(tail.draft.groups.sort((a,b)=>a.order-b.order).map(g=>g.id),['g1','g2','g3']);
  const changed=run(moved,Event.MaterialReordered,{material_id:'m3',before_material_id:'m1'}).state;
  const restored=run(changed,Event.ReorderCancelled,{groups,materials,edit:Edit.Clean}).state;
  assert.equal(restored.edit,Edit.Clean);
  assert.equal(restored.draft,null);
  assert.equal(run({...changed,edit:Edit.Saving},Event.ReorderCancelled,{groups,materials,edit:Edit.Clean}).state.edit,Edit.Saving);
  assert.equal(run(changed,Event.ReorderCancelled,{groups:[],materials,edit:Edit.Clean}).state,changed);
});
