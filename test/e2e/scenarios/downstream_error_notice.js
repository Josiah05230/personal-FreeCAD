/* When editing a sketch breaks a feature further down the tree (not the
 * feature being edited, and not the very next one either), FreeCAD throws no
 * exception - it just leaves that feature in an error state holding its
 * last-good shape, silently. User report, 2026-09-14: "your sketch solver
 * isn't perfect and, the sweep never actually generated or presented an
 * error." finishSketch() now diffs tree.get's per-feature `error` flag
 * before/after the commit and flashes a notice naming whatever newly broke.
 * Reproduced here with a Fillet downstream of a Pad: shrink the Pad's
 * profile (real drag) until the Fillet's edge is too short for its own
 * radius - a standard, deterministic PartDesign failure mode (unlike Sweep,
 * whose OCCT kernel tolerates a lot before actually erroring). */

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

note('--- does breaking a DOWNSTREAM feature (Fillet, after a Pad profile edit) surface a visible notice? ---');

await rpc('session.reset');
await G.refresh();
await idle();

const prof = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: prof.sketchId,
  elements: [
    { type: 'line', a: [0, 0], b: [20, 0] },
    { type: 'line', a: [20, 0], b: [20, 20] },
    { type: 'line', a: [20, 20], b: [0, 20] },
    { type: 'line', a: [0, 20], b: [0, 0] }
  ],
  constraints: []
});
await G.refresh();
await idle();

G.clearSelection();
G.pick({ kind: 'sketch', sketchId: prof.sketchId }, false);
await sleep(60);
G.openOp('extrude');
await sleep(80);
await waitFor(() => G.getState().opReady === true, 4000);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 20 });
await idle();

let tree = await rpc('tree.get');
const bodyId = tree.bodies[0].id;
const padId = tree.bodies[0].features.find((f) => f.opType === 'Extrude').id;

// fillet ALL 4 vertical edges of the pad with a large-ish radius (8) - fine
// while the top face is a 20x20 square, but breaks once the square shrinks
// to something the fillet can't fit on (radius > half the shrunk side)
const scene1 = await rpc('scene.get');
const padMesh = scene1.meshes.find((m) => m.id === bodyId);
assert(padMesh, 'pad mesh exists');
G.clearSelection();
const edgeSubs = ['Edge1', 'Edge3', 'Edge5', 'Edge7'];
for (const sub of edgeSubs) {
  G.pick({ kind: 'edge', bodyId, sub, point: [0, 0, 0] }, true);
}
await sleep(60);
G.openOp('fillet');
await sleep(80);
await waitFor(() => G.getState().opReady === true, 4000);
await G.applyOp('fillet', { radius: 8 });
await idle();

tree = await rpc('tree.get');
const filletFeat = tree.bodies[0].features.find((f) => f.opType === 'Fillet');
assert(filletFeat && !filletFeat.error, `Fillet built cleanly at radius 8 on the 20x20 square (error=${filletFeat && filletFeat.error})`);

// now shrink the profile via a REAL drag until the square is too small for
// an 8-unit fillet radius (needs side > 2*radius = 16 to stay valid)
await G.editSketch(prof.sketchId);
await G.refresh();
await idle();
await sleep(200);
G.fit();
await sleep(150);

const cornerUV = [20, 20];
const cornerScreen = G.sketchUVToScreen(cornerUV[0], cornerUV[1]);
const originScreen = G.sketchUVToScreen(0, 0);
assert(!!cornerScreen && !!originScreen, 'square corner + origin project onto the screen');
note('dragging the square corner inward (real pointer drag) - shrinking it well below the fillet radius...');
// drag the (20,20) corner point down to about (10,10) - both adjacent edges
// shrink to 10, too small for an 8-radius fillet on either, but nowhere near
// collapsing onto another point (avoids "both points are equal" degeneracy)
const targetScreen = {
  x: originScreen.x + (cornerScreen.x - originScreen.x) * 0.2,
  y: originScreen.y + (cornerScreen.y - originScreen.y) * 0.2
};
dragTo(cornerScreen.x, cornerScreen.y, targetScreen.x, targetScreen.y);
await sleep(300);
await idle();
await sleep(200);

const snap = G.sketch.entitySnapshot(2);
note('dragged corner line snapshot: ' + JSON.stringify(snap));

await G.finishSketch();
await idle();
await sleep(400);

tree = await rpc('tree.get');
const filletAfter = tree.bodies[0].features.find((f) => f.opType === 'Fillet');
note('Fillet feature state after shrinking the profile: ' + JSON.stringify(filletAfter));

const st = G.getState();
note('app notice after Finish: ' + JSON.stringify(st.notice));

assert(
  !!filletAfter && filletAfter.error === true,
  `the shrink genuinely broke the Fillet (error=${filletAfter && filletAfter.error}) - if this is false the geometry didn't shrink enough, adjust the drag target`
);
assert(
  !!st.notice && /fillet|failed/i.test(st.notice),
  `REAL CHECK: a downstream feature that broke silently (no exception) after Finish shows a visible notice naming it (got notice=${JSON.stringify(st.notice)})`
);

note('--- done ---');
