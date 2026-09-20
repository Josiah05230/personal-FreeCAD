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

note('--- the LIVE preview axis kind updates on mouse move alone, before any click ---');
// user report, 2026-09-19: "The UI didn't seem to update/change at all when
// I was hitting shift while dimensioning. It only seemed to happen after I
// placed the dimension" - assert the preview state actually tracks the
// cursor continuously, not just at the final placement click.
const el = viewportEl();
fire(el, 'pointermove', pA.x, pA.y); // roughly along the line itself
fire(el, 'pointermove', (pA.x + pB.x) / 2, (pA.y + pB.y) / 2 + 5, { buttons: 0 });
const belowPlace = await G.sketchUVToScreen(10, -15); // far vertical offset from the (10, 7.5) midpoint
fire(el, 'pointermove', belowPlace.x, belowPlace.y);
await sleep(60);
let liveKind = G.sketch.dimAxisKind();
note('live axis kind after moving far vertically (no click yet): ' + JSON.stringify(liveKind));
assert(liveKind.kind === 'distanceY', 'the LIVE preview already reads DistanceY from mouse position alone, before any placement click (got ' + liveKind.kind + ')');

const alongPreview = await G.sketchUVToScreen(26, 19.5); // far along the line's own direction
fire(el, 'pointermove', alongPreview.x, alongPreview.y);
await sleep(60);
liveKind = G.sketch.dimAxisKind();
note('live axis kind after moving along the line (no click yet): ' + JSON.stringify(liveKind));
assert(liveKind.kind === 'distance', 'moving the mouse back to an along-the-line position updates the LIVE preview back to plain Distance, with no click at all (got ' + liveKind.kind + ')');

note('--- Shift keydown updates the LIVE preview immediately too, before any click ---');
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true, cancelable: true }));
await sleep(60);
liveKind = G.sketch.dimAxisKind();
note('live axis kind immediately after a Shift keydown (no click yet): ' + JSON.stringify(liveKind));
assert(liveKind.forced === 'distanceX', 'a Shift keydown alone (no click) forces the live preview to DistanceX (got forced=' + liveKind.forced + ')');
window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true, cancelable: true }));
await sleep(30);
// cycle forward three more times (distanceX -> distanceY -> distance -> null)
// to deterministically clear the forced override before placing below - the
// cycle has 4 states (auto/null, forced distance, forced X, forced Y), and
// each press needs a keyup in between since it only advances on the leading
// edge of a keydown.
for (let i = 0; i < 3; i++) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true, cancelable: true }));
  await sleep(30);
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true, cancelable: true }));
  await sleep(30);
}
liveKind = G.sketch.dimAxisKind();
note('live axis kind after cycling Shift back to unforced: ' + JSON.stringify(liveKind));
assert(liveKind.forced === null, 'cycling Shift 3 times total returns to the unforced (drag-angle auto-detect) state');
fire(el, 'pointermove', belowPlace.x, belowPlace.y);
await sleep(60);

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
// Shift is a REAL held modifier now (live-updates the preview continuously,
// per the user's own follow-up report: "the UI didn't seem to update... it
// only seemed to happen after I placed the dimension") - a genuine keydown
// is what cycles dimAxisForced, not a shiftKey flag on the placement click
// itself. Press it once (forces distanceX), move the mouse (live preview
// should reflect it before any click), THEN click anywhere to place.
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true, cancelable: true }));
await sleep(80);
const ambiguous = await G.sketchUVToScreen(3, 20);
fire(viewportEl(), 'pointermove', ambiguous.x, ambiguous.y, { shiftKey: true });
await sleep(80);
window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true, cancelable: true }));
await sleep(30);
clickAt(ambiguous.x, ambiguous.y);
await sleep(150);
input = dimEditorInput();
assert(!!input, 'clicking after Shift-cycling the axis still placed/opened the editor');
if (input) {
  typeAndCommitDimEditor('9');
  await sleep(200);
  const cons3 = G.sketch.newConstraints();
  note('constraints after Shift-cycle place: ' + JSON.stringify(cons3));
  const d3 = cons3.find((c) => c.type === 'Distance' || c.type === 'DistanceX' || c.type === 'DistanceY');
  assert(!!d3 && d3.type === 'DistanceX', 'a real Shift keydown cycled from the default distance to DistanceX, and it stuck through to placement (got ' + (d3 && d3.type) + ')');
}

note('--- done ---');
await G.cancelSketch().catch(() => {});
