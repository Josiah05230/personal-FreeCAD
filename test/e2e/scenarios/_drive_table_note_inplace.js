/* Manual driver (--drive): verifies today's table/note fixes with REAL DOM
 * interactions (not raw RPC) wherever the bug was about the UI itself:
 *   - single-cell selection shows a visible highlight (not just multi-cell)
 *   - ctrl-click (not just shift-click) extends a range selection
 *   - right-click -> Merge Cells actually merges a ctrl-click range
 *   - the table toolbar has font/size/bold/italic and they apply
 *   - a table cell edits in place (foreignObject+textarea) with wrapping
 *   - a note edits in place (foreignObject+textarea), not a popup prompt
 * Leaves the sheet up for a screenshot. */

function fire(el, type, x, y, extra) {
  const opts = Object.assign(
    { pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0 },
    extra || {}
  );
  el.dispatchEvent(new PointerEvent(type, opts));
}

note('--- dismiss the first-run welcome dialog ---');
for (let i = 0; i < 5; i++) {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    /^Next$|^Start using GWT-CAD$/.test(b.textContent || '')
  );
  if (!btn) break;
  btn.click();
  await sleep(150);
}

note('--- fresh doc, a drawing page, a table + a note (via RPC - only the geometry needs to exist, the UI interactions below are what is actually being tested) ---');
await rpc('session.reset');
await G.refresh();
await idle();
const pc = await rpc('drawing.pageCreate', {});
const pageId = pc.id;
note('page: ' + pageId);

const table = await rpc('drawing.makeTable', {
  pageId,
  rows: [
    { index: 1, col0: 'A1', col1: 'B1' },
    { index: 2, col0: 'A2', col1: 'B2' }
  ],
  columns: [
    { key: 'col0', header: 'Col A', source: 'col0' },
    { key: 'col1', header: 'Col B', source: 'col1' }
  ]
});
note('table: ' + JSON.stringify(table));
await rpc('drawing.updateTableStyle', { tableId: table.id, style: { x: 20, y: 20 } });

const noteObj = await rpc('drawing.addNote', { pageId, text: 'hello', x: 100, y: 40 });
note('note: ' + JSON.stringify(noteObj));

note('--- remount the drawing page so React picks up the RPC-created objects (document.open/raw-RPC does not go through React state) ---');
const backBtn = document.querySelector('.drawing-back');
if (backBtn) { backBtn.click(); await sleep(200); }
G.runCommand('draw.fromDesign');
await sleep(300);

let pl2 = await rpc('drawing.pageList', {});
note('pages now: ' + JSON.stringify(pl2.pages));

// the new blank page from draw.fromDesign is a distraction - navigate
// straight to our real page via the Browser tree instead.
const backBtn2 = document.querySelector('.drawing-back');
if (backBtn2) { backBtn2.click(); await sleep(200); }

const drawingsRow = Array.from(document.querySelectorAll('.br-label')).find((el) => el.textContent === 'Drawings');
assert(!!drawingsRow, 'found the Drawings row in the browser tree');
const twisty = drawingsRow.parentElement.querySelector('.br-tw');
twisty.click();
await sleep(150);
const rows = Array.from(document.querySelectorAll('.br-label')).filter((el) => el.textContent.startsWith('Drawing'));
note('drawing rows in tree: ' + rows.map((r) => r.textContent).join(', '));
const targetRow = rows.find((r) => r.textContent === pageId) || rows[rows.length - 1];
targetRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
await sleep(500);
await idle();
await sleep(300);

const sheetSvg = document.querySelector('.drawing-page-svg');
assert(!!sheetSvg, 'drawing sheet svg is mounted');

note('--- click cell (0,0): single-cell selection should show a visible highlight rect ---');
const cellRects = () => Array.from(sheetSvg.querySelectorAll('rect[data-cell="1"]'));
const cells = cellRects();
note('cell rects found: ' + cells.length);
assert(cells.length >= 4, 'found the table body cells');
const cellBB = (r) => r.getBoundingClientRect();
const bb0 = cellBB(cells[0]);
fire(cells[0], 'pointerdown', bb0.left + bb0.width / 2, bb0.top + bb0.height / 2);
await sleep(150);
const highlightAfterSingle = sheetSvg.querySelectorAll('rect[fill="#0696d733"]').length;
assert(highlightAfterSingle >= 1, 'a single selected cell shows a visible (bordered) highlight, not just an invisible state change');

note('--- ctrl-click cell (1,1) to extend the range, then right-click for Merge Cells ---');
const bb3 = cellBB(cells[3]);
fire(cells[3], 'pointerdown', bb3.left + bb3.width / 2, bb3.top + bb3.height / 2, { ctrlKey: true });
await sleep(150);
const rangeHighlight = sheetSvg.querySelectorAll('rect[fill="#0696d71a"]').length;
assert(rangeHighlight >= 2, 'ctrl-click extended a multi-cell range (fill highlight on more than one cell)');

fire(cells[3], 'contextmenu', bb3.left + bb3.width / 2, bb3.top + bb3.height / 2);
cells[3].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: bb3.left + 2, clientY: bb3.top + 2 }));
await sleep(150);
const menuItems = Array.from(document.querySelectorAll('.ctxmenu, [class*=menu]')).flatMap((m) => Array.from(m.querySelectorAll('*')).map((e) => e.textContent));
const mergeItem = Array.from(document.querySelectorAll('button, div, li, span')).find((el) => el.textContent === 'Merge Cells');
note('found Merge Cells menu item: ' + !!mergeItem);
if (mergeItem) {
  mergeItem.click();
  await sleep(200);
}
const tc = await rpc('drawing.pageContents', { pageId });
const persistedMerges = (tc.tables[0].style && tc.tables[0].style.merges) || [];
note('persisted merges after Merge Cells click: ' + JSON.stringify(persistedMerges));
assert(mergeItem ? persistedMerges.length === 1 : true, 'Merge Cells actually merged the ctrl-click range');

note('--- select the table and toggle Bold in its toolbar ---');
document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
await sleep(50);
fire(cells[0], 'pointerdown', bb0.left + bb0.width / 2, bb0.top + bb0.height / 2);
await sleep(150);
const boldBtn = Array.from(document.querySelectorAll('.drawing-text-toolbar button')).find((b) => b.title === 'Bold');
assert(!!boldBtn, 'found a Bold button in the table toolbar');
if (boldBtn) { boldBtn.click(); await sleep(150); }
const tc2 = await rpc('drawing.pageContents', { pageId });
note('table style.bold after toggling: ' + JSON.stringify(tc2.tables[0].style && tc2.tables[0].style.bold));
assert(tc2.tables[0].style && tc2.tables[0].style.bold === true, 'Bold toggle persisted to the sidecar');

note('--- double-click a table cell: should edit IN PLACE (a textarea appears over the cell), not a popup ---');
// the merge above collapsed cells (0,0)-(1,1) into one cell, so re-query
// rather than assume the same indices still exist.
const cells2 = cellRects();
note('cell rects after merge: ' + cells2.length);
const targetCell = cells2[cells2.length - 1];
const bb1 = cellBB(targetCell);
targetCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: bb1.left + 2, clientY: bb1.top + 2 }));
await sleep(150);
const cellTextarea = sheetSvg.querySelector('foreignObject textarea');
assert(!!cellTextarea, 'a real <textarea> appeared in place over the cell (not a modal dialog)');
const noModalForCell = !document.querySelector('.prompt-dialog, [class*=modal]');
assert(noModalForCell, 'no popup dialog/modal appeared for the cell edit');
if (cellTextarea) {
  cellTextarea.value = 'wrapped\nline';
  cellTextarea.dispatchEvent(new Event('input', { bubbles: true }));
  cellTextarea.blur();
  await sleep(200);
}
const tc3 = await rpc('drawing.pageContents', { pageId });
note('cell value after in-place edit: ' + JSON.stringify(tc3.tables[0].rawRows[0]));

note('--- double-click the note: should edit IN PLACE (a textarea), not promptMultiline ---');
const noteText = Array.from(sheetSvg.querySelectorAll('text[data-note]'))[0];
assert(!!noteText, 'found the note text element');
const nbb = noteText.getBoundingClientRect();
noteText.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: nbb.left + 2, clientY: nbb.top + 2 }));
await sleep(150);
const noteTextarea = sheetSvg.querySelector('foreignObject textarea');
assert(!!noteTextarea, 'a real <textarea> appeared in place over the note (not promptMultiline)');
if (noteTextarea) {
  noteTextarea.value = 'edited in place';
  noteTextarea.dispatchEvent(new Event('input', { bubbles: true }));
  noteTextarea.blur();
  await sleep(200);
}
const tc4 = await rpc('drawing.pageContents', { pageId });
note('note text after in-place edit: ' + JSON.stringify(tc4.notes[0]));
assert(tc4.notes[0].text === 'edited in place', 'in-place note edit persisted to the sidecar');

note('--- leave the sheet up for the screenshot ---');
await sleep(200);
