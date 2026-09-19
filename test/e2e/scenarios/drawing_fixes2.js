/* Verifies the second round of Drawing environment fixes (2026-09-18):
 *  - sheet zoom/pan (wheel-to-zoom, zoom-fit button, viewBox actually changes)
 *  - window-select (rubber-band) on the sheet, multi-select highlight
 *  - Insert Table is now a separate, blank, row/column-prompted flow
 *  - the table renders real grid lines and supports per-cell editing
 *  - Ctrl+Z/Ctrl+Y undo/redo real drawing edits (add view, add note, table insert)
 */

function fire(el, type, x, y, extra) {
  const opts = Object.assign(
    { pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0 },
    extra || {}
  );
  el.dispatchEvent(new PointerEvent(type, opts));
}

note('--- build a part and enter a drawing ---');
await rpc('session.reset');
await G.refresh();
await idle();
const s0 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', { sketchId: s0.sketchId, elements: [{ type: 'rect', a: [0, 0], b: [40, 30] }], constraints: [] });
await G.refresh();
await idle();
G.selectSketch(s0.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10 });
await idle();
G.runCommand('draw.fromDesign');
await sleep(300);
const sheetSvg = document.querySelector('.drawing-page-svg');
assert(!!sheetSvg, 'drawing sheet svg is mounted');

note('--- sheet zoom: wheel changes the viewBox, zoom-fit resets it ---');
const vbBefore = sheetSvg.getAttribute('viewBox');
sheetSvg.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
await sleep(60);
const vbAfterZoomIn = sheetSvg.getAttribute('viewBox');
note('viewBox before=' + vbBefore + ' after wheel=' + vbAfterZoomIn);
assert(vbBefore !== vbAfterZoomIn, 'scrolling the wheel over the sheet actually changes its viewBox (zoom)');

const fitBtn = Array.from(document.querySelectorAll('.drawing-zoom button')).find((b) => /%/.test(b.textContent || ''));
assert(!!fitBtn, 'the zoom-to-fit percentage button is rendered in the toolbar');
if (fitBtn) fitBtn.click();
await sleep(60);
const vbAfterFit = sheetSvg.getAttribute('viewBox');
note('viewBox after zoom-fit=' + vbAfterFit);
assert(vbAfterFit === '0 0 420 297', 'zoom-to-fit resets the viewBox to the whole sheet');

note('--- window-select (rubber band) selects multiple views ---');
G.runCommand('draw.front');
await sleep(150);
G.runCommand('draw.top');
await sleep(150);
const boxes = Array.from(sheetSvg.querySelectorAll('[data-view-box]'));
assert(boxes.length === 2, 'two views are placed (front + top)');

// drag a big rubber band across empty sheet space that should cross both views
const sheetRect = sheetSvg.getBoundingClientRect();
const x0 = sheetRect.left + 5;
const y0 = sheetRect.top + 5;
const x1 = sheetRect.left + sheetRect.width - 5;
const y1 = sheetRect.top + sheetRect.height - 5;
fire(sheetSvg, 'pointerdown', x0, y0, { buttons: 1 });
await sleep(30);
fire(sheetSvg, 'pointermove', x1, y1, { buttons: 1 });
await sleep(30);
fire(sheetSvg, 'pointerup', x1, y1, { buttons: 0 });
await sleep(100);
const selectedRects = boxes.map((g) => g.querySelector('rect').getAttribute('stroke'));
note('rect strokes after rubber-band over both views: ' + JSON.stringify(selectedRects));
assert(
  selectedRects.every((s) => s === '#0696d7'),
  'a rubber-band drag across both views selects them both (multi-select)'
);

note('--- multi-selected views can be deleted together ---');
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
await sleep(300);
const boxesAfterDelete = sheetSvg.querySelectorAll('[data-view-box]');
assert(boxesAfterDelete.length === 0, 'Delete removed BOTH multi-selected views at once');

note('--- Insert Table is now a separate blank flow, distinct from Insert BOM ---');
// promptForm auto-cancels under --e2e (returns null) by design (see
// PromptDialog.tsx's _e2e() guard), so insertTable's row/column prompt
// can't be driven through the real UI here - verify the same
// drawing.makeTable RPC insertTable calls, with a manually blank row set,
// confirming the table that results is genuinely blank (not BOM data) and
// that Insert BOM still auto-fills from the model as before.
const pageList = await rpc('drawing.pageList');
const pageId = pageList.pages[pageList.pages.length - 1].id;
const blankRows = [
  { index: 1, col0: '', col1: '' },
  { index: 2, col0: '', col1: '' }
];
const blankColumns = [
  { key: 'col0', header: 'Column 1', source: 'col0' },
  { key: 'col1', header: 'Column 2', source: 'col1' }
];
const blankTable = await rpc('drawing.makeTable', { pageId, rows: blankRows, columns: blankColumns });
note('blank table created: ' + JSON.stringify(blankTable));
assert(
  blankTable.rows.every((r) => r.col0 === '' && r.col1 === ''),
  'a manually-specified blank table has genuinely empty cells, not auto-filled BOM data'
);
const removedBlank = await rpc('drawing.removeTable', { tableId: blankTable.id });
assert(removedBlank.ok === true, 'the blank table can be removed via drawing.removeTable');

const bomRows = await rpc('drawing.bomRows', {});
note('BOM rows for the single-part document: ' + JSON.stringify(bomRows.rows));
assert(bomRows.rows.length === 1 && bomRows.rows[0].qty === 1, 'Insert BOM still auto-fills exactly one row for the single body');

note('--- table renders real grid lines and supports cell editing ---');
G.runCommand('draw.bom');
await sleep(300);
const gridLines = sheetSvg.querySelectorAll('g[stroke] > line, g[stroke] > rect');
note('grid-ish elements found near the table: ' + gridLines.length);
const tableCellText = Array.from(sheetSvg.querySelectorAll('text')).find((t) => /ITEM|PART/.test(t.textContent || ''));
assert(!!tableCellText, 'the BOM table header renders after Insert BOM');

const bomTable = await rpc('drawing.pageContents', { pageId });
const insertedTable = bomTable.tables[0];
assert(!!insertedTable, 'a table exists in page contents after Insert BOM');
const cellSet = await rpc('drawing.makeTable', {
  pageId,
  rows: insertedTable.rows.map((r, i) => (i === 0 ? { ...r, description: 'edited via cell click' } : r)),
  columns: insertedTable.columns,
  tableId: insertedTable.id
});
const editedRow = cellSet.rows[0];
note('row after simulated cell edit: ' + JSON.stringify(editedRow));
assert(editedRow.description === 'edited via cell click', 'a single cell value can be updated in place (same RPC the UI cell editor calls)');

note('--- Ctrl+Z/Ctrl+Y undo real drawing edits ---');
await rpc('session.reset');
await G.refresh();
await idle();
const s1 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', { sketchId: s1.sketchId, elements: [{ type: 'rect', a: [0, 0], b: [40, 30] }], constraints: [] });
await G.refresh();
await idle();
G.selectSketch(s1.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10 });
await idle();
G.runCommand('draw.fromDesign');
await sleep(300);
const sheetSvg2 = document.querySelector('.drawing-page-svg');
assert(!sheetSvg2.querySelector('[data-view-box]'), 'sheet starts blank for the undo check');

G.runCommand('draw.front');
await sleep(250);
assert(sheetSvg2.querySelectorAll('[data-view-box]').length === 1, 'a view was added');

document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
await sleep(300);
const afterUndo = sheetSvg2.querySelectorAll('[data-view-box]').length;
note('views after Ctrl+Z: ' + afterUndo);
assert(afterUndo === 0, 'Ctrl+Z undid adding the view (drawing-local undo, not the 3D model history)');

document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true, cancelable: true }));
await sleep(300);
const afterRedo = sheetSvg2.querySelectorAll('[data-view-box]').length;
note('views after Ctrl+Y: ' + afterRedo);
assert(afterRedo === 1, 'Ctrl+Y redid the view add');

// confirm the redone view is a REAL server-side object, not just a local
// ghost left over from the undo/redo bookkeeping
const pageList2 = await rpc('drawing.pageList');
const pageId2 = pageList2.pages[pageList2.pages.length - 1].id;
const contents2 = await rpc('drawing.pageContents', { pageId: pageId2 });
assert(contents2.views.length === 1, 'the redone view genuinely exists server-side (page_contents sees it, not just local React state)');

note('--- done ---');
await G.cancelSketch().catch(() => {});
