/* Manual driver (--drive, real dialogs): verifies the actual multi-line
 * Note textarea and the Text formatting toolbar (font/size/bold/italic/
 * color/symbols) work through real UI interaction. */

function click(el) {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}
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

note('--- Note tool: click empty sheet, type MULTI-LINE text in the real textarea ---');
G.runCommand('draw.note');
await sleep(150);
const sheetRect = sheetSvg.getBoundingClientRect();
const noteX = sheetRect.left + sheetRect.width * 0.6;
const noteY = sheetRect.top + sheetRect.height * 0.6;
sheetSvg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: noteX, clientY: noteY }));
await sleep(200);
const dlg = document.querySelector('.prompt-dialog');
assert(!!dlg, 'the note dialog opened');
const textarea = dlg.querySelector('textarea');
assert(!!textarea, 'the note dialog has a REAL textarea (was a single-line input before)');
if (textarea) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(textarea, 'first line\nsecond line\nthird line');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  // real Enter key in a textarea inserts a newline, doesn't submit - confirm
  // that here too (typing a literal Enter keypress must not close the dialog)
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(80);
  assert(document.querySelector('.prompt-dialog') != null, 'pressing Enter in the textarea does NOT submit/close the dialog');
}
const submitBtn = dlg.querySelector('button[type="submit"]');
if (submitBtn) click(submitBtn);
await sleep(300);

const noteTextEls = sheetSvg.querySelectorAll('[data-note] tspan, text[data-note] tspan');
const allNoteTspans = Array.from(sheetSvg.querySelectorAll('text[data-note]')).flatMap((t) => Array.from(t.querySelectorAll('tspan')));
note('tspan count for the note (should be 3 for 3 lines): ' + allNoteTspans.length);
assert(allNoteTspans.length === 3, 'the multi-line note rendered as 3 separate <tspan> lines, not one run-on line');
const lineTexts = allNoteTspans.map((t) => t.textContent);
note('line texts: ' + JSON.stringify(lineTexts));
assert(
  lineTexts[0] === 'first line' && lineTexts[1] === 'second line' && lineTexts[2] === 'third line',
  'each tspan holds the correct line of text, in order'
);

note('--- Text toolbar appears when the note is selected, and controls work ---');
const noteTextEl = sheetSvg.querySelector('text[data-note]');
assert(!!noteTextEl, 'the note text element exists');
const ntb = noteTextEl.getBoundingClientRect();
fire(noteTextEl, 'pointerdown', ntb.left + 5, ntb.top + 5);
await sleep(150);
const toolbar = document.querySelector('.drawing-text-toolbar');
assert(!!toolbar, 'selecting the note shows the Text formatting toolbar');

if (toolbar) {
  const boldBtn = Array.from(toolbar.querySelectorAll('button')).find((b) => b.textContent === 'B');
  assert(!!boldBtn, 'a Bold button exists in the Text toolbar');
  if (boldBtn) click(boldBtn);
  await sleep(200);
  const pl = await rpc('drawing.pageList', {});
  const pageId = pl.pages[pl.pages.length - 1].id;
  const contents = await rpc('drawing.pageContents', { pageId });
  const n = contents.notes[0];
  note('note after clicking Bold: ' + JSON.stringify(n));
  assert(n.textStyle === 'Bold', 'clicking Bold actually set the note textStyle to Bold server-side');

  const symBtn = Array.from(toolbar.querySelectorAll('button')).find((b) => b.title === 'Insert Ø');
  assert(!!symBtn, 'a diameter-symbol insert button exists');
  if (symBtn) click(symBtn);
  await sleep(200);
  const contents2 = await rpc('drawing.pageContents', { pageId });
  note('note text after inserting symbol: ' + JSON.stringify(contents2.notes[0].text));
  assert(contents2.notes[0].text.endsWith('Ø'), 'clicking the symbol button appended it to the note text');
}

note('--- done, leaving sheet on screen for screenshot ---');
