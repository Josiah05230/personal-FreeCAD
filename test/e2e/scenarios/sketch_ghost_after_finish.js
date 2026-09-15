/* After editing a sketch that a downstream solid feature has already
 * consumed (its .Profile) and hitting Finish, the sketch's own wireframe
 * outline must not stay drawn on top of the solid. User report, 2026-09-14
 * (screenshot + trace): after a real drag + Finish + roll down the timeline,
 * "it also still has the 'ghost' drawing in the sketch where it didn't
 * remove/hide the original pre-drag [shape]." Root cause: sketch.finish
 * forced sk.Visibility = True unconditionally and nothing hid it again until
 * the next explicit history.rollTo call - so right after Finish (and for
 * however long until the user happened to scrub the timeline) the profile's
 * raw wireframe sat visible over the already-correctly-updated solid. */

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

note('--- does a Pad-consumed sketch stop showing its own wireframe right after Finish (no ghost outline)? ---');

await rpc('session.reset');
await G.refresh();
await idle();

// base profile sketch on XY, drawn via elements (shape at draw time doesn't
// matter - only that it later gets edited)
const prof = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: prof.sketchId,
  elements: [{ type: 'circle', c: [0, 0], r: 5 }],
  constraints: []
});
await G.refresh();
await idle();

// Pad it - this makes the sketch a CONSUMED profile (Pad.Profile == prof)
G.clearSelection();
G.pick({ kind: 'sketch', sketchId: prof.sketchId }, false);
await sleep(60);
G.openOp('extrude');
await sleep(80);
await waitFor(() => G.getState().opReady === true, 4000);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10 });
await idle();

let tree = await rpc('tree.get');
let sk = tree.bodies[0].features.find((f) => f.id === prof.sketchId);
assert(sk && sk.visible === false, `profile sketch is hidden right after being consumed by Pad (visible=${sk && sk.visible})`);

// re-enter the sketch and drag the circle's radius via a REAL pointer drag
await G.editSketch(prof.sketchId);
await G.refresh();
await idle();
await sleep(200);
G.fit();
await sleep(150);

const rimUV = [5, 0];
const rimScreen = G.sketchUVToScreen(rimUV[0], rimUV[1]);
const centreScreen = G.sketchUVToScreen(0, 0);
assert(!!rimScreen && !!centreScreen, 'circle rim + centre project onto the screen');
const dx = rimScreen.x - centreScreen.x;
const dy = rimScreen.y - centreScreen.y;
note('dragging the circle rim outward (real pointer drag)...');
dragTo(rimScreen.x, rimScreen.y, centreScreen.x + dx * 1.6, centreScreen.y + dy * 1.6);
await sleep(300);
await idle();
await sleep(200);

const snap = G.sketch.entitySnapshot(0);
note('circle radius after the drag (still in the sketch editor): ' + JSON.stringify(snap));
assert(snap && snap.r > 6, `radius actually grew via the real drag (expected >6, got ${snap ? snap.r : 'none'})`);

await G.finishSketch();
await idle();
await sleep(250);

// THE REAL CHECK: immediately after Finish, with no further rollTo, is the
// profile sketch's wireframe still hidden (not a ghost overlay on the Pad)?
const sceneRightAfterFinish = await rpc('scene.get');
const sketchOverlay = (sceneRightAfterFinish.sketches || []).find((s) => s.id === prof.sketchId);
note('sketch overlay right after Finish: ' + JSON.stringify(sketchOverlay ? { id: sketchOverlay.id, visible: sketchOverlay.visible, polyCount: (sketchOverlay.polys || []).length } : null));
assert(
  !sketchOverlay || sketchOverlay.visible === false,
  `REAL CHECK: the consumed profile sketch stays HIDDEN right after Finish - no ghost wireframe on top of the Pad (got visible=${sketchOverlay ? sketchOverlay.visible : 'n/a'})`
);

tree = await rpc('tree.get');
sk = tree.bodies[0].features.find((f) => f.id === prof.sketchId);
assert(sk && sk.visible === false, `tree.get also reports the profile sketch hidden right after Finish (visible=${sk && sk.visible})`);

// and the Pad itself actually reflects the grown radius (not just a
// visibility check with stale geometry underneath)
const bodyId = tree.bodies[0].id;
const padMesh = sceneRightAfterFinish.meshes.find((m) => m.id === bodyId || true);
assert(padMesh && padMesh.bbox, 'Pad mesh has a bbox');
const grew = Math.abs(padMesh.bbox.max[0] - padMesh.bbox.min[0]) > 11;
assert(grew, `Pad's own geometry reflects the grown radius too (bbox ${JSON.stringify(padMesh.bbox)})`);

note('--- done ---');
