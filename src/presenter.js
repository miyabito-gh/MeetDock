import { Event } from './model.js';
import { id } from './contracts.js';

// Phase-2 input/render boundary; no product UI and no direct Service/IPC access.
export function createPresenter(view, dispatch) {
  return Object.freeze({
    render: model => view.render(model),
    selectGroup(group_id) { id(group_id); dispatch({ type: Event.GroupSelected, group_id }); },
    activate(material_id) { id(material_id); dispatch({ type: Event.ActivateRequested, material_id }); },
    batch(group_id) { id(group_id); dispatch({ type: Event.BatchLaunchRequested, group_id }); },
    cancelBatch(group_id) { id(group_id); dispatch({ type: Event.BatchLaunchCancelRequested, group_id }); },
    edit() { dispatch({ type: Event.EditRequested }); },
    addGroup(group) { dispatch({ type: Event.GroupAdded, group: structuredClone(group) }); },
    renameGroup(group_id, name) { id(group_id); dispatch({ type: Event.GroupRenamed, group_id, name }); },
    deleteGroup(group_id, confirmed) { id(group_id); dispatch({ type: Event.GroupDeleted, group_id, confirmed }); },
    reorderGroup(group_id, before_group_id) { id(group_id); id(before_group_id); dispatch({ type: Event.GroupReordered, group_id, before_group_id }); },
    addMaterial(material) { dispatch({ type: Event.MaterialAdded, material: structuredClone(material) }); },
    updateMaterial(material) { id(material.id); dispatch({ type: Event.MaterialUpdated, material: structuredClone(material) }); },
    deleteMaterial(material_id, confirmed) { id(material_id); dispatch({ type: Event.MaterialDeleted, material_id, confirmed }); },
    reorderMaterial(material_id, before_material_id) { id(material_id); id(before_material_id); dispatch({ type: Event.MaterialReordered, material_id, before_material_id }); },
    nativeFilesDropped(group_id, paths) {
      id(group_id); if (!Array.isArray(paths)) throw new TypeError('Expected paths');
      dispatch({ type: Event.NativeFilesDropped, group_id, paths: paths.map(String) });
    },
    confirmDroppedFiles(group_id, role) { id(group_id); dispatch({ type: Event.DroppedFilesConfirmed, group_id, role }); },
    cancelDroppedFiles() { dispatch({ type: Event.DroppedFilesCancelled }); },
    changeDraft(config) { dispatch({ type: Event.DraftChanged, config: structuredClone(config) }); },
    save() { dispatch({ type: Event.SaveRequested }); },
    discard(confirmed) { dispatch({ type: Event.EditDiscarded, confirmed: confirmed === true }); },
    reload(confirmed) { dispatch({ type: Event.ReloadRequested, confirmed: confirmed === true }); },
    sync(request_id, manual = true) { dispatch({ type: Event.SyncRequested, request_id, manual }); },
    openWindows() { dispatch({ type: Event.WindowDialogOpened }); },
    closeWindows() { dispatch({ type: Event.WindowDialogClosed }); },
    activateWindow(window_id) { id(window_id); dispatch({ type: Event.WindowActivateRequested, window_id }); },
    closeExternalWindow(window_id) { id(window_id); dispatch({ type: Event.WindowCloseRequested, window_id }); },
    saveWindowExclusions(patterns) {
      if (!Array.isArray(patterns)) throw new TypeError('Expected patterns');
      dispatch({ type: Event.WindowExclusionsSaveRequested, patterns: patterns.map(String) });
    },
    openPdf(material_id) { id(material_id); dispatch({ type: Event.PdfOpenRequested, material_id }); },
    pdfDocumentPrevious() { dispatch({ type: Event.PdfDocumentPreviousRequested }); },
    pdfDocumentNext() { dispatch({ type: Event.PdfDocumentNextRequested }); },
    openPdfExternal() { dispatch({ type: Event.PdfOpenExternalRequested }); },
    closePdf() { dispatch({ type: Event.PdfClosed }); },
    openContainingFolder(material_id) { id(material_id); dispatch({ type: Event.OpenContainingFolderRequested, material_id }); },
    pdfPrevious() { dispatch({ type: Event.PdfPreviousRequested }); },
    pdfNext() { dispatch({ type: Event.PdfNextRequested }); },
    pdfPage(page) { if (!Number.isSafeInteger(page)) throw new TypeError('Expected page'); dispatch({ type: Event.PdfPageRequested, page }); },
    pdfZoomIn() { dispatch({ type: Event.PdfZoomInRequested }); },
    pdfZoomOut() { dispatch({ type: Event.PdfZoomOutRequested }); },
    pdfFit(viewport_width) { dispatch({ type: Event.PdfFitRequested, viewport_width }); },
    pdfSearch(query) { if (typeof query !== 'string') throw new TypeError('Expected text'); dispatch({ type: Event.PdfSearchRequested, query }); },
    pdfSearchPrevious() { dispatch({ type: Event.PdfSearchPreviousRequested }); },
    pdfSearchNext() { dispatch({ type: Event.PdfSearchNextRequested }); },
    pdfMaximize() { dispatch({ type: Event.PdfMaximizeToggled }); },
    toggleSidebar() { dispatch({ type: Event.SidebarToggled }); },
    sidebarWidth(value) { dispatch({ type: Event.SidebarWidthChanged, value }); },
    pdfWidth(value) { dispatch({ type: Event.PdfWidthChanged, value }); },
    approveMigration(candidate_id) { dispatch({ type: Event.MigrationApproved, candidate_id }); },
    rejectMigration() { dispatch({ type: Event.MigrationRejected }); },
    restore(candidate_id) { dispatch({ type: Event.RestoreSelected, candidate_id }); },
    initialize(confirmed) { dispatch({ type: Event.InitializeSelected, confirmed }); },
    readOnly() { dispatch({ type: Event.ReadOnlySelected }); },
    search(value) { if (typeof value !== 'string') throw new TypeError('Expected text'); dispatch({ type: Event.SearchChanged, value }); },
    resize(value) { if (!Number.isFinite(value)) throw new TypeError('Expected width'); dispatch({ type: Event.ResizeChanged, value }); },
  });
}
