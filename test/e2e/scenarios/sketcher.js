/* Interactive 2D sketcher: drives the real SketchController through the test
 * hooks on window.__gwtcad.sketch (same code paths as pointer input) and
 * asserts the constraint / dimension / delete behaviour end to end, including
 * the sidecar round-trip on Finish.
 *
 * Covers the bugs reported 2026-09-08:
 *  - constraints on construction lines
 *  - line<->circle Coincident / PointOnObject
 *  - radius vs diameter dimensioning + toggle
 *  - auto-constrain while drawing (near-horizontal -> Horizontal, tangent)
 *  - deleting sketch geometry (session + reopened)
 *  - constraining to the sketch origin
 */

async function freshSketch() {
  if (G.getState().sketchMode) {
    await G.cancelSketch();
    await waitFor(() => !G.getState().sketchMode, 4000);
  }
  await rpc('session.reset');
  await G.refresh();
  await idle();
  await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
  await waitFor(() => G.getState().sketchMode, 4000);
  await sleep(80);
}

// ---------------------------------------------------------------- auto-angle
note('--- auto-constrain while drawing: near-horizontal / near-vertical ---');
await freshSketch();
// a segment ~1.5 degrees off horizontal should snap to Horizontal
let li = G.sketch.addEntity({ type: 'line', a: [0, 0], b: [50, 1.3] });
await sleep(40);
let cons = G.sketch.newConstraints();
assert(
  cons.some((c) => c.type === 'Horizontal' && (c.refs[0].new === li || c.refs[0].geo === li)),
  'a nearly-horizontal drawn line gets an auto Horizontal constraint'
);
const lv = G.sketch.addEntity({ type: 'line', a: [0, 0], b: [1.1, 40] });
await sleep(40);
cons = G.sketch.newConstraints();
assert(
  cons.some((c) => c.type === 'Vertical' && (c.refs[0].new === lv || c.refs[0].geo === lv)),
  'a nearly-vertical drawn line gets an auto Vertical constraint'
);
// a clearly diagonal line gets neither
const ld = G.sketch.addEntity({ type: 'line', a: [0, 0], b: [30, 30] });
await sleep(40);
cons = G.sketch.newConstraints();
assert(
  !cons.some(
    (c) =>
      (c.type === 'Horizontal' || c.type === 'Vertical') &&
      (c.refs[0].new === ld || c.refs[0].geo === ld)
  ),
  'a 45-degree line gets neither Horizontal nor Vertical'
);

// ---------------------------------------------------------------- origin
note('--- constrain a point to the sketch origin ---');
await freshSketch();
const lo = G.sketch.addEntity({ type: 'line', a: [10, 10], b: [40, 10] });
await sleep(40);
G.sketch.selectPoints([{ e: -1, pt: 1 }, { e: lo, pt: 1 }]); // origin + line start
const availOrigin = G.sketch.available();
assert(availOrigin.includes('Coincident'), 'Coincident is offered for origin + a point');
assert(G.sketch.applyConstraint('Coincident'), 'Coincident origin<->point applies');
await sleep(120);
let ents = G.sketch.entities();
let d0 = Math.hypot(ents[lo].a[0], ents[lo].a[1]);
assert(d0 < 0.01, 'the line start is now at the origin (' + d0.toFixed(3) + ')');

// ---------------------------------------------------------------- construction
note('--- constraints on a construction line ---');
await freshSketch();
G.sketch.setConstruction(true);
const cl = G.sketch.addEntity({ type: 'line', a: [5, 5], b: [45, 8] });
G.sketch.setConstruction(false);
await sleep(40);
ents = G.sketch.entities();
assert(ents[cl].construction === true, 'the line is construction geometry');
G.sketch.select([cl]);
const availC = G.sketch.available();
assert(availC.includes('Horizontal'), 'Horizontal is offered for a construction line');
assert(G.sketch.applyConstraint('Horizontal'), 'Horizontal applies to a construction line');
await sleep(150);
ents = G.sketch.entities();
assert(
  Math.abs(ents[cl].a[1] - ents[cl].b[1]) < 0.05,
  'the construction line actually became horizontal (dy=' +
    Math.abs(ents[cl].a[1] - ents[cl].b[1]).toFixed(3) +
    ') - it is not frozen'
);

// ---------------------------------------------------------------- line<->circle
note('--- line endpoint coincident / point-on a circle ---');
await freshSketch();
const circ = G.sketch.addEntity({ type: 'circle', c: [0, 0], r: 20 });
const ln1 = G.sketch.addEntity({ type: 'line', a: [30, 5], b: [60, 40] });
await sleep(40);
// endpoint -> circle centre (Coincident)
G.sketch.selectPoints([{ e: ln1, pt: 1 }]);
G.sketch.select([circ]);
let availLC = G.sketch.available();
assert(availLC.includes('Coincident'), 'Coincident offered for a point + a circle');
assert(G.sketch.applyConstraint('Coincident'), 'point<->circle-centre Coincident applies');
await sleep(120);
ents = G.sketch.entities();
let dc = Math.hypot(ents[ln1].a[0] - ents[circ].c[0], ents[ln1].a[1] - ents[circ].c[1]);
assert(dc < 0.05, 'the line start welded to the circle centre (' + dc.toFixed(3) + ')');

// endpoint -> on the circle rim (PointOnObject)
await freshSketch();
const circ2 = G.sketch.addEntity({ type: 'circle', c: [0, 0], r: 20 });
const ln2 = G.sketch.addEntity({ type: 'line', a: [40, 3], b: [60, 40] });
await sleep(40);
G.sketch.selectPoints([{ e: ln2, pt: 1 }]);
G.sketch.select([circ2]);
assert(G.sketch.available().includes('PointOnObject'), 'PointOnObject offered for a point + a circle');
assert(G.sketch.applyConstraint('PointOnObject'), 'point-on-circle applies');
await sleep(150);
ents = G.sketch.entities();
let rr = Math.hypot(ents[ln2].a[0] - ents[circ2].c[0], ents[ln2].a[1] - ents[circ2].c[1]);
assert(Math.abs(rr - 20) < 0.2, 'the line start sits on the circle rim, r=' + rr.toFixed(2) + ' (want ~20)');

// ---------------------------------------------------------------- radius/diameter
note('--- radius vs diameter dimensioning and toggle ---');
await freshSketch();
const cD = G.sketch.addEntity({ type: 'circle', c: [0, 0], r: 5 });
await sleep(40);
assert(G.sketch.setDimension(cD, 30, 'diameter'), 'diameter dimension applies');
await sleep(150);
ents = G.sketch.entities();
assert(Math.abs(ents[cD].r - 15) < 0.05, 'Ø30 gives radius 15 (got ' + ents[cD].r.toFixed(2) + ')');
let dcon = G.sketch.newConstraints().find((c) => c.type === 'Diameter');
assert(dcon && Math.abs(dcon.value - 30) < 1e-6, 'the constraint is a Diameter with value 30');
// toggle it to radius
assert(G.sketch.selectDim(cD), 'the circle dimension can be selected');
const nk = G.sketch.toggleDimKind();
assert(nk === 'radius', 'toggle flips Diameter -> radius');
await sleep(120);
ents = G.sketch.entities();
assert(Math.abs(ents[cD].r - 15) < 0.1, 'the circle stayed the same size after the toggle (r=' + ents[cD].r.toFixed(2) + ')');
let rcon = G.sketch.newConstraints().find((c) => c.type === 'Radius');
assert(rcon && Math.abs(rcon.value - 15) < 1e-6, 'it is now a Radius with value 15');

// ---------------------------------------------------------------- delete
note('--- deleting sketch geometry (session-drawn) ---');
await freshSketch();
const a = G.sketch.addEntity({ type: 'line', a: [0, 0], b: [40, 0] });
const b = G.sketch.addEntity({ type: 'line', a: [40, 0], b: [40, 30] });
await sleep(40);
const before = G.sketch.entities().length;
G.sketch.select([b]);
G.sketch.deleteSelection();
await sleep(80);
assert(G.sketch.entities().length === before - 1, 'deleting a session line removes it');

// deleting a REOPENED (base) line -> queued for removedElements, gone after Finish
note('--- deleting reopened geometry, round-tripped on Finish ---');
await freshSketch();
G.sketch.addEntity({ type: 'line', a: [0, 0], b: [50, 0] });
G.sketch.addEntity({ type: 'line', a: [50, 0], b: [50, 50] });
G.sketch.addEntity({ type: 'line', a: [50, 50], b: [0, 50] });
G.sketch.addEntity({ type: 'line', a: [0, 50], b: [0, 0] });
await sleep(60);
await G.finishSketch();
await idle();
await sleep(200);
// the finished sketch is now the current selection
const skId = (G.getState().selection.find((s) => s.startsWith('sketch:')) || '').slice(7);
assert(!!skId, 'the finished sketch id is known (' + skId + ')');
const skReopen0 = await rpc('sketch.reopen', { sketchId: skId });
assert(skReopen0.entities.length === 4, 'the committed sketch has 4 lines (' + skReopen0.entities.length + ')');
await G.editSketch(skId);
await waitFor(() => G.getState().sketchMode, 4000);
await sleep(120);
const reEnts = G.sketch.entities();
assert(reEnts.length === 4, 'the reopened editor shows its 4 lines (' + reEnts.length + ')');
G.sketch.select([1]); // delete the 2nd reopened line
G.sketch.deleteSelection();
await sleep(60);
assert(G.sketch.removedEntities().includes(1), 'the reopened line is queued for removal (removedElements)');
await G.finishSketch();
await idle();
await sleep(250);
const sk2 = await rpc('sketch.reopen', { sketchId: skId });
assert(sk2.entities.length === 3, 'the real sketch lost a line on Finish (' + sk2.entities.length + ' left)');

// ---------------------------------------------------------------- health
note('--- editor + engine healthy at end ---');
const fin = G.getState();
assert(fin.status === 'ready', 'app still ready (' + fin.status + ')');
assert(!document.body.innerText.includes('The interface hit an error'), 'no ErrorBoundary');
assert((await rpc('ping')).pong === true, 'engine still responds');
note('sketcher scenario complete');
