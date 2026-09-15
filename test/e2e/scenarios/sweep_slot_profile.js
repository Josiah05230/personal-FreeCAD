/* User report, 2026-09-15 (screenshot: a stadium/slot profile mid-drag with
 * a stale duplicate outline) + follow-up: "after dragging the timeline to
 * the end, the sweep object doesn't generate 3d geometry. It should. I also
 * can't seem to go in and edit it." Reproduces the exact real construction
 * (2 lines + 2 tangent arcs, all 4 corners welded, all 4 tangents applied -
 * same technique proven in real_input.js's stadium tests) as a Sweep
 * profile, drags one arc's radius via a real pointer drag, Finishes, rolls
 * the timeline to the end, and checks the Sweep's own 3D geometry actually
 * reflects the edit - plus whether the Sweep can be reopened for editing at
 * all (feature.get / feature.primaryDim for AdditivePipe/SubtractivePipe). */

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
      pointerId: 1, isPrimary: true, pointerType: 'mouse',
      clientX: x, clientY: y, bubbles: true, cancelable: true,
      button: 0, buttons: type === 'pointerdown' ? 1 : 0
    },
    extra || {}
  );
  el.dispatchEvent(new PointerEvent(type, opts));
}
function dragTo(x0, y0, x1, y1, steps) {
  const el = viewportEl();
  fire(el, 'pointermove', x0, y0);
  fire(el, 'pointerdown', x0, y0);
  for (let i = 1; i <= steps; i++) {
    fire(el, 'pointermove', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, { buttons: 1 });
  }
  fire(el, 'pointerup', x1, y1, { buttons: 0 });
}

note('--- stadium/slot profile: drag + Finish + roll to end -> does the Sweep actually regenerate + stay editable? ---');

await rpc('session.reset');
await G.refresh();
await idle();

await G.beginSketch({ kind: 'origin', role: 'YZ_Plane' });
await waitFor(() => G.getState().sketchMode, 4000);
await sleep(60);

const rTop = G.sketch.addEntity({ type: 'line', a: [-10, 8], b: [10, 8] });
const rBot = G.sketch.addEntity({ type: 'line', a: [10, -8], b: [-10, -8] });
const aR = G.sketch.addEntity({ type: 'arc', c: [10, 0], r: 8, a0: -Math.PI / 2, a1: Math.PI / 2 });
const aL = G.sketch.addEntity({ type: 'arc', c: [-10, 0], r: 8, a0: Math.PI / 2, a1: (3 * Math.PI) / 2 });
await sleep(40);

G.sketch.selectPoints([{ e: rTop, pt: 2 }, { e: aR, pt: 1 }]);
assert(G.sketch.applyConstraint('Coincident'), 'weld top-right corner');
await sleep(60);
G.sketch.selectPoints([{ e: aR, pt: 2 }, { e: rBot, pt: 1 }]);
assert(G.sketch.applyConstraint('Coincident'), 'weld bottom-right corner');
await sleep(60);
G.sketch.selectPoints([{ e: rBot, pt: 2 }, { e: aL, pt: 1 }]);
assert(G.sketch.applyConstraint('Coincident'), 'weld bottom-left corner');
await sleep(60);
G.sketch.selectPoints([{ e: aL, pt: 2 }, { e: rTop, pt: 1 }]);
assert(G.sketch.applyConstraint('Coincident'), 'weld top-left corner');
await sleep(60);

G.sketch.select([aL, rTop]);
assert(G.sketch.applyConstraint('Tangent'), 'tangent left arc <-> top line');
await sleep(60);
G.sketch.select([rTop, aR]);
assert(G.sketch.applyConstraint('Tangent'), 'tangent top line <-> right arc');
await sleep(60);
G.sketch.select([aR, rBot]);
assert(G.sketch.applyConstraint('Tangent'), 'tangent right arc <-> bottom line');
await sleep(60);
G.sketch.select([rBot, aL]);
assert(G.sketch.applyConstraint('Tangent'), 'tangent bottom line <-> left arc');
await sleep(300);

const entsBefore = G.sketch.entities();
assert(entsBefore.length === 4, 'stadium has 4 entities before the drag (got ' + entsBefore.length + ')');

await G.finishSketch();
await idle();
await sleep(200);

const tree0 = await rpc('tree.get');
const profId = tree0.bodies[0].features.find((f) => f.kind === 'sketch').id;
const profFeat0 = tree0.bodies[0].features.find((f) => f.kind === 'sketch');
note('profile sketch feature right after Finish: ' + JSON.stringify(profFeat0));
const reopenCheck = await rpc('sketch.reopen', { sketchId: profId });
note('profile sketch geometry+constraints right after Finish: ' + JSON.stringify(reopenCheck.entities) + ' cons=' + JSON.stringify(reopenCheck.constraints));

// a straight path sketch, PERPENDICULAR to the profile's own plane - the
// profile lives on YZ (normal = world X), so the path must travel along
// world X to sweep AWAY from that plane. XZ_Plane's local u-axis maps to
// world X (see _ORIGIN_FRAMES), so [0,0]->[40,0] in ITS 2D coords is the
// right direction; [0,0]->[0,40] (its local v-axis = world Z) runs INSIDE
// the profile's own plane instead of away from it - confirmed via a direct
// headless repro that this exact stadium profile swept along a
// world-Z-direction path produces a negative-volume degenerate solid
// (isValid()=False) while the SAME profile along world X is completely
// valid. Not a product bug - just picked the wrong path axis first.
const path = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XZ_Plane' } });
await rpc('sketch.finish', { sketchId: path.sketchId, elements: [{ type: 'line', a: [0, 0], b: [40, 0] }], constraints: [] });
await G.refresh();
await idle();

G.clearSelection();
G.openOp('sweep');
await sleep(80);
G.pick({ kind: 'sketch', sketchId: profId }, false);
await sleep(40);
G.pick({ kind: 'sketch', sketchId: path.sketchId }, false);
await sleep(80);
await waitFor(() => G.getState().opReady === true, 4000);
await G.applyOp('sweep', { operation: 'Join', orientation: 'Path', transition: 'Transformed' });
await idle();

let tree = await rpc('tree.get');
const sweepFeat = tree.bodies[0].features.find((f) => /sweep/i.test(f.opType));
assert(sweepFeat && !sweepFeat.error, `Sweep built cleanly from the stadium profile (error=${sweepFeat && sweepFeat.error})`);
const bodyId = tree.bodies[0].id;
const bboxBefore = (await rpc('scene.get')).meshes.find((m) => m.id === bodyId).bbox;
note('sweep bbox BEFORE dragging the profile: ' + JSON.stringify(bboxBefore));

// re-enter the profile sketch and drag the RIGHT arc's radius outward via a
// REAL pointer drag - same interaction as the screenshot
await G.editSketch(profId);
await G.refresh();
await idle();
await sleep(200);
G.fit();
await sleep(150);

// the tangent-loop's auto-solve can land on a DIFFERENT radius than
// originally drawn (confirmed: the redundant-constraint pick is order-
// sensitive, see _strip_redundant_constraints) - read the arc's REAL current
// radius instead of assuming it is still 8, or the "rim" point computed from
// a stale radius can miss the actual handle and grab nothing.
const preDragSnap = G.sketch.entitySnapshot(aR);
note('right arc BEFORE the drag: ' + JSON.stringify(preDragSnap));
const r0 = preDragSnap.r;
const rimUV = [10 + r0, 0]; // rim of the right arc (c=[10,0]) at angle 0
const centreUV = [10, 0];
const rimScreen = G.sketchUVToScreen(rimUV[0], rimUV[1]);
const centreScreen = G.sketchUVToScreen(centreUV[0], centreUV[1]);
assert(!!rimScreen && !!centreScreen, 'arc rim + centre project onto the screen');
const dx = rimScreen.x - centreScreen.x;
const dy = rimScreen.y - centreScreen.y;
note('dragging the right arc outward (real pointer drag)...');
// a larger overshoot (2x, matching sweep_stale_profile.js's own proven-
// stable circle drag) - occasionally a single synthetic drag sequence lands
// on a smaller-than-requested radius (the same class of "grabbed a nearby
// handle instead" flake documented elsewhere in this suite) - retry once
// rather than assert on a single attempt, since the actual product behavior
// under test is what happens AFTER a successful drag, not the synthetic
// pointer-event mechanics themselves.
let snap = null;
for (let attempt = 0; attempt < 3; attempt++) {
  dragTo(rimScreen.x, rimScreen.y, centreScreen.x + dx * 2, centreScreen.y + dy * 2, 8);
  await sleep(300);
  await idle();
  await sleep(200);
  snap = G.sketch.entitySnapshot(aR);
  note(`right arc after drag attempt ${attempt + 1}: ` + JSON.stringify(snap));
  if (snap && snap.r > r0 * 1.2) break;
}
// PROPORTIONAL growth check, not a fixed absolute delta - the drag targets
// centre + (rim-centre)*2 in SCREEN space, so the resulting radius growth
// scales with r0 itself (a small starting radius drags a proportionally
// small distance too); a fixed "+1" threshold flakes when the tangent
// loop's auto-solve happens to land on a small starting r0.
assert(
  snap && snap.r > r0 * 1.2,
  `arc radius actually grew via the real drag (started at ${r0}, expected >${(r0 * 1.2).toFixed(2)}, got ${snap ? snap.r : 'none'})`
);

await G.finishSketch();
await idle();
await sleep(250);

await G.rollTo(null);
await idle();
await sleep(300);

tree = await rpc('tree.get');
const sweepAfter = tree.bodies[0].features.find((f) => /sweep/i.test(f.opType));
note('Sweep feature state after drag+Finish+rollTo(end): ' + JSON.stringify(sweepAfter));
assert(sweepAfter && !sweepAfter.error, `Sweep did not go into an error state after the edit (error=${sweepAfter && sweepAfter.error}, text=${sweepAfter && sweepAfter.errorText})`);

const sceneAfter = await rpc('scene.get');
const meshAfter = sceneAfter.meshes.find((m) => m.id === bodyId);
note('sweep bbox AFTER drag+Finish+rollTo(end): ' + JSON.stringify(meshAfter && meshAfter.bbox));
assert(!!meshAfter, 'REAL CHECK: the body still produces a mesh at all after rolling to the end (not blank)');
if (meshAfter) {
  // PROPORTIONAL growth, same reasoning as the radius check above - the
  // starting size varies run to run with which tangent the auto-solve drops
  const beforeY = Math.abs(bboxBefore.max[1] - bboxBefore.min[1]);
  const beforeZ = Math.abs(bboxBefore.max[2] - bboxBefore.min[2]);
  const afterY = Math.abs(meshAfter.bbox.max[1] - meshAfter.bbox.min[1]);
  const afterZ = Math.abs(meshAfter.bbox.max[2] - meshAfter.bbox.min[2]);
  const grewY = afterY > beforeY * 1.15;
  const grewZ = afterZ > beforeZ * 1.15;
  assert(grewY || grewZ, `REAL CHECK: the Sweep's 3D geometry reflects the grown arc radius (before ${JSON.stringify(bboxBefore)}, after ${JSON.stringify(meshAfter.bbox)})`);
}

// can the Sweep be reopened for editing at all?
let editInfo = null;
let editErr = null;
try {
  editInfo = await rpc('feature.get', { id: sweepAfter.id });
} catch (e) {
  editErr = e && e.message;
}
note('feature.get on the Sweep: ' + JSON.stringify(editInfo) + ' err=' + editErr);
assert(!editErr, `feature.get on the Sweep did not throw (${editErr || 'ok'})`);
assert(!!editInfo && !!editInfo.kind, `REAL CHECK: the Sweep reports a real editable kind from feature.get (got kind=${editInfo && editInfo.kind})`);

// and through the REAL edit dialog, not just the raw RPC - double-click
// equivalent (G.editFeature), change a value, Apply, confirm it stuck
note('opening the Sweep in its real edit dialog (G.editFeature)...');
await G.editFeature(sweepAfter.id);
await waitFor(() => G.getState().op === 'sweep', 4000);
assert(G.getState().op === 'sweep', 'REAL CHECK: the Sweep edit dialog actually opened (not silently falling back to nothing)');
await G.applyOp('sweep', { operation: 'Join', orientation: 'Parallel', transition: 'Right corner' });
await idle();
await sleep(200);

const editInfoAfter = await rpc('feature.get', { id: sweepAfter.id });
note('feature.get after the real edit+apply: ' + JSON.stringify(editInfoAfter));
assert(
  editInfoAfter.values.orientation === 'Parallel' && editInfoAfter.values.transition === 'Right corner',
  `REAL CHECK: the edit dialog's changes actually committed (got ${JSON.stringify(editInfoAfter.values)})`
);
const treeAfterEdit = await rpc('tree.get');
const sweepAfterEdit = treeAfterEdit.bodies[0].features.find((f) => f.id === sweepAfter.id);
assert(sweepAfterEdit && !sweepAfterEdit.error, `Sweep still builds cleanly after the real edit (error=${sweepAfterEdit && sweepAfterEdit.error})`);

note('--- done ---');
