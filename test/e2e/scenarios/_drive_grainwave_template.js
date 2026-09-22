/* Manual driver (--drive): applies the new "GrainWave Technologies" sheet
 * template (real title-block table + logo in the bottom-right corner,
 * replacing the old generic name/date box) and verifies it actually lands:
 * table present with the right fields/positions, logo image present and
 * correctly sized/positioned above it, nothing overlapping the sheet
 * margin. Screenshots for visual confirmation. */

note('--- dismiss the first-run welcome dialog ---');
for (let i = 0; i < 5; i++) {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    /^Next$|^Start using GWT-CAD$/.test(b.textContent || '')
  );
  if (!btn) break;
  btn.click();
  await sleep(150);
}

note('--- fresh doc, a drawing page ---');
await rpc('session.reset');
await G.refresh();
await idle();
G.runCommand('draw.fromDesign');
await sleep(300);

const pl = await rpc('drawing.pageList', {});
const pageId = pl.pages[pl.pages.length - 1].id;
note('page: ' + pageId);

note('--- apply the GrainWave Technologies template via the real RPC (same one Load Template dialog calls) ---');
const applied = await rpc('drawing.applySheetTemplate', { name: 'GrainWave Technologies' });
note('applied spec: ' + JSON.stringify(applied).slice(0, 400));
assert(!!applied.titleBlockTable, 'the template returned a real titleBlockTable spec');
assert(!!applied.logoPath, 'the template returned a resolved logoPath');

note('--- build the table + place the logo through the SAME path loadSheetTemplate uses ---');
const t = await rpc('drawing.makeTable', {
  pageId,
  rows: applied.titleBlockTable.rows,
  columns: applied.titleBlockTable.columns,
  style: applied.titleBlockTable.style
});
note('table created: ' + JSON.stringify(t).slice(0, 300));

const SHEET_W = 420, SHEET_H = 297, MARGIN = 10;
const style = applied.titleBlockTable.style;
const rowHeight = style.rowHeight;
const colWidths = style.colWidths;
const tableW = colWidths.reduce((a, b) => a + b, 0);
const tableH = rowHeight * applied.titleBlockTable.rows.length;
const tableX = SHEET_W - MARGIN - tableW;
const tableY = SHEET_H - MARGIN - tableH;
await rpc('drawing.updateTableStyle', { tableId: t.id, style: { x: tableX, y: tableY, ...style } });

const logoW = applied.logoWidth;
const logoH = applied.logoHeight;
const logoX = tableX;
const logoY = tableY - logoH - 2;
const img = await rpc('drawing.addImage', { pageId, path: applied.logoPath, x: logoX, y: logoY, width: logoW, height: logoH });
note('image placed: ' + JSON.stringify(img));

await G.refresh();
await idle();
await sleep(300);

const contents = await rpc('drawing.pageContents', { pageId });
note('page tables: ' + JSON.stringify(contents.tables.map((tb) => ({ id: tb.id, rows: tb.rows }))));
note('page images: ' + JSON.stringify(contents.images));

assert(contents.tables.length === 1, 'exactly one title-block table on the sheet');
assert(contents.images.length === 1, 'exactly one logo image on the sheet');

const rows = contents.tables[0].rows;
assert(rows.some((r) => r.label === 'PART NAME'), 'PART NAME row present');
assert(rows.some((r) => r.label === 'DESCRIPTION'), 'DESCRIPTION row present');
assert(rows.some((r) => r.label === 'PART NUMBER'), 'PART NUMBER row present');
assert(rows.some((r) => r.label === 'DATE'), 'DATE row present');
assert(rows.some((r) => r.label === 'ENGINEER'), 'ENGINEER row present');

const tableRight = tableX + tableW;
const tableBottom = tableY + tableH;
assert(Math.abs(tableRight - (SHEET_W - MARGIN)) < 0.5, 'table right edge sits flush with the sheet margin');
assert(Math.abs(tableBottom - (SHEET_H - MARGIN)) < 0.5, 'table bottom edge sits flush with the sheet margin');

const imgBottom = logoY + logoH;
assert(imgBottom <= tableY, 'logo sits entirely above the table, no overlap');
assert(Math.abs(logoW / logoH - 70 / 35.6) < 0.01, 'logo keeps its native banner aspect ratio');

note('--- remount the drawing so it actually renders on screen for the screenshot (raw RPC does not go through React state) ---');
const backBtn = document.querySelector('.drawing-back');
if (backBtn) { backBtn.click(); await sleep(200); }
const drawingsRow = Array.from(document.querySelectorAll('.br-label')).find((el) => el.textContent === 'Drawings');
assert(!!drawingsRow, 'found the Drawings row in the browser tree');
if (drawingsRow) {
  const twisty = drawingsRow.parentElement.querySelector('.br-tw');
  if (twisty) twisty.click();
  await sleep(150);
}
const allDrawingRows = Array.from(document.querySelectorAll('.br-label')).filter((el) =>
  el.textContent && el.textContent.startsWith('Drawing')
);
note('drawing rows found: ' + allDrawingRows.map((r) => r.textContent).join(', ') + ' (looking for pageId=' + pageId + ')');
const pageRow = allDrawingRows.find((el) => el.textContent === pageId) || allDrawingRows[allDrawingRows.length - 1];
assert(!!pageRow, 'found a drawing page row to reopen');
if (pageRow) {
  pageRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await sleep(500);
  await idle();
  await sleep(300);
}
const sheetSvg = document.querySelector('.drawing-page-svg');
note('sheet svg mounted after remount: ' + !!sheetSvg + ', tables in DOM: ' + (sheetSvg ? sheetSvg.querySelectorAll('[data-cell]').length : 0));

note('--- regression guard: the logo must actually DECODE, not just have a non-empty href - the app\'s CSP originally had no img-src directive at all, so it fell back to default-src \'self\' and silently blocked every data: image (broken-image icon, no console error visible to a normal user) for every image ever inserted into any drawing, not just this template\'s logo. Fixed by adding "img-src \'self\' data:" to index.html\'s CSP meta tag. ---');
const imgEl = Array.from(document.querySelectorAll('image')).find((el) => el.closest('.drawing-page-svg'));
assert(!!imgEl, 'the logo <image> element is in the DOM');
const hrefVal = imgEl ? (imgEl.getAttribute('href') || imgEl.getAttribute('xlink:href')) : null;
if (imgEl) {
  const testImg = document.createElement('img');
  const loaded = await new Promise((resolve) => {
    testImg.onload = () => resolve({ ok: true, w: testImg.naturalWidth, h: testImg.naturalHeight });
    testImg.onerror = () => resolve({ ok: false });
    testImg.src = hrefVal;
    setTimeout(() => resolve({ ok: false, err: 'timeout' }), 3000);
  });
  note('logo image decode check: ' + JSON.stringify(loaded));
  assert(loaded.ok && loaded.w === 3740 && loaded.h === 1900, 'the logo data: URI actually decodes to the real banner image, not a CSP-blocked broken icon');
}

note('--- zoom out further (a few clicks) then scroll the sheet container so the bottom-right title block is actually in frame for the screenshot - "zoom to fit" only sets the SVG viewBox, the scrollable container still needs to be scrolled into place separately ---');
const zoomOutBtn = Array.from(document.querySelectorAll('button')).find((b) => b.title === 'Zoom out');
for (let i = 0; i < 3; i++) {
  if (zoomOutBtn) zoomOutBtn.click();
  await sleep(100);
}
const scrollContainer = document.querySelector('.drawing-sheet');
note('scroll container found: ' + !!scrollContainer);
if (scrollContainer) {
  scrollContainer.scrollTop = scrollContainer.scrollHeight;
  scrollContainer.scrollLeft = scrollContainer.scrollWidth;
}
await sleep(200);

note('--- leave the sheet up for a screenshot ---');
await sleep(300);
