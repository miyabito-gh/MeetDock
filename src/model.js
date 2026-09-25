import { validate, uuid, appError, MAX_SAFE, restorationTargetKey, windowsPathKey } from './contracts.js';

const enumeration = names => Object.freeze(Object.fromEntries(names.split(' ').map(n => [n, n])));
export const Lifecycle = enumeration('Booting Ready ReadOnly RecoveryPending MigrationPending FatalError');
export const Edit = enumeration('Clean Dirty Saving Conflict');
export const Pdf = enumeration('Closed Loading Viewing PasswordRequired Failed');
export const WINDOW_SNAPSHOT_GROUP_ID = 'window-snapshot';
export const Event = enumeration('Started CloseRequested EffectFailed SettingsLoaded FutureSchemaFound LegacySettingsFound CorruptSettingsFound SettingsUnavailable SettingsLoadFailed MigrationApproved MigrationRejected RestoreSelected InitializeSelected ReadOnlySelected ResolutionFailed EditRequested DraftChanged GroupAdded GroupRenamed GroupDuplicated GroupMoved GroupDeleted GroupReordered GroupMovedToEnd ReorderCancelled MaterialAdded MaterialUpdated MaterialMoved MaterialDeleted MaterialReordered NativeFilesDropped DroppedFilesPrepared DroppedFilesPrepareFailed DroppedFilesConfirmed DroppedFilesCancelled SaveRequested SaveSucceeded SaveConflict SaveFailed EditDiscarded ReloadRequested GroupSelected SyncRequested SyncSucceeded SyncFailed WindowDialogOpened WindowDialogClosed WindowSyncSucceeded WindowSyncFailed WindowActivateRequested WindowActivateSucceeded WindowActivateFailed WindowCloseRequested WindowCloseSucceeded WindowCloseFailed WindowExclusionsSaveRequested WindowExclusionsSaved WindowExclusionsSaveFailed WindowSnapshotSaveRequested WindowSnapshotSaved WindowSnapshotSaveFailed WindowSnapshotLoadRequested WindowSnapshotLoaded WindowSnapshotLoadFailed WindowSnapshotClearSucceeded WindowSnapshotClearFailed WindowSnapshotLaunchRequested WindowSnapshotLaunchAllRequested WindowSnapshotLaunchSucceeded WindowSnapshotLaunchFailed WindowSnapshotLaunchAllCompleted WindowSnapshotRegisterRequested ActivateRequested OpenContainingFolderRequested OpenContainingFolderCompleted LaunchSucceeded LaunchFailed ForegroundDenied BatchLaunchRequested BatchLaunchCancelRequested BatchLaunchProgressed BatchLaunchCompleted BatchLaunchCancelled PdfOpenRequested PdfDocumentPreviousRequested PdfDocumentNextRequested PdfReady PdfViewChanged PdfPasswordRequired PdfFailed PdfOpenExternalRequested PdfClosed PdfPreviousRequested PdfNextRequested PdfPageRequested PdfZoomInRequested PdfZoomOutRequested PdfFitRequested PdfSearchRequested PdfSearchPreviousRequested PdfSearchNextRequested PdfSearchCompleted PdfSidecarSaveRequested PdfSidecarRemoveRequested PdfSidecarLoaded PdfSidecarSaved PdfSidecarRemoved PdfSidecarFailed PdfMaximizeToggled PdfFullscreenSucceeded PdfFullscreenFailed FatalError SearchChanged ResizeChanged SidebarToggled SidebarWidthChanged PdfWidthChanged GenerationResetRequested');
export const Effect = enumeration('LoadSettings ResolveSettings SaveSettings SyncStatuses SyncWindows ActivateWindow RequestWindowClose SaveWindowExclusions SaveWindowSnapshot LoadWindowSnapshot ClearWindowSnapshot LaunchWindowSnapshotItem BatchLaunchWindowSnapshot Activate OpenContainingFolder PrepareDroppedFiles BatchLaunch CancelBatch ReplacePdf ClosePdf PdfPrevious PdfNext PdfGoToPage PdfZoomIn PdfZoomOut PdfFit PdfSearch PdfSearchPrevious PdfSearchNext LoadPdfSidecar SavePdfSidecar RemovePdfSidecar SetFullscreen CloseWindow');

export function initialState() {
  return { lifecycle: Lifecycle.Booting, edit: Edit.Clean, sync: { kind: 'Idle' },
    launch: { running: [], batch: null }, pdf: { kind: Pdf.Closed }, pdf_sidecars: {},
    windowing: { dialog_open: false, sync: { kind: 'Idle' }, items: [], exclusions: [], running: [], closing: [], saving_exclusions: false, snapshot_busy:false, snapshot_focus_after_load:false, snapshot:null, snapshot_running:[], snapshot_batch:false, last_sync_at: null },
    config_revision: 0, state_generation: 0, saved_config: null, draft: null,
    candidates: [], resolution: null, saving: null, selected_group_id: null,
    statuses: [], last_sync_at: null, launch_results: [], query: '', width: null,
    dropped_files: null, layout: { sidebar_collapsed: false, sidebar_width: 250, pdf_width: 430, pdf_maximized: false, pdf_fullscreen_pending: null, pdf_fullscreen_request: 0, pdf_fullscreen_recovery: false } };
}
const valid = (type, value) => { try { return validate(type, value); } catch { return null; } };
const material = (s, id) => s.saved_config?.materials.find(m => m.id === id);
const displayedMaterial = (s, id) => (s.draft ?? s.saved_config)?.materials.find(m => m.id === id);
const savedTarget = (s, id) => {
  const shown = displayedMaterial(s, id), saved = material(s, id);
  return shown && saved && shown.path === saved.path && shown.target_type === saved.target_type && shown.group_id === saved.group_id && shown.role === saved.role && shown.window_match_pattern === saved.window_match_pattern ? saved : null;
};
const group = (s, id) => s.saved_config?.groups.some(g => g.id === id);
const pdfMaterials = s => {
  const config = s.saved_config, query = String(s.query ?? '').trim().toLocaleLowerCase('ja');
  const names = new Map((config?.groups ?? []).map(g => [g.id, g.name]));
  return (config?.materials ?? []).filter(m => savedTarget(s,m.id) && m.target_type === 'file' && /\.pdf$/i.test(m.path) &&
    (query ? `${m.name} ${names.get(m.group_id) ?? ''}`.toLocaleLowerCase('ja').includes(query) : m.group_id === s.selected_group_id))
    .sort((a, b) => (a.role === b.role ? a.order - b.order : a.role === 'main' ? -1 : 1));
};
const editable = s => s.lifecycle === Lifecycle.Ready && s.edit !== Edit.Saving && !s.resolution;
const busy = s => s.edit === Edit.Saving || s.sync.kind === 'Running' || s.launch.running.length || s.launch.batch || s.pdf.kind === Pdf.Loading || s.resolution;
const editableConfig = s => structuredClone(s.draft ?? s.saved_config);
const reorder = (items, key) => {
  const buckets = new Map();
  for (const item of items) { const k = key(item); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(item); }
  for (const bucket of buckets.values()) bucket.sort((a, b) => a.order - b.order).forEach((item, index) => { item.order = index + 1; });
};
const uniqueSnapshotItems = items => {
  const targets = new Set();
  return items.filter(item => {
    const key = restorationTargetKey(item.executable_path, item.document_path ?? null, item.shell_location ?? null);
    if (targets.has(key)) return false;
    targets.add(key); return true;
  });
};
const dirtyWith = (s, config) => ({ ...s, edit: s.edit === Edit.Conflict ? Edit.Conflict : Edit.Dirty, draft: config });
const explorerMode = (s, groupId) => {
  const config = s.saved_config;
  const override = config?.groups.find(g => g.id === groupId)?.explorer_open_mode ?? 'inherit';
  return override === 'inherit' ? (config?.explorer_open_mode ?? 'new_window') : override;
};

/** Pure transition; guard failures retain the identical state and produce no effects.
 * `notice` is an ephemeral RenderModel value, never persisted or an effect.
 */
export function transition(s, e) {
  const result = (state = s, effects = [], notice = null, diagnostic = null) => ({ handled: true, state, effects, notice, diagnostic });
  const deny = () => result();
  const effect = (type, request, extra = {}) => ({ type, request, generation: s.state_generation, ...extra });
  const bump = () => s.state_generation < MAX_SAFE ? s.state_generation + 1 : null;
  const closeFullscreen = () => {
    const layout = s.layout;
    if (layout.pdf_fullscreen_pending === false) return { layout, effects: [] };
    if (!layout.pdf_maximized && layout.pdf_fullscreen_pending !== true && !layout.pdf_fullscreen_recovery) return { layout, effects: [] };
    const request = layout.pdf_fullscreen_request + 1;
    return { layout: { ...layout, pdf_fullscreen_pending: false, pdf_fullscreen_request: request, pdf_fullscreen_recovery: false },
      effects: [effect(Effect.SetFullscreen, { value: false, request })] };
  };
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
      const config = valid('AppConfig', e.config), generation = bump(), request_id = crypto.randomUUID();
      if (!config || generation === null) return deny();
      return result({ ...s, lifecycle: Lifecycle.Ready, edit: Edit.Clean, resolution: null, saving: null,
        saved_config: config, draft: null, config_revision: config.revision, state_generation: generation,
        candidates: [], statuses: [], selected_group_id: config.groups[0]?.id ?? null,
        sync: { kind: 'Running', request_id }, windowing: { ...s.windowing, sync: { kind: 'Running', request_id } } },
        [effect(Effect.SyncStatuses, { material_ids: config.materials.map(m => m.id), request_id }, { generation }),
          effect(Effect.SyncWindows, { request_id }, { generation }), effect(Effect.LoadWindowSnapshot,{})]);
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
      return result(dirtyWith(s, structuredClone(e.config)));
    case Event.GroupAdded: {
      if (!editable(s) || !s.saved_config || typeof e.group?.name !== 'string' || !e.group.name.trim()) return deny();
      const config = editableConfig(s);
      if (config.groups.some(g => g.id === e.group.id) || (e.group.parent_id !== null && !config.groups.some(g => g.id === e.group.parent_id))) return deny();
      config.groups.push({ id: e.group.id, parent_id: e.group.parent_id, name: e.group.name, order: Number.MAX_SAFE_INTEGER, explorer_open_mode: e.group.explorer_open_mode ?? 'inherit' });
      reorder(config.groups, g => g.parent_id ?? 'root');
      return result({ ...dirtyWith(s, config), selected_group_id: e.group.id });
    }
    case Event.GroupRenamed: {
      if (!editable(s) || typeof e.name !== 'string' || !e.name.trim()) return deny();
      const config = editableConfig(s), item = config?.groups.find(g => g.id === e.group_id); if (!item) return deny();
      item.name = e.name; return result(dirtyWith(s, config));
    }
    case Event.GroupDuplicated: {
      if (!editable(s)) return deny();
      const config = editableConfig(s), source = config?.groups.find(g => g.id === e.group_id);
      if (!source) return deny();
      const descendants = new Set([source.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const item of config.groups) if (item.parent_id !== null && descendants.has(item.parent_id) && !descendants.has(item.id)) {
          descendants.add(item.id); changed = true;
        }
      }
      const idMap = new Map([...descendants].map(id => [id, crypto.randomUUID()]));
      const copies = config.groups.filter(g => descendants.has(g.id)).map(g => ({ ...structuredClone(g), id: idMap.get(g.id),
        parent_id: g.id === source.id ? source.parent_id : idMap.get(g.parent_id), name: g.id === source.id ? `${g.name}（コピー）` : g.name,
        order: g.id === source.id ? Number.MAX_SAFE_INTEGER : g.order }));
      const materialCopies = config.materials.filter(m => descendants.has(m.group_id)).map(m => ({ ...structuredClone(m), id: crypto.randomUUID(), group_id: idMap.get(m.group_id) }));
      config.groups.push(...copies); config.materials.push(...materialCopies);
      reorder(config.groups, g => g.parent_id ?? 'root'); reorder(config.materials, m => `${m.group_id}\0${m.role}`);
      return result({ ...dirtyWith(s, config), selected_group_id: idMap.get(source.id) });
    }
    case Event.GroupMoved: {
      if (!editable(s) || !Object.hasOwn(e, 'parent_id')) return deny();
      const config = editableConfig(s), moving = config?.groups.find(g => g.id === e.group_id);
      if (!moving || (e.parent_id !== null && !config.groups.some(g => g.id === e.parent_id)) || moving.id === e.parent_id) return deny();
      let ancestor = e.parent_id;
      while (ancestor !== null) {
        if (ancestor === moving.id) return deny();
        ancestor = config.groups.find(g => g.id === ancestor)?.parent_id ?? null;
      }
      moving.parent_id = e.parent_id; moving.order = Number.MAX_SAFE_INTEGER;
      reorder(config.groups, g => g.parent_id ?? 'root');
      return result(dirtyWith(s, config));
    }
    case Event.GroupDeleted: {
      if (!editable(s) || e.confirmed !== true) return deny();
      const config = editableConfig(s), item = config?.groups.find(g => g.id === e.group_id);
      if (!item) return deny();
      const deleted = new Set([item.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const child of config.groups) if (child.parent_id !== null && deleted.has(child.parent_id) && !deleted.has(child.id)) {
          deleted.add(child.id); changed = true;
        }
      }
      config.groups = config.groups.filter(g => !deleted.has(g.id)); config.materials = config.materials.filter(m => !deleted.has(m.group_id));
      reorder(config.groups, g => g.parent_id ?? 'root'); reorder(config.materials, m => `${m.group_id}\0${m.role}`);
      return result({ ...dirtyWith(s, config), selected_group_id: item.parent_id ?? config.groups[0]?.id ?? null });
    }
    case Event.GroupReordered: {
      if (!editable(s) || e.group_id === e.before_group_id) return deny();
      const config = editableConfig(s), moving = config?.groups.find(g => g.id === e.group_id), before = config?.groups.find(g => g.id === e.before_group_id);
      if (!moving || !before || moving.parent_id !== before.parent_id) return deny();
      const siblings = config.groups.filter(g => g.parent_id === moving.parent_id && g.id !== moving.id).sort((a,b)=>a.order-b.order), index = siblings.findIndex(g=>g.id===before.id);
      siblings.splice(index,0,moving);siblings.forEach((g,i)=>{g.order=i+1});return result(dirtyWith(s,config));
    }
    case Event.GroupMovedToEnd: {
      if (!editable(s)) return deny();
      const config = editableConfig(s), moving = config?.groups.find(g => g.id === e.group_id);
      if (!moving) return deny();
      const peers = config.groups.filter(g => g.parent_id === moving.parent_id && g.id !== moving.id).sort((a,b) => a.order-b.order);
      peers.push(moving); peers.forEach((g,i) => { g.order = i+1; });
      return result(dirtyWith(s,config));
    }
    case Event.ReorderCancelled: {
      if (!editable(s) || !Array.isArray(e.groups) || !Array.isArray(e.materials)) return deny();
      const config = editableConfig(s);
      if (e.groups.length !== config.groups.length || e.materials.length !== config.materials.length) return deny();
      const groupOrder = new Map(e.groups.map(item => [item.id, item]));
      const materialOrder = new Map(e.materials.map(item => [item.id, item]));
      if (groupOrder.size !== e.groups.length || materialOrder.size !== e.materials.length) return deny();
      if (!config.groups.every(g => groupOrder.get(g.id)?.parent_id === g.parent_id && Number.isSafeInteger(groupOrder.get(g.id)?.order)) ||
          !config.materials.every(m => materialOrder.has(m.id) && Number.isSafeInteger(materialOrder.get(m.id)?.order) &&
            ['main', 'reference'].includes(materialOrder.get(m.id)?.role) && config.groups.some(g => g.id === materialOrder.get(m.id)?.group_id))) return deny();
      for (const g of config.groups) g.order = groupOrder.get(g.id).order;
      for (const m of config.materials) Object.assign(m, { group_id: materialOrder.get(m.id).group_id, role: materialOrder.get(m.id).role, order: materialOrder.get(m.id).order });
      if (e.edit === Edit.Clean && JSON.stringify(config) === JSON.stringify(s.saved_config)) return result({ ...s, edit: Edit.Clean, draft: null });
      return result(dirtyWith(s, config));
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
    case Event.MaterialMoved: {
      if (!editable(s) || !['main', 'reference'].includes(e.role)) return deny();
      const config = editableConfig(s), moving = config?.materials.find(m => m.id === e.material_id);
      if (!moving || !config.groups.some(g => g.id === e.group_id) || e.before_material_id === moving.id) return deny();
      const before = e.before_material_id == null ? null : config.materials.find(m => m.id === e.before_material_id);
      if (e.before_material_id != null && (!before || before.group_id !== e.group_id || before.role !== e.role)) return deny();
      moving.group_id = e.group_id; moving.role = e.role;
      const peers = config.materials.filter(m => m.group_id === e.group_id && m.role === e.role && m.id !== moving.id).sort((a,b)=>a.order-b.order);
      const index = before ? peers.findIndex(m => m.id === before.id) : peers.length;
      peers.splice(index, 0, moving); peers.forEach((m, i) => { m.order = i + 1; });
      reorder(config.materials, m => `${m.group_id}\0${m.role}`);
      return result(dirtyWith(s, config));
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
      if (!editable(s) || !editableConfig(s)?.groups.some(g => g.id === e.group_id) || !Array.isArray(e.response?.candidates) || !Array.isArray(e.response?.failures)) return deny();
      return result({ ...s, dropped_files: { group_id: e.group_id, candidates: structuredClone(e.response.candidates), failures: structuredClone(e.response.failures??[]) } });
    case Event.DroppedFilesPrepareFailed:
      return result(s, [], e.error);
    case Event.DroppedFilesCancelled:
      return s.dropped_files ? result({ ...s, dropped_files: null }) : deny();
    case Event.DroppedFilesConfirmed: {
      if (!editable(s) || !s.dropped_files?.candidates?.length || !editableConfig(s)?.groups.some(g => g.id === e.group_id) || !['main', 'reference'].includes(e.role)) return deny();
      const config = editableConfig(s);
      for (const entry of s.dropped_files.candidates) config.materials.push({ id: crypto.randomUUID(), group_id: e.group_id, name: entry.name, role: e.role, target_type: entry.target_type, path: entry.path, order: Number.MAX_SAFE_INTEGER, window_match_pattern: null });
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
      const fullscreen = closeFullscreen();
      return result({ ...s, edit: Edit.Clean, draft: null, state_generation: generation, pdf: { kind: Pdf.Closed }, layout: fullscreen.layout },
        [...(s.pdf.kind === Pdf.Closed ? [] : [effect(Effect.ClosePdf, {})]), ...fullscreen.effects]);
    }
    case Event.ReloadRequested: {
      const generation = bump();
      if (busy(s) || generation === null || (![Edit.Clean].includes(s.edit) && e.confirmed !== true)) return deny();
      const fullscreen = closeFullscreen();
      return result({ ...s, lifecycle: Lifecycle.Booting, edit: Edit.Clean, draft: null, state_generation: generation, resolution: 'load', pdf: { kind: Pdf.Closed }, layout: fullscreen.layout },
        [effect(Effect.ClosePdf, {}), ...fullscreen.effects, effect(Effect.LoadSettings, {}, { generation })]);
    }
    case Event.GroupSelected: {
      const generation = bump();
      if (!(group(s, e.group_id) || (e.group_id === WINDOW_SNAPSHOT_GROUP_ID && s.windowing.snapshot?.items?.length)) || e.group_id === s.selected_group_id || generation === null) return deny();
      const fullscreen = closeFullscreen();
      return result({ ...s, selected_group_id: e.group_id, state_generation: generation, pdf: { kind: Pdf.Closed }, layout: fullscreen.layout },
        [...(s.pdf.kind === Pdf.Closed ? [] : [effect(Effect.ClosePdf, {})]), ...fullscreen.effects]);
    }
    case Event.SyncRequested: {
      if (![Lifecycle.Ready, Lifecycle.ReadOnly].includes(s.lifecycle) || s.resolution) return deny();
      if ((s.sync.kind === 'Running' || s.windowing.sync.kind === 'Running') && !(e.manual === true || e.new_auto === true)) return deny();
      try { uuid(e.request_id); } catch { return deny(); }
      if (s.sync.request_id === e.request_id || s.windowing.sync.request_id === e.request_id) return deny();
      const request = { material_ids: s.saved_config?.materials.map(m => m.id) ?? [], request_id: e.request_id };
      return result({ ...s, sync: { kind: 'Running', request_id: e.request_id },
        windowing: { ...s.windowing, sync: { kind: 'Running', request_id: e.request_id } } },
        [effect(Effect.SyncStatuses, request), effect(Effect.SyncWindows, { request_id: e.request_id })]);
    }
    case Event.SyncSucceeded:
    case Event.SyncFailed:
      if (s.sync.kind !== 'Running' || e.request_id !== s.sync.request_id) return result(s, [], null, 'stale_sync');
      if (e.type === Event.SyncSucceeded && !valid('SyncStatusesResponse', { request_id: e.request_id, results: e.results })) return deny();
      return result({ ...s, sync: { kind: 'Idle' }, statuses: e.type === Event.SyncSucceeded ? structuredClone(e.results) : s.statuses,
        last_sync_at: e.type === Event.SyncSucceeded && Number.isFinite(e.completed_at) ? e.completed_at : s.last_sync_at }, [], e.type === Event.SyncFailed ? e.error : null);
    case Event.WindowDialogOpened:
      return result({ ...s, windowing: { ...s.windowing, dialog_open: true } });
    case Event.WindowDialogClosed:
      return result({ ...s, windowing: { ...s.windowing, dialog_open: false } });
    case Event.WindowSyncSucceeded:
    case Event.WindowSyncFailed: {
      if (s.windowing.sync.kind !== 'Running' || e.request_id !== s.windowing.sync.request_id) return result(s, [], null, 'stale_window_sync');
      if (e.type === Event.WindowSyncFailed) return result({ ...s, windowing: { ...s.windowing, sync: { kind: 'Idle' } } }, [], e.error);
      const response = valid('ListWindowsResponse', e.response);
      if (!response || response.request_id !== e.request_id) return deny();
      return result({ ...s, windowing: { ...s.windowing, sync: { kind: 'Idle' }, items: response.windows,
        exclusions: response.exclusions, closing: [], last_sync_at: Number.isFinite(e.completed_at) ? e.completed_at : s.windowing.last_sync_at } });
    }
    case Event.WindowActivateRequested:
    case Event.WindowCloseRequested: {
      const item = s.windowing.items.find(item => item.window_id === e.window_id);
      if (!item || s.windowing.running.some(item => item.window_id === e.window_id) || s.windowing.saving_exclusions) return deny();
      const action = e.type === Event.WindowActivateRequested ? 'activate' : 'close';
      const type = action === 'activate' ? Effect.ActivateWindow : Effect.RequestWindowClose;
      return result({ ...s, windowing: { ...s.windowing, running: [...s.windowing.running, { window_id: e.window_id, action }] } },
        [effect(type, { window_id: e.window_id })]);
    }
    case Event.WindowActivateSucceeded:
    case Event.WindowActivateFailed:
    case Event.WindowCloseSucceeded:
    case Event.WindowCloseFailed: {
      const operation = s.windowing.running.find(item => item.window_id === e.window_id);
      if (!operation) return deny();
      const closeSucceeded = e.type === Event.WindowCloseSucceeded;
      return result({ ...s, windowing: { ...s.windowing,
        running: s.windowing.running.filter(item => item !== operation),
        closing: closeSucceeded && !s.windowing.closing.includes(e.window_id) ? [...s.windowing.closing, e.window_id] : s.windowing.closing } },
        [], e.type.endsWith('Failed') ? e.error : null);
    }
    case Event.WindowExclusionsSaveRequested: {
      if (s.windowing.saving_exclusions) return deny();
      const request = valid('SaveWindowExclusionsRequest', { patterns: e.patterns });
      if (!request) return result(s, [], appError('VALIDATION_ERROR'));
      return result({ ...s, windowing: { ...s.windowing, saving_exclusions: true } }, [effect(Effect.SaveWindowExclusions, request)]);
    }
    case Event.WindowExclusionsSaved: {
      if (!s.windowing.saving_exclusions) return deny();
      const response = valid('SaveWindowExclusionsResponse', e.response), request_id = crypto.randomUUID();
      if (!response) return deny();
      return result({ ...s, windowing: { ...s.windowing, exclusions: response.patterns, saving_exclusions: false,
        sync: { kind: 'Running', request_id }, running: [], closing: [] } }, [effect(Effect.SyncWindows, { request_id })]);
    }
    case Event.WindowExclusionsSaveFailed:
      return s.windowing.saving_exclusions
        ? result({ ...s, windowing: { ...s.windowing, saving_exclusions: false } }, [], e.error)
        : deny();
    case Event.WindowSnapshotSaveRequested:
      return s.windowing.snapshot_busy?deny():result({...s,windowing:{...s.windowing,snapshot_busy:true,snapshot_focus_after_load:true}},[effect(Effect.SaveWindowSnapshot,{})]);
    case Event.WindowSnapshotLoadRequested:
      return s.windowing.snapshot_busy?deny():result({...s,windowing:{...s.windowing,snapshot_busy:true,snapshot_focus_after_load:true}},[effect(Effect.LoadWindowSnapshot,{})]);
    case Event.WindowSnapshotSaved:
      return e.response?.saved?result({...s,windowing:{...s.windowing,dialog_open:false,snapshot_busy:true}},[effect(Effect.LoadWindowSnapshot,{})],{code:'WINDOW_SNAPSHOT_SAVED'}):result({...s,windowing:{...s.windowing,snapshot_busy:false,snapshot_focus_after_load:false}},[],appError('VALIDATION_ERROR'));
    case Event.WindowSnapshotLoaded: {
      const snapshot=e.response===null?null:valid('OptionalWindowSnapshot',e.response);
      if(e.response!==null&&!snapshot)return deny();
      if(snapshot)snapshot.items=uniqueSnapshotItems(snapshot.items);
      return result({...s,selected_group_id:s.windowing.snapshot_focus_after_load&&snapshot?.items?.length?WINDOW_SNAPSHOT_GROUP_ID:s.selected_group_id,windowing:{...s.windowing,snapshot_busy:false,snapshot_focus_after_load:false,snapshot}});
    }
    case Event.WindowSnapshotSaveFailed:
    case Event.WindowSnapshotLoadFailed:
      return result({...s,windowing:{...s.windowing,snapshot_busy:false,snapshot_focus_after_load:false}},[],e.error);
    case Event.WindowSnapshotClearSucceeded:
      return result(s);
    case Event.WindowSnapshotClearFailed:
      return result(s,[],e.error);
    case Event.WindowSnapshotLaunchRequested: {
      const items=s.windowing.snapshot?.items??[];
      if(!Number.isSafeInteger(e.index)||e.index<0||e.index>=items.length||s.windowing.snapshot_running.includes(e.index)||s.windowing.snapshot_batch)return deny();
      return result({...s,windowing:{...s.windowing,snapshot_running:[...s.windowing.snapshot_running,e.index]}},[effect(Effect.LaunchWindowSnapshotItem,{index:e.index})]);
    }
    case Event.WindowSnapshotLaunchAllRequested: {
      const targets=new Set(),indices=[];
      for(const [index,item] of (s.windowing.snapshot?.items??[]).entries()){
        const key=restorationTargetKey(item.executable_path,item.document_path??null,item.shell_location??null);
        if(!targets.has(key)){targets.add(key);indices.push(index);}
      }
      if(!indices.length||s.windowing.snapshot_batch||s.windowing.snapshot_running.length)return deny();
      return result({...s,windowing:{...s.windowing,snapshot_batch:true}},[effect(Effect.BatchLaunchWindowSnapshot,{indices})]);
    }
    case Event.WindowSnapshotLaunchSucceeded:
    case Event.WindowSnapshotLaunchFailed:
      if(!s.windowing.snapshot_running.includes(e.index))return deny();
      return result({...s,windowing:{...s.windowing,snapshot_running:s.windowing.snapshot_running.filter(index=>index!==e.index)}},[],e.type===Event.WindowSnapshotLaunchFailed?e.error:{code:'WINDOW_SNAPSHOT_LAUNCHED'});
    case Event.WindowSnapshotLaunchAllCompleted:
      if(!s.windowing.snapshot_batch)return deny();
      return result({...s,windowing:{...s.windowing,snapshot_batch:false}},[],e.error??{code:'WINDOW_SNAPSHOT_LAUNCHED'});
    case Event.WindowSnapshotRegisterRequested: {
      if(!editable(s)||!s.windowing.snapshot?.items?.length||!s.saved_config)return deny();
      const config=editableConfig(s),groupId=crypto.randomUUID(),stamp=new Date(s.windowing.snapshot.saved_at_unix_ms).toLocaleString('ja-JP');
      const existingTargets=new Set(config.materials.map(item=>windowsPathKey(item.path)));
      const items=uniqueSnapshotItems(s.windowing.snapshot.items).filter(item=>!item.shell_location&&!existingTargets.has(windowsPathKey(item.document_path??item.executable_path)));
      if(items.length)config.groups.push({id:groupId,parent_id:null,name:`保存ウィンドウ ${stamp}`,order:Number.MAX_SAFE_INTEGER});
      for(const item of items)config.materials.push({id:crypto.randomUUID(),group_id:groupId,name:item.title||item.app_name,role:'main',target_type:item.executable_name.toLocaleLowerCase('ja')==='explorer.exe'&&item.document_path?'folder':'file',path:item.document_path??item.executable_path,window_match_pattern:null,order:Number.MAX_SAFE_INTEGER});
      reorder(config.groups,g=>g.parent_id??'root');reorder(config.materials,m=>`${m.group_id}\0${m.role}`);
      const next=items.length?dirtyWith(s,config):s;
      return result({...next,selected_group_id:items.length?groupId:s.selected_group_id,windowing:{...next.windowing,snapshot:null,snapshot_focus_after_load:false}},[effect(Effect.ClearWindowSnapshot,{})],{code:'WINDOW_SNAPSHOT_REGISTERED'});
    }
    case Event.ActivateRequested:
      if (!editable(s) || !savedTarget(s, e.material_id) || s.launch.running.some(x => x.material_id === e.material_id) || s.launch.batch?.material_ids.includes(e.material_id)) return deny();
      return result({ ...s, launch_results: [], launch: { ...s.launch, running: [...s.launch.running, { material_id: e.material_id, generation: s.state_generation }] } },
        [effect(Effect.Activate, { material_id: e.material_id, explorer_open_mode: explorerMode(s, material(s,e.material_id).group_id) })]);
    case Event.OpenContainingFolderRequested:
      if (!editable(s) || !savedTarget(s, e.material_id) || savedTarget(s, e.material_id).target_type !== 'file') return deny();
      return result(s, [effect(Effect.OpenContainingFolder, { material_id: e.material_id, explorer_open_mode: explorerMode(s, material(s,e.material_id).group_id) })]);
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
        launch_results: [] }, [], e.generation === s.state_generation ? (response ?? e.error) : null);
    }
    case Event.BatchLaunchRequested: {
      if (!editable(s) || !group(s, e.group_id) || s.launch.batch) return deny();
      const ids = s.saved_config.materials.filter(m => m.group_id === e.group_id && m.role === 'main').map(m => m.id);
      if (!ids.length || ids.some(id=>!savedTarget(s,id))) return deny();
      if (s.launch.running.some(x => ids.includes(x.material_id))) return deny();
      return result({ ...s, launch_results: [], launch: { ...s.launch, batch: { group_id: e.group_id, material_ids: ids, generation: s.state_generation, completed: 0 } } }, [effect(Effect.BatchLaunch, { group_id: e.group_id, material_ids: ids, explorer_open_mode: explorerMode(s,e.group_id) })]);
    }
    case Event.BatchLaunchCancelRequested:
      if (!s.launch.batch || s.launch.batch.group_id !== e.group_id) return deny();
      return result(s, [effect(Effect.CancelBatch, { group_id: e.group_id })]);
    case Event.BatchLaunchProgressed:
      if (!s.launch.batch || s.launch.batch.group_id !== e.group_id || s.launch.batch.generation !== e.generation ||
        !Number.isSafeInteger(e.completed) || e.completed <= s.launch.batch.completed || e.completed > s.launch.batch.material_ids.length) return deny();
      return result({ ...s, launch: { ...s.launch, batch: { ...s.launch.batch, completed: e.completed } } });
    case Event.BatchLaunchCompleted:
    case Event.BatchLaunchCancelled:
      if (!s.launch.batch || s.launch.batch.group_id !== e.group_id || s.launch.batch.generation !== e.generation) return deny();
      if (e.response && !valid('BatchLaunchResponse', e.response)) return deny();
      return result({ ...s, launch: { ...s.launch, batch: null }, launch_results: structuredClone(e.response?.results ?? []) }, [],
        e.generation === s.state_generation ? (e.error ?? e.response ?? null) : null);
    case Event.PdfOpenRequested: {
      const m = savedTarget(s, e.material_id), generation = bump();
      if (!editable(s) || !m || m.target_type !== 'file' || !/\.pdf$/i.test(m.path) || generation === null ||
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
      const nextPdf = e.type === Event.PdfReady
        ? { ...s.pdf, kind: Pdf.Viewing, ...e.view }
        : { kind: e.type === Event.PdfPasswordRequired ? Pdf.PasswordRequired : Pdf.Failed, material_id: s.pdf.material_id,
          generation: s.pdf.generation, ...(e.type === Event.PdfFailed ? { code: e.error.code } : {}) };
      if (e.type !== Event.PdfReady) return result({ ...s, pdf: nextPdf }, [], e.error ?? null);
      const current = material(s, s.pdf.material_id), pdf_identity = `${current.target_type}:${current.path}`;
      return result({ ...s, pdf: { ...nextPdf, sidecar_loading: true, pdf_identity } },
        [effect(Effect.LoadPdfSidecar, { material_id: current.id, pdf_identity }, { generation: s.pdf.generation })]);
    case Event.PdfSidecarLoaded:
      if (s.pdf.kind !== Pdf.Viewing || e.generation !== s.pdf.generation || e.material_id !== s.pdf.material_id) return deny();
      return result({ ...s, pdf: { ...s.pdf, sidecar_loading: false, sidecar: e.sidecar }, pdf_sidecars: e.sidecar ? { ...s.pdf_sidecars, [`${e.sidecar.material_id}\0${e.sidecar.pdf_identity}`]: e.sidecar } : s.pdf_sidecars });
    case Event.PdfSidecarSaveRequested:
      { const target = material(s, e.sidecar?.material_id), identity = target ? `${target.target_type}:${target.path}` : null;
      if (!target || e.sidecar?.pdf_identity !== identity) return deny();
      const key = `${e.sidecar.material_id}\0${identity}`, current = s.pdf.kind === Pdf.Viewing && e.sidecar.material_id === s.pdf.material_id;
      return result({ ...s, pdf: current ? { ...s.pdf, sidecar: structuredClone(e.sidecar) } : s.pdf,
        pdf_sidecars: { ...s.pdf_sidecars, [key]: structuredClone(e.sidecar) } },
        [effect(Effect.SavePdfSidecar, structuredClone(e.sidecar), { generation: s.state_generation })]); }
    case Event.PdfSidecarSaved:
      return result({ ...s, pdf_sidecars: { ...s.pdf_sidecars, [`${e.sidecar.material_id}\0${e.sidecar.pdf_identity}`]: e.sidecar },
        pdf: s.pdf.kind === Pdf.Viewing && e.sidecar.material_id === s.pdf.material_id ? { ...s.pdf, sidecar: e.sidecar } : s.pdf });
    case Event.PdfSidecarRemoveRequested: {
      const target = material(s, e.material_id), identity = target ? `${target.target_type}:${target.path}` : null;
      if (!target || e.pdf_identity !== identity) return deny();
      return result(s, [effect(Effect.RemovePdfSidecar, { material_id: e.material_id, pdf_identity: identity })]);
    }
    case Event.PdfSidecarRemoved: {
      const key = `${e.material_id}\0${e.pdf_identity}`, sidecars = { ...s.pdf_sidecars }; delete sidecars[key];
      return result({ ...s, pdf_sidecars: sidecars, pdf: s.pdf.kind === Pdf.Viewing && e.material_id === s.pdf.material_id ? { ...s.pdf, sidecar: null } : s.pdf });
    }
    case Event.PdfSidecarFailed:
      return result(s, [], e.error);
    case Event.PdfClosed: {
      const generation = bump();
      if (s.pdf.kind === Pdf.Closed || generation === null) return deny();
      const fullscreen = closeFullscreen();
      return result({ ...s, state_generation: generation, pdf: { kind: Pdf.Closed }, layout: fullscreen.layout }, [effect(Effect.ClosePdf, {}), ...fullscreen.effects]);
    }
    case Event.PdfOpenExternalRequested:
      if (!editable(s) || !(s.pdf.kind === Pdf.PasswordRequired || s.pdf.kind === Pdf.Failed && ['PDF_FALLBACK_TOO_LARGE', 'PDF_NOT_READABLE', 'PDF_CORRUPT'].includes(s.pdf.code)) || !savedTarget(s, s.pdf.material_id) || s.launch.running.some(x=>x.material_id===s.pdf.material_id)) return deny();
      return result({ ...s, launch_results: [], launch: { ...s.launch, running: [...s.launch.running, { material_id: s.pdf.material_id, generation: s.state_generation }] } },
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
    case Event.PdfSearchRequested:
    case Event.PdfSearchPreviousRequested:
    case Event.PdfSearchNextRequested: {
      if (s.pdf.kind !== Pdf.Viewing || s.pdf.search_status === 'searching') return deny();
      const query = e.type === Event.PdfSearchRequested ? String(e.query ?? '').trim() : s.pdf.search_query;
      if (e.type !== Event.PdfSearchRequested && !s.pdf.search_total) return deny();
      const search_generation = (s.pdf.search_generation ?? 0) + 1;
      if (!Number.isSafeInteger(search_generation)) return deny();
      const type = { PdfSearchRequested: Effect.PdfSearch, PdfSearchPreviousRequested: Effect.PdfSearchPrevious, PdfSearchNextRequested: Effect.PdfSearchNext }[e.type];
      return result({ ...s, pdf: { ...s.pdf, search_query: query, search_status: 'searching', search_generation } },
        [effect(type, { material_id: s.pdf.material_id, generation: s.pdf.generation, search_generation, query })]);
    }
    case Event.PdfSearchCompleted:
      if (s.pdf.kind !== Pdf.Viewing || e.generation !== s.pdf.generation || e.search_generation !== s.pdf.search_generation ||
        e.material_id !== s.pdf.material_id || !Number.isSafeInteger(e.view?.search_index) || !Number.isSafeInteger(e.view?.search_total) ||
        !Number.isSafeInteger(e.view?.current_page) || !Number.isSafeInteger(e.view?.total_pages) || !Number.isSafeInteger(e.view?.zoom_percent) ||
        typeof e.view?.search_query !== 'string' || e.view.search_index < 0 || e.view.search_index > e.view.search_total ||
        e.view.current_page < 1 || e.view.current_page > e.view.total_pages || e.view.zoom_percent < 1) return result(s, [], null, 'stale_pdf_search');
      return result({ ...s, pdf: { ...s.pdf, ...e.view, search_status: 'ready' } });
    case Event.PdfMaximizeToggled:
      if ((s.pdf.kind === Pdf.Closed && !s.layout.pdf_fullscreen_recovery) || s.layout.pdf_fullscreen_pending != null || s.layout.pdf_fullscreen_request >= MAX_SAFE) return deny();
      { const value = s.layout.pdf_fullscreen_recovery ? false : !s.layout.pdf_maximized;
        const request = s.layout.pdf_fullscreen_request + 1;
        return result({ ...s, layout: { ...s.layout, pdf_fullscreen_pending: value, pdf_fullscreen_request: request, pdf_fullscreen_recovery: false } },
          [effect(Effect.SetFullscreen, { value, request })]); }
    case Event.PdfFullscreenSucceeded:
      // The runner serializes native calls. An entry completed while exit was queued is
      // the current OS state until that exit completes, even if its request is obsolete.
      if (e.value === true && s.layout.pdf_fullscreen_pending === false && e.request === s.layout.pdf_fullscreen_request - 1)
        return result({ ...s, layout: { ...s.layout, pdf_maximized: true } }, [], null, 'stale_pdf_fullscreen');
      if (s.layout.pdf_fullscreen_pending !== e.value || s.layout.pdf_fullscreen_request !== e.request) return result(s, [], null, 'stale_pdf_fullscreen');
      return result({ ...s, layout: { ...s.layout, pdf_maximized: e.value, pdf_fullscreen_pending: null, pdf_fullscreen_recovery: false } });
    case Event.PdfFullscreenFailed:
      if (s.layout.pdf_fullscreen_pending !== e.value || s.layout.pdf_fullscreen_request !== e.request) return result(s, [], null, 'stale_pdf_fullscreen');
      return result({ ...s, layout: { ...s.layout, pdf_fullscreen_pending: null, pdf_fullscreen_recovery: !e.value } }, [], 'FULLSCREEN_FAILED');
    case Event.SearchChanged:
      return typeof e.value === 'string' ? result({ ...s, query: e.value }) : deny();
    case Event.ResizeChanged:
      return Number.isFinite(e.value) && e.value >= 0 ? result({ ...s, width: e.value }) : deny();
    case Event.SidebarToggled:
      return result({ ...s, layout: { ...s.layout, sidebar_collapsed: !s.layout.sidebar_collapsed } });
    case Event.SidebarWidthChanged:
      return Number.isFinite(e.value) ? result({ ...s, layout: { ...s.layout, sidebar_width: Math.min(450, Math.max(180, e.value)) } }) : deny();
    case Event.PdfWidthChanged: {
      const maximum = 1200 + (s.layout.sidebar_collapsed ? s.layout.sidebar_width : 0);
      return Number.isFinite(e.value) ? result({ ...s, layout: { ...s.layout, pdf_width: Math.min(maximum, Math.max(280, e.value)) } }) : deny();
    }
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
  const config = s.draft ?? s.saved_config;
  return { lifecycle: s.lifecycle, edit: s.edit, sync: s.sync, launch: s.launch, pdf: s.pdf,
    config_revision: s.config_revision, state_generation: s.state_generation,
    can_edit: editable(s) && s.edit !== Edit.Saving, can_launch: editable(s),
    config, runnable_material_ids: (config?.materials??[]).filter(m=>savedTarget(s,m.id)).map(m=>m.id), statuses: s.statuses, last_sync_at: s.last_sync_at, launch_results: s.launch_results,
    candidates: s.candidates, selected_group_id: s.selected_group_id,
    dropped_files: s.dropped_files, pdf_candidates, pdf_current_name, pdf_sidecars: s.pdf_sidecars, query: s.query, width: s.width, layout: s.layout,
    window_dialog_open: s.windowing.dialog_open, window_items: s.windowing.items, window_exclusions: s.windowing.exclusions, window_snapshot_busy:s.windowing.snapshot_busy, window_snapshot:s.windowing.snapshot, window_snapshot_running:s.windowing.snapshot_running, window_snapshot_batch:s.windowing.snapshot_batch,
    window_sync: s.windowing.sync, window_operations: s.windowing.running, closing_window_ids: s.windowing.closing,
    window_exclusions_saving: s.windowing.saving_exclusions, window_last_sync_at: s.windowing.last_sync_at,
    refreshing: s.sync.kind === 'Running' || s.windowing.sync.kind === 'Running', notice: result.notice };
}
