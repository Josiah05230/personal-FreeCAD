/* Manual driver script (run via --drive, NOT --e2e) - promptText/promptForm
 * show REAL dialogs here since window.__E2E_ENV is unset, so this actually
 * exercises the Note tool click-to-place flow, the Cleanup Line tool, and
 * the Section View right-click dialog the way a real user would, including
 * typing into and submitting the real PromptDialog. */

function fire(el, type, x, y, extra) {
  const opts = Object.assign(
    { pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0 },
    extra || {}
  );
  el.dispatchEvent(new PointerEvent(type, opts));
}
function click(el) {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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

note('--- Note tool: click "Note" in ribbon, click empty sheet, type text, submit real dialog ---');
G.runCommand('draw.note');
await sleep(150);
const sheetRect = sheetSvg.getBoundingClientRect();
// click on empty sheet space, away from the placed view
const noteX = sheetRect.left + sheetRect.width * 0.7;
const noteY = sheetRect.top + sheetRect.height * 0.6;
sheetSvg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: noteX, clientY: noteY }));
await sleep(200);
const dlg = document.querySelector('.prompt-dialog');
note('prompt dialog present after clicking sheet with Note tool: ' + !!dlg);
assert(!!dlg, 'clicking the sheet with the Note tool active opened the real text-entry dialog');
if (dlg) {
  const input = dlg.querySelector('input');
  assert(!!input, 'the note dialog has a text input');
  if (input) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Live-driven note');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const submitBtn = dlg.querySelector('button[type="submit"]');
  assert(!!submitBtn, 'the note dialog has a submit button');
  if (submitBtn) click(submitBtn);
}
await sleep(300);
const noteTextEl = Array.from(sheetSvg.querySelectorAll('text')).find((t) => /Live-driven note/.test(t.textContent || ''));
note('note text found on sheet after real dialog submit: ' + !!noteTextEl);
assert(!!noteTextEl, 'the note typed through the REAL dialog actually renders on the sheet');

note('--- Cleanup Line tool: two clicks (not a drag) on the view draws a cosmetic line ---');
G.runCommand('draw.cleanup');
await sleep(150);
const viewG = sheetSvg.querySelector('[data-view-box]');
assert(!!viewG, 'a view exists to draw a cleanup line on');
if (viewG) {
  const vb = viewG.getBoundingClientRect();
  const x0 = vb.left + vb.width * 0.2;
  const y0 = vb.top + vb.height * 0.2;
  const x1 = vb.left + vb.width * 0.8;
  const y1 = vb.top + vb.height * 0.8;
  const rectEl = viewG.querySelector('rect');
  fire(rectEl, 'pointerdown', x0, y0, { buttons: 1 });
  await sleep(150);
  fire(rectEl, 'pointerdown', x1, y1, { buttons: 1 });
  await sleep(300);
}
const pl = await rpc('drawing.pageList', {});
const pageId = pl.pages[pl.pages.length - 1].id;
const contentsAfterCleanup = await rpc('drawing.pageContents', { pageId });
note('cleanup lines after click-drag: ' + JSON.stringify(contentsAfterCleanup.cleanupLines));
const anyCleanup = Object.values(contentsAfterCleanup.cleanupLines || {}).some((arr) => (arr || []).length > 0);
assert(anyCleanup, 'the click-drag with the Cleanup Line tool active actually created a cosmetic line server-side');

note('--- Section View: right-click the view, choose Section View, submit real dialog ---');
G.setTool ? G.setTool('select') : null;
await sleep(100);
const viewG2 = sheetSvg.querySelector('[data-view-box]');
const vb2 = viewG2.getBoundingClientRect();
const cx = vb2.left + vb2.width / 2;
const cy = vb2.top + vb2.height / 2;
const rectEl2 = viewG2.querySelector('rect');
fire(rectEl2, 'pointerdown', cx, cy, { buttons: 1 });
await sleep(30);
fire(rectEl2, 'pointerup', cx, cy, { buttons: 0 });
await sleep(100);
rectEl2.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 2 }));
await sleep(150);
const menu = document.querySelector('.ctxmenu');
note('context menu present after right-click: ' + !!menu);
if (menu) {
  const items = Array.from(menu.querySelectorAll('.ctx-item')).filter((el) => /Section View/.test(el.textContent || ''));
  note('menu item candidates for Section View: ' + items.length);
  if (items[0]) click(items[0]);
  await sleep(200);
  const dlg2 = document.querySelector('.prompt-dialog');
  note('section view dialog present: ' + !!dlg2);
  assert(!!dlg2, 'right-clicking a view and choosing "Section View..." opened the real parameter dialog');
  if (dlg2) {
    const submitBtn2 = dlg2.querySelector('button[type="submit"]');
    if (submitBtn2) click(submitBtn2);
    await sleep(300);
  }
} else {
  fail('the right-click context menu did not appear on a placed view');
}
const contentsAfterSection = await rpc('drawing.pageContents', { pageId });
note('views after section attempt: ' + JSON.stringify(contentsAfterSection.views.map((v) => v.id)));
assert(contentsAfterSection.views.length >= 2, 'a section view was actually created server-side via the real right-click + dialog flow');

note('--- done ---');
await G.cancelSketch().catch(() => {});
