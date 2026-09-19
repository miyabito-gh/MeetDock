import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createIpcAdapter } from './ipc-adapter.js';
import { createServices } from './effect-runner.js';
import { createFocusSync } from './focus-sync.js';
import { createProductionPdfViewAdapter } from './pdf-runtime.js';
import { createPresenter } from './presenter.js';
import { createRoot } from './root.js';
import { createAppView } from './view.js';
import './mock-styles.css';
import './visibility.css';

const view = createAppView(document.querySelector('#app'));
const pdf = createProductionPdfViewAdapter({ canvas: view.canvas, requestPassword: request => view.requestPassword(request) });
const services = createServices(createIpcAdapter(invoke), pdf, { close: () => getCurrentWindow().close() });
let root;
const presenter = createPresenter(view, event => root.dispatch(event));
root = createRoot({ services, presenter, diagnostic: code => console.warn(`MeetDock diagnostic: ${code}`) });
view.bind(presenter);
const syncOnFocus = createFocusSync({
  sync: (requestId, manual) => presenter.sync(requestId, manual),
  canSync: () => ['Ready', 'ReadOnly'].includes(root.getState().lifecycle),
});
window.addEventListener('focus', syncOnFocus);
getCurrentWindow().onDragDropEvent(event => {
  const payload = event.payload;
  document.querySelector('.drop-zone')?.classList.toggle('dragover', payload.type === 'over');
  if (payload.type === 'drop') view.nativeFilesDropped(payload.paths ?? []);
}).catch(() => {});
root.start();
