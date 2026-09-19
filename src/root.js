import { Event, initialState } from './model.js';
import { createDispatcher } from './event-chain.js';
import { createEffectRunner } from './effect-runner.js';

// Composition only; no OS, DOM, persistence, or per-material decisions.
export function createRoot({ services, presenter, diagnostic = () => {} }) {
  let runner;
  const dispatcher = createDispatcher({ initial: initialState(), render: model => presenter.render(model),
    runEffects: effects => runner.run(effects), diagnostic, availableEffects: () => 256 - runner.pendingCount });
  const resetGeneration = () => {
    if (dispatcher.getState().state_generation === Number.MAX_SAFE_INTEGER)
      dispatcher.dispatch({ type: Event.GenerationResetRequested, quiescent: true });
  };
  const dispatch = event => {
    if (runner.pendingCount === 0) resetGeneration();
    return dispatcher.dispatch(event);
  };
  runner = createEffectRunner(services, dispatch, resetGeneration);
  return Object.freeze({ dispatch, getState: dispatcher.getState,
    start: () => dispatch({ type: Event.Started }), settled: runner.settled });
}
