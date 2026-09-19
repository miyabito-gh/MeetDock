import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transition, initialState, Event, Effect, Lifecycle, Edit, Pdf } from '../src/model.js';
import { appError, MAX_SAFE } from '../src/contracts.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/contracts.json', import.meta.url))).fixtures;
export const config = structuredClone(fixtures.find(f => f.name === 'AppConfig: valid').value);
config.groups.push({ id: 'g2', parent_id: null, name: '会議2', order: 2 });
config.materials.push({ ...config.materials[0], id: 'm2', role: 'reference', path: 'C:\\Fixtures\\second.PDF' });
export const request1 = '12345678-1234-4234-8234-123456789abc', request2 = '12345678-1234-4234-8234-123456789abd';
export const run = (s, type, fields = {}) => transition(s, { type, ...fields });
export const ready = () => run(initialState(), Event.SettingsLoaded, { config }).state;
const dirty = () => run(ready(), Event.EditRequested).state;
const saving = () => run(dirty(), Event.SaveRequested).state;
const sync = () => run(ready(), Event.SyncRequested, { request_id: request1 }).state;
const launch = () => run(ready(), Event.ActivateRequested, { material_id: 'm1' }).state;
const batch = () => run(ready(), Event.BatchLaunchRequested, { group_id: 'g1' }).state;
const loading = () => run(ready(), Event.PdfOpenRequested, { material_id: 'm1' }).state;
const viewing = () => run(loading(), Event.PdfReady, { material_id: 'm1', generation: 2 }).state;
const candidate = { candidate_id: 'candidate1', kind: 'backup', revision: 12, last_updated: null };
const pending = lifecycle => ({ ...initialState(), lifecycle, candidates: [{ ...candidate, kind: lifecycle === Lifecycle.MigrationPending ? 'legacy' : 'backup' }] });
const response = mode => ({ mode, config: null, source_schema_version: mode === 'read_only_future_schema' ? 4 : 3, candidates: [{ ...candidate, kind: mode === 'migration_required' ? 'legacy' : 'backup' }], notice_code: null });
const io = appError('CONFIG_IO'), conflict = appError('CONFIG_CONFLICT'), pdfError = appError('PDF_CORRUPT');
const saved = { revision: 13, last_updated: '2026-09-19T10:00:00Z' };
const launched = { material_id: 'm1', outcome: 'launched', error: null };

// IDs map 1:1 to the rows in MEDIATOR_STATE_TRANSITIONS.md.
// Each row includes success/effect count and an independent failed guard.
const rows = [
  ['M01 settings', initialState, Event.SettingsLoaded, { config }, 0, s => s.lifecycle === Lifecycle.Ready, { config: { ...config, schema_version: 4 } }],
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
  ['M16 sync idle', ready, Event.SyncRequested, { request_id: request1 }, 1, s => s.sync.request_id === request1, { request_id: 'bad' }],
  ['M17 sync replace', sync, Event.SyncRequested, { request_id: request2, manual: true }, 1, s => s.sync.request_id === request2, { request_id: request2 }],
  ['M18 sync success', sync, Event.SyncSucceeded, { request_id: request1, results: [] }, 0, s => s.sync.kind === 'Idle', { request_id: request2, results: [] }],
  ['M19 stale sync', sync, Event.SyncFailed, { request_id: request2, error: io }, 0, s => s.sync.kind === 'Running', { request_id: request2, error: io }],
  ['M20 activate', ready, Event.ActivateRequested, { material_id: 'm1' }, 1, s => s.launch.running.length === 1, { material_id: 'unknown' }],
  ['M21 duplicate launch', launch, Event.ActivateRequested, { material_id: 'm1' }, 0, s => s.launch.running.length === 1, { material_id: 'm1' }],
  ['M22 launch complete', launch, Event.LaunchSucceeded, { material_id: 'm1', generation: 1, response: launched }, 0, s => s.launch.running.length === 0, { material_id: 'm2', generation: 1 }],
  ['M23 batch', ready, Event.BatchLaunchRequested, { group_id: 'g1' }, 1, s => s.launch.batch.group_id === 'g1', { group_id: 'missing' }],
  ['M24 batch complete', batch, Event.BatchLaunchCompleted, { group_id: 'g1', generation: 1, response: { results: [launched] } }, 0, s => s.launch.batch === null, { group_id: 'g2', generation: 1 }],
  ['M25 pdf open', ready, Event.PdfOpenRequested, { material_id: 'm1' }, 1, s => s.pdf.kind === Pdf.Loading && s.state_generation === 2, { material_id: 'missing' }],
  ['M26 pdf ready', loading, Event.PdfReady, { material_id: 'm1', generation: 2 }, 0, s => s.pdf.kind === Pdf.Viewing, { material_id: 'm2', generation: 2 }],
  ['M27 pdf switch', viewing, Event.PdfOpenRequested, { material_id: 'm2' }, 1, s => s.pdf.material_id === 'm2' && s.state_generation === 3, { material_id: 'm1' }],
  ['M28 pdf password', loading, Event.PdfPasswordRequired, { material_id: 'm1', generation: 2, error: appError('PDF_PASSWORD_REQUIRED') }, 0, s => s.pdf.kind === Pdf.PasswordRequired, { material_id: 'm1', generation: 1 }],
  ['M29 pdf fail', viewing, Event.PdfFailed, { material_id: 'm1', generation: 2, error: pdfError }, 0, s => s.pdf.kind === Pdf.Failed, { material_id: 'm1', generation: 1, error: pdfError }],
  ['M30 stale pdf', loading, Event.PdfReady, { material_id: 'm1', generation: 1 }, 0, s => s.pdf.kind === Pdf.Loading, { material_id: 'm1', generation: 1 }],
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
  assert.equal(run({ ...ready(), lifecycle: Lifecycle.ReadOnly }, Event.SyncRequested, { request_id: request1 }).effects.length, 1);
  assert.equal(run(sync(), Event.SyncRequested, { request_id: request2, new_auto: true }).effects.length, 1);
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
  assert.equal(run(latest, Event.PdfReady, { material_id: 'm2', generation: 3 }).state.pdf.kind, Pdf.Viewing);
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
test('effects contain only saved IDs, never a path or arbitrary URL', () => {
  for (const [type, fields] of [[Event.ActivateRequested, { material_id: 'm1' }], [Event.BatchLaunchRequested, { group_id: 'g1' }]]) {
    const f = run(ready(), type, fields).effects[0]; assert.deepEqual(f.request, fields);
  }
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
