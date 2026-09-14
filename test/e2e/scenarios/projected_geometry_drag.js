/* Does geometry welded to PROJECTED (external) geometry actually stay
 * anchored there through a real drag + Finish + reopen, or does it drift?
 * User report, 2026-09-14: "Geometry constrained to/from the projected
 * geometry seems to be moving even though the projected geometry isn't." */

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
    { pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: x, clientY: y,
      bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0 },
    extra || {}
  );
  el.dispatchEvent(new PointerEvent(type, opts));
}
function clickAt(x, y, extra) {
  const el = viewportEl();
  fire(el, 'pointermove', x, y, extra);
  fire(el, 'pointerdown', x, y, extra);
  fire(el, 'pointerup', x, y, Object.assign({ buttons: 0 }, extra || {}));
}
function dragTo(x0, y0, x1, y1) {
  const el = viewportEl();
  fire(el, 'pointermove', x0, y0);
  fire(el, 'pointerdown', x0, y0);
  for (let i = 1; i <= 8; i++) {
    fire(el, 'pointermove', x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8, { buttons: 1 });
  }
  fire(el, 'pointerup', x1, y1, { buttons: 0 });
}
function pressKey(key) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}
async function screenOf(world) {
  return G.projectToScreen(world);
}

note('--- geometry welded to projected (external) geometry stays anchored through a real drag + Finish ---');

await rpc('session.reset');
await G.refresh();
await idle();

const baseS = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: baseS.sketchId,
  elements: [{ type: 'rect', a: [0, 0], b: [40, 30] }],
  constraints: []
});
await G.refresh();
await idle();
G.selectSketch(baseS.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10 });
await idle();
const bid = G.getState().bodies[0]?.id;
assert(!!bid, 'base block built');

await G.beginSketch({ kind: 'origin', role: 'XZ_Plane' });
await waitFor(() => G.getState().sketchMode, 4000);
await sleep(60);
pressKey('p');
await sleep(30);

const sc = await rpc('scene.get');
const mesh = sc.meshes.find((m) => m.id === bid);
const edge = (mesh.edges || []).find((e) => {
  const p = e.points;
  if (p.length < 6) return false;
  const dz = Math.abs(p[2] - 10) < 1e-3 && Math.abs(p[p.length - 1] - 10) < 1e-3;
  const dy = Math.abs(p[1]) < 1e-3 && Math.abs(p[p.length - 2]) < 1e-3;
  return dz && dy && Math.abs(p[0] - p[p.length - 3]) > 20;
});
assert(!!edge, 'found a top edge along X to project');

const eMid = [
  (edge.points[0] + edge.points[edge.points.length - 3]) / 2,
  (edge.points[1] + edge.points[edge.points.length - 2]) / 2,
  (edge.points[2] + edge.points[edge.points.length - 1]) / 2
];
const eScreen = await screenOf(eMid);
clickAt(eScreen.x, eScreen.y);
await sleep(80);
const projected = G.sketch.projected();
assert(projected.length > 0, 'the top edge is now projected into the sketch');
const p0 = projected[0];
note('projected edge: ' + JSON.stringify(p0));

pressKey('Escape');
await sleep(20);
pressKey('l');
await sleep(20);

// draw a line whose START is on the projected edge's own endpoint A (a real
// synthetic click on that exact point, so the real snap() records a genuine
// Coincident against the projected geoId), and whose END is out in free
// space - the free end is what we will drag
const c1 = await G.sketchUVToScreen(p0.a[0], p0.a[1]);
const c2 = await G.sketchUVToScreen(p0.a[0] - 20, p0.a[1] + 20);
clickAt(c1.x, c1.y);
await sleep(40);
clickAt(c2.x, c2.y);
await sleep(40);
pressKey('Escape'); // done drawing, back to select
await sleep(40);

const consAfterDraw = G.sketch.constraints();
note('constraints after drawing the welded line: ' + JSON.stringify(consAfterDraw));
const weldedToProjected = consAfterDraw.some(
  (c) => c.type === 'Coincident' && c.refs.some((r) => r.geo != null && r.geo <= -3)
);
assert(weldedToProjected, 'the new line really did weld (Coincident) to the projected geometry, not just visually snap');

// now DRAG the line's free end (its OTHER point) - a real pointer drag -
// somewhere else entirely
pressKey('Escape');
await sleep(20);
const freeEndBefore = G.sketch.entitySnapshot(0); // the new line is entity index 1 (0 = base rect side... actually first new entity)
note('new line snapshot before drag: ' + JSON.stringify(freeEndBefore));

const c2Screen = await G.sketchUVToScreen(p0.a[0] - 20, p0.a[1] + 20);
const c3Screen = await G.sketchUVToScreen(p0.a[0] - 5, p0.a[1] + 35);
dragTo(c2Screen.x, c2Screen.y, c3Screen.x, c3Screen.y);
await sleep(300);

const afterDrag = G.sketch.entitySnapshot(0);
note('new line snapshot after drag: ' + JSON.stringify(afterDrag));

// THE REAL CHECK: after the drag, does the line's WELDED point still sit
// exactly on the projected edge's endpoint?
const weldedPtAfterDrag = afterDrag.a; // point 1 was the one clicked onto p0.a
const gapAfterDrag = Math.hypot(weldedPtAfterDrag[0] - p0.a[0], weldedPtAfterDrag[1] - p0.a[1]);
note('gap between the welded point and the projected edge, mid-drag: ' + gapAfterDrag);
assert(gapAfterDrag < 1e-3, 'REAL CHECK: the welded point stayed on the projected edge DURING the drag');

await G.finishSketch();
await idle();
await sleep(300);

// reopen and check the REAL, sidecar-solved state - not just the client's
// own local drag preview, which is a separate (already-fixed) code path
const tree = await rpc('tree.get');
const newSketchId = tree.bodies[0].features
  .filter((f) => f.kind === 'sketch')
  .map((f) => f.id)
  .find((id) => id !== baseS.sketchId);
assert(!!newSketchId, 'found the new (projected-geometry) sketch in the tree');

await G.editSketch(newSketchId);
await waitFor(() => G.getState().sketchMode, 4000);
await sleep(200);

const reopenedProjected = G.sketch.projected();
assert(reopenedProjected.length > 0, 'the projected edge survived Finish + reopen');
const p0After = reopenedProjected[0];
note('projected edge after reopen: ' + JSON.stringify(p0After));

const reopenedEnts = G.sketch.entities();
note('entities after reopen: ' + JSON.stringify(reopenedEnts));
// find the line that starts near where we drew it - it should have exactly
// ONE endpoint sitting on the projected edge's own endpoint
let bestGap = Infinity;
for (const e of reopenedEnts) {
  if (e.type !== 'line') continue;
  const gA = Math.hypot(e.a[0] - p0After.a[0], e.a[1] - p0After.a[1]);
  const gB = Math.hypot(e.b[0] - p0After.a[0], e.b[1] - p0After.a[1]);
  bestGap = Math.min(bestGap, gA, gB);
}
note('best gap to the projected edge among reopened lines: ' + bestGap);
assert(
  bestGap < 1e-3,
  `REAL CHECK: after Finish + reopen (real sidecar solve, not just the client preview), a line endpoint still sits exactly on the projected geometry (gap ${bestGap})`
);

note('--- done ---');
