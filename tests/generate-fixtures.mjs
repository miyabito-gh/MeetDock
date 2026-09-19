// Deterministic generated data; seed: meetdock-contract-v1 (no random data).
import { writeFileSync } from 'node:fs';
import { enums, errorCodes, appError, MAX_SAFE } from '../src/contracts.js';
const timestamp = '2026-09-19T08:35:00Z';
const group = { id: 'g1', parent_id: null, name: '会議', order: 1 };
const material = { id: 'm1', group_id: 'g1', name: '資料', role: 'main', target_type: 'file',
  path: 'C:\\Fixtures\\資料.pdf', window_match_pattern: null, order: 1 };
const config = { schema_version: 3, app_version: '0.1.0', revision: 12, last_updated: timestamp, groups: [group], materials: [material] };
const candidate = { candidate_id: 'backup1', kind: 'backup', revision: null, last_updated: null };
const status = { material_id: 'm1', open_state: 'unknown', confidence: 'unknown', path_state: 'unchecked', detail: null };
const launch = { material_id: 'm1', outcome: 'launched', error: null };
const request_id = '12345678-1234-4234-8234-123456789abc';
const bases = {
  AppConfig: config, GroupItem: group, MaterialItem: material, SettingsCandidate: candidate,
  SettingsLoadResponse: { mode: 'ready', config, source_schema_version: 3, candidates: [candidate], notice_code: null },
  AppError: appError('CONFIG_IO'), MaterialStatusResult: status, LaunchResponse: launch,
  LoadSettingsRequest: {}, EmptyResponse: {},
  ResolveSettingsIssueRequest: { action: 'initialize_empty', candidate_id: null },
  SaveSettingsRequest: { config, expected_revision: 12 }, SaveSettingsResponse: { revision: 13, last_updated: timestamp },
  SyncStatusesRequest: { material_ids: ['m1'], request_id }, SyncStatusesResponse: { request_id, results: [status] },
  ActivateOrLaunchRequest: { material_id: 'm1' }, OpenContainingFolderRequest: { material_id: 'm1' },
  BatchLaunchRequest: { group_id: 'g1' }, BatchLaunchResponse: { results: [launch] },
};
const fixtures = [];
function add(name, type, value, valid, normalized) {
  fixtures.push({ name, type, value: structuredClone(value), valid, ...(normalized ? { normalized } : {}) });
}
function change(type, key, value, valid, name = `${key}=${JSON.stringify(value)}`) {
  add(`${type}: ${name}`, type, { ...structuredClone(bases[type]), [key]: value }, valid);
}
for (const [type, value] of Object.entries(bases)) {
  add(`${type}: valid`, type, value, true);
  change(type, 'unknown_field', 1, false);
  add(`${type}: null`, type, null, false);
  add(`${type}: array`, type, [], false);
  for (const key of Object.keys(value)) {
    const missing = structuredClone(value); delete missing[key];
    add(`${type}: missing ${key}`, type, missing, false);
    if (value[key] !== null) change(type, key, null, type === 'SettingsLoadResponse' && key === 'source_schema_version');
  }
}
for (const [type, fields] of Object.entries({ MaterialItem: ['role', 'target_type'], SettingsCandidate: ['kind'],
  MaterialStatusResult: ['open_state', 'confidence', 'path_state'] })) {
  for (const field of fields) {
    for (const value of enums[field]) {
      const dto = { ...bases[type], [field]: value };
      if (field === 'target_type' && value === 'url') dto.path = 'https://example.com/docs';
      add(`${type}: ${field} ${value}`, type, dto, true);
    }
    change(type, field, 'unknown_enum', false);
  }
}
for (const code of errorCodes) {
  add(`AppError: ${code}`, 'AppError', appError(code), true);
  add(`AppError: wrong retry ${code}`, 'AppError', { ...appError(code), retryable: !appError(code).retryable }, false);
}
change('AppError', 'code', 'UNKNOWN', false);
for (const outcome of enums.outcome) {
  add(`LaunchResponse: ${outcome}`, 'LaunchResponse', { ...launch, outcome,
    error: ['activated', 'launched', 'not_trackable'].includes(outcome) ? null : appError('LAUNCH_FAILED', 'm1') }, true);
}
change('LaunchResponse', 'outcome', 'unknown', false);
change('LaunchResponse', 'outcome', 'failed', false);
change('LaunchResponse', 'error', appError('LAUNCH_FAILED'), false);
change('AppError', 'material_id', 'm1', true);
change('MaterialStatusResult', 'detail', '状態を確認できません。', true);
change('SettingsCandidate', 'revision', MAX_SAFE, true);
change('SettingsCandidate', 'last_updated', timestamp, true);
change('GroupItem', 'parent_id', 'parent1', true);
for (const type of ['GroupItem', 'MaterialItem']) {
  change(type, 'order', 0xffffffff, true);
  for (const order of [-1, 1.5, 0x100000000, '1']) change(type, 'order', order, false);
}
for (const action of enums.action) add(`Resolve: ${action}`, 'ResolveSettingsIssueRequest', {
  action, candidate_id: ['restore_candidate', 'import_legacy'].includes(action) ? 'backup1' : null }, true);
change('ResolveSettingsIssueRequest', 'action', 'unknown', false);
change('ResolveSettingsIssueRequest', 'action', 'restore_candidate', false);
change('ResolveSettingsIssueRequest', 'candidate_id', 'backup1', false);
for (const mode of enums.mode) add(`Settings: ${mode}`, 'SettingsLoadResponse', {
  mode, config: mode === 'ready' ? config : null, source_schema_version: mode === 'read_only_future_schema' ? 4 : 3,
  candidates: mode === 'migration_required' ? [{ ...candidate, kind: 'legacy' }] : [], notice_code: null }, true);
change('SettingsLoadResponse', 'mode', 'unknown', false);
change('SettingsLoadResponse', 'mode', 'read_only_future_schema', false);
for (const value of ['', 'a/b', '日本語', 'a'.repeat(65), 'a\n', '..', 'a.b', 1]) change('ActivateOrLaunchRequest', 'material_id', value, false);
change('ActivateOrLaunchRequest', 'material_id', 'a'.repeat(64), true);
change('ActivateOrLaunchRequest', 'path', 'C:\\secret', false);
change('BatchLaunchRequest', 'url', 'https://example.com', false);
for (const value of ['', request_id.replace('-4', '-3'), request_id.replace('-8', '-7'), 1]) change('SyncStatusesRequest', 'request_id', value, false);
change('SyncStatusesRequest', 'request_id', request_id.toUpperCase(), true);
for (const value of [-1, 1.5, MAX_SAFE + 1, '12']) change('SaveSettingsResponse', 'revision', value, false);
for (const value of [0, MAX_SAFE]) change('SaveSettingsResponse', 'revision', value, true);
change('SaveSettingsRequest', 'expected_revision', 11, false);
add('save revision exhausted', 'SaveSettingsRequest', { config: { ...config, revision: MAX_SAFE }, expected_revision: MAX_SAFE }, false);
for (const value of ['2026-02-29T00:00:00Z', '2026-09-19T24:00:00Z', '2026-09-19T08:35:00+09:00', '2026-09-19', '2026-09-19T08:35:00.Z']) change('SaveSettingsResponse', 'last_updated', value, false);
for (const value of ['2024-02-29T00:00:00.123Z', '2026-09-19t08:35:00z', '2026-09-19T08:35:00+00:00', '2016-12-31T23:59:60Z']) change('SaveSettingsResponse', 'last_updated', value, true);
for (const path of ['http://example.com', 'javascript:alert(1)', 'file:///x', 'data:text/plain,x', 'https://', 'https://a\nb', 'https://a\\b', 'https://a b', 'https://example.com/\u0085', 'https://example.com/\uFEFF']) add(`URL rejected ${JSON.stringify(path)}`, 'MaterialItem', { ...material, target_type: 'url', path }, false);
for (const path of ['https://example.com/a?q=1', 'HTTPS://example.com', 'https://例え.jp/資料']) add(`URL allowed ${path}`, 'MaterialItem', { ...material, target_type: 'url', path }, true);
change('MaterialItem', 'window_match_pattern', '😀'.repeat(128), true);
change('MaterialItem', 'window_match_pattern', 'a'.repeat(129), false);
add('empty hint normalized', 'MaterialItem', { ...material, window_match_pattern: '' }, true, material);
for (const schema of [1, 2, 4, 0xffffffff]) add(`schema discriminator ${schema}`, 'ConfigDocument', { schema_version: schema, future: { incompatible: true } }, true);
add('schema 3 strict', 'ConfigDocument', { ...config, future: true }, false);
add('schema 3 valid', 'ConfigDocument', config, true);
for (const schema of [null, '4', -1, 0x100000000]) add(`invalid schema ${schema}`, 'ConfigDocument', { schema_version: schema }, false);
add('schema 4 not AppConfig', 'AppConfig', { ...config, schema_version: 4 }, false);
add('nested unknown', 'AppConfig', { ...config, groups: [{ ...group, extra: true }] }, false);
add('nested positional struct rejected', 'AppConfig', { ...config, groups: [['g1', null, '会議', 1]] }, false);
add('nested missing null', 'AppConfig', { ...config, materials: [{ ...material, window_match_pattern: undefined }] }, false);
writeFileSync(new URL('./fixtures/contracts.json', import.meta.url), JSON.stringify({ seed: 'meetdock-contract-v1', fixtures }, null, 2) + '\n');
