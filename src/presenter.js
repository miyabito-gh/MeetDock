import { Event } from './model.js';
import { id } from './contracts.js';

// Phase-2 input/render boundary; no product UI and no direct Service/IPC access.
export function createPresenter(view, dispatch) {
  return Object.freeze({
    render: model => view.render(model),
    activate(material_id) { id(material_id); dispatch({ type: Event.ActivateRequested, material_id }); },
    batch(group_id) { id(group_id); dispatch({ type: Event.BatchLaunchRequested, group_id }); },
    edit() { dispatch({ type: Event.EditRequested }); },
    save() { dispatch({ type: Event.SaveRequested }); },
    discard(confirmed) { dispatch({ type: Event.EditDiscarded, confirmed: confirmed === true }); },
    search(value) { if (typeof value !== 'string') throw new TypeError('Expected text'); dispatch({ type: Event.SearchChanged, value }); },
    resize(value) { if (!Number.isFinite(value)) throw new TypeError('Expected width'); dispatch({ type: Event.ResizeChanged, value }); },
  });
}
