export function createPdfWheelState() {
  return { accumulated: 0 };
}

export function resetPdfWheel() {
  return createPdfWheelState();
}

export function accumulatePdfWheel(state, deltaY, { threshold = 100, inverted = false } = {}) {
  if (!Number.isFinite(deltaY) || !Number.isFinite(threshold) || threshold <= 0) throw new TypeError('無効なホイール入力です');
  const accumulated = (state?.accumulated ?? 0) + (inverted ? -deltaY : deltaY);
  if (Math.abs(accumulated) < threshold) return { state: { accumulated }, direction: null };
  return { state: createPdfWheelState(), direction: accumulated > 0 ? 'next' : 'previous' };
}
