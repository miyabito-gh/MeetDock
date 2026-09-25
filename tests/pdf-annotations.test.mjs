import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addBookmark, annotationSessionChange, commitAnnotations, createAnnotationHistory, createStroke, deleteBookmark, eraseAt, exportPdfAnnotations, hitTestStroke, importPdfAnnotations, normalizePoint, redoAnnotations, renameBookmark, reorderBookmark, undoAnnotations } from '../src/pdf-annotations.js';

test('annotation session resets on preview close, reopen and PDF switch but keeps same-page edits', () => {
  const key='m1\0file:a.pdf', other='m2\0file:b.pdf', saved={strokes:[]};
  assert.equal(annotationSessionChange(null,null,null,false,key,1,saved),'reset');
  assert.equal(annotationSessionChange(key,1,saved,false,key,1,saved),'keep');
  assert.equal(annotationSessionChange(key,1,saved,true,key,1,{strokes:[{id:'new'}]}),'keep');
  assert.equal(annotationSessionChange(key,1,saved,true,null,undefined,null),'reset');
  assert.equal(annotationSessionChange(key,1,saved,true,key,2,saved),'reset');
  assert.equal(annotationSessionChange(key,1,saved,true,other,3,saved),'reset');
  assert.equal(annotationSessionChange(key,1,saved,false,key,1,{strokes:[]}), 'load');
});

test('marker strokes use normalized page coordinates and supported styles', () => {
  assert.deepEqual(normalizePoint(50, 25, 100, 100), { x: .5, y: .25 });
  assert.deepEqual(normalizePoint(120, -10, 100, 100), { x: 1, y: 0 });
  assert.throws(() => createStroke({ id: 's', page: 1, color: 'blue', points: [{ x: 0, y: 0 }] }));
});

test('eraser hit-tests stroke segments on the selected page', () => {
  const stroke = createStroke({ id: 's', page: 2, color: 'pink', width: 'thin', points: [{ x: .1, y: .1 }, { x: .9, y: .1 }] });
  assert.equal(hitTestStroke(stroke, { x: .5, y: .103 }, .002), true);
  assert.deepEqual(eraseAt([stroke], 2, { x: .5, y: .103 }, .002), []);
  assert.deepEqual(eraseAt([stroke], 1, { x: .5, y: .103 }, .002), [stroke]);
});

test('annotation history supports undo, redo and clears redo on a new edit', () => {
  let history = createAnnotationHistory([]);
  history = commitAnnotations(history, [{ id: 'one' }]);
  history = undoAnnotations(history);
  assert.deepEqual(history.present, []);
  history = redoAnnotations(history);
  assert.deepEqual(history.present, [{ id: 'one' }]);
  history = undoAnnotations(history);
  history = commitAnnotations(history, [{ id: 'two' }]);
  assert.equal(history.future.length, 0);
});

test('bookmarks are unique per page and support rename, delete and reorder', () => {
  let result = addBookmark([], 3, 'a');
  assert.deepEqual(result.bookmark, { id: 'a', page: 3, name: 'p.3' });
  assert.equal(addBookmark(result.bookmarks, 3, 'duplicate').created, false);
  result = addBookmark(result.bookmarks, 8, 'b');
  let bookmarks = renameBookmark(result.bookmarks, 'b', ' 結論 ');
  bookmarks = reorderBookmark(bookmarks, 'b', 0);
  assert.deepEqual(bookmarks.map(item => item.name), ['結論', 'p.3']);
  assert.deepEqual(deleteBookmark(bookmarks, 'b').map(item => item.id), ['a']);
});

test('material export/import validates envelope, identity and duplicate bookmark pages', () => {
  const envelope = exportPdfAnnotations({ materialId: 'm1', pdfIdentity: 'sha256:x', bookmarks: [{ id: 'b', page: 1, name: 'p.1' }] });
  assert.deepEqual(importPdfAnnotations(JSON.stringify(envelope), { materialId: 'm1', pdfIdentity: 'sha256:x' }), envelope);
  assert.throws(() => importPdfAnnotations({ ...envelope, version: 99 }));
  assert.throws(() => importPdfAnnotations({ ...envelope, bookmarks: [...envelope.bookmarks, { id: 'c', page: 1, name: 'dup' }] }));
  assert.throws(() => importPdfAnnotations(envelope, { materialId: 'other' }));
});
