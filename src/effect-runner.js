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
export function createServices(ipc, pdf, lifecycle) {
  return Object.freeze({
    settings: Object.freeze({ load: () => ipc.call('load_settings'), resolve: r => ipc.call('resolve_settings_issue', r), save: r => ipc.call('save_settings', r) }),
    statuses: Object.freeze({ sync: r => ipc.call('sync_material_statuses', r) }),
    launch: Object.freeze({ activate: r => ipc.call('activate_or_launch', r), batch: r => ipc.call('batch_launch_main', r) }),
    pdf, lifecycle,
  });
}

/** No timers or retries. Start effects in list order without waiting for unrelated
 * I/O. A WeakSet prevents accidental redelivery without accumulating a history.
 * pdf.replace owns cancel -> Canvas reset -> cleanup -> destroy -> load (Phase 6).
 */
export function createEffectRunner(services, dispatch, onIdle = () => {}) {
  const seen = new WeakSet(), pending = new Set();
  async function execute(f) {
    const context = { generation: f.generation, material_id: f.request.material_id, group_id: f.request.group_id };
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
          event = { type: Event.SyncSucceeded, request_id: r.request_id, results: r.results }; break;
        }
        case Effect.Activate: {
          const r = validate('LaunchResponse', await services.launch.activate(f.request));
          if (r.material_id !== f.request.material_id) throw appError('INTERNAL_ERROR');
          event = { type: r.outcome === 'foreground_denied' ? Event.ForegroundDenied : r.error ? Event.LaunchFailed : Event.LaunchSucceeded, response: r, ...context }; break;
        }
        case Effect.BatchLaunch:
          event = { type: Event.BatchLaunchCompleted, response: validate('BatchLaunchResponse', await services.launch.batch(f.request)), ...context }; break;
        case Effect.ReplacePdf:
          await services.pdf.replace(f.request); event = { type: Event.PdfReady, ...context }; break;
        case Effect.ClosePdf: await services.pdf.close(); return;
        case Effect.CloseWindow: await services.lifecycle.close(); return;
        default: throw appError('INTERNAL_ERROR');
      }
    } catch (raw) {
      const error = safeError(raw);
      const type = {
        [Effect.LoadSettings]: Event.SettingsLoadFailed, [Effect.ResolveSettings]: Event.ResolutionFailed,
        [Effect.SaveSettings]: error.code === 'CONFIG_CONFLICT' ? Event.SaveConflict : Event.SaveFailed,
        [Effect.SyncStatuses]: Event.SyncFailed, [Effect.Activate]: Event.LaunchFailed,
        [Effect.BatchLaunch]: Event.BatchLaunchCompleted,
        [Effect.ReplacePdf]: error.code === 'PDF_PASSWORD_REQUIRED' ? Event.PdfPasswordRequired : Event.PdfFailed,
        [Effect.ClosePdf]: Event.EffectFailed, [Effect.CloseWindow]: Event.EffectFailed,
      }[f.type] ?? Event.FatalError;
      event = { type, error, ...context, effect_type: f.type, request_id: f.request.request_id };
    }
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
