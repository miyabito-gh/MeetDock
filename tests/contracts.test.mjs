import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validate, decodeConfig, appError, restorationTargetKey, windowsPathKey } from '../src/contracts.js';
import { createIpcAdapter } from '../src/ipc-adapter.js';
const { fixtures } = JSON.parse(readFileSync(new URL('./fixtures/contracts.json', import.meta.url)));
test('restoration target keys normalize Windows path spelling without merging distinct documents', () => {
  assert.equal(windowsPathKey('\\\\?\\C:/Apps/Editor.EXE\\'), windowsPathKey('c:\\apps\\editor.exe'));
  assert.equal(windowsPathKey('\\\\?\\UNC\\Server\\Share\\Docs\\'), windowsPathKey('\\\\server/share/docs'));
  assert.equal(
    restorationTargetKey('C:\\Apps\\Editor.exe', 'C:\\Docs\\Agenda.docx'),
    restorationTargetKey('c:/apps/editor.exe/', '\\\\?\\C:\\DOCS\\AGENDA.DOCX\\'),
  );
  assert.notEqual(
    restorationTargetKey('C:\\Apps\\Editor.exe', 'C:\\Docs\\Agenda.docx'),
    restorationTargetKey('C:\\Apps\\Editor.exe', 'C:\\Docs\\Minutes.docx'),
  );
  assert.notEqual(
    restorationTargetKey('C:\\Apps\\Editor.exe', 'C:\\Docs\\Agenda.docx'),
    restorationTargetKey('C:\\Apps\\Other.exe', 'C:\\Docs\\Agenda.docx'),
  );
});

test('window snapshot keeps strict Shell locations separate from document paths', () => {
  const base={app_name:'Explorer',title:'PC',executable_name:'explorer.exe',executable_path:'C:\\Windows\\explorer.exe',restorability:'restorable',reason:null};
  assert.doesNotThrow(()=>validate('OptionalWindowSnapshot',{schema_version:1,saved_at_unix_ms:1,items:[{...base,shell_location:'::{20D04FE0-3AEA-1069-A2D8-08002B30309D}'}]}));
  for(const item of [
    {...base,shell_location:'Home'},
    {...base,shell_location:'::{not-a-guid}'},
    {...base,document_path:'C:\\Meetings',shell_location:'::{20D04FE0-3AEA-1069-A2D8-08002B30309D}'},
  ]) assert.throws(()=>validate('OptionalWindowSnapshot',{schema_version:1,saved_at_unix_ms:1,items:[item]}),TypeError);
});
for (const f of fixtures) test(f.name, () => {
  const decode = () => f.type === 'ConfigDocument' ? decodeConfig(f.value) : validate(f.type, f.value);
  if (!f.valid) assert.throws(decode);
  else {
    const result = decode();
    if (f.normalized) assert.deepEqual(result, f.normalized);
    if (f.type === 'ConfigDocument' && f.value.schema_version !== 3) assert.equal(result.config, null);
  }
});
const base = type => structuredClone(fixtures.find(f => f.name === `${type}: valid`).value);
test('adapter: exact command envelope, no generation on wire', async () => {
  const calls = [];
  const api = createIpcAdapter(async (command, args) => {
    calls.push([command, args]); return command === 'load_settings' ? base('SettingsLoadResponse') : base('LaunchResponse');
  });
  await api.call('load_settings'); await api.call('activate_or_launch', { material_id: 'm1' });
  assert.deepEqual(calls, [['load_settings', {}], ['activate_or_launch', { request: { material_id: 'm1', explorer_open_mode: 'new_window' } }]]);
});

test('window snapshot commands reach native IPC with exact envelopes', async () => {
  const snapshot = { schema_version: 1, saved_at_unix_ms: 1, items: [] };
  const calls = [], responses = {
    save_window_snapshot: { saved: true, saved_count: 1, excluded_count: 0, exclusion_reasons: [] },
    load_window_snapshot: snapshot,
    clear_window_snapshot: true,
    launch_window_snapshot_item: { index: 2 },
  };
  const api = createIpcAdapter(async (command, payload) => { calls.push([command, payload]); return responses[command]; });
  assert.equal((await api.call('save_window_snapshot')).saved, true);
  assert.deepEqual(await api.call('load_window_snapshot'), snapshot);
  assert.equal(await api.call('clear_window_snapshot'), true);
  assert.deepEqual(await api.call('launch_window_snapshot_item', { index: 2 }), { index: 2 });
  assert.deepEqual(calls, [
    ['save_window_snapshot', {}],
    ['load_window_snapshot', {}],
    ['clear_window_snapshot', {}],
    ['launch_window_snapshot_item', { request: { index: 2 } }],
  ]);
});
test('adapter rejects invalid request before I/O and sanitizes malformed errors/results', async () => {
  let calls = 0;
  const api = createIpcAdapter(async () => { calls++; throw 'C:\\secret OS details'; });
  await assert.rejects(api.call('activate_or_launch', { material_id: 'm1', path: 'C:\\secret' }), { code: 'INVALID_REQUEST' });
  assert.equal(calls, 0);
  await assert.rejects(api.call('activate_or_launch', { material_id: 'm1' }), { code: 'INTERNAL_ERROR' });
  await assert.rejects(createIpcAdapter(async () => null).call('open_containing_folder', { material_id: 'm1' }), { code: 'INTERNAL_ERROR' });
  await assert.rejects(createIpcAdapter(async () => { throw appError('CONFIG_IO'); }).call('load_settings'), { code: 'CONFIG_IO' });
});

test('dropped file response accepts files and folders with explicit target types', async () => {
  const response = { candidates: [
    { name: 'sample.pdf', path: 'C:\\Drop\\sample.pdf', target_type: 'file' },
    { name: 'Materials', path: 'C:\\Drop\\Materials', target_type: 'folder' },
  ], failures: [{ path: 'C:\\Drop\\missing.pdf', reason: 'not_found' }] };
  const result = await createIpcAdapter(async () => response)
    .call('prepare_dropped_files', { paths: response.candidates.map(candidate => candidate.path) });
  assert.deepEqual(result, response);
  const allFailed = { candidates: [], failures: [{ path: 'missing.pdf', reason: 'not_found' }] };
  assert.deepEqual(await createIpcAdapter(async () => allFailed)
    .call('prepare_dropped_files', { paths: ['C:\\Drop\\missing.pdf'] }), allFailed);
  for (const invalid of [
    { candidates: [], failures: [] },
    { candidates: [], failures: [{ path: 'missing.pdf', reason: 'not_found', detail: 'OS secret' }] },
    { candidates: [], failures: [{ path: 'missing.pdf', reason: 7 }] },
    { candidates: [{ name: 'URL', path: 'https://example.com', target_type: 'url' }], failures: [] },
    { candidates: [{ name: 'Missing type', path: 'C:\\Drop\\item' }], failures: [] },
    { candidates: [{ name: 'Valid', path: 'C:\\Drop\\item', target_type: 'file' }], failures: [{ path: 'x', reason: 'unknown' }] },
  ]) await assert.rejects(
    createIpcAdapter(async () => invalid).call('prepare_dropped_files', { paths: ['C:\\Drop\\item'] }),
    { code: 'INTERNAL_ERROR' },
  );
});
test('adapter checks response correlation and save revision increment', async () => {
  for (const [command, request, response] of [
    ['sync_material_statuses', base('SyncStatusesRequest'), { ...base('SyncStatusesResponse'), request_id: '12345678-1234-4234-8234-123456789abd' }],
    ['activate_or_launch', { material_id: 'm1' }, { ...base('LaunchResponse'), material_id: 'm2' }],
    ['save_settings', base('SaveSettingsRequest'), { ...base('SaveSettingsResponse'), revision: 14 }],
  ]) await assert.rejects(createIpcAdapter(async () => response).call(command, request), { code: 'INTERNAL_ERROR' });
});
