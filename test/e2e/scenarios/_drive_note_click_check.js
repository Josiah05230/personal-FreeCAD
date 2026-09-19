/* Manual driver (--drive, real dialogs): places a real note through the
 * actual Note tool + textarea, confirms the tool auto-exits, then confirms
 * clicking the placed note (in Select mode) selects it WITHOUT reopening
 * the edit dialog, and a genuine double-click DOES open it. */

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
  const btn = Array.from(document.querySelectorAll('button')).find((b) => /^Next$|^Start using GWT-CAD$/.test(b.textContent || ''));
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

note('--- place a real note via the Note tool + real textarea ---');
G.runCommand('draw.note');
await sleep(150);
const sheetRect = sheetSvg.getBoundingClientRect();
const noteX = sheetRect.left + sheetRect.width * 0.6;
const noteY = sheetRect.top + sheetRect.height * 0.6;
sheetSvg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: noteX, clientY: noteY }));
await sleep(200);
const dlg = document.querySelector('.prompt-dialog');
assert(!!dlg, 'the note dialog opened');
const textarea = dlg && dlg.querySelector('textarea');
if (textarea) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(textarea, 'test note');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}
const submitBtn = dlg && dlg.querySelector('button[type="submit"]');
if (submitBtn) click(submitBtn);
await sleep(300);

assert(document.querySelector('.drawing-tool-active') == null, 'the Note tool auto-exited to Select after placing the note');

const noteEl = sheetSvg.querySelector('text[data-note]');
assert(!!noteEl, 'the placed note is rendered on the sheet');

note('--- a SINGLE click on the note selects it, does NOT open the edit dialog ---');
if (noteEl) {
  const nb = noteEl.getBoundingClientRect();
  fire(noteEl, 'pointerdown', nb.left + nb.width / 2, nb.top + nb.height / 2);
  fire(noteEl, 'pointerup', nb.left + nb.width / 2, nb.top + nb.height / 2);
  await sleep(200);
  assert(document.querySelector('.prompt-dialog') == null, 'a single click on the note did NOT open the edit-text dialog');
  const fillAfterClick = noteEl.getAttribute('fill');
  note('note fill after single click (should be the selected-blue): ' + fillAfterClick);
  assert(fillAfterClick === '#0696d7', 'the single click DID select the note (fill turned selected-blue)');
  assert(document.querySelector('.drawing-text-toolbar') != null, 'selecting the note shows the Text formatting toolbar');
}

note('--- a genuine DOUBLE-click on the note DOES open the edit dialog ---');
if (noteEl) {
  const nb = noteEl.getBoundingClientRect();
  noteEl.dispatchEvent(
    new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: nb.left + nb.width / 2, clientY: nb.top + nb.height / 2 })
  );
  await sleep(200);
  assert(document.querySelector('.prompt-dialog') != null, 'a real double-click DID open the edit-text dialog');
  const cancelBtn = document.querySelector('.prompt-dialog button.ghost, .prompt-dialog button[type="button"]');
  if (cancelBtn) click(cancelBtn);
}

note('--- done, leaving sheet on screen for screenshot ---');
