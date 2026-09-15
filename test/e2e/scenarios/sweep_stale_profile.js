/* Does a Sweep downstream of a profile sketch actually recompute after the
 * profile is edited (real UI drag, real Finish) and the timeline is rolled
 * back down past the Sweep? User report, 2026-09-14: "I hit finish sketch
 * after dragging and moved down the timeline. The sweep of that sketch
 * didn't error or update. Pending there is a valid surface/face, it should
 * update the 3d geometry." - the worst kind of bug if real: wrong geometry,
 * no error, no visible signal anything is stale. */

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
function dragTo(x0, y0, x1, y1) {
  const el = viewportEl();
  fire(el, 'pointermove', x0, y0);
  fire(el, 'pointerdown', x0, y0);
  for (let i = 1; i <= 8; i++) {
    fire(el, 'pointermove', x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8, { buttons: 1 });
  }
  fire(el, 'pointerup', x1, y1, { buttons: 0 });
}

note('--- does a Sweep recompute after its profile sketch is edited + Finish + roll down the timeline? ---');

await rpc('session.reset');
await G.refresh();
await idle();

// profile: a circle on YZ (drawn via elements, not a drag - the profile's
// SHAPE at build time doesn't matter, only that it gets EDITED afterward)
const prof = await rpc('sketch.on', { ref: { kind: 'origin', role: 'YZ_Plane' } });
await rpc('sketch.finish', {
  sketchId: prof.sketchId,
  elements: [{ type: 'circle', c: [0, 0], r: 4 }],
  constraints: []
});
// path: PERPENDICULAR to the profile's own YZ plane - XZ_Plane's local u-axis
// maps to world X (see _ORIGIN_FRAMES / a live headless repro), which is
// what actually travels AWAY from a YZ-plane profile; [0,0]->[0,40] (local
// v = world Z) runs WITHIN that plane instead and produces a degenerate,
// near-zero-volume "solid" that happened to still pass this test's own
// bbox-growth check before feature.sweep started rejecting that case
// outright with a clear error (2026-09-15 fix).
const path = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XZ_Plane' } });
await rpc('sketch.finish', {
  sketchId: path.sketchId,
  elements: [{ type: 'line', a: [0, 0], b: [40, 0] }],
  constraints: []
});
await G.refresh();
await idle();

G.clearSelection();
G.openOp('sweep');
await sleep(80);
G.pick({ kind: 'sketch', sketchId: prof.sketchId }, false);
await sleep(40);
G.pick({ kind: 'sketch', sketchId: path.sketchId }, false);
await sleep(80);
await waitFor(() => G.getState().opReady === true, 4000);
await G.applyOp('sweep', { operation: 'Join', orientation: 'Path', transition: 'Transformed' });
await idle();

const bodyId = G.getState().bodies[0].id;
const sceneBefore = await rpc('scene.get');
const bboxBefore = sceneBefore.meshes.find((m) => m.id === bodyId || true)?.bbox;
note('sweep body bbox BEFORE editing the profile: ' + JSON.stringify(bboxBefore));

// now EDIT the profile sketch via the REAL UI drag path (not a synthetic
// sketch.finish overwrite) - grow the circle's radius substantially
await G.editSketch(prof.sketchId);
await G.refresh();
await idle();
await sleep(200);
G.fit();
await sleep(150);

const circUV = [4, 0]; // rim point of the r=4 circle at angle 0
const circScreen = G.sketchUVToScreen(circUV[0], circUV[1]);
const centreScreen = G.sketchUVToScreen(0, 0);
assert(!!circScreen && !!centreScreen, 'circle rim + centre project onto the screen');
note('dragging the circle rim outward to grow its radius (real pointer drag)...');
const dx = circScreen.x - centreScreen.x;
const dy = circScreen.y - centreScreen.y;
// drag well past the rim, away from centre - roughly double the radius
dragTo(circScreen.x, circScreen.y, centreScreen.x + dx * 2, centreScreen.y + dy * 2);
await sleep(300);
await idle();
await sleep(200);

const snap = G.sketch.entitySnapshot(0);
note('circle radius after the drag (still in the sketch editor): ' + JSON.stringify(snap));
assert(snap && snap.r > 5, `radius actually grew via the real drag (expected >5, got ${snap ? snap.r : 'none'})`);

await G.finishSketch();
await idle();
await sleep(200);

// roll the timeline down to the end (past the Sweep) - exactly "moved down
// the timeline" per the report
await G.rollTo(null);
await idle();
await sleep(300);

const sceneAfter = await rpc('scene.get');
const bboxAfter = sceneAfter.meshes.find((m) => m.id === bodyId || true)?.bbox;
note('sweep body bbox AFTER editing the profile + Finish + roll to end: ' + JSON.stringify(bboxAfter));

const grew =
  bboxAfter &&
  bboxBefore &&
  (Math.abs(bboxAfter.max[1] - bboxAfter.min[1]) > Math.abs(bboxBefore.max[1] - bboxBefore.min[1]) + 1 ||
    Math.abs(bboxAfter.max[2] - bboxAfter.min[2]) > Math.abs(bboxBefore.max[2] - bboxBefore.min[2]) + 1);
assert(
  grew,
  `REAL CHECK: the Sweep's 3D geometry reflects the edited (grown) profile radius after Finish + roll-to-end (before ${JSON.stringify(bboxBefore)}, after ${JSON.stringify(bboxAfter)})`
);

note('--- done ---');
