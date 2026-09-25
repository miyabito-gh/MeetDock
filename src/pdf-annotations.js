export const MARKER_COLORS = Object.freeze(['yellow', 'green', 'pink']);
export const MARKER_WIDTHS = Object.freeze({ thin: 0.004, standard: 0.008, thick: 0.014 });
export const PDF_ANNOTATIONS_FORMAT = 'meetdock-pdf-annotations';
export const PDF_ANNOTATIONS_VERSION = 1;

const finite = value => Number.isFinite(value);
const clamp = value => Math.min(1, Math.max(0, value));

export function normalizePoint(x, y, width, height) {
  if (![x, y, width, height].every(finite) || width <= 0 || height <= 0) {
    throw new TypeError('描画座標とページサイズには有限の正数を指定してください');
  }
  return { x: clamp(x / width), y: clamp(y / height) };
}

export function createStroke({ id, page, color = 'yellow', width = 'standard', points }) {
  if (typeof id !== 'string' || !id || !Number.isInteger(page) || page < 1) throw new TypeError('無効なマーカーです');
  if (!MARKER_COLORS.includes(color) || !Object.hasOwn(MARKER_WIDTHS, width)) throw new TypeError('無効な色または太さです');
  if (!Array.isArray(points) || points.length === 0 || points.some(point => !validPoint(point))) throw new TypeError('無効な描画点です');
  return { id, page, color, width, points: points.map(point => ({ x: point.x, y: point.y })) };
}

function validPoint(point) {
  return point && finite(point.x) && finite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
}

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared);
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

export function hitTestStroke(stroke, point, radius = 0.01) {
  if (!stroke || !validPoint(point) || !finite(radius) || radius < 0 || !Array.isArray(stroke.points) || stroke.points.length === 0) return false;
  const tolerance = radius + (MARKER_WIDTHS[stroke.width] ?? 0) / 2;
  if (stroke.points.length === 1) return Math.hypot(point.x - stroke.points[0].x, point.y - stroke.points[0].y) <= tolerance;
  return stroke.points.slice(1).some((current, index) => distanceToSegment(point, stroke.points[index], current) <= tolerance + Number.EPSILON);
}

export function eraseAt(strokes, page, point, radius) {
  return strokes.filter(stroke => stroke.page !== page || !hitTestStroke(stroke, point, radius));
}

export function createAnnotationHistory(initial = []) {
  return { present: structuredClone(initial), past: [], future: [] };
}

export function annotationSessionChange(activeKey, activeGeneration, activeValue, dirty, key, generation, value) {
  if (key !== activeKey || generation !== activeGeneration) return 'reset';
  if (dirty || value === activeValue) return 'keep';
  return 'load';
}

export function commitAnnotations(history, next) {
  if (JSON.stringify(history.present) === JSON.stringify(next)) return history;
  return { present: structuredClone(next), past: [...history.past, history.present], future: [] };
}

export function undoAnnotations(history) {
  if (history.past.length === 0) return history;
  return { present: history.past.at(-1), past: history.past.slice(0, -1), future: [history.present, ...history.future] };
}

export function redoAnnotations(history) {
  if (history.future.length === 0) return history;
  return { present: history.future[0], past: [...history.past, history.present], future: history.future.slice(1) };
}

export function addBookmark(bookmarks, page, id) {
  if (!Number.isInteger(page) || page < 1 || typeof id !== 'string' || !id) throw new TypeError('無効なしおりです');
  const existing = bookmarks.find(bookmark => bookmark.page === page);
  return existing ? { bookmarks, bookmark: existing, created: false } : {
    bookmarks: [...bookmarks, { id, page, name: `p.${page}` }], bookmark: { id, page, name: `p.${page}` }, created: true,
  };
}

export function renameBookmark(bookmarks, id, name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) throw new TypeError('しおり名は空にできません');
  return bookmarks.map(bookmark => bookmark.id === id ? { ...bookmark, name: trimmed } : bookmark);
}

export const deleteBookmark = (bookmarks, id) => bookmarks.filter(bookmark => bookmark.id !== id);

export function reorderBookmark(bookmarks, id, targetIndex) {
  const from = bookmarks.findIndex(bookmark => bookmark.id === id);
  if (from < 0 || !Number.isInteger(targetIndex)) return bookmarks;
  const result = bookmarks.slice();
  const [bookmark] = result.splice(from, 1);
  result.splice(Math.max(0, Math.min(targetIndex, result.length)), 0, bookmark);
  return result;
}

export function exportPdfAnnotations({ materialId, pdfIdentity, strokes = [], bookmarks = [] }) {
  const envelope = { format: PDF_ANNOTATIONS_FORMAT, version: PDF_ANNOTATIONS_VERSION, materialId, pdfIdentity, strokes, bookmarks };
  validateEnvelope(envelope);
  return structuredClone(envelope);
}

export function importPdfAnnotations(value, expected = {}) {
  const envelope = typeof value === 'string' ? JSON.parse(value) : value;
  validateEnvelope(envelope);
  if (expected.materialId && envelope.materialId !== expected.materialId) throw new TypeError('資料IDが一致しません');
  if (expected.pdfIdentity && envelope.pdfIdentity !== expected.pdfIdentity) throw new TypeError('PDF識別情報が一致しません');
  return structuredClone(envelope);
}

function validateEnvelope(value) {
  if (!value || value.format !== PDF_ANNOTATIONS_FORMAT || value.version !== PDF_ANNOTATIONS_VERSION || typeof value.materialId !== 'string' || !value.materialId || typeof value.pdfIdentity !== 'string' || !value.pdfIdentity) throw new TypeError('未対応のPDF注釈データです');
  if (!Array.isArray(value.strokes) || !Array.isArray(value.bookmarks)) throw new TypeError('PDF注釈データが壊れています');
  value.strokes.forEach(stroke => createStroke(stroke));
  const pages = new Set();
  for (const bookmark of value.bookmarks) {
    if (!bookmark || typeof bookmark.id !== 'string' || !bookmark.id || !Number.isInteger(bookmark.page) || bookmark.page < 1 || typeof bookmark.name !== 'string' || !bookmark.name.trim() || pages.has(bookmark.page)) throw new TypeError('無効なしおりデータです');
    pages.add(bookmark.page);
  }
}
