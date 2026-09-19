import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher } from '../src/event-chain.js';
import { createEffectRunner, createServices } from '../src/effect-runner.js';
import { createRoot } from '../src/root.js';
import { createPresenter } from '../src/presenter.js';
import { initialState, transition, Event, Effect } from '../src/model.js';
import { appError } from '../src/contracts.js';
import { readFileSync } from 'node:fs';
const fixture = name => structuredClone(JSON.parse(readFileSync(new URL('./fixtures/contracts.json', import.meta.url))).fixtures.find(f => f.name === `${name}: valid`).value);
const ready = () => transition(initialState(), { type: Event.SettingsLoaded, config: fixture('AppConfig') }).state;
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const req1 = '12345678-1234-4234-8234-123456789abc', req2 = '12345678-1234-4234-8234-123456789abd';
function ports() {
  return { settings: { load: async () => fixture('SettingsLoadResponse'), save: async () => fixture('SaveSettingsResponse'), resolve: async () => fixture('SettingsLoadResponse') },
    statuses: { sync: async r => ({ request_id: r.request_id, results: [] }) },
    launch: { activate: async () => fixture('LaunchResponse'), batch: async () => fixture('BatchLaunchResponse') },
    pdf: { replace: async () => {}, close: async () => {} }, lifecycle: { close: async () => {} } };
}
test('fixed CoR: root consumes close once, unknown falls back with zero effects', () => {
  const effects = [], diagnostics = [];
  const d = createDispatcher({ initial: ready(), render() {}, runEffects: fs => effects.push(...fs), diagnostic: x => diagnostics.push(x) });
  const before = d.getState();
  d.dispatch({ type: Event.CloseRequested }); d.dispatch({ type: Event.CloseRequested });
  assert.equal(effects.length, 1); assert.equal(effects[0].type, Effect.CloseWindow);
  d.dispatch({ type: 'NotAnEvent', path: 'C:\\private' });
  assert.equal(effects.length, 1); assert.deepEqual(diagnostics, ['unhandled_event']); assert.equal(d.getState(), before);
});
test('reentrant input is FIFO after transition + render + effect delivery; single save', () => {
  const order = [];
  let d, reentered = false;
  d = createDispatcher({ initial: ready(), render: m => {
    order.push(`render:${m.edit}`);
    if (m.edit === 'Dirty' && !reentered) { reentered = true; d.dispatch({ type: Event.SaveRequested }); d.dispatch({ type: Event.SaveRequested }); }
  }, runEffects: fs => { for (const f of fs) order.push(`effect:${f.type}`); } });
  d.dispatch({ type: Event.EditRequested });
  assert.deepEqual(order, ['render:Dirty', 'render:Saving', 'effect:SaveSettings', 'render:Saving']);
  assert.throws(() => { d.getState().config_revision = 99; }, TypeError);
});
test('consecutive search and resize merge, queue has a hard 256 bound', () => {
  let d, entered = false, accepted = 0, max = 0;
  const diagnostics = [];
  d = createDispatcher({ initial: ready(), render() {
    if (entered) return; entered = true;
    for (let i = 0; i < 1000; i++) d.dispatch({ type: Event.SearchChanged, value: `${i}` });
    for (let i = 0; i < 1000; i++) d.dispatch({ type: Event.ResizeChanged, value: i });
    assert.equal(d.queuedCount, 2);
    for (let i = 0; i < 300; i++) { if (d.dispatch({ type: Event.EditRequested })) accepted++; max = Math.max(max, d.queuedCount); }
  }, runEffects() {}, diagnostic: x => diagnostics.push(x) });
  d.dispatch({ type: Event.SearchChanged, value: 'first' });
  assert.equal(max, 256); assert.equal(accepted, 254); assert.equal(d.getState().query, '999');
  assert.equal(d.getState().width, 999); assert.equal(d.getState().lifecycle, 'FatalError');
  assert.ok(diagnostics.includes('event_queue_full')); assert.equal(d.queuedCount, 0);
});
test('effect capacity refuses before committing Running/Saving', () => {
  const d2 = createDispatcher({ initial: ready(), render() {}, runEffects: fs => assert.equal(fs.length, 0), availableEffects: () => 0 });
  const before = d2.getState(); d2.dispatch({ type: Event.ActivateRequested, material_id: 'm1' });
  assert.equal(d2.getState(), before);
});
test('Presenter types input and sends once; render model is passed to passive View', () => {
  const events = [], models = [];
  const p = createPresenter({ render: m => models.push(m) }, e => events.push(e));
  p.activate('m1'); p.batch('g1'); p.edit(); p.save(); p.discard(true); p.search('text'); p.resize(400); p.render({ edit: 'Clean' });
  assert.equal(events.length, 7); assert.equal(models.length, 1); assert.equal(events[0].type, Event.ActivateRequested);
  assert.throws(() => p.activate('C:\\private')); assert.equal(events.length, 7);
});
test('Runner executes each effect object once, in list order, with no retry', async () => {
  const services = ports(), calls = [], events = [], a = deferred(), b = deferred();
  services.launch.activate = r => { calls.push(r.material_id); return r.material_id === 'm1' ? a.promise : b.promise; };
  const runner = createEffectRunner(services, e => events.push(e));
  const fs = ['m1', 'm2'].map(material_id => ({ type: Effect.Activate, request: { material_id }, generation: 1 }));
  runner.run(fs); runner.run(fs);
  assert.deepEqual(calls, ['m1', 'm2']); assert.equal(runner.pendingCount, 2);
  a.reject(appError('LAUNCH_FAILED')); b.resolve({ material_id: 'm2', outcome: 'foreground_denied', error: appError('FOREGROUND_DENIED') });
  await runner.settled();
  assert.deepEqual(events.map(e => e.type), [Event.LaunchFailed, Event.ForegroundDenied]); assert.equal(calls.length, 2);
});
test('Runner error mapping for every service and malformed response', async () => {
  const cases = [
    [Effect.LoadSettings, 'settings', 'load', Event.SettingsLoadFailed, appError('CONFIG_IO')],
    [Effect.ResolveSettings, 'settings', 'resolve', Event.ResolutionFailed, appError('CONFIG_IO')],
    [Effect.SaveSettings, 'settings', 'save', Event.SaveConflict, appError('CONFIG_CONFLICT')],
    [Effect.SaveSettings, 'settings', 'save', Event.SaveFailed, appError('CONFIG_IO')],
    [Effect.SyncStatuses, 'statuses', 'sync', Event.SyncFailed, appError('PATH_TIMEOUT')],
    [Effect.Activate, 'launch', 'activate', Event.LaunchFailed, appError('LAUNCH_FAILED')],
    [Effect.BatchLaunch, 'launch', 'batch', Event.BatchLaunchCompleted, appError('LAUNCH_FAILED')],
    [Effect.ReplacePdf, 'pdf', 'replace', Event.PdfPasswordRequired, appError('PDF_PASSWORD_REQUIRED')],
    [Effect.ReplacePdf, 'pdf', 'replace', Event.PdfFailed, appError('PDF_CORRUPT')],
    [Effect.ClosePdf, 'pdf', 'close', Event.EffectFailed, appError('INTERNAL_ERROR')],
    [Effect.CloseWindow, 'lifecycle', 'close', Event.EffectFailed, appError('INTERNAL_ERROR')],
  ];
  for (const [type, port, method, eventType, error] of cases) {
    const services = ports(), events = []; let calls = 0;
    services[port][method] = async () => { calls++; throw error; };
    const runner = createEffectRunner(services, e => events.push(e));
    runner.run([{ type, request: { material_id: 'm1', group_id: 'g1', request_id: req1 }, generation: 2 }]);
    await runner.settled(); assert.equal(calls, 1); assert.equal(events[0].type, eventType); assert.deepEqual(events[0].error, error);
  }
  const services = ports(), events = [];
  services.settings.save = async () => null;
  const runner = createEffectRunner(services, e => events.push(e));
  runner.run([{ type: Effect.SaveSettings, request: { expected_revision: 12 }, generation: 1 }]);
  await runner.settled(); assert.equal(events[0].type, Event.SaveFailed); assert.equal(events[0].error.code, 'INTERNAL_ERROR');
});
test('Root integrates transitions/render before I/O, preserves draft on failure', async () => {
  const services = ports(), models = [], save = deferred(); let calls = 0;
  const root = createRoot({ services, presenter: { render: m => models.push(m) } });
  services.settings.save = () => { assert.equal(models.at(-1).edit, 'Saving'); calls++; return save.promise; };
  root.start(); root.start(); await root.settled();
  assert.equal(root.getState().lifecycle, 'Ready');
  root.dispatch({ type: Event.EditRequested }); const draft = root.getState().draft;
  root.dispatch({ type: Event.SaveRequested }); root.dispatch({ type: Event.SaveRequested });
  save.reject(appError('CONFIG_IO')); await root.settled();
  assert.equal(calls, 1); assert.equal(root.getState().edit, 'Dirty'); assert.deepEqual(root.getState().draft, draft);
  assert.equal(models.at(-1).notice.code, 'CONFIG_IO');
});
test('Root discards out-of-order sync successes AND failures', async () => {
  for (const rejectOld of [false, true]) {
    const services = ports(), first = deferred(), second = deferred();
    services.statuses.sync = r => r.request_id === req1 ? first.promise : second.promise;
    const root = createRoot({ services, presenter: { render() {} } }); root.start(); await root.settled();
    root.dispatch({ type: Event.SyncRequested, request_id: req1 });
    root.dispatch({ type: Event.SyncRequested, request_id: req2, manual: true });
    second.resolve({ request_id: req2, results: [fixture('MaterialStatusResult')] });
    await new Promise(resolve => setImmediate(resolve));
    if (rejectOld) first.reject(appError('PATH_TIMEOUT')); else first.resolve({ request_id: req1, results: [] });
    await root.settled(); assert.equal(root.getState().statuses.length, 1); assert.equal(root.getState().sync.kind, 'Idle');
  }
});
test('application service ports send contract commands without generation', async () => {
  const calls = [];
  const services = createServices({ call: async (...args) => calls.push(args) }, {}, {});
  await services.settings.load(); await services.settings.resolve({ action: 'initialize_empty', candidate_id: null });
  await services.launch.activate({ material_id: 'm1' });
  assert.deepEqual(calls, [['load_settings'], ['resolve_settings_issue', { action: 'initialize_empty', candidate_id: null }], ['activate_or_launch', { material_id: 'm1' }]]);
});
