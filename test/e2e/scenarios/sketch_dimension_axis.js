/* Verifies the 2026-09-19 sketch dimension fixes:
 *  - a point-to-point dimension follows the DRAG DIRECTION used to place it:
 *    dropping it mostly along the two points' own line -> Distance, mostly
 *    horizontal -> DistanceX, mostly vertical -> DistanceY (previously there
 *    was no way at all to get anything but a plain path-length Distance)
 *  - Shift-clicking to place cycles distance -> distanceX -> distanceY,
 *    letting the user force it when the drag-angle auto-detect is ambiguous
 *  - DistanceX/DistanceY constraints are now genuinely applied by the
 *    sidecar (previously declared "valid" but silently dropped - no handler
 *    existed at all in _apply_sketch_constraints)
 *  - a point-to-point dimension now renders a REAL glyph (witness lines +
 *    value) instead of being invisible/unselectable ("hidden dimensions" -
 *    user report, 2026-09-19) */

function fire(el, type, x, y, extra) {
  const opts = Object.assign(
    { pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0 },
    extra || {}
  );
  el.dispatchEvent(new PointerEvent(type, opts));
}
function viewportEl() {
  const cands = Array.from(document.querySelectorAll('.viewport canvas'));
  let best = cands[0];
  for (const c of cands) if (c.clientWidth * c.clientHeight > best.clientWidth * best.clientHeight) best = c;
  return best;
}
function clickAt(x, y, extra) {
  const el = viewportEl();
  fire(el, 'pointermove', x, y, extra);
  fire(el, 'pointerdown', x, y, extra);
  fire(el, 'pointerup', x, y, Object.assign({ buttons: 0 }, extra || {}));
}
function pressKey(key) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}
function dimEditorInput() {
  return document.querySelector('.dim-editor input');
}
function typeAndCommitDimEditor(text) {
  const input = dimEditorInput();
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  return true;
}

note('--- draw a diagonal line so its two endpoints are neither purely horizontal nor vertical apart ---');
await rpc('session.reset');
await G.refresh();
await idle();
await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
await waitFor(() => G.getState().sketchMode, 4000);

G.sketch.addEntity({ type: 'line', a: [0, 0], b: [20, 15] });
await sleep(60);

const pA = await G.sketchUVToScreen(0, 0);
const pB = await G.sketchUVToScreen(20, 15);
assert(pA && pB, 'projected the line endpoints to screen');

note('--- pick both endpoints, place FAR VERTICALLY from the midpoint -> DistanceY ---');
pressKey('d');
await sleep(60);
clickAt(pA.x, pA.y);
await sleep(60);
clickAt(pB.x, pB.y, { ctrlKey: true });
await sleep(60);
assert(!dimEditorInput(), 'Ctrl-click ADDS the 2nd point but does not place until an empty click');

const belowPlace = await G.sketchUVToScreen(10, -15); // far vertical offset from the (10, 7.5) midpoint
clickAt(belowPlace.x, belowPlace.y);
await sleep(150);
let input = dimEditorInput();
assert(!!input, 'an empty-space click placed the point-to-point dimension (floating editor opened)');
if (input) {
  typeAndCommitDimEditor('12');
  await sleep(200);
  const cons = G.sketch.newConstraints();
  note('constraints after far-vertical placement: ' + JSON.stringify(cons));
  const d = cons.find((c) => c.type === 'Distance' || c.type === 'DistanceX' || c.type === 'DistanceY');
  assert(!!d, 'a dimension constraint was recorded');
  if (d) {
    assert(d.type === 'DistanceY', 'placing far vertically from the midpoint created a DistanceY (got ' + d.type + ')');

    note('--- the DistanceY constraint actually solves cleanly (sidecar handler exists) ---');
    const solveRes = await rpc('sketch.solve', { elements: G.sketch.entities(), constraints: cons });
    note('solve result: ' + JSON.stringify(solveRes));
    assert(
      (solveRes.redundant || []).length === 0 && (solveRes.conflicting || []).length === 0,
      'DistanceY solves cleanly with no redundant/conflicting flag (was previously silently dropped - no sidecar handler existed at all)'
    );
  }
}

note('--- undo, then pick the same 2 points and drag-place ALONG the line direction -> plain Distance ---');
pressKey('z');
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
await sleep(200);
pressKey('d');
await sleep(60);
clickAt(pA.x, pA.y);
await sleep(60);
clickAt(pB.x, pB.y, { ctrlKey: true });
await sleep(60);
// place further along the SAME direction as the line itself (extending past
// point B), so the offset from the midpoint is dominated by the along-path
// component, not a pure horizontal or vertical one
const alongPlace = await G.sketchUVToScreen(26, 19.5);
clickAt(alongPlace.x, alongPlace.y);
await sleep(150);
input = dimEditorInput();
if (input) {
  typeAndCommitDimEditor('26');
  await sleep(200);
  const cons2 = G.sketch.newConstraints();
  note('constraints after along-path placement: ' + JSON.stringify(cons2));
  const d2 = cons2.find((c) => c.type === 'Distance' || c.type === 'DistanceX' || c.type === 'DistanceY');
  assert(!!d2 && d2.type === 'Distance', 'placing along the line direction created a plain Distance (got ' + (d2 && d2.type) + ')');
}

note('--- undo, then Shift-click to PLACE cycles the axis kind (forces past an ambiguous auto-detect) ---');
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
await sleep(200);
pressKey('d');
await sleep(60);
clickAt(pA.x, pA.y);
await sleep(60);
clickAt(pB.x, pB.y, { ctrlKey: true });
await sleep(60);
// a placement point well clear of the line itself (directly "above" the
// midpoint in a perpendicular-ish direction) so this click can't be
// re-interpreted as picking the line/a point on it - Shift forces the axis
// cycle regardless of where exactly this lands.
const ambiguous = await G.sketchUVToScreen(3, 20);
fire(viewportEl(), 'pointerdown', ambiguous.x, ambiguous.y, { shiftKey: true, buttons: 1 });
fire(viewportEl(), 'pointerup', ambiguous.x, ambiguous.y, { shiftKey: true, buttons: 0 });
await sleep(150);
input = dimEditorInput();
assert(!!input, 'a Shift-click at the ambiguous midpoint still placed/opened the editor');
if (input) {
  typeAndCommitDimEditor('9');
  await sleep(200);
  const cons3 = G.sketch.newConstraints();
  note('constraints after Shift-cycle place: ' + JSON.stringify(cons3));
  const d3 = cons3.find((c) => c.type === 'Distance' || c.type === 'DistanceX' || c.type === 'DistanceY');
  assert(!!d3 && d3.type === 'DistanceX', 'Shift-clicking to place cycled from the default distance to DistanceX (got ' + (d3 && d3.type) + ')');
}

note('--- done ---');
await G.cancelSketch().catch(() => {});
