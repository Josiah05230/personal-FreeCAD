/* Manual driver (--drive): builds a real example part, sets a real part
 * number/name/description on the document, creates a drawing with a front
 * view of the part, applies the GrainWave Technologies template, and
 * leaves it on screen zoomed to fit for a showcase screenshot - shows the
 * template in actual context (not an empty sheet) the way the user would
 * really see it. */

note('--- dismiss the first-run welcome dialog ---');
for (let i = 0; i < 5; i++) {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    /^Next$|^Start using GWT-CAD$/.test(b.textContent || '')
  );
  if (!btn) break;
  btn.click();
  await sleep(150);
}

note('--- build a real example part: a mounting bracket (base plate + a bolt hole pattern + a fillet) ---');
await rpc('session.reset');
await G.refresh();
await idle();
const s0 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: s0.sketchId,
  elements: [{ type: 'rect', a: [0, 0], b: [80, 50] }],
  constraints: []
});
await G.refresh();
await idle();
G.selectSketch(s0.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 8 });
await idle();

let state = await rpc('tree.get', {});
const padId = state.bodies[0].features.find((f) => f.kind === 'solid').id;

note('--- fillet the 4 vertical edges ---');
const sc = await rpc('scene.get', {});
const box = sc.meshes[0];
const vEdges = box.edges.filter((e) => Math.abs(e.points[2] - e.points[5]) > 1);
const edgeNames = vEdges.map((e) => 'Edge' + (e.edge + 1));
const points = vEdges.map((e) => [
  (e.points[0] + e.points[3]) / 2,
  (e.points[1] + e.points[4]) / 2,
  (e.points[2] + e.points[5]) / 2
]);
await rpc('feature.fillet', { edges: edgeNames, radius: 6, points });
await idle();

note('--- four corner bolt holes ---');
const s1 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: s1.sketchId,
  elements: [
    { type: 'circle', c: [12, 12], r: 3 },
    { type: 'circle', c: [68, 12], r: 3 },
    { type: 'circle', c: [12, 38], r: 3 },
    { type: 'circle', c: [68, 38], r: 3 }
  ],
  constraints: []
});
await G.refresh();
await idle();
G.selectSketch(s1.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Cut', mode: 'Blind', length: 8 });
await idle();

note('--- assign a real part number/name/description so =PN/=NAME/=DESCRIPTION resolve for real in the title block ---');
await rpc('pn.tagDocument', {
  pn: 'PSZ0010A0',
  name: 'PowerSync Mounting Bracket',
  description: '4-hole tractor mount bracket, 8mm aluminum'
});

note('--- create a drawing, add a front view + isometric view ---');
G.runCommand('draw.fromDesign');
await sleep(300);
G.runCommand('draw.top');
await sleep(250);
G.runCommand('draw.iso');
await sleep(250);

const pl = await rpc('drawing.pageList', {});
const pageId = pl.pages[pl.pages.length - 1].id;

note('--- apply the GrainWave Technologies template (same RPC sequence loadSheetTemplate uses) ---');
const applied = await rpc('drawing.applySheetTemplate', { name: 'GrainWave Technologies' });
assert(!!applied.titleBlockTable, 'template returned a titleBlockTable');

const t = await rpc('drawing.makeTable', {
  pageId,
  rows: applied.titleBlockTable.rows,
  columns: applied.titleBlockTable.columns,
  style: applied.titleBlockTable.style
});
const SHEET_W = 420, SHEET_H = 297, MARGIN = 10;
const style = applied.titleBlockTable.style;
const rowHeight = style.rowHeight;
const colWidths = style.colWidths;
const tableW = colWidths.reduce((a, b) => a + b, 0);
const tableH = rowHeight * (applied.titleBlockTable.rows.length + 1);
const tableX = SHEET_W - MARGIN - tableW;
const tableY = SHEET_H - MARGIN - tableH;
await rpc('drawing.updateTableStyle', { tableId: t.id, style: { x: tableX, y: tableY, ...style } });

// logo sits immediately LEFT of the table, top-aligned, sized to
// logoHeightFrac of the table's own height x the logo's native aspect
// ratio - the rest of that left column goes to legalNote below the logo
// (same layout loadSheetTemplate now uses, user request 2026-09-22:
// "raise + shrink the logo so that both fit in the height of the table").
const hasNote = !!applied.legalNote;
const logoFrac = hasNote ? (applied.logoHeightFrac ?? 0.55) : 1;
const logoH = tableH * logoFrac;
const logoW = logoH * applied.logoAspect;
const noteW = hasNote ? Math.max(logoW, 55) : logoW;
const panelW = Math.max(logoW, noteW);
const panelRight = tableX - 2;
const logoX = panelRight - panelW / 2 - logoW / 2;
const logoY = tableY;
await rpc('drawing.addImage', {
  pageId, path: applied.logoPath, x: logoX, y: logoY, width: logoW, height: logoH
});
if (hasNote) {
  const noteX = panelRight - panelW;
  const noteTop = logoY + logoH + 2;
  const noteH = tableH - logoH - 2;
  const lines = applied.legalNote.split('\n').filter(Boolean);
  const lineSpan = Math.max(1, 1 + 1.2 * (lines.length - 1));
  const noteTextSize = Math.max(1.4, Math.min(2.2, (noteH * 0.85) / lineSpan));
  await rpc('drawing.addNote', {
    pageId, text: applied.legalNote, x: noteX, y: noteTop + noteTextSize, font: 'osifont', textSize: noteTextSize
  });
}

const contents = await rpc('drawing.pageContents', { pageId });
note('final table rows (should show real PN/name/description now): ' + JSON.stringify(contents.tables[0].rows));
assert(contents.tables[0].rows.some((r) => r.value === 'PowerSync Mounting Bracket'), 'PART NAME resolved to the real part name');
assert(contents.tables[0].rows.some((r) => r.value === 'PSZ0010A0'), 'PART NUMBER resolved to the real PN');

note('--- remount to render, zoom to fit, scroll to show the whole sheet ---');
G.refresh();
await idle();
const backBtn = document.querySelector('.drawing-back');
if (backBtn) { backBtn.click(); await sleep(200); }
const drawingsRow = Array.from(document.querySelectorAll('.br-label')).find((el) => el.textContent === 'Drawings');
if (drawingsRow) {
  const twisty = drawingsRow.parentElement.querySelector('.br-tw');
  if (twisty) twisty.click();
  await sleep(150);
}
const pageRow = Array.from(document.querySelectorAll('.br-label')).find((el) => el.textContent === pageId);
if (pageRow) {
  pageRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await sleep(500);
  await idle();
  await sleep(300);
}
const fitBtn = Array.from(document.querySelectorAll('button')).find((b) => b.title === 'Zoom to fit the whole sheet');
if (fitBtn) fitBtn.click();
await sleep(200);
const zoomOutBtn = Array.from(document.querySelectorAll('button')).find((b) => b.title === 'Zoom out');
if (zoomOutBtn) zoomOutBtn.click();
await sleep(100);
const scrollContainer = document.querySelector('.drawing-sheet');
if (scrollContainer) {
  // centre the sheet in the scrollable viewport rather than pinning to a
  // corner - a real full-sheet overview, not a scroll-hunted crop.
  scrollContainer.scrollTop = (scrollContainer.scrollHeight - scrollContainer.clientHeight) / 2;
  scrollContainer.scrollLeft = (scrollContainer.scrollWidth - scrollContainer.clientWidth) / 2;
}
await sleep(300);

note('--- leave up for the showcase screenshot ---');
await sleep(300);
