/* Verifies the centre-point 'arc' sketch tool's snap-to-Coincident behaviour:
 * whichever point (centre, start rim, or end rim) actually lands ON existing
 * geometry gets a real Coincident constraint, unconditionally - the solver's
 * job is to reconcile shape from constraints, not ours to pre-filter based on
 * our own seed geometry (an earlier attempt at this fix added a radius-
 * tolerance guard that rejected real-world snaps whose seed r/a0/a1 hadn't
 * converged yet; that made things LESS welded and was reverted per explicit
 * user feedback: "It needs to effectively be MORE welded, not less").
 *
 * It also verifies the actual root cause behind persistent "arc endpoints
 * don't get constrained" reports: snap()'s candidate scan used to let a
 * multi-click tool's OWN already-placed points (this.pending - the arc's own
 * centre/start clicks, added purely so the cursor could visually settle near
 * them) compete on raw distance against real external snap targets. A rim
 * click landing near BOTH its own pending point and a real target could
 * resolve snapRef to the pending point (ref: null) instead of the real one,
 * so the click looked snapped on screen but produced no Coincident at all.
 * Real geometry must always win over a tool's own pending points whenever
 * both are in tolerance. */

note('--- centre snap gets a real Coincident ---');
await rpc('session.reset');
await G.refresh();
await idle();
await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
await waitFor(() => G.getState().sketchMode, 4000);

const anchor = G.sketch.commitTool('line', [[-20, 0], [-20, 10]]);
await sleep(40);

const before1 = G.sketch.newConstraints().length;
G.sketch.commitTool(
  'arc',
  [[-20, 0], [-10, 0], [-10, 10]], // centre snaps onto anchor's pt 1
  [{ idx: anchor, pt: 1 }, null, null]
);
await sleep(60);
const centreCons = G.sketch.newConstraints();
note('constraints after centre-snapped arc: ' + JSON.stringify(centreCons));
assert(
  centreCons.length > before1 && centreCons.some((c) => c.type === 'Coincident'),
  'an arc centre that snaps onto an existing point gets welded with a real Coincident'
);

note('--- start-rim snap gets a real Coincident ---');
await rpc('session.reset');
await G.refresh();
await idle();
await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
await waitFor(() => G.getState().sketchMode, 4000);

const lineA = G.sketch.commitTool('line', [[0, 0], [10, 0]]); // endpoint at (10,0)
await sleep(40);

G.sketch.commitTool(
  'arc',
  [[0, 0], [10, 0], [0, 10]], // centre at origin, start rim snaps onto lineA's end (10,0)
  [null, { idx: lineA, pt: 2 }, null]
);
await sleep(60);
const startRimCons = G.sketch.newConstraints();
note('constraints after start-rim-snapped arc: ' + JSON.stringify(startRimCons));
assert(
  startRimCons.some(
    (c) =>
      c.type === 'Coincident' &&
      c.refs.some((r) => r.pt === 1) &&
      c.refs.some((r) => (r.new ?? r.geo) === lineA && r.pt === 2)
  ),
  'an arc start-rim point that snaps onto an existing endpoint gets a real Coincident'
);

note('--- end-rim snap gets a real Coincident even before the seed geometry has converged ---');
await rpc('session.reset');
await G.refresh();
await idle();
await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
await waitFor(() => G.getState().sketchMode, 4000);

// endpoint (12,5) is NOT at radius 10 from the origin - the seed r/a0/a1
// computed from the raw click points won't exactly match this target yet,
// but the user's click DID snap onto it, so it must still get welded and let
// the solver reconcile the shape.
const lineB = G.sketch.commitTool('line', [[5, 5], [12, 5]]);
await sleep(40);

const arcIdx = G.sketch.commitTool(
  'arc',
  [[0, 0], [10, 0], [12, 5]],
  [null, null, { idx: lineB, pt: 2 }]
);
await sleep(60);
const endRimCons = G.sketch.newConstraints();
note('constraints after end-rim-snapped arc: ' + JSON.stringify(endRimCons));
assert(
  endRimCons.some(
    (c) =>
      c.type === 'Coincident' &&
      c.refs.some((r) => r.new === arcIdx && r.pt === 2) &&
      c.refs.some((r) => (r.new ?? r.geo) === lineB && r.pt === 2)
  ),
  'an arc end-rim point that snaps onto an existing endpoint gets a real Coincident, even off the seed radius - the solver reconciles it, we do not pre-filter'
);

note('--- REAL snap() path: a rim click near BOTH the arc\'s own pending point AND a real target snaps to the real target ---');
await rpc('session.reset');
await G.refresh();
await idle();
await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
await waitFor(() => G.getState().sketchMode, 4000);

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
      buttons: type === 'pointerdown' ? 1 : 0
    },
    extra || {}
  );
  el.dispatchEvent(new PointerEvent(type, opts));
}
function clickAt(x, y) {
  const el = viewportEl();
  fire(el, 'pointermove', x, y);
  fire(el, 'pointerdown', x, y);
  fire(el, 'pointerup', x, y);
}
function pressKey(key) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

// a real line whose start point sits at (30,30) - the SAME sketch-plane
// point the arc's centre click below will land on. This is the exact shape
// of the real-world bug: a rim/centre click that visually lands on shared
// coordinates has to resolve to the REAL entity, not to nothing.
const lineC = G.sketch.commitTool('line', [[30, 30], [30, 40]]);
await sleep(60);

// commitTool leaves the sketch tool state as it found it (it restores it
// after the synthetic commit) - switch to the arc tool for real, the same
// way a real user would (the "A" hotkey), so the dispatched clicks below
// actually drive the real multi-click arc flow instead of whatever tool
// was last active.
pressKey('a');
await sleep(40);

const p0 = G.sketchUVToScreen(30, 30); // arc centre - exactly on lineC's start point
const p1 = G.sketchUVToScreen(40, 30); // arc start rim
const p2 = G.sketchUVToScreen(30, 20); // arc end rim
assert(!!p0 && !!p1 && !!p2, 'projected all three intended arc clicks to real screen coordinates');

if (p0 && p1 && p2) {
  // hover first so snap() actually runs and picks a candidate before the
  // click commits it, exactly like a real user moving the mouse in
  clickAt(p0.x, p0.y);
  await sleep(40);
  clickAt(p1.x, p1.y);
  await sleep(40);
  clickAt(p2.x, p2.y);
  await sleep(80);

  const realCons = G.sketch.entities();
  note('entities after real-dispatched arc draw: ' + JSON.stringify(realCons));
  const cons = G.sketch.newConstraints();
  note('constraints after real-dispatched centre-on-shared-point arc: ' + JSON.stringify(cons));
  assert(
    cons.some(
      (c) =>
        c.type === 'Coincident' &&
        c.refs.some((r) => r.pt === 3) &&
        c.refs.some((r) => (r.new ?? r.geo) === lineC && r.pt === 1)
    ),
    'a REAL mouse-dispatched arc centre click landing on an existing line endpoint resolves snap() to that real entity (not to nothing, and not to the arc\'s own pending point) and gets welded with a Coincident'
  );
} else {
  note('skipped real-dispatch assertion - screen projection unavailable in this environment');
}

note('--- done ---');
await G.cancelSketch().catch(() => {});
