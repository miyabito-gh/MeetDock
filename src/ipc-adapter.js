import { validate, appError } from './contracts.js';

const commands = Object.freeze({
  load_settings: ['LoadSettingsRequest', 'SettingsLoadResponse'],
  resolve_settings_issue: ['ResolveSettingsIssueRequest', 'SettingsLoadResponse'],
  save_settings: ['SaveSettingsRequest', 'SaveSettingsResponse'],
  sync_material_statuses: ['SyncStatusesRequest', 'SyncStatusesResponse'],
  list_windows: ['ListWindowsRequest', 'ListWindowsResponse'],
  activate_window: ['WindowActionRequest', 'WindowActionResponse'],
  close_window: ['WindowActionRequest', 'WindowActionResponse'],
  save_window_exclusions: ['SaveWindowExclusionsRequest', 'SaveWindowExclusionsResponse'],
  activate_or_launch: ['ActivateOrLaunchRequest', 'LaunchResponse'],
  batch_launch_main: ['BatchLaunchRequest', 'BatchLaunchResponse'],
  open_containing_folder: ['OpenContainingFolderRequest', 'EmptyResponse'],
  prepare_dropped_files: ['PrepareDroppedFilesRequest', 'PrepareDroppedFilesResponse'],
  load_pdf_sidecar: ['PdfSidecarKey', 'OptionalPdfSidecar'],
  save_pdf_sidecar: ['PdfSidecar', 'PdfSidecar'],
  remove_pdf_sidecar: ['PdfSidecarKey', 'BooleanResponse'],
});

// Composition Root supplies Tauri invoke; tests supply a plain function.
export function createIpcAdapter(invoke) {
  return Object.freeze({
    async call(command, request = {}) {
      if (!Object.hasOwn(commands, command)) throw appError('INVALID_REQUEST');
      const [input, output] = commands[command];
      let dto;
      try { dto = validate(input, request); }
      catch { throw appError(command === 'save_settings' ? 'VALIDATION_ERROR' : 'INVALID_REQUEST'); }
      let response;
      try { response = await invoke(command, command === 'load_settings' ? {} : { request: dto }); }
      catch (error) {
        let checked;
        try { checked = validate('AppError', error); }
        catch { throw appError('INTERNAL_ERROR'); }
        throw checked;
      }
      try {
        const result = validate(output, response);
        if (command === 'sync_material_statuses' && result.request_id !== dto.request_id) throw new TypeError();
        if (command === 'list_windows' && result.request_id !== dto.request_id) throw new TypeError();
        if (['activate_window', 'close_window'].includes(command) && result.window_id !== dto.window_id) throw new TypeError();
        if (command === 'activate_or_launch' && result.material_id !== dto.material_id) throw new TypeError();
        if (command === 'save_settings' && result.revision !== dto.expected_revision + 1) throw new TypeError();
        return result;
      } catch { throw appError('INTERNAL_ERROR'); }
    },
  });
}
