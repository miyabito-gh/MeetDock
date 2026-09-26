import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createIpcAdapter } from './ipc-adapter.js';
import { createServices } from './effect-runner.js';
import { createFocusSync } from './focus-sync.js';
import { createProductionPdfViewAdapter } from './pdf-runtime.js';
import { createPresenter } from './presenter.js';
import { createRoot } from './root.js';
import { Event } from './model.js';
import { handleCloseRequest } from './event-chain.js';
import { createAppView } from './view.js';
import './mock-styles.css';
import './visibility.css';

const view = createAppView(document.querySelector('#app'));
const pdf = createProductionPdfViewAdapter({ canvas: view.canvas, requestPassword: request => view.requestPassword(request) });
const services = createServices(createIpcAdapter(invoke), pdf, { close: async () => getCurrentWindow().destroy() }, { set: value => getCurrentWindow().setFullscreen(value) });
let root;
const presenter = createPresenter(view, event => root.dispatch(event));
root = createRoot({ services, presenter, diagnostic: code => console.warn(`MeetDock diagnostic: ${code}`) });
view.bind(presenter);
const syncOnFocus = createFocusSync({
  sync: (requestId, manual) => presenter.sync(requestId, manual),
  canSync: () => {
    const state = root.getState();
    return ['Ready', 'ReadOnly'].includes(state.lifecycle) && !state.windowing.dialog_open;
  },
});
window.addEventListener('focus', syncOnFocus);
let closePending = false;
const waitForSave = () => new Promise(resolve => {
  const timer = setInterval(() => {
    if (root.getState().edit === 'Saving') return;
    clearInterval(timer); resolve(root.getState().edit === 'Clean');
  }, 50);
});
getCurrentWindow().onCloseRequested(async event => {
  event.preventDefault();
  if (closePending) return;
  closePending = true;
  try {
    await handleCloseRequest({
      getState: () => root.getState(),
      choose: edit => view.requestCloseChoice(edit),
      save: () => presenter.save(), discard: () => presenter.discard(true), waitForSave,
      close: () => root.dispatch({ type: Event.CloseRequested }),
    });
  } finally { closePending = false; }
}).catch(() => {});
getCurrentWindow().onDragDropEvent(event => {
  const payload = event.payload;
  document.querySelector('.drop-zone')?.classList.toggle('dragover', payload.type === 'over');
  if (payload.type === 'drop') view.nativeFilesDropped(payload.paths ?? []);
}).catch(() => {});
root.start();
