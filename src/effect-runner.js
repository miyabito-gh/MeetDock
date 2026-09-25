import { appError, validate } from './contracts.js';
import { Event, Effect } from './model.js';

function safeError(error) {
  try { return validate('AppError', error); } catch { return appError('INTERNAL_ERROR'); }
}
function settingsEvent(response) {
  const r = validate('SettingsLoadResponse', response);
  const type = { ready: Event.SettingsLoaded, migration_required: Event.LegacySettingsFound,
    recovery_required: Event.CorruptSettingsFound, read_only_future_schema: Event.FutureSchemaFound,
    read_only_unavailable: Event.SettingsUnavailable }[r.mode];
  return { type, response: r, config: r.config };
}

// Thin application-service ports. Actual IPC is only reachable through these ports.
export function createServices(ipc, pdf, lifecycle, fullscreen = { set: async () => {} }) {
  return Object.freeze({
    settings: Object.freeze({ load: () => ipc.call('load_settings'), resolve: r => ipc.call('resolve_settings_issue', r), save: r => ipc.call('save_settings', r) }),
    statuses: Object.freeze({ sync: r => ipc.call('sync_material_statuses', r) }),
    windows: Object.freeze({ list: r => ipc.call('list_windows', r), activate: r => ipc.call('activate_window', r), close: r => ipc.call('close_window', r), saveExclusions: r => ipc.call('save_window_exclusions', r), saveSnapshot:()=>ipc.call('save_window_snapshot'), loadSnapshot:()=>ipc.call('load_window_snapshot'), clearSnapshot:()=>ipc.call('clear_window_snapshot'), launchSnapshotItem:r=>ipc.call('launch_window_snapshot_item',r) }),
    launch: Object.freeze({ activate: r => ipc.call('activate_or_launch', r), batch: r => ipc.call('batch_launch_main', r), openContainingFolder: r => ipc.call('open_containing_folder', r) }),
    droppedFiles: Object.freeze({ prepare: r => ipc.call('prepare_dropped_files', r) }),
    pdfSidecars: Object.freeze({ load: r => ipc.call('load_pdf_sidecar', r), save: r => ipc.call('save_pdf_sidecar', r), remove: r => ipc.call('remove_pdf_sidecar', r) }),
    pdf, lifecycle, fullscreen,
  });
}

/** No timers or retries. Start effects in list order without waiting for unrelated
 * I/O. A WeakSet prevents accidental redelivery without accumulating a history.
 * pdf.replace owns cancel -> Canvas reset -> cleanup -> destroy -> load (Phase 6).
 */
export function createEffectRunner(services, dispatch, onIdle = () => {}) {
  const seen = new WeakSet(), pending = new Set(), batches = new Map();
  let fullscreenQueue = Promise.resolve();
  async function execute(f) {
    const context = { generation: f.generation, material_id: f.request.material_id, pdf_identity: f.request.pdf_identity, window_id: f.request.window_id, group_id: f.group_id ?? f.request.group_id, index:f.request.index,
      ...(Number.isSafeInteger(f.request.search_generation) ? { search_generation: f.request.search_generation } : {}) };
    let event;
    try {
      switch (f.type) {
        case Effect.LoadSettings: event = settingsEvent(await services.settings.load()); break;
        case Effect.ResolveSettings: event = settingsEvent(await services.settings.resolve(f.request)); break;
        case Effect.SaveSettings:
          {
            const response = validate('SaveSettingsResponse', await services.settings.save(f.request));
            if (response.revision !== f.request.expected_revision + 1) throw appError('INTERNAL_ERROR');
            event = { type: Event.SaveSucceeded, response, ...context }; break;
          }
        case Effect.SyncStatuses: {
          const r = validate('SyncStatusesResponse', await services.statuses.sync(f.request));
          if (r.request_id !== f.request.request_id) throw appError('INTERNAL_ERROR');
          event = { type: Event.SyncSucceeded, request_id: r.request_id, results: r.results, completed_at: Date.now() }; break;
        }
        case Effect.SyncWindows: {
          const r = validate('ListWindowsResponse', await services.windows.list(f.request));
          if (r.request_id !== f.request.request_id) throw appError('INTERNAL_ERROR');
          event = { type: Event.WindowSyncSucceeded, response: r, request_id: r.request_id, completed_at: Date.now() }; break;
        }
        case Effect.ActivateWindow: {
          const r = validate('WindowActionResponse', await services.windows.activate(f.request));
          if (r.window_id !== f.request.window_id) throw appError('INTERNAL_ERROR');
          event = { type: Event.WindowActivateSucceeded, response: r, ...context }; break;
        }
        case Effect.RequestWindowClose: {
          const r = validate('WindowActionResponse', await services.windows.close(f.request));
          if (r.window_id !== f.request.window_id) throw appError('INTERNAL_ERROR');
          event = { type: Event.WindowCloseSucceeded, response: r, ...context }; break;
        }
        case Effect.SaveWindowExclusions: {
          const r = validate('SaveWindowExclusionsResponse', await services.windows.saveExclusions(f.request));
          event = { type: Event.WindowExclusionsSaved, response: r, ...context }; break;
        }
        case Effect.SaveWindowSnapshot: event={type:Event.WindowSnapshotSaved,response:await services.windows.saveSnapshot(),...context};break;
        case Effect.LoadWindowSnapshot: event={type:Event.WindowSnapshotLoaded,response:await services.windows.loadSnapshot(),...context};break;
        case Effect.ClearWindowSnapshot: event={type:Event.WindowSnapshotClearSucceeded,removed:await services.windows.clearSnapshot(),...context};break;
        case Effect.LaunchWindowSnapshotItem: {
          const r=await services.windows.launchSnapshotItem(f.request);if(r?.index!==f.request.index)throw appError('INTERNAL_ERROR');
          event={type:Event.WindowSnapshotLaunchSucceeded,index:r.index,...context};break;
        }
        case Effect.BatchLaunchWindowSnapshot: {
          let error=null;for(const index of f.request.indices){try{const r=await services.windows.launchSnapshotItem({index});if(r?.index!==index)throw appError('INTERNAL_ERROR')}catch(raw){error=safeError(raw)}}
          event={type:Event.WindowSnapshotLaunchAllCompleted,error,...context};break;
        }
        case Effect.Activate: {
          const r = validate('LaunchResponse', await services.launch.activate(f.request));
          if (r.material_id !== f.request.material_id) throw appError('INTERNAL_ERROR');
          event = { type: r.outcome === 'foreground_denied' ? Event.ForegroundDenied : r.error ? Event.LaunchFailed : Event.LaunchSucceeded, response: r, ...context }; break;
        }
        case Effect.OpenContainingFolder:
          await services.launch.openContainingFolder(f.request); event = { type: Event.OpenContainingFolderCompleted, ...context }; break;
        case Effect.PrepareDroppedFiles: {
          const response = validate('PrepareDroppedFilesResponse', await services.droppedFiles.prepare(f.request));
          event = { type: Event.DroppedFilesPrepared, response, ...context }; break;
        }
        case Effect.BatchLaunch: {
          const control = { cancelled: false }; batches.set(f.request.group_id, control);
          const results = [];
          for (let index = 0; index < f.request.material_ids.length; index++) {
            if (control.cancelled) break;
            if (index) await new Promise(resolve => setTimeout(resolve, 250));
            if (control.cancelled) break;
            try { results.push(validate('LaunchResponse', await services.launch.activate({ material_id: f.request.material_ids[index], explorer_open_mode: f.request.explorer_open_mode }))); }
            catch (raw) { results.push({ material_id: f.request.material_ids[index], outcome: 'launch_failed', error: safeError(raw) }); }
            dispatch({ type: Event.BatchLaunchProgressed, completed: results.length, ...context });
          }
          batches.delete(f.request.group_id);
          event = { type: control.cancelled ? Event.BatchLaunchCancelled : Event.BatchLaunchCompleted,
            response: validate('BatchLaunchResponse', { results }), ...context }; break;
        }
        case Effect.CancelBatch:
          if (batches.has(f.request.group_id)) batches.get(f.request.group_id).cancelled = true;
          return;
        case Effect.ReplacePdf: {
          const view = await services.pdf.replace(f.request);
          if (!view) return;
          event = { type: Event.PdfReady, view, ...context }; break;
        }
        case Effect.ClosePdf: await services.pdf.close(); return;
        case Effect.SetFullscreen: {
          const operation = fullscreenQueue.catch(() => {}).then(() => services.fullscreen.set(f.request.value));
          fullscreenQueue = operation;
          await operation;
          event = { type: Event.PdfFullscreenSucceeded, value: f.request.value, request: f.request.request }; break;
        }
        case Effect.LoadPdfSidecar: event = { type: Event.PdfSidecarLoaded, sidecar: await services.pdfSidecars.load(f.request), ...context }; break;
        case Effect.SavePdfSidecar: event = { type: Event.PdfSidecarSaved, sidecar: await services.pdfSidecars.save(f.request), ...context }; break;
        case Effect.RemovePdfSidecar: event = { type: Event.PdfSidecarRemoved, removed: await services.pdfSidecars.remove(f.request), ...context }; break;
        case Effect.PdfPrevious: event = { type: Event.PdfViewChanged, view: await services.pdf.previous(f.request), ...context }; break;
        case Effect.PdfNext: event = { type: Event.PdfViewChanged, view: await services.pdf.next(f.request), ...context }; break;
        case Effect.PdfGoToPage: event = { type: Event.PdfViewChanged, view: await services.pdf.goToPage(f.request.page, f.request), ...context }; break;
        case Effect.PdfZoomIn: event = { type: Event.PdfViewChanged, view: await services.pdf.zoomIn(f.request), ...context }; break;
        case Effect.PdfZoomOut: event = { type: Event.PdfViewChanged, view: await services.pdf.zoomOut(f.request), ...context }; break;
        case Effect.PdfFit: event = { type: Event.PdfViewChanged, view: await services.pdf.fit(f.request.viewport_width, f.request), ...context }; break;
        case Effect.PdfSearch: event = { type: Event.PdfSearchCompleted, view: await services.pdf.search(f.request.query, f.request), ...context }; break;
        case Effect.PdfSearchPrevious: event = { type: Event.PdfSearchCompleted, view: await services.pdf.searchPrevious(f.request), ...context }; break;
        case Effect.PdfSearchNext: event = { type: Event.PdfSearchCompleted, view: await services.pdf.searchNext(f.request), ...context }; break;
        case Effect.CloseWindow: await services.lifecycle.close(); return;
        default: throw appError('INTERNAL_ERROR');
      }
    } catch (raw) {
      const error = safeError(raw);
      const type = {
        [Effect.LoadSettings]: Event.SettingsLoadFailed, [Effect.ResolveSettings]: Event.ResolutionFailed,
        [Effect.SaveSettings]: error.code === 'CONFIG_CONFLICT' ? Event.SaveConflict : Event.SaveFailed,
        [Effect.SyncStatuses]: Event.SyncFailed, [Effect.SyncWindows]: Event.WindowSyncFailed,
        [Effect.ActivateWindow]: Event.WindowActivateFailed, [Effect.RequestWindowClose]: Event.WindowCloseFailed,
        [Effect.SaveWindowExclusions]: Event.WindowExclusionsSaveFailed,
        [Effect.SaveWindowSnapshot]: Event.WindowSnapshotSaveFailed, [Effect.LoadWindowSnapshot]: Event.WindowSnapshotLoadFailed, [Effect.ClearWindowSnapshot]: Event.WindowSnapshotClearFailed,
        [Effect.LaunchWindowSnapshotItem]: Event.WindowSnapshotLaunchFailed, [Effect.BatchLaunchWindowSnapshot]: Event.WindowSnapshotLaunchAllCompleted,
        [Effect.Activate]: Event.LaunchFailed, [Effect.OpenContainingFolder]: Event.OpenContainingFolderCompleted,
        [Effect.PrepareDroppedFiles]: Event.DroppedFilesPrepareFailed,
        [Effect.BatchLaunch]: Event.BatchLaunchCompleted,
        [Effect.ReplacePdf]: error.code === 'PDF_PASSWORD_REQUIRED' ? Event.PdfPasswordRequired : Event.PdfFailed,
        [Effect.SetFullscreen]: Event.PdfFullscreenFailed,
        [Effect.ClosePdf]: Event.EffectFailed, [Effect.LoadPdfSidecar]: Event.PdfSidecarFailed, [Effect.SavePdfSidecar]: Event.PdfSidecarFailed, [Effect.RemovePdfSidecar]: Event.PdfSidecarFailed, [Effect.PdfPrevious]: Event.PdfFailed, [Effect.PdfNext]: Event.PdfFailed,
        [Effect.PdfZoomIn]: Event.PdfFailed, [Effect.PdfZoomOut]: Event.PdfFailed, [Effect.PdfFit]: Event.PdfFailed,
        [Effect.PdfSearch]: Event.PdfFailed, [Effect.PdfSearchPrevious]: Event.PdfFailed, [Effect.PdfSearchNext]: Event.PdfFailed, [Effect.CloseWindow]: Event.EffectFailed,
      }[f.type] ?? Event.FatalError;
      event = { type, error, ...context, value: f.request.value, request: f.request.request, effect_type: f.type, request_id: f.request.request_id };
    }
    if ([Event.PdfViewChanged, Event.PdfSearchCompleted].includes(event?.type) && !event.view) return;
    dispatch(event);
  }
  return Object.freeze({
    run(effects) {
      for (const effect of effects) {
        if (seen.has(effect)) continue;
        seen.add(effect);
        const promise = execute(effect);
        pending.add(promise);
        // Catch delivery errors as well; never leave a rejected promise unobserved.
        promise.catch(() => dispatch({ type: Event.FatalError })).finally(() => {
          pending.delete(promise); if (!pending.size) onIdle();
        }).catch(() => {});
      }
    },
    get pendingCount() { return pending.size; },
    async settled() { while (pending.size) await Promise.allSettled([...pending]); },
  });
}
