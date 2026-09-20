import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validate, decodeConfig, appError } from '../src/contracts.js';
import { createIpcAdapter } from '../src/ipc-adapter.js';
const { fixtures } = JSON.parse(readFileSync(new URL('./fixtures/contracts.json', import.meta.url)));
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
  assert.deepEqual(calls, [['load_settings', {}], ['activate_or_launch', { request: { material_id: 'm1' } }]]);
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
  ] };
  const result = await createIpcAdapter(async () => response)
    .call('prepare_dropped_files', { paths: response.candidates.map(candidate => candidate.path) });
  assert.deepEqual(result, response);
  for (const invalid of [
    { candidates: [] },
    { candidates: [{ name: 'URL', path: 'https://example.com', target_type: 'url' }] },
    { candidates: [{ name: 'Missing type', path: 'C:\\Drop\\item' }] },
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
