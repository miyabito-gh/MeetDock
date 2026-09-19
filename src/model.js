import { validate, uuid, appError, MAX_SAFE } from './contracts.js';

const enumeration = names => Object.freeze(Object.fromEntries(names.split(' ').map(n => [n, n])));
export const Lifecycle = enumeration('Booting Ready ReadOnly RecoveryPending MigrationPending FatalError');
export const Edit = enumeration('Clean Dirty Saving Conflict');
export const Pdf = enumeration('Closed Loading Viewing PasswordRequired Failed');
export const Event = enumeration('Started CloseRequested EffectFailed SettingsLoaded FutureSchemaFound LegacySettingsFound CorruptSettingsFound SettingsUnavailable SettingsLoadFailed MigrationApproved MigrationRejected RestoreSelected InitializeSelected ReadOnlySelected ResolutionFailed EditRequested DraftChanged SaveRequested SaveSucceeded SaveConflict SaveFailed EditDiscarded ReloadRequested GroupSelected SyncRequested SyncSucceeded SyncFailed ActivateRequested LaunchSucceeded LaunchFailed ForegroundDenied BatchLaunchRequested BatchLaunchCompleted BatchLaunchCancelled PdfOpenRequested PdfReady PdfPasswordRequired PdfFailed PdfClosed FatalError SearchChanged ResizeChanged GenerationResetRequested');
export const Effect = enumeration('LoadSettings ResolveSettings SaveSettings SyncStatuses Activate BatchLaunch ReplacePdf ClosePdf CloseWindow');

export function initialState() {
  return { lifecycle: Lifecycle.Booting, edit: Edit.Clean, sync: { kind: 'Idle' },
    launch: { running: [], batch: null }, pdf: { kind: Pdf.Closed },
    config_revision: 0, state_generation: 0, saved_config: null, draft: null,
    candidates: [], resolution: null, saving: null, selected_group_id: null,
    statuses: [], launch_results: [], query: '', width: null };
}
const valid = (type, value) => { try { return validate(type, value); } catch { return null; } };
const material = (s, id) => s.saved_config?.materials.find(m => m.id === id);
const group = (s, id) => s.saved_config?.groups.some(g => g.id === id);
const editable = s => s.lifecycle === Lifecycle.Ready && !s.resolution;
const busy = s => s.edit === Edit.Saving || s.sync.kind === 'Running' || s.launch.running.length || s.launch.batch || s.pdf.kind === Pdf.Loading || s.resolution;

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
      return result({ ...s, sync: { kind: 'Idle' }, statuses: e.type === Event.SyncSucceeded ? structuredClone(e.results) : s.statuses }, [], e.type === Event.SyncFailed ? e.error : null);
    case Event.ActivateRequested:
      if (!editable(s) || !material(s, e.material_id) || s.launch.running.some(x => x.material_id === e.material_id) || s.launch.batch?.material_ids.includes(e.material_id)) return deny();
      return result({ ...s, launch: { ...s.launch, running: [...s.launch.running, { material_id: e.material_id, generation: s.state_generation }] } },
        [effect(Effect.Activate, { material_id: e.material_id })]);
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
      return result({ ...s, launch: { ...s.launch, batch: { group_id: e.group_id, material_ids: ids, generation: s.state_generation } } }, [effect(Effect.BatchLaunch, { group_id: e.group_id })]);
    }
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
    case Event.PdfReady:
    case Event.PdfPasswordRequired:
    case Event.PdfFailed:
      if (e.generation !== s.state_generation || e.generation !== s.pdf.generation || e.material_id !== s.pdf.material_id) return result(s, [], null, 'stale_pdf');
      if (!(s.pdf.kind === Pdf.Loading || (e.type === Event.PdfFailed && s.pdf.kind === Pdf.Viewing))) return deny();
      return result({ ...s, pdf: { ...s.pdf, kind: e.type === Event.PdfReady ? Pdf.Viewing : e.type === Event.PdfPasswordRequired ? Pdf.PasswordRequired : Pdf.Failed,
        ...(e.type === Event.PdfFailed ? { code: e.error.code } : {}) } }, [], e.error ?? null);
    case Event.PdfClosed: {
      const generation = bump();
      if (s.pdf.kind === Pdf.Closed || generation === null) return deny();
      return result({ ...s, state_generation: generation, pdf: { kind: Pdf.Closed } }, [effect(Effect.ClosePdf, {})]);
    }
    case Event.SearchChanged:
      return typeof e.value === 'string' ? result({ ...s, query: e.value }) : deny();
    case Event.ResizeChanged:
      return Number.isFinite(e.value) && e.value >= 0 ? result({ ...s, width: e.value }) : deny();
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
  return { lifecycle: s.lifecycle, edit: s.edit, sync: s.sync, launch: s.launch, pdf: s.pdf,
    config_revision: s.config_revision, state_generation: s.state_generation,
    can_edit: editable(s) && s.edit !== Edit.Saving, can_launch: editable(s),
    config: s.draft ?? s.saved_config, statuses: s.statuses, launch_results: s.launch_results,
    candidates: s.candidates, selected_group_id: s.selected_group_id,
    query: s.query, width: s.width, notice: result.notice };
}
