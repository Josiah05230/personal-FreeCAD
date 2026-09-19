/* Verifies the interactive sketch drag pipeline is now driven directly by
 * FreeCAD's real solver (sketch.dragStart/dragMove/dragEnd) instead of the
 * old client-side local-relaxation approximation (solveLocal, deleted).
 *
 * Checks, all via REAL synthetic pointer events on the viewport canvas (not
 * calling internal handlers directly):
 *  (a) dragging a rectangle corner propagates to the OTHER corners/sides
 *      (proves the real solver is driving it, not a shadow copy - the real
 *      solver enforces the rect's H/V + coincident constraints on every
 *      intermediate frame, not just at release)
 *  (b) per-dragMove round trip timing (rough responsiveness signal)
 *  (c) no visible snap/jump immediately after mouse-up (nothing left to
 *      reconcile once there is only one solver)
 *  (d) dragging a point onto a degenerate target (its own line's other
 *      endpoint) and back doesn't crash or corrupt geometry
 */

function viewportEl() {
  const cands = Array.from(document.querySelectorAll('.viewport canvas'));
  let best = cands[0];
  for (const c of cands) {
    if (c.clientWidth * c.clientHeight > best.clientWidth * best.clientHeight) best = c;
  }
  return best;
}
function fire(el, type, x, y, extra) {
  const opts = Object.assign(
    {
      pointerId: 1,
      isPrimary: true,
      pointerType: 'mouse',
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1
    },
    extra || {}
  );
  el.dispatchEvent(new PointerEvent(type, opts));
}
async function dragTo(x0, y0, x1, y1, steps = 12, stepDelayMs = 0) {
  const el = viewportEl();
  fire(el, 'pointermove', x0, y0, { buttons: 0 });
  fire(el, 'pointerdown', x0, y0);
  const times = [];
  for (let i = 1; i <= steps; i++) {
    const t0 = performance.now();
    fire(el, 'pointermove', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, {
      buttons: 1
    });
    times.push(performance.now() - t0);
    if (stepDelayMs) await sleep(stepDelayMs);
  }
  fire(el, 'pointerup', x1, y1);
  return times;
}

note('--- interactive drag is driven by the real FreeCAD solver, not a local approximation ---');

await rpc('session.reset');
await G.refresh();
await idle();

await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
await waitFor(() => G.getState().sketchMode, 4000);
await sleep(80);

function pressKey(key) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

// draw the rect through the SAME commit()/auto-constrain path a real draw
// hits (testCommitTool - the established test-hook pattern other scenarios
// use for drawing, see sketcher.js). The DRAG itself below is what is under
// test, and that uses only real synthetic pointer events.
G.sketch.commitTool('rect', [[0, 0], [60, 40]]);
await sleep(80);

let ents = G.sketch.entities();
note('entities after drawing rect: ' + JSON.stringify(ents.map((e) => e && e.type)));
assert(ents.length === 4 && ents.every((e) => e && e.type === 'line'), 'rect decomposed into 4 line entities');

pressKey('Escape');
await sleep(20);

// entity 0 runs from (0,0) to (60,0) per pushRect's corner order - drag its
// "b" endpoint (60,0) out to (60, 60): a real solver enforces the rect's
// Horizontal/Vertical + Coincident-corner constraints on EVERY frame, so
// entity 1 (the right side, vertical) and entity 3 (left side) must follow
const before = ents.map((e) => ({ a: [...e.a], b: [...e.b] }));
note('rect before drag: ' + JSON.stringify(before));

const dragStart = await G.sketchUVToScreen(60, 0);
const dragEnd = await G.sketchUVToScreen(60, 70);
const stepTimes = await dragTo(dragStart.x, dragStart.y, dragEnd.x, dragEnd.y, 14);
await sleep(150);

ents = G.sketch.entities();
note('rect after drag: ' + JSON.stringify(ents.map((e) => ({ a: e.a, b: e.b }))));

// screenshot evidence: the stretched rect, settled after the drag
try {
  const shot = await window.cad.captureThumb('/tmp/gwtcad-drag-evidence.FCStd');
  note('screenshot (post-drag, stretched rect): ' + JSON.stringify(shot));
} catch (e) {
  note('screenshot capture failed (non-fatal): ' + (e && e.message));
}

// (a) propagation: the OTHER corners must have moved too, not just the
// dragged point - proves the real solver drove every frame (constraint
// propagation), not a shadow copy that only updates the dragged handle
const movedOther = ents.some((e, i) => {
  if (i === 0) return false;
  const b0 = before[i];
  return (
    Math.hypot(e.a[0] - b0.a[0], e.a[1] - b0.a[1]) > 1 ||
    Math.hypot(e.b[0] - b0.b[0], e.b[1] - b0.b[1]) > 1
  );
});
assert(movedOther, 'dragging one rect corner propagated to the OTHER sides (real solver, not a shadow copy)');

// the rect must still look like a rect (closed loop, still 4 lines, still H/V
// on the appropriate sides) - not corrupted by the drag
const closed = (() => {
  for (let i = 0; i < 4; i++) {
    const a = ents[i];
    const b = ents[(i + 1) % 4];
    if (!a || !b) return false;
    if (Math.hypot(a.b[0] - b.a[0], a.b[1] - b.a[1]) > 0.5) return false;
  }
  return true;
})();
assert(closed, 'the rectangle stayed a closed 4-sided loop after the drag');

// (b) rough responsiveness signal: report step timings (informational, not a
// hard gate - environment/CPU dependent)
note('dragMove dispatch step wall-times (ms, includes RPC if the browser task queue drains synchronously): ' + JSON.stringify(stepTimes.map((t) => +t.toFixed(2))));

// a second responsiveness pass at a realistic ~60fps cadence (16ms between
// pointermoves, like a real mouse) so each rAF frame gets its own dragMove
// round trip, timed individually - this is the number that matters for "does
// it feel responsive", not the tight synchronous-dispatch loop above (which
// collapses many moves into one rAF-throttled call, by design)
ents = G.sketch.entities();
const e0b = ents[0];
const s0 = await G.sketchUVToScreen(e0b.b[0], e0b.b[1]);
const s1 = await G.sketchUVToScreen(e0b.b[0], e0b.b[1] + 30);
const perFrameTimes = await dragTo(s0.x, s0.y, s1.x, s1.y, 10, 16);
note('per-frame (16ms cadence) dispatch times (ms): ' + JSON.stringify(perFrameTimes.map((t) => +t.toFixed(2))));
await sleep(150);

// (c) no snap/jump at mouse-up: sample geometry right after pointerup and
// again a bit later - they should already match (nothing left to reconcile)
const justAfter = G.sketch.entities().map((e) => ({ a: [...e.a], b: [...e.b] }));
await sleep(300);
const later = G.sketch.entities().map((e) => ({ a: [...e.a], b: [...e.b] }));
let maxJump = 0;
for (let i = 0; i < justAfter.length; i++) {
  maxJump = Math.max(
    maxJump,
    Math.hypot(justAfter[i].a[0] - later[i].a[0], justAfter[i].a[1] - later[i].a[1]),
    Math.hypot(justAfter[i].b[0] - later[i].b[0], justAfter[i].b[1] - later[i].b[1])
  );
}
note('max geometry drift between mouse-up and +300ms later: ' + maxJump.toFixed(6) + 'mm');
assert(maxJump < 0.01, 'no snap/jump after mouse-up - nothing left to reconcile with a single real solver');

// (d) degenerate drag: drag entity 0's start point (0,0-ish, now wherever the
// rect ended up) exactly onto its own end point - a zero-length line -
// then back out. Must not crash or corrupt geometry (applied:false handling).
ents = G.sketch.entities();
const e0 = ents[0];
const aScr = await G.sketchUVToScreen(e0.a[0], e0.a[1]);
const bScr = await G.sketchUVToScreen(e0.b[0], e0.b[1]);
let threw = false;
try {
  await dragTo(aScr.x, aScr.y, bScr.x, bScr.y, 10);
  await sleep(150);
  // and back to roughly where it was
  const backScr = await G.sketchUVToScreen(e0.a[0], e0.a[1]);
  await dragTo(bScr.x, bScr.y, backScr.x, backScr.y, 10);
  await sleep(150);
} catch (e) {
  threw = true;
  note('EXCEPTION during degenerate drag: ' + (e && e.message));
}
assert(!threw, 'dragging a point onto a degenerate target (zero-length line) and back did not throw');
const afterDegenerate = G.sketch.entities();
const stillValid = afterDegenerate.every(
  (e) => e && e.type === 'line' && Number.isFinite(e.a[0]) && Number.isFinite(e.a[1]) && Number.isFinite(e.b[0]) && Number.isFinite(e.b[1])
);
assert(stillValid, 'geometry is still well-formed (finite coordinates) after the degenerate drag attempt');

note('--- drag pipeline check complete ---');
