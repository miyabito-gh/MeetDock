import { validate, uuid, appError, MAX_SAFE } from './contracts.js';

const enumeration = names => Object.freeze(Object.fromEntries(names.split(' ').map(n => [n, n])));
export const Lifecycle = enumeration('Booting Ready ReadOnly RecoveryPending MigrationPending FatalError');
export const Edit = enumeration('Clean Dirty Saving Conflict');
export const Pdf = enumeration('Closed Loading Viewing PasswordRequired Failed');
export const Event = enumeration('Started CloseRequested EffectFailed SettingsLoaded FutureSchemaFound LegacySettingsFound CorruptSettingsFound SettingsUnavailable SettingsLoadFailed MigrationApproved MigrationRejected RestoreSelected InitializeSelected ReadOnlySelected ResolutionFailed EditRequested DraftChanged GroupAdded GroupRenamed GroupDeleted GroupReordered MaterialAdded MaterialUpdated MaterialDeleted MaterialReordered NativeFilesDropped DroppedFilesPrepared DroppedFilesPrepareFailed DroppedFilesConfirmed DroppedFilesCancelled SaveRequested SaveSucceeded SaveConflict SaveFailed EditDiscarded ReloadRequested GroupSelected SyncRequested SyncSucceeded SyncFailed ActivateRequested OpenContainingFolderRequested OpenContainingFolderCompleted LaunchSucceeded LaunchFailed ForegroundDenied BatchLaunchRequested BatchLaunchCancelRequested BatchLaunchCompleted BatchLaunchCancelled PdfOpenRequested PdfDocumentPreviousRequested PdfDocumentNextRequested PdfReady PdfViewChanged PdfPasswordRequired PdfFailed PdfOpenExternalRequested PdfClosed PdfPreviousRequested PdfNextRequested PdfPageRequested PdfZoomInRequested PdfZoomOutRequested PdfFitRequested PdfMaximizeToggled FatalError SearchChanged ResizeChanged SidebarToggled SidebarWidthChanged PdfWidthChanged GenerationResetRequested');
export const Effect = enumeration('LoadSettings ResolveSettings SaveSettings SyncStatuses Activate OpenContainingFolder PrepareDroppedFiles BatchLaunch CancelBatch ReplacePdf ClosePdf PdfPrevious PdfNext PdfGoToPage PdfZoomIn PdfZoomOut PdfFit CloseWindow');

export function initialState() {
  return { lifecycle: Lifecycle.Booting, edit: Edit.Clean, sync: { kind: 'Idle' },
    launch: { running: [], batch: null }, pdf: { kind: Pdf.Closed },
    config_revision: 0, state_generation: 0, saved_config: null, draft: null,
    candidates: [], resolution: null, saving: null, selected_group_id: null,
    statuses: [], last_sync_at: null, launch_results: [], query: '', width: null,
    dropped_files: null, layout: { sidebar_collapsed: false, sidebar_width: 250, pdf_width: 430, pdf_maximized: false } };
}
const valid = (type, value) => { try { return validate(type, value); } catch { return null; } };
const material = (s, id) => s.saved_config?.materials.find(m => m.id === id);
const group = (s, id) => s.saved_config?.groups.some(g => g.id === id);
const pdfMaterials = s => {
  const config = s.saved_config, query = String(s.query ?? '').trim().toLocaleLowerCase('ja');
  const names = new Map((config?.groups ?? []).map(g => [g.id, g.name]));
  return (config?.materials ?? []).filter(m => m.target_type === 'file' && /\.pdf$/i.test(m.path) &&
    (query ? `${m.name} ${names.get(m.group_id) ?? ''}`.toLocaleLowerCase('ja').includes(query) : m.group_id === s.selected_group_id))
    .sort((a, b) => (a.role === b.role ? a.order - b.order : a.role === 'main' ? -1 : 1));
};
const editable = s => s.lifecycle === Lifecycle.Ready && !s.resolution;
const busy = s => s.edit === Edit.Saving || s.sync.kind === 'Running' || s.launch.running.length || s.launch.batch || s.pdf.kind === Pdf.Loading || s.resolution;
const editableConfig = s => structuredClone(s.draft ?? s.saved_config);
const reorder = (items, key) => {
  const buckets = new Map();
  for (const item of items) { const k = key(item); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(item); }
  for (const bucket of buckets.values()) bucket.sort((a, b) => a.order - b.order).forEach((item, index) => { item.order = index + 1; });
};
const dirtyWith = (s, config) => ({ ...s, edit: s.edit === Edit.Conflict ? Edit.Conflict : Edit.Dirty, draft: config });

/** Pure transition; guard failures retain the identical state and produce no effects.
 * `notice` is an ephemeral RenderModel value, never persisted or an effect.
 */
export function transition(s, e) {
  const result = (state = s, effects = [], notice = null, diagnostic = null) => ({ handled: true, state, effects, notice, diagnostic });
  const deny = () => result();
  const effect = (type, request, extra = {}) => ({ type, request, generation: s.state_generation, ...extra });
  const bump = () => s.state_generation < MAX_SAFE ? s.state_generation + 1 : null;
  if (!Object.hasOwn(Event, e.type) || ['CloseRequested'].includes(e.type)) return { ...result(), handled: false };
  if (e.type === Event.FatalError) return result({ ...s, lifecycle: Lifecycle.FatalError }, [], appError('INTERNAL_ERROR'));
  if (s.lifecycle === Lifecycle.FatalError) return deny();
  if (s.lifecycle === Lifecycle.ReadOnly && [Event.SaveRequested, Event.ActivateRequested, Event.BatchLaunchRequested].includes(e.type))
    return result(s, [], appError('READ_ONLY_SCHEMA'));
  switch (e.type) {
    case Event.EffectFailed:
      return result(s, [], e.generation === s.state_generation ? e.error : null);
    case Event.Started:
      if (s.lifecycle !== Lifecycle.Booting || s.resolution) return deny();
      return result({ ...s, resolution: 'load' }, [effect(Effect.LoadSettings, {})]);
    case Event.SettingsLoaded: {
      if (s.lifecycle !== Lifecycle.Booting && !s.resolution) return deny();
      const config = valid('AppConfig', e.config), generation = bump();
      if (!config || generation === null) return deny();
      return result({ ...s, lifecycle: Lifecycle.Ready, edit: Edit.Clean, resolution: null, saving: null,
        saved_config: config, draft: null, config_revision: config.revision, state_generation: generation,
        candidates: [], statuses: [], selected_group_id: config.groups[0]?.id ?? null });
    }
    case Event.FutureSchemaFound:
    case Event.LegacySettingsFound:
    case Event.CorruptSettingsFound:
    case Event.SettingsUnavailable: {
      if (s.lifecycle !== Lifecycle.Booting && !s.resolution) return deny();
      const response = valid('SettingsLoadResponse', e.response);
      const expected = { FutureSchemaFound: 'read_only_future_schema', LegacySettingsFound: 'migration_required',
        CorruptSettingsFound: 'recovery_required', SettingsUnavailable: 'read_only_unavailable' }[e.type];
      if (!response || response.mode !== expected || (e.type === Event.LegacySettingsFound && !response.candidates.some(c => c.kind === 'legacy'))) return deny();
      const lifecycle = { FutureSchemaFound: Lifecycle.ReadOnly, LegacySettingsFound: Lifecycle.MigrationPending,
        CorruptSettingsFound: Lifecycle.RecoveryPending, SettingsUnavailable: Lifecycle.ReadOnly }[e.type];
      return result({ ...s, lifecycle, resolution: null, saved_config: null, candidates: response.candidates });
    }
    case Event.SettingsLoadFailed:
      if (s.lifecycle !== Lifecycle.Booting || !s.resolution) return deny();
      return result({ ...s, lifecycle: Lifecycle.RecoveryPending, resolution: null }, [], e.error);
    case Event.MigrationApproved:
    case Event.RestoreSelected:
    case Event.InitializeSelected: {
      const migration = e.type === Event.MigrationApproved, initialize = e.type === Event.InitializeSelected;
      if (s.lifecycle !== (migration ? Lifecycle.MigrationPending : Lifecycle.RecoveryPending) || s.resolution) return deny();
      if (initialize ? e.confirmed !== true : !s.candidates.some(c => c.candidate_id === e.candidate_id && (migration ? c.kind === 'legacy' : c.kind !== 'legacy'))) return deny();
      const request = { action: migration ? 'import_legacy' : initialize ? 'initialize_empty' : 'restore_candidate', candidate_id: initialize ? null : e.candidate_id };
      return result({ ...s, lifecycle: migration ? Lifecycle.Ready : Lifecycle.Booting, resolution: migration ? 'migration' : 'recovery' }, [effect(Effect.ResolveSettings, request)]);
    }
    case Event.MigrationRejected:
    case Event.ReadOnlySelected:
      if (s.lifecycle !== (e.type === Event.MigrationRejected ? Lifecycle.MigrationPending : Lifecycle.RecoveryPending)) return deny();
      return result({ ...s, lifecycle: Lifecycle.ReadOnly });
    case Event.ResolutionFailed:
      if (!['migration', 'recovery'].includes(s.resolution)) return deny();
      return result({ ...s, lifecycle: s.resolution === 'migration' ? Lifecycle.MigrationPending : Lifecycle.RecoveryPending, resolution: null }, [], e.error);
    case Event.EditRequested:
      if (!editable(s) || s.edit !== Edit.Clean || !s.saved_config) return deny();
      return result({ ...s, edit: Edit.Dirty, draft: structuredClone(s.saved_config) });
    case Event.DraftChanged:
      if (!editable(s) || ![Edit.Dirty, Edit.Conflict].includes(s.edit)) return deny();
      // Keep incomplete user input; SaveRequested alone validates the draft.
      return result({ ...s, draft: structuredClone(e.config) });
    case Event.GroupAdded: {
      if (!editable(s) || !s.saved_config || typeof e.group?.name !== 'string' || !e.group.name.trim()) return deny();
      const config = editableConfig(s);
      if (config.groups.some(g => g.id === e.group.id) || (e.group.parent_id !== null && !config.groups.some(g => g.id === e.group.parent_id))) return deny();
      config.groups.push({ id: e.group.id, parent_id: e.group.parent_id, name: e.group.name, order: Number.MAX_SAFE_INTEGER });
      reorder(config.groups, g => g.parent_id ?? 'root');
      return result({ ...dirtyWith(s, config), selected_group_id: e.group.id });
    }
    case Event.GroupRenamed: {
      if (!editable(s) || typeof e.name !== 'string' || !e.name.trim()) return deny();
      const config = editableConfig(s), item = config?.groups.find(g => g.id === e.group_id); if (!item) return deny();
      item.name = e.name; return result(dirtyWith(s, config));
    }
    case Event.GroupDeleted: {
      if (!editable(s) || e.confirmed !== true) return deny();
      const config = editableConfig(s), item = config?.groups.find(g => g.id === e.group_id);
      if (!item || config.groups.some(g => g.parent_id === item.id) || config.materials.some(m => m.group_id === item.id)) return result(s, [], appError('VALIDATION_ERROR'));
      config.groups = config.groups.filter(g => g.id !== item.id); reorder(config.groups, g => g.parent_id ?? 'root');
      return result({ ...dirtyWith(s, config), selected_group_id: item.parent_id ?? config.groups[0]?.id ?? null });
    }
    case Event.GroupReordered: {
      if (!editable(s) || e.group_id === e.before_group_id) return deny();
      const config = editableConfig(s), moving = config?.groups.find(g => g.id === e.group_id), before = config?.groups.find(g => g.id === e.before_group_id);
      if (!moving || !before || moving.parent_id !== before.parent_id) return deny();
      const siblings = config.groups.filter(g => g.parent_id === moving.parent_id && g.id !== moving.id).sort((a,b)=>a.order-b.order), index = siblings.findIndex(g=>g.id===before.id);
      siblings.splice(index,0,moving);siblings.forEach((g,i)=>{g.order=i+1});return result(dirtyWith(s,config));
    }
    case Event.MaterialAdded: {
      if (!editable(s) || !e.material) return deny();
      const config = editableConfig(s); if (!config.groups.some(g => g.id === e.material.group_id) || config.materials.some(m => m.id === e.material.id)) return deny();
      config.materials.push({ ...structuredClone(e.material), order: Number.MAX_SAFE_INTEGER, window_match_pattern: e.material.window_match_pattern ?? null });
      reorder(config.materials, m => `${m.group_id}\0${m.role}`); return result(dirtyWith(s, config));
    }
    case Event.MaterialUpdated: {
      if (!editable(s) || !e.material) return deny();
      const config = editableConfig(s), index = config?.materials.findIndex(m => m.id === e.material.id);
      if (index < 0 || !config.groups.some(g => g.id === e.material.group_id)) return deny();
      config.materials[index] = { ...structuredClone(e.material), order: config.materials[index].order, window_match_pattern: e.material.window_match_pattern ?? null };
      reorder(config.materials, m => `${m.group_id}\0${m.role}`); return result(dirtyWith(s, config));
    }
    case Event.MaterialDeleted: {
      if (!editable(s) || e.confirmed !== true) return deny();
      const config = editableConfig(s); if (!config?.materials.some(m => m.id === e.material_id)) return deny();
      config.materials = config.materials.filter(m => m.id !== e.material_id); reorder(config.materials, m => `${m.group_id}\0${m.role}`);
      return result(dirtyWith(s, config));
    }
    case Event.MaterialReordered: {
      if (!editable(s) || e.material_id === e.before_material_id) return deny();
      const config=editableConfig(s),moving=config?.materials.find(m=>m.id===e.material_id),before=config?.materials.find(m=>m.id===e.before_material_id);
      if(!moving||!before||moving.group_id!==before.group_id||moving.role!==before.role)return deny();
      const peers=config.materials.filter(m=>m.group_id===moving.group_id&&m.role===moving.role&&m.id!==moving.id).sort((a,b)=>a.order-b.order),index=peers.findIndex(m=>m.id===before.id);
      peers.splice(index,0,moving);peers.forEach((m,i)=>{m.order=i+1});return result(dirtyWith(s,config));
    }
    case Event.NativeFilesDropped: {
      if (!editable(s) || !editableConfig(s)?.groups.some(g => g.id === e.group_id) || !Array.isArray(e.paths) || !e.paths.length || s.dropped_files) return deny();
      return result(s, [effect(Effect.PrepareDroppedFiles, { paths: structuredClone(e.paths) }, { group_id: e.group_id })]);
    }
    case Event.DroppedFilesPrepared:
      if (!editable(s) || !editableConfig(s)?.groups.some(g => g.id === e.group_id) || !e.response?.candidates?.length) return deny();
      return result({ ...s, dropped_files: { group_id: e.group_id, candidates: structuredClone(e.response.candidates) } });
    case Event.DroppedFilesPrepareFailed:
      return result(s, [], e.error);
    case Event.DroppedFilesCancelled:
      return s.dropped_files ? result({ ...s, dropped_files: null }) : deny();
    case Event.DroppedFilesConfirmed: {
      if (!editable(s) || !s.dropped_files || !editableConfig(s)?.groups.some(g => g.id === e.group_id) || !['main', 'reference'].includes(e.role)) return deny();
      const config = editableConfig(s);
      for (const entry of s.dropped_files.candidates) config.materials.push({ id: crypto.randomUUID(), group_id: e.group_id, name: entry.name, role: e.role, target_type: 'file', path: entry.path, order: Number.MAX_SAFE_INTEGER, window_match_pattern: null });
      reorder(config.materials, m => `${m.group_id}\0${m.role}`); return result({ ...dirtyWith(s, config), dropped_files: null, selected_group_id: e.group_id });
    }
    case Event.SaveRequested: {
      if (!editable(s) || ![Edit.Dirty, Edit.Conflict].includes(s.edit)) return deny();
      const request = valid('SaveSettingsRequest', { config: s.draft, expected_revision: s.config_revision });
      if (!request) return result(s, [], appError('VALIDATION_ERROR'));
      return result({ ...s, edit: Edit.Saving, saving: { generation: s.state_generation, config: request.config } }, [effect(Effect.SaveSettings, request)]);
    }
    case Event.SaveSucceeded: {
      if (s.edit !== Edit.Saving || e.generation !== s.saving?.generation) return deny();
      const response = valid('SaveSettingsResponse', e.response);
      if (!response || response.revision !== s.config_revision + 1) return deny();
      const saved = { ...s.saving.config, ...response }, current = e.generation === s.state_generation;
      // A committed save remains a fact even after a screen switch. Release the
      // operation, rebase the retained draft, and suppress the stale success notice.
      return result({ ...s, edit: current ? Edit.Clean : Edit.Dirty, saving: null,
        saved_config: saved, draft: current ? null : { ...s.draft, ...response }, config_revision: response.revision }, [], current ? 'saved' : null);
    }
    case Event.SaveConflict:
    case Event.SaveFailed:
      if (s.edit !== Edit.Saving || e.generation !== s.saving?.generation) return deny();
      return result({ ...s, edit: e.type === Event.SaveConflict ? Edit.Conflict : Edit.Dirty, saving: null }, [], e.generation === s.state_generation ? e.error : null);
    case Event.EditDiscarded: {
      const generation = bump();
      if (![Edit.Dirty, Edit.Conflict].includes(s.edit) || e.confirmed !== true || generation === null) return deny();
      return result({ ...s, edit: Edit.Clean, draft: null, state_generation: generation, pdf: { kind: Pdf.Closed } },
        s.pdf.kind === Pdf.Closed ? [] : [effect(Effect.ClosePdf, {})]);
    }
    case Event.ReloadRequested: {
      const generation = bump();
      if (busy(s) || generation === null || (![Edit.Clean].includes(s.edit) && e.confirmed !== true)) return deny();
      return result({ ...s, lifecycle: Lifecycle.Booting, edit: Edit.Clean, draft: null, state_generation: generation, resolution: 'load', pdf: { kind: Pdf.Closed } },
        [effect(Effect.ClosePdf, {}), effect(Effect.LoadSettings, {}, { generation })]);
    }
    case Event.GroupSelected: {
      const generation = bump();
      if (!group(s, e.group_id) || e.group_id === s.selected_group_id || generation === null) return deny();
      return result({ ...s, selected_group_id: e.group_id, state_generation: generation, pdf: { kind: Pdf.Closed } },
        s.pdf.kind === Pdf.Closed ? [] : [effect(Effect.ClosePdf, {})]);
    }
    case Event.SyncRequested: {
      if (![Lifecycle.Ready, Lifecycle.ReadOnly].includes(s.lifecycle) || s.resolution) return deny();
      if (s.sync.kind === 'Running' && !(e.manual === true || e.new_auto === true)) return deny();
      try { uuid(e.request_id); } catch { return deny(); }
      if (s.sync.request_id === e.request_id) return deny();
      const request = { material_ids: s.saved_config?.materials.map(m => m.id) ?? [], request_id: e.request_id };
      return result({ ...s, sync: { kind: 'Running', request_id: e.request_id } }, [effect(Effect.SyncStatuses, request)]);
    }
    case Event.SyncSucceeded:
    case Event.SyncFailed:
      if (s.sync.kind !== 'Running' || e.request_id !== s.sync.request_id) return result(s, [], null, 'stale_sync');
      if (e.type === Event.SyncSucceeded && !valid('SyncStatusesResponse', { request_id: e.request_id, results: e.results })) return deny();
      return result({ ...s, sync: { kind: 'Idle' }, statuses: e.type === Event.SyncSucceeded ? structuredClone(e.results) : s.statuses,
        last_sync_at: e.type === Event.SyncSucceeded && Number.isFinite(e.completed_at) ? e.completed_at : s.last_sync_at }, [], e.type === Event.SyncFailed ? e.error : null);
    case Event.ActivateRequested:
      if (!editable(s) || !material(s, e.material_id) || s.launch.running.some(x => x.material_id === e.material_id) || s.launch.batch?.material_ids.includes(e.material_id)) return deny();
      return result({ ...s, launch: { ...s.launch, running: [...s.launch.running, { material_id: e.material_id, generation: s.state_generation }] } },
        [effect(Effect.Activate, { material_id: e.material_id })]);
    case Event.OpenContainingFolderRequested:
      if (!editable(s) || !material(s, e.material_id)) return deny();
      return result(s, [effect(Effect.OpenContainingFolder, { material_id: e.material_id })]);
    case Event.OpenContainingFolderCompleted:
      return result(s, [], e.error ?? null);
    case Event.LaunchSucceeded:
    case Event.LaunchFailed:
    case Event.ForegroundDenied: {
      const running = s.launch.running.find(x => x.material_id === e.material_id);
      if (!running || running.generation !== e.generation) return deny();
      const response = e.response ? valid('LaunchResponse', e.response) : null;
      if (e.response && (!response || response.material_id !== e.material_id)) return deny();
      return result({ ...s, launch: { ...s.launch, running: s.launch.running.filter(x => x !== running) },
        launch_results: response ? [response] : [] }, [], e.generation === s.state_generation ? (response ?? e.error) : null);
    }
    case Event.BatchLaunchRequested: {
      if (!editable(s) || !group(s, e.group_id) || s.launch.batch) return deny();
      const ids = s.saved_config.materials.filter(m => m.group_id === e.group_id && m.role === 'main').map(m => m.id);
      if (s.launch.running.some(x => ids.includes(x.material_id))) return deny();
      return result({ ...s, launch: { ...s.launch, batch: { group_id: e.group_id, material_ids: ids, generation: s.state_generation } } }, [effect(Effect.BatchLaunch, { group_id: e.group_id, material_ids: ids })]);
    }
    case Event.BatchLaunchCancelRequested:
      if (!s.launch.batch || s.launch.batch.group_id !== e.group_id) return deny();
      return result(s, [effect(Effect.CancelBatch, { group_id: e.group_id })]);
    case Event.BatchLaunchCompleted:
    case Event.BatchLaunchCancelled:
      if (!s.launch.batch || s.launch.batch.group_id !== e.group_id || s.launch.batch.generation !== e.generation) return deny();
      if (e.response && !valid('BatchLaunchResponse', e.response)) return deny();
      return result({ ...s, launch: { ...s.launch, batch: null }, launch_results: structuredClone(e.response?.results ?? []) }, [],
        e.generation === s.state_generation ? (e.error ?? e.response ?? null) : null);
    case Event.PdfOpenRequested: {
      const m = material(s, e.material_id), generation = bump();
      if (!m || m.target_type !== 'file' || !/\.pdf$/i.test(m.path) || generation === null ||
        (s.pdf.material_id === m.id && [Pdf.Loading, Pdf.Viewing].includes(s.pdf.kind))) return deny();
      return result({ ...s, state_generation: generation, pdf: { kind: Pdf.Loading, material_id: m.id, generation } },
        [effect(Effect.ReplacePdf, { material_id: m.id, url: `material://pdf/${m.id}`, generation }, { generation })]);
    }
    case Event.PdfDocumentPreviousRequested:
    case Event.PdfDocumentNextRequested: {
      if (s.pdf.kind === Pdf.Closed) return deny();
      const candidates = pdfMaterials(s), index = candidates.findIndex(m => m.id === s.pdf.material_id);
      const offset = e.type === Event.PdfDocumentPreviousRequested ? -1 : 1, next = candidates[index + offset];
      if (index < 0 || !next) return deny();
      return transition(s, { type: Event.PdfOpenRequested, material_id: next.id });
    }
    case Event.PdfReady:
    case Event.PdfViewChanged:
    case Event.PdfPasswordRequired:
    case Event.PdfFailed:
      if (e.generation !== s.state_generation || e.generation !== s.pdf.generation || e.material_id !== s.pdf.material_id) return result(s, [], null, 'stale_pdf');
      if (e.type === Event.PdfViewChanged) {
        if (s.pdf.kind !== Pdf.Viewing || !Number.isSafeInteger(e.view?.current_page) || !Number.isSafeInteger(e.view?.total_pages) ||
          !Number.isSafeInteger(e.view?.zoom_percent) || e.view.current_page < 1 || e.view.current_page > e.view.total_pages || e.view.zoom_percent < 1) return deny();
        return result({ ...s, pdf: { ...s.pdf, ...e.view } });
      }
      if (!(s.pdf.kind === Pdf.Loading || (e.type === Event.PdfFailed && s.pdf.kind === Pdf.Viewing))) return deny();
      if (e.type === Event.PdfReady && (!Number.isSafeInteger(e.view?.current_page) || !Number.isSafeInteger(e.view?.total_pages) ||
        !Number.isSafeInteger(e.view?.zoom_percent) || e.view.current_page < 1 || e.view.current_page > e.view.total_pages || e.view.zoom_percent < 1)) return deny();
      return result({ ...s, pdf: e.type === Event.PdfReady
        ? { ...s.pdf, kind: Pdf.Viewing, ...e.view }
        : { kind: e.type === Event.PdfPasswordRequired ? Pdf.PasswordRequired : Pdf.Failed, material_id: s.pdf.material_id,
          generation: s.pdf.generation, ...(e.type === Event.PdfFailed ? { code: e.error.code } : {}) } }, [], e.error ?? null);
    case Event.PdfClosed: {
      const generation = bump();
      if (s.pdf.kind === Pdf.Closed || generation === null) return deny();
      return result({ ...s, state_generation: generation, pdf: { kind: Pdf.Closed } }, [effect(Effect.ClosePdf, {})]);
    }
    case Event.PdfOpenExternalRequested:
      if (s.pdf.kind !== Pdf.Failed || !['PDF_FALLBACK_TOO_LARGE', 'PDF_NOT_READABLE', 'PDF_CORRUPT'].includes(s.pdf.code) || !material(s, s.pdf.material_id)) return deny();
      return result({ ...s, launch: { ...s.launch, running: [...s.launch.running, { material_id: s.pdf.material_id, generation: s.state_generation }] } },
        [effect(Effect.Activate, { material_id: s.pdf.material_id })]);
    case Event.PdfPreviousRequested:
    case Event.PdfNextRequested:
    case Event.PdfPageRequested:
    case Event.PdfZoomInRequested:
    case Event.PdfZoomOutRequested:
    case Event.PdfFitRequested: {
      if (s.pdf.kind !== Pdf.Viewing) return deny();
      if (e.type === Event.PdfPageRequested && (!Number.isSafeInteger(e.page) || e.page < 1 || e.page > s.pdf.total_pages)) return deny();
      const type = { PdfPreviousRequested: Effect.PdfPrevious, PdfNextRequested: Effect.PdfNext, PdfPageRequested: Effect.PdfGoToPage, PdfZoomInRequested: Effect.PdfZoomIn, PdfZoomOutRequested: Effect.PdfZoomOut, PdfFitRequested: Effect.PdfFit }[e.type];
      return result(s, [effect(type, { material_id: s.pdf.material_id, generation: s.pdf.generation, viewport_width: e.viewport_width ?? null, page: e.page ?? null })]);
    }
    case Event.PdfMaximizeToggled:
      if (s.pdf.kind === Pdf.Closed) return deny();
      return result({ ...s, layout: { ...s.layout, pdf_maximized: !s.layout.pdf_maximized } });
    case Event.SearchChanged:
      return typeof e.value === 'string' ? result({ ...s, query: e.value }) : deny();
    case Event.ResizeChanged:
      return Number.isFinite(e.value) && e.value >= 0 ? result({ ...s, width: e.value }) : deny();
    case Event.SidebarToggled:
      return result({ ...s, layout: { ...s.layout, sidebar_collapsed: !s.layout.sidebar_collapsed } });
    case Event.SidebarWidthChanged:
      return Number.isFinite(e.value) ? result({ ...s, layout: { ...s.layout, sidebar_width: Math.min(450, Math.max(180, e.value)) } }) : deny();
    case Event.PdfWidthChanged:
      return Number.isFinite(e.value) ? result({ ...s, layout: { ...s.layout, pdf_width: Math.min(1200, Math.max(280, e.value)) } }) : deny();
    case Event.GenerationResetRequested:
      // Only Root requests this once Effect Runner has no pending promises,
      // including superseded sync/PDF operations. Never wrap while an old result can arrive.
      if (s.state_generation !== MAX_SAFE || busy(s) || e.quiescent !== true) return deny();
      return result({ ...s, state_generation: 0 });
    default: return deny();
  }
}

export function renderModel(result) {
  const s = result.state;
  const pdf_candidates = pdfMaterials(s).map(({ id, name }) => ({ id, name }));
  const pdf_current_name = material(s, s.pdf.material_id)?.name ?? '';
  return { lifecycle: s.lifecycle, edit: s.edit, sync: s.sync, launch: s.launch, pdf: s.pdf,
    config_revision: s.config_revision, state_generation: s.state_generation,
    can_edit: editable(s) && s.edit !== Edit.Saving, can_launch: editable(s),
    config: s.draft ?? s.saved_config, statuses: s.statuses, last_sync_at: s.last_sync_at, launch_results: s.launch_results,
    candidates: s.candidates, selected_group_id: s.selected_group_id,
    dropped_files: s.dropped_files, pdf_candidates, pdf_current_name, query: s.query, width: s.width, layout: s.layout, notice: result.notice };
}
