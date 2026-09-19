/* Manual driver (--drive): places a real two-click Distance dimension using
 * actual DOM pointer events on real snap targets, and screenshots the
 * result, to verify the witness-line/position/value fixes visually. */

function fire(el, type, x, y, extra) {
  const opts = Object.assign(
    { pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0 },
    extra || {}
  );
  el.dispatchEvent(new PointerEvent(type, opts));
}

note('--- dismiss the first-run welcome dialog (multi-step, not suppressed under --drive, unlike --e2e) ---');
for (let i = 0; i < 5; i++) {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    /^Next$|^Start using GWT-CAD$/.test(b.textContent || '')
  );
  if (!btn) break;
  btn.click();
  await sleep(150);
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
G.runCommand('draw.front');
await sleep(250);
const sheetSvg = document.querySelector('.drawing-page-svg');
assert(!!sheetSvg, 'drawing sheet svg is mounted');

note('--- place a real two-click Distance dimension on two different corners ---');
G.runCommand('draw.dimension');
await sleep(150);
const viewG = sheetSvg.querySelector('[data-view-box]');
const vb = viewG.getBoundingClientRect();
// click near the top-left vertex, then the bottom-right vertex, so the two
// picked points are NOT collinear with any single edge - this is the case
// that actually needs visible witness (extension) lines to make sense.
const x0 = vb.left + vb.width * 0.03;
const y0 = vb.top + vb.height * 0.03;
const x1 = vb.left + vb.width * 0.97;
const y1 = vb.top + vb.height * 0.97;
fire(viewG.querySelector('rect'), 'pointerdown', x0, y0);
await sleep(150);
fire(viewG.querySelector('rect'), 'pointerdown', x1, y1);
await sleep(300);

const pl = await rpc('drawing.pageList', {});
const pageId = pl.pages[pl.pages.length - 1].id;
const contents = await rpc('drawing.pageContents', { pageId });
note('dimensions after two-click place: ' + JSON.stringify(contents.dimensions));
assert(contents.dimensions.length === 1, 'exactly one dimension was created');
assert(contents.dimensions[0].value > 1, 'the dimension has a genuine non-zero, non-trivial value (got ' + contents.dimensions[0].value + ')');

note('--- done, leaving sheet on screen for screenshot ---');
