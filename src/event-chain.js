import { Event, Effect, transition, renderModel } from './model.js';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}

export function createRootLifecycleHandler() {
  let closing = false;
  return (state, event) => {
    if (event.type === Event.EffectFailed && event.effect_type === Effect.CloseWindow) {
      closing = false;
      return { handled: true, state, effects: [], notice: event.error };
    }
    if (event.type !== Event.CloseRequested) return { handled: false };
    const effects = closing ? [] : [{ type: Effect.CloseWindow, request: {}, generation: state.state_generation }];
    closing = true;
    return { handled: true, state, effects, notice: null };
  };
}
export const mediatorHandler = (state, event) => transition(state, event);
export function diagnosticFallback(state) {
  return { handled: true, state, effects: [], notice: null, diagnostic: 'unhandled_event' };
}

/** Fixed CoR only. No handler registration, event forwarding, or async reducer.
 * Overflow fails closed after accepted events drain. This preserves bounded memory
 * and never silently loses a completion while pretending the app is still usable.
 */
export function createDispatcher({ initial, render, runEffects, diagnostic = () => {}, availableEffects = () => 256 }) {
  let state = freeze(initial), draining = false, overflow = false;
  const queue = [], rootLifecycleHandler = createRootLifecycleHandler();
  function dispatch(event) {
    const last = queue.at(-1);
    if ([Event.SearchChanged, Event.ResizeChanged].includes(event.type) && last?.type === event.type) queue[queue.length - 1] = structuredClone(event);
    else {
      if (queue.length >= 256) { overflow = true; diagnostic('event_queue_full'); return false; }
      queue.push(structuredClone(event));
    }
    if (draining) return true;
    draining = true;
    try {
      while (queue.length || overflow) {
        const next = queue.length ? queue.shift() : { type: Event.FatalError };
        if (!queue.length && next.type === Event.FatalError) overflow = false;
        let result = rootLifecycleHandler(state, next);
        if (!result.handled) result = mediatorHandler(state, next);
        if (!result.handled) result = diagnosticFallback(state);
        if (result.effects.length > availableEffects())
          result = { handled: true, state, effects: [], notice: '処理中です。完了後に再操作してください。', diagnostic: 'effect_capacity' };
        state = freeze(result.state);
        if (result.diagnostic) diagnostic(result.diagnostic);
        render(freeze(renderModel(result)));
        runEffects(freeze(result.effects));
      }
    } finally { draining = false; }
    return true;
  }
  return Object.freeze({ dispatch, getState: () => state, get queuedCount() { return queue.length; } });
}
