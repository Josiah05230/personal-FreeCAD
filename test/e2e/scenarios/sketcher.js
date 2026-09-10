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
// the coincident-to-origin constraint must actually reach FreeCAD and survive
{
  const nc = G.sketch.newConstraints();
  assert(
    nc.some(
      (c) =>
        c.type === 'Coincident' &&
        c.refs.some((r) => r.geo === -1) &&
        c.refs.some((r) => r.new === lo || r.geo === lo)
    ),
    'the origin Coincident is recorded with a geo:-1 ref for the sidecar'
  );
  await G.finishSketch();
  await idle();
  await sleep(220);
  const oId = (G.getState().selection.find((s) => s.startsWith('sketch:')) || '').slice(7);
  const oRe = await rpc('sketch.reopen', { sketchId: oId });
  assert(
    (oRe.constraints || []).some(
      (c) => c.type === 'Coincident' && [c.refs?.[0]?.geo, c.refs?.[1]?.geo].includes(-1)
    ),
    'the real sketch kept a Coincident-to-origin constraint after Finish + reopen'
  );
  const oent = oRe.entities.find((e) => e.type === 'line');
  assert(
    oent && Math.hypot(oent.a[0], oent.a[1]) < 0.01,
    'the reopened line start sits on the origin (' +
      (oent ? Math.hypot(oent.a[0], oent.a[1]).toFixed(3) : 'n/a') +
      ')'
  );
}

// ---------------------------------------------------------------- center rectangle
note('--- a Center Rectangle: 4 sides + 2 crossing construction diagonals, centred ---');
await freshSketch();
// first pick = the centre (on the origin), second pick = a corner
G.sketch.commitTool('rect-center', [[0, 0], [20, 12]]);
await sleep(120);
{
  const es = G.sketch.entities();
  const sides = es.filter((e) => e.type === 'line' && !e.construction);
  const diags = es.filter((e) => e.type === 'line' && e.construction);
  assert(sides.length === 4, `center rect has 4 real sides (${sides.length})`);
  assert(diags.length === 2, `center rect has 2 construction diagonals crossing at the centre (${diags.length})`);
  // the diagonals' shared midpoint is the rectangle centre - it must be the origin
  const mid = (l) => [(l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2];
  const m0 = mid(diags[0]);
  const m1 = mid(diags[1]);
  assert(
    Math.hypot(m0[0] - m1[0], m0[1] - m1[1]) < 0.01,
    'both construction diagonals share one midpoint (a real centre point to snap to)'
  );
  assert(
    Math.hypot(m0[0], m0[1]) < 0.05,
    `the centre sits on the origin (${m0[0].toFixed(2)}, ${m0[1].toFixed(2)})`
  );
  // it survives Finish + reopen with its diagonals + centre anchor
  await G.finishSketch();
  await idle();
  await sleep(220);
  const crId = (G.getState().selection.find((s) => s.startsWith('sketch:')) || '').slice(7);
  const crRe = await rpc('sketch.reopen', { sketchId: crId });
  const rSides = crRe.entities.filter((e) => e.type === 'line' && !e.construction);
  const rDiags = crRe.entities.filter((e) => e.type === 'line' && e.construction);
  assert(rSides.length === 4 && rDiags.length === 2, `reopened center rect: 4 sides + 2 diagonals (${rSides.length}/${rDiags.length})`);
  const rm = [(rDiags[0].a[0] + rDiags[0].b[0]) / 2, (rDiags[0].a[1] + rDiags[0].b[1]) / 2];
  assert(Math.hypot(rm[0], rm[1]) < 0.1, `reopened centre still on the origin (${rm[0].toFixed(2)}, ${rm[1].toFixed(2)})`);
}

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

// ---------------------------------------------------------------- convert to construction
note('--- toggle selected geometry to/from construction, round-tripped ---');
await freshSketch();
G.sketch.addEntity({ type: 'line', a: [0, 0], b: [40, 0] });
G.sketch.addEntity({ type: 'line', a: [0, 10], b: [40, 10] });
await sleep(60);
await G.finishSketch();
await idle();
await sleep(200);
const cId = (G.getState().selection.find((s) => s.startsWith('sketch:')) || '').slice(7);
await G.editSketch(cId);
await waitFor(() => G.getState().sketchMode, 4000);
await sleep(120);
assert(G.sketch.entities().every((e) => !e.construction), 'both reopened lines start as real geometry');
G.sketch.select([1]);
G.sketch.toggleConstruction(); // the Construction button, with a selection -> converts it
await sleep(40);
assert(G.sketch.entities()[1].construction === true, 'the selected line converted to construction');
assert(
  G.sketch.convertedEntities().some((p) => p[0] === 1 && p[1] === true),
  'the conversion is queued for the sidecar (convertedElements)'
);
await G.finishSketch();
await idle();
await sleep(250);
const cRe = await rpc('sketch.reopen', { sketchId: cId });
assert(cRe.entities[1] && cRe.entities[1].construction === true, 'the real sketch line is now construction after Finish');

// ---------------------------------------------------------------- projected geometry
note('--- project model geometry into a sketch and round-trip it ---');
await rpc('session.reset');
await G.refresh();
await idle();
const ps = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: ps.sketchId,
  elements: [{ type: 'rect', a: [0, 0], b: [40, 30] }],
  constraints: []
});
G.selectSketch(ps.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10 });
await idle();
const pbid = G.getState().bodies[0].id;
// a sketch on the TOP face - its own top edges project as real lines
const scAfter = await rpc('scene.get');
const mm = scAfter.meshes.find((x) => x.id === pbid);
// top face = the faceGroup whose triangles are highest in Z; just use the last
// face group's face index as a heuristic, then let the sidecar resolve it
const topFaceSub = `Face${mm.faceGroups[mm.faceGroups.length - 1].face + 1}`;
const fsk = await rpc('sketch.onFace', { bodyId: pbid, face: topFaceSub });
await G.editSketch(fsk.sketchId);
await waitFor(() => G.getState().sketchMode, 4000);
await sleep(100);
// project a top edge (Edge1..Edge12 - the top-face ones come back as real lines)
let proj = [];
for (const en of ['Edge1', 'Edge2', 'Edge3', 'Edge5', 'Edge7']) {
  proj = await G.sketch.project(pbid, en);
  if (proj.some((p) => p.type === 'line' && (p.a[0] !== p.b[0] || p.a[1] !== p.b[1]))) break;
}
assert(proj.length >= 1, `projection produced geometry (${proj.length})`);
assert(proj[0].geoId < 0, 'projected geometry has a negative geoId');
assert(proj[0].projected === true, 'projected entity is flagged projected');
await G.finishSketch();
await idle();
await sleep(200);
const pro = await rpc('sketch.reopen', { sketchId: fsk.sketchId });
assert((pro.projected || []).length >= 1, 'projected geometry survives Finish + reopen');
// unproject removes it
await G.editSketch(fsk.sketchId);
await waitFor(() => G.getState().sketchMode, 4000);
await sleep(80);
const afterUn = await G.sketch.unproject();
assert(afterUn.length === 0, 'unproject clears the projected geometry');
await G.finishSketch();
await idle();
await sleep(150);
const pro2 = await rpc('sketch.reopen', { sketchId: fsk.sketchId });
assert((pro2.projected || []).length === 0, 'the real sketch has no projections after unproject + Finish');

// ---------------------------------------------------------------- health
note('--- editor + engine healthy at end ---');
const fin = G.getState();
assert(fin.status === 'ready', 'app still ready (' + fin.status + ')');
assert(!document.body.innerText.includes('The interface hit an error'), 'no ErrorBoundary');
assert((await rpc('ping')).pong === true, 'engine still responds');
note('sketcher scenario complete');
