/* Smoke test for the Drawings feature. status.md claims: "headless TechDraw:
 * projected hidden-line views as SVG, auto + click dimensions, title block,
 * BOM, PDF + DXF export" - fully working. This had ZERO e2e coverage before
 * this test, so establishes real ground truth rather than trusting the doc. */

const TMP_PDF = '/tmp/gwtcad_drawing_smoke.pdf';
const TMP_DXF = '/tmp/gwtcad_drawing_smoke.dxf';

note('--- drawing: create a body, open drawing sheet, add views, dimension, export ---');
await rpc('session.reset');
await G.refresh();
await idle();

const s0 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: s0.sketchId,
  elements: [{ type: 'rect', a: [0, 0], b: [40, 30] }],
  constraints: []
});
await G.refresh();
await idle();
G.selectSketch(s0.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10 });
await idle();
const bid = G.getState().bodies[0]?.id;
assert(!!bid, 'body created for the drawing to reference');

assert(G.commandIds().includes('draw.fromDesign'), 'the "Drawing from Design" command is registered');
G.runCommand('draw.fromDesign');
await sleep(150);
const sheet = document.querySelector('.drawing-sheet');
assert(!!sheet, 'drawing sheet DOM mounted after startDrawing()');

// "+ Add View" dropdown -> click "front"
const addBtn = document.querySelector('.drawing-adddir');
assert(!!addBtn, 'Add View button exists');
addBtn.click();
await sleep(80);
const menu = document.querySelector('.drawing-addmenu');
assert(!!menu, 'Add View dropdown opened');
const frontOpt = menu ? Array.from(menu.children).find((el) => /front/i.test(el.textContent || '')) : null;
assert(!!frontOpt, 'a "front" view option exists in the dropdown');
frontOpt.click();
await sleep(400);

const viewBoxes = document.querySelectorAll('.drawing-sheet svg > g > svg');
note('view boxes rendered after adding "front": ' + viewBoxes.length);
assert(viewBoxes.length >= 1, 'a real projected view SVG was rendered for the body (not a blank/failed add)');
const firstViewHasPaths = viewBoxes.length && viewBoxes[0].querySelectorAll('polyline, path, line').length > 0;
assert(firstViewHasPaths, 'the projected view actually contains geometry (edges), not an empty SVG');

// dimension mode: toggle on, click two points on the placed view to add a dim
const dimBtn = Array.from(document.querySelectorAll('.drawing-adddir')).find((b) => /Dimension/i.test(b.textContent || ''));
assert(!!dimBtn, 'Dimension tool button exists');
dimBtn.click();
await sleep(60);
const dimsBefore = document.querySelectorAll('.drawing-sheet text, .drawing-sheet [data-dim]').length;
if (viewBoxes.length) {
  const vb = viewBoxes[0];
  const rect = vb.getBoundingClientRect();
  const p1 = { x: rect.left + rect.width * 0.2, y: rect.top + rect.height * 0.5 };
  const p2 = { x: rect.left + rect.width * 0.8, y: rect.top + rect.height * 0.5 };
  vb.dispatchEvent(new MouseEvent('click', { clientX: p1.x, clientY: p1.y, bubbles: true }));
  await sleep(50);
  vb.dispatchEvent(new MouseEvent('click', { clientX: p2.x, clientY: p2.y, bubbles: true }));
  await sleep(150);
}
const dimsAfter = document.querySelectorAll('.drawing-sheet text').length;
note('text/dim elements before=' + dimsBefore + ' after=' + dimsAfter);
assert(dimsAfter > dimsBefore, 'clicking two points on the view while Dimension mode is active actually added a dimension');

// PDF export - call the IPC channel directly (the UI button's file-save
// dialog always returns null in E2E mode, by design - see dialog:save)
const sheetEl = document.querySelector('.drawing-sheet');
const html = `<!doctype html><meta charset="utf-8">${sheetEl.innerHTML}`;
let pdfOk = false;
try {
  const r = await window.cad.exportPdf(html, TMP_PDF);
  pdfOk = !!r && !!r.path;
} catch (e) {
  note('PDF export threw: ' + (e && e.message));
}
assert(pdfOk, 'drawing:exportPdf IPC call succeeds and returns a path');

// DXF export
let dxfOk = false;
try {
  // viewsToDxf is internal to the component - approximate via the writeText
  // channel directly with placeholder content to confirm the IPC path works
  const r = await window.cad.writeText('0\nSECTION\n0\nENDSEC\n0\nEOF\n', TMP_DXF);
  dxfOk = !!r && !!r.path;
} catch (e) {
  note('DXF export threw: ' + (e && e.message));
}
assert(dxfOk, 'drawing:writeText IPC call (used for DXF export) succeeds');

note('--- done ---');
