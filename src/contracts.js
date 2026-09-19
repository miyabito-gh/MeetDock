// IPC_CONTRACT.md. No I/O: the same boundary is used by the adapter and model.
export const MAX_SAFE = Number.MAX_SAFE_INTEGER;
export const enums = Object.freeze({
  role: ['main', 'reference'], target_type: ['file', 'folder', 'url'],
  mode: ['ready', 'migration_required', 'recovery_required', 'read_only_future_schema', 'read_only_unavailable'],
  kind: ['backup', 'legacy', 'temporary'],
  action: ['restore_candidate', 'import_legacy', 'initialize_empty', 'open_read_only'],
  open_state: ['open', 'not_detected', 'unknown', 'not_trackable'],
  confidence: ['exact', 'estimated', 'unknown'],
  path_state: ['exists', 'missing', 'timeout', 'access_denied', 'unchecked', 'error'],
  outcome: ['activated', 'launched', 'not_trackable', 'foreground_denied', 'not_found', 'failed'],
});
Object.values(enums).forEach(Object.freeze);
export const errorCodes = Object.freeze([
  'INVALID_REQUEST', 'VALIDATION_ERROR', 'CONFIG_CONFLICT', 'CONFIG_CORRUPT', 'CONFIG_IO',
  'READ_ONLY_SCHEMA', 'NOT_FOUND', 'ACCESS_DENIED', 'PATH_TIMEOUT', 'PATH_QUEUE_BUSY',
  'UNSUPPORTED_TARGET', 'WINDOW_NOT_FOUND', 'FOREGROUND_DENIED', 'LAUNCH_FAILED',
  'PDF_RANGE_INVALID', 'PDF_NOT_ALLOWED', 'PDF_NOT_READABLE', 'PDF_PASSWORD_REQUIRED',
  'PDF_CORRUPT', 'PDF_FALLBACK_TOO_LARGE', 'INTERNAL_ERROR',
]);
const retryable = new Set(['CONFIG_IO', 'PATH_TIMEOUT', 'PATH_QUEUE_BUSY', 'WINDOW_NOT_FOUND', 'LAUNCH_FAILED']);
export function appError(code, material_id = null) {
  if (!errorCodes.includes(code)) throw new TypeError('Unknown error code');
  return { code, message: '操作を完了できませんでした。', material_id, retryable: retryable.has(code) };
}
function requireValue(ok) { if (!ok) throw new TypeError('Contract validation failed'); }
const string = v => requireValue(typeof v === 'string');
const bool = v => requireValue(typeof v === 'boolean');
const integer = max => v => requireValue(Number.isSafeInteger(v) && v >= 0 && v <= max);
const safe = integer(MAX_SAFE), u32 = integer(0xffffffff);
export const id = v => requireValue(typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v));
export const uuid = v => requireValue(typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v));
const member = values => v => requireValue(values.includes(v));
const nullable = check => v => { if (v !== null) check(v); };
const array = check => v => { requireValue(Array.isArray(v)); v.forEach(check); };
function object(v, fields) {
  requireValue(v !== null && typeof v === 'object' && !Array.isArray(v));
  requireValue(Object.keys(v).length === Object.keys(fields).length);
  for (const [key, check] of Object.entries(fields)) {
    requireValue(Object.hasOwn(v, key)); check(v[key]);
  }
}
export function timestamp(v) {
  string(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|\+00:00)$/.exec(v);
  requireValue(m);
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  requireValue(mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1] && h < 24 && mi < 60 &&
    (s < 60 || (s === 60 && h === 23 && mi === 59 && [6, 12].includes(mo) && d === days[mo - 1])));
}
function material(v) {
  object(v, { id, group_id: id, name: string, role: member(enums.role), target_type: member(enums.target_type),
    path: string, window_match_pattern: nullable(string), order: u32 });
  requireValue(nonblank(v.name) && v.order > 0);
  requireValue(v.window_match_pattern === null || [...v.window_match_pattern].length <= 128);
  requireValue(!/[\x00-\x1f\x7f]/.test(v.path));
  if (v.target_type === 'url') {
    requireValue(/^https:\/\//i.test(v.path) && !/[\p{White_Space}\uFEFF\\]/u.test(v.path));
    let url; try { url = new URL(v.path); } catch { requireValue(false); }
    requireValue(url.protocol === 'https:' && url.hostname.length > 0);
  } else requireValue(windowsAbsolutePath(v.path));
}
const nonblank = s => /[^\p{White_Space}\uFEFF]/u.test(s);
function windowsAbsolutePath(path) {
  let p = path.replaceAll('/', '\\');
  const extended = p.startsWith('\\\\?\\');
  if (extended) p = p.slice(4);
  const unc = extended ? p.startsWith('UNC\\') : p.startsWith('\\\\');
  let tail;
  if (unc) {
    tail = p.slice(extended ? 4 : 2);
    const parts = tail.split('\\');
    if (parts.length < 2 || !parts[0] || !parts[1]) return false;
  } else {
    if (!/^[A-Za-z]:\\/.test(p)) return false;
    tail = p.slice(3);
  }
  if (tail.endsWith('\\')) tail = tail.slice(0, -1);
  return !tail || tail.split('\\').every(c => c && c !== '.' && c !== '..' &&
    !/[. ]$/.test(c) && !/[\x00-\x1f\x7f<>:"|?*]/.test(c) &&
    !/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(c.split('.')[0]));
}
const group = v => {
  object(v, { id, parent_id: nullable(id), name: string, order: u32 });
  requireValue(nonblank(v.name) && v.order > 0 && v.parent_id !== v.id);
};
function config(v) {
  object(v, { schema_version: member([3]), app_version: string, revision: safe,
    last_updated: timestamp, groups: array(group), materials: array(material) });
  const groups = new Map(), materials = new Set(), orders = new Map();
  const addOrder = (scope, order) => { const key = JSON.stringify(scope); if (!orders.has(key)) orders.set(key, []); orders.get(key).push(order); };
  for (const g of v.groups) {
    requireValue(!groups.has(g.id)); groups.set(g.id, g.parent_id);
    addOrder([g.parent_id, null], g.order);
  }
  const complete = new Set();
  for (const start of groups.keys()) {
    const chain = new Set(); let current = start;
    while (current !== null && !complete.has(current)) {
      requireValue(groups.has(current) && !chain.has(current)); chain.add(current); current = groups.get(current);
    }
    for (const id of chain) complete.add(id);
  }
  for (const m of v.materials) {
    requireValue(!materials.has(m.id) && groups.has(m.group_id)); materials.add(m.id);
    addOrder([m.group_id, m.role], m.order);
  }
  for (const values of orders.values()) requireValue(values.sort((a, b) => a - b).every((order, i) => order === i + 1));
}
const candidate = v => object(v, { candidate_id: id, kind: member(enums.kind), revision: nullable(safe), last_updated: nullable(timestamp) });
function settings(v) {
  object(v, { mode: member(enums.mode), config: nullable(config), source_schema_version: nullable(u32),
    candidates: array(candidate), notice_code: nullable(string) });
  if (v.mode === 'ready') requireValue(v.config !== null);
  if (['read_only_future_schema', 'read_only_unavailable'].includes(v.mode)) requireValue(v.config === null);
  if (v.mode === 'read_only_future_schema') requireValue(v.source_schema_version > 3);
}
function error(v) {
  object(v, { code: member(errorCodes), message: string, material_id: nullable(id), retryable: bool });
  requireValue(v.retryable === retryable.has(v.code));
}
const status = v => object(v, { material_id: id, open_state: member(enums.open_state), confidence: member(enums.confidence),
  path_state: member(enums.path_state), detail: nullable(string) });
function launch(v) {
  object(v, { material_id: id, outcome: member(enums.outcome), error: nullable(error) });
  requireValue(['activated', 'launched', 'not_trackable'].includes(v.outcome) === (v.error === null));
}
const empty = v => object(v, {});
export const validators = Object.freeze({
  AppConfig: config, GroupItem: group, MaterialItem: material, SettingsCandidate: candidate,
  SettingsLoadResponse: settings, AppError: error, MaterialStatusResult: status, LaunchResponse: launch,
  LoadSettingsRequest: empty, EmptyResponse: empty,
  ResolveSettingsIssueRequest(v) {
    object(v, { action: member(enums.action), candidate_id: nullable(id) });
    requireValue(['restore_candidate', 'import_legacy'].includes(v.action) === (v.candidate_id !== null));
  },
  SaveSettingsRequest(v) {
    object(v, { config, expected_revision: safe });
    requireValue(v.config.revision === v.expected_revision && v.expected_revision < MAX_SAFE);
  },
  SaveSettingsResponse: v => object(v, { revision: safe, last_updated: timestamp }),
  SyncStatusesRequest: v => object(v, { material_ids: array(id), request_id: uuid }),
  SyncStatusesResponse: v => object(v, { request_id: uuid, results: array(status) }),
  ActivateOrLaunchRequest: v => object(v, { material_id: id }),
  OpenContainingFolderRequest: v => object(v, { material_id: id }),
  BatchLaunchRequest: v => object(v, { group_id: id }),
  BatchLaunchResponse: v => object(v, { results: array(launch) }),
  PrepareDroppedFilesRequest: v => { object(v, { paths: array(string) }); requireValue(v.paths.length > 0 && v.paths.length <= 100 && v.paths.every(path => path.length > 0 && path.length <= 32767)); },
  DroppedFileCandidate: v => object(v, { name: string, path: string }),
  PrepareDroppedFilesResponse: v => object(v, { candidates: array(x => object(x, { name: string, path: string })) }),
});
export function validate(type, value) {
  requireValue(Object.hasOwn(validators, type)); validators[type](value);
  const copy = structuredClone(value);
  const cfg = type === 'AppConfig' ? copy : copy.config;
  for (const m of cfg?.materials ?? []) if (m.window_match_pattern === '') m.window_match_pattern = null;
  if (type === 'MaterialItem' && copy.window_match_pattern === '') copy.window_match_pattern = null;
  return copy;
}
// Schema discrimination precedes strict schema-3 decoding. Never expose a partial future config.
export function decodeConfig(value) {
  u32(value?.schema_version);
  if (value.schema_version !== 3) return {
    mode: value.schema_version > 3 ? 'read_only_future_schema' : 'read_only_unavailable',
    config: null, source_schema_version: value.schema_version, candidates: [], notice_code: 'READ_ONLY_SCHEMA',
  };
  return { mode: 'ready', config: validate('AppConfig', value), source_schema_version: 3, candidates: [], notice_code: null };
}
