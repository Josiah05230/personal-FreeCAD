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

// ---------------------------------------------------------------- tangent
note('--- manual Tangent: a line becomes tangent to a circle and round-trips ---');
await freshSketch();
const tcirc = G.sketch.addEntity({ type: 'circle', c: [0, 0], r: 15 });
// a line that PASSES THROUGH the circle - Tangent must push it out to just touch
const tln = G.sketch.addEntity({ type: 'line', a: [-30, 8], b: [30, 8] });
await sleep(40);
G.sketch.select([tln, tcirc]);
assert(G.sketch.available().includes('Tangent'), 'Tangent is offered for a line + a circle');
assert(G.sketch.applyConstraint('Tangent'), 'Tangent(line, circle) applies');
await sleep(200);
{
  ents = G.sketch.entities();
  const c = ents[tcirc].c;
  const A = ents[tln].a;
  const B = ents[tln].b;
  // distance from the circle centre to the (infinite) line = radius, for tangency
  const dx = B[0] - A[0];
  const dy = B[1] - A[1];
  const L = Math.hypot(dx, dy) || 1;
  const dist = Math.abs((c[0] - A[0]) * dy - (c[1] - A[1]) * dx) / L;
  assert(
    Math.abs(dist - ents[tcirc].r) < 0.3,
    `the line is now tangent to the circle (gap ${(dist - ents[tcirc].r).toFixed(3)})`
  );
  // finish + reopen: the Tangent constraint must survive
  await G.finishSketch();
  await idle();
  await sleep(220);
  const tId = (G.getState().selection.find((s) => s.startsWith('sketch:')) || '').slice(7);
  const tRe = await rpc('sketch.reopen', { sketchId: tId });
  assert(
    (tRe.constraints || []).some((k) => k.type === 'Tangent'),
    'the real sketch kept a Tangent constraint after Finish + reopen'
  );
}

// auto-tangent while drawing: a line whose end lands on an arc endpoint
note('--- auto-tangent: a line ending on an arc endpoint gets ONE Tangent, no conflict ---');
await freshSketch();
{
  // an arc, then a line whose END snaps to the arc's start point
  const aArc = G.sketch.addEntity({ type: 'arc', c: [20, 0], r: 10, a0: Math.PI, a1: 1.5 * Math.PI });
  await sleep(40);
  const aEnts = G.sketch.entities();
  // arc start (pt 1) world position
  const as = [
    aEnts[aArc].c[0] + Math.cos(aEnts[aArc].a0) * aEnts[aArc].r,
    aEnts[aArc].c[1] + Math.sin(aEnts[aArc].a0) * aEnts[aArc].r
  ];
  // draw a line ending exactly there, telling the controller its end snapped to the arc start
  const aLn = G.sketch.addEntity({ type: 'line', a: [-15, as[1]], b: as }, [null, { idx: aArc, pt: 1 }]);
  await sleep(120);
  note('all new constraints: ' + JSON.stringify(G.sketch.newConstraints()));
  const nc = G.sketch.newConstraints().filter(
    (k) => (k.refs || []).some((r) => r.new === aLn || r.geo === aLn)
  );
  const tanCount = nc.filter((k) => k.type === 'Tangent').length;
  const coinCount = nc.filter((k) => k.type === 'Coincident').length;
  assert(tanCount === 1, `exactly one auto Tangent for the line->arc snap (${tanCount})`);
  assert(coinCount === 0, `NO separate Coincident (endpoint tangent implies it) - got ${coinCount}`);
  // and the whole set must actually solve without a conflict
  await G.finishSketch();
  await idle();
  await sleep(200);
  const atId = (G.getState().selection.find((s) => s.startsWith('sketch:')) || '').slice(7);
  const atRe = await rpc('sketch.reopen', { sketchId: atId });
  assert((atRe.constraints || []).some((k) => k.type === 'Tangent'), 'the auto Tangent survived Finish + reopen (it solved)');
  assert(atRe.entities.length >= 2, 'both the arc and the line are still there after Finish');
}

// manual Tangent (toolbar) between a line and an arc whose endpoints are only
// CLOSE (not exactly coincident, e.g. imprecise clicking while drawing) must
// weld that shared point, not just add an edge-level Tangent - a real user
// .FCStd file (2026-09-12) had exactly this: a line ending near an arc's rim,
// Tangent applied by hand, and the two points left ~0.014mm apart with no
// Coincident anywhere - the profile solved "fine" per-constraint but the wire
// was open, so Finish/Pad either failed or silently produced a non-solid.
note('--- manual Tangent: a line + a NEARBY (not exactly coincident) arc endpoint welds shut ---');
await freshSketch();
{
  const mLn = G.sketch.addEntity({ type: 'line', a: [0, 0], b: [30, 0] });
  await sleep(40);
  // arc whose START rim point is close to the line's end (30,0) but off by a
  // deliberate, sub-pixel-at-typical-zoom fraction of a mm - same as a real
  // imprecise click, well inside the fix's weld tolerance
  const mArc = G.sketch.addEntity({
    type: 'arc',
    c: [30, 10],
    r: 10,
    a0: -Math.PI / 2 + 0.0015, // start point ~= (30.015, 0.0), not exactly (30,0)
    a1: 0
  });
  await sleep(40);
  const preEnts = G.sketch.entities();
  const gap0 = Math.hypot(
    preEnts[mLn].b[0] - (preEnts[mArc].c[0] + Math.cos(preEnts[mArc].a0) * preEnts[mArc].r),
    preEnts[mLn].b[1] - (preEnts[mArc].c[1] + Math.sin(preEnts[mArc].a0) * preEnts[mArc].r)
  );
  assert(gap0 > 1e-4 && gap0 < 0.5, `the two points start out CLOSE but not identical (gap ${gap0})`);
  G.sketch.select([mLn, mArc]);
  assert(G.sketch.available().includes('Tangent'), 'Tangent is offered for a line + a nearby arc endpoint');
  assert(G.sketch.applyConstraint('Tangent'), 'Tangent(line, arc-endpoint) applies');
  await sleep(120);
  const nc = G.sketch.newConstraints();
  const tan = nc.find((k) => k.type === 'Tangent' && (k.refs || []).some((r) => (r.new === mLn || r.geo === mLn)));
  assert(!!tan, 'a Tangent constraint was recorded for the line');
  assert(
    (tan.refs || []).every((r) => r.pt === 1 || r.pt === 2),
    `the Tangent carries POINT refs (endpoint tangent, implies coincidence) - got refs ${JSON.stringify(tan.refs)}`
  );
  const postEnts = G.sketch.entities();
  const arcStart = [
    postEnts[mArc].c[0] + Math.cos(postEnts[mArc].a0) * postEnts[mArc].r,
    postEnts[mArc].c[1] + Math.sin(postEnts[mArc].a0) * postEnts[mArc].r
  ];
  const gap1 = Math.hypot(postEnts[mLn].b[0] - arcStart[0], postEnts[mLn].b[1] - arcStart[1]);
  assert(gap1 < 1e-6, `the shared point is now exactly welded (gap ${gap1})`);
  // round-trip through the real solver: Finish + reopen and re-check the gap
  await G.finishSketch();
  await idle();
  await sleep(220);
  const mId = (G.getState().selection.find((s) => s.startsWith('sketch:')) || '').slice(7);
  const mRe = await rpc('sketch.reopen', { sketchId: mId });
  assert((mRe.constraints || []).some((k) => k.type === 'Tangent'), 'the Tangent survived Finish + reopen');
  const reLn = mRe.entities[mLn];
  const reArc = mRe.entities[mArc];
  const reArcStart = [
    reArc.c[0] + Math.cos(reArc.a0) * reArc.r,
    reArc.c[1] + Math.sin(reArc.a0) * reArc.r
  ];
  const gap2 = Math.hypot(reLn.b[0] - reArcStart[0], reLn.b[1] - reArcStart[1]);
  assert(gap2 < 1e-4, `after the real FreeCAD solve, the joint is still closed (gap ${gap2})`);
}

// ---------------------------------------------------------------- centre-point arc
note('--- centre-point arc: centre snaps to a line endpoint (real commit() path) ---');
await freshSketch();
{
  // a line, then a centre-point arc drawn through the REAL 3-click commit()
  // path (not addEntity/testAddEntity, which is a separate code path) whose
  // FIRST click (the centre) lands exactly on the line's endpoint
  const lIdx = G.sketch.commitTool('line', [
    [0, 0],
    [20, 0]
  ]);
  await sleep(40);
  const before = G.sketch.newConstraints().length;
  const aIdx = G.sketch.commitTool(
    'arc',
    [
      [20, 0], // centre - exactly the line's endpoint
      [30, 0], // start/radius point
      [20, 10] // end point
    ],
    [{ idx: lIdx, pt: 2 }, null, null]
  );
  await sleep(60);
  const ents = G.sketch.entities();
  assert(ents[aIdx] && ents[aIdx].type === 'arc', 'drew a centre-point arc');
  const after = G.sketch.newConstraints();
  assert(after.length > before, 'the arc centre landing on the line endpoint auto-constrained (got ' + after.length + ' vs before ' + before + ')');
  const hitsArcCentre = after.some(
    (c) => c.type === 'Coincident' && (c.refs || []).some((r) => (r.new === aIdx || r.geo === aIdx) && r.pt === 3)
  );
  assert(hitsArcCentre, 'the recorded constraint actually pins the arc CENTRE (pt 3), not something else');
  await G.finishSketch();
  await idle();
  await sleep(200);
  const acId = (G.getState().selection.find((s) => s.startsWith('sketch:')) || '').slice(7);
  const acRe = await rpc('sketch.reopen', { sketchId: acId });
  assert((acRe.constraints || []).some((k) => k.type === 'Coincident'), 'the centre-arc weld survived Finish + reopen');
  assert(acRe.entities.length >= 2, 'both the line and the arc are still there after Finish');
}

// ------------------------------ centre-point arc's RIM points snap too
note('--- centre-point arc: the START/END rim clicks (not just the centre) weld onto existing geometry, closing the wire (real user report, 2026-09-11: "doesn\'t want to make an enclosed face") ---');
await freshSketch();
{
  // a line, then a centre-point arc whose START click (the 2nd of the 3)
  // snaps onto that line's free endpoint - only the arc's CENTRE ever got
  // auto-constrained before this fix; the start/end rim clicks were silently
  // dropped even when a real snap was detected, leaving that joint open no
  // matter how precisely it was clicked
  const lIdx = G.sketch.commitTool('line', [
    [0, 0],
    [10, 0]
  ]);
  await sleep(40);
  const before = G.sketch.newConstraints().length;
  const aIdx = G.sketch.commitTool(
    'arc',
    [
      [20, 10], // centre - unrelated to the line
      [10, 0], // start point - lands exactly on the line's free endpoint
      [20, 20] // end point
    ],
    [null, { idx: lIdx, pt: 2 }, null]
  );
  await sleep(60);
  const after = G.sketch.newConstraints();
  const added = after.length - before;
  assert(added >= 1, `the arc's start-point snap onto the line endpoint added a constraint (got ${added})`);
  const weldsLineToArcStart = after.some(
    (c) =>
      c.type === 'Coincident' &&
      (c.refs || []).some((r) => (r.new === lIdx || r.geo === lIdx) && r.pt === 2) &&
      (c.refs || []).some((r) => (r.new === aIdx || r.geo === aIdx) && r.pt === 1)
  );
  assert(weldsLineToArcStart, 'the recorded constraint actually welds the line endpoint to the arc START (pt 1), not something else');

  await G.finishSketch();
  await idle();
  await sleep(200);
  const arId = (G.getState().selection.find((s) => s.startsWith('sketch:')) || '').slice(7);
  const arRe = await rpc('sketch.reopen', { sketchId: arId });
  assert(!arRe.error, 'the sketch solved cleanly after Finish');
  assert(
    (arRe.constraints || []).some((k) => k.type === 'Coincident'),
    'the line-to-arc-start weld survived Finish + reopen'
  );
}

// ------------------------------------------------- line endpoint onto arc centre
note('--- centre-point arc: a LINE endpoint snapping onto the arc CENTRE gets exactly one Coincident, not also a spurious Tangent (real user log, 2026-09-11) ---');
await freshSketch();
{
  // draw the arc FIRST (centre at [20,0]), then a line whose endpoint lands
  // on that same centre - this is the reverse direction of the test above,
  // and it is the exact sequence from the user's bug log: autoTangent used to
  // fire on ANY curve snap regardless of which point (falling back to
  // "endpoint 1") even when the snapped point was the centre (pt 3), adding a
  // second, contradictory constraint on top of autoCoincident's correct one
  const aIdx = G.sketch.commitTool('arc', [
    [20, 0], // centre
    [30, 0], // start
    [20, 10] // end
  ]);
  await sleep(40);
  const before = G.sketch.newConstraints().length;
  const lIdx = G.sketch.commitTool(
    'line',
    [
      [20, 0], // starts exactly on the arc's centre
      [40, 20]
    ],
    [{ idx: aIdx, pt: 3 }, null]
  );
  await sleep(60);
  const after = G.sketch.newConstraints();
  const added = after.length - before;
  assert(added === 1, `snapping a line endpoint onto an arc centre adds exactly ONE constraint, not ${added}`);
  assert(
    after.some(
      (c) => c.type === 'Coincident' && (c.refs || []).some((r) => (r.new === lIdx || r.geo === lIdx) && r.pt === 1)
    ),
    'the one constraint is the Coincident pinning the line start to the centre'
  );
  assert(
    !after.some((c) => c.type === 'Tangent' && (c.refs || []).some((r) => r.new === lIdx || r.geo === lIdx)),
    'no spurious Tangent got attached to the line from a centre snap'
  );
  await G.finishSketch();
  await idle();
  await sleep(200);
  const lcId = (G.getState().selection.find((s) => s.startsWith('sketch:')) || '').slice(7);
  const lcRe = await rpc('sketch.reopen', { sketchId: lcId });
  assert(!lcRe.error, 'the sketch solved cleanly (no conflicting/redundant constraints) after Finish');
  assert(lcRe.entities.length >= 2, 'both the arc and the line are still there after Finish');
}

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

// Ctrl+Z INSIDE the sketch editor, as a real window keydown (not the semantic
// bridge) - the exact path the user's own keypress takes. User report
// (2026-09-12): "ctrl+z while editing a sketch should undo whatever action I
// just did. Always. In any context." - reproduces via a genuine
// KeyboardEvent dispatched at window, same target both the App-level global
// handler and SketchController's own handler listen on.
note('--- Ctrl+Z inside the sketch editor undoes the last local edit (real keydown) ---');
await freshSketch();
{
  const uz = G.sketch.addEntity({ type: 'line', a: [0, 0], b: [50, 0] });
  await sleep(40);
  const countAfterDraw = G.sketch.entities().length;
  assert(countAfterDraw >= 1, 'a line exists after drawing it');
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
  );
  await sleep(120);
  const countAfterUndo = G.sketch.entities().length;
  assert(
    countAfterUndo === countAfterDraw - 1,
    `Ctrl+Z undid the drawn line (${countAfterDraw} -> ${countAfterUndo}, want ${countAfterDraw - 1})`
  );
  // still inside the sketch - undo must not have kicked out to the feature tree
  assert(G.getState().sketchMode, 'Ctrl+Z kept the sketch editor open (did not fall through to the app-level undo)');

  // and after a DELETE, the same real Ctrl+Z should bring the deleted entity back
  const uz2 = G.sketch.addEntity({ type: 'line', a: [0, 10], b: [50, 10] });
  await sleep(40);
  const countBeforeDelete = G.sketch.entities().length;
  G.sketch.select([uz2]);
  G.sketch.deleteSelection();
  await sleep(80);
  assert(G.sketch.entities().length === countBeforeDelete - 1, 'the second line was deleted');
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
  );
  await sleep(120);
  assert(
    G.sketch.entities().length === countBeforeDelete,
    `Ctrl+Z restored the deleted line (want ${countBeforeDelete}, got ${G.sketch.entities().length})`
  );
}

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
const pointsBeforeDelete = G.sketch.handlePointCount();
G.sketch.select([1]); // delete the 2nd reopened line
G.sketch.deleteSelection();
await sleep(60);
assert(G.sketch.removedEntities().includes(1), 'the reopened line is queued for removal (removedElements)');
// deleting a REOPENED (base) line never actually splices it out of
// this.entities (its index is the reopen contract - see deleteSelected) so
// the LINE render already correctly hid it via deletedBaseSet, but the
// point-handle render loop had no such guard: its two endpoint handles kept
// being drawn forever after "deleting" it, looking exactly like the line
// was still there (user report, 2026-09-13: "when I delete a line or any
// sketch object, it's points don't seem to go [a]way")
assert(
  G.sketch.handlePointCount() === pointsBeforeDelete - 2,
  `deleting a reopened line's endpoint handles actually disappear from the render (before ${pointsBeforeDelete}, after ${G.sketch.handlePointCount()}, want ${pointsBeforeDelete - 2})`
);

// Ctrl+Z must undo the delete of REOPENED (base) geometry just as completely
// as it does freshly-drawn geometry - a real user report (2026-09-12) found
// that deleting base geometry, then Ctrl+Z, left it still hidden and still
// queued for removal on Finish even though `entities`/`constraints` looked
// reverted: the reopen-era bookkeeping (removedElements / deletedBaseSet)
// was never part of the undo snapshot.
window.dispatchEvent(
  new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
);
await sleep(120);
assert(
  !G.sketch.removedEntities().includes(1),
  'Ctrl+Z un-queues the reopened line for removal (' + JSON.stringify(G.sketch.removedEntities()) + ')'
);
assert(G.sketch.entities().length === 4, 'Ctrl+Z brings the reopened line back into the visible entity list (4)');
// and it must actually survive Finish now, not just look present in memory
await G.finishSketch();
await idle();
await sleep(250);
const skAfterUndo = await rpc('sketch.reopen', { sketchId: skId });
assert(
  skAfterUndo.entities.length === 4,
  'the real sketch kept all 4 lines after Ctrl+Z undid the delete, then Finish (' + skAfterUndo.entities.length + ')'
);

// redo the same delete-and-finish path for real (without the undo) to keep
// the original "deleting reopened geometry" assertion below meaningful
await G.editSketch(skId);
await waitFor(() => G.getState().sketchMode, 4000);
await sleep(120);
G.sketch.select([1]);
G.sketch.deleteSelection();
await sleep(60);
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

// ---------------------------------------------------------------- project a perpendicular edge -> a point
note('--- an edge perpendicular to the sketch plane projects to a point on it ---');
{
  // a sketch back on the XY plane; a vertical edge of the pad pierces it
  const xsk = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await G.editSketch(xsk.sketchId);
  await waitFor(() => G.getState().sketchMode, 4000);
  await sleep(100);
  let pt = [];
  for (const en of ['Edge1', 'Edge2', 'Edge3', 'Edge4', 'Edge9', 'Edge10', 'Edge11', 'Edge12']) {
    pt = await G.sketch.project(pbid, en);
    // a perpendicular edge -> a zero-length "line" (a point marker in the editor)
    if (pt.some((p) => p.type === 'line' && p.a[0] === p.b[0] && p.a[1] === p.b[1])) break;
  }
  assert(
    pt.some((p) => p.a[0] === p.b[0] && p.a[1] === p.b[1]),
    'a perpendicular edge projected to a point (zero-length entity)'
  );
  assert(pt.every((p) => p.projected === true), 'the projected point is flagged projected');
  await G.finishSketch();
  await idle();
  await sleep(200);
  const xre = await rpc('sketch.reopen', { sketchId: xsk.sketchId });
  assert(
    (xre.projected || []).some((p) => p.a && p.a[0] === p.b[0] && p.a[1] === p.b[1]),
    'the projected point survives Finish + reopen'
  );
}

// ---------------------------------------------------------------- fully-constrained color
note('--- a fully-constrained line renders WHITE, not the muted grey it used to ---');
await freshSketch();
{
  // deliberately NOT axis-aligned when drawn - a near-horizontal/vertical
  // line auto-gets its own Horizontal/Vertical constraint at draw time (see
  // the auto-angle test above), which would make the explicit
  // applyConstraint('Horizontal') below REDUNDANT - the solver's
  // over-constraint veto then silently drops it, so DOF this test expects to
  // pin never actually gets pinned (same lesson as the button-first
  // Coincident tests in real_input.js)
  const li2 = G.sketch.addEntity({ type: 'line', a: [8, 3], b: [28, 9] });
  await sleep(40);
  const before = G.sketch.entityColorHex(li2);
  assert(before && before !== '#ffffff', 'an unconstrained line does not start out white (' + before + ')');
  assert(
    !G.sketch.constrainedIndices().includes(li2),
    'an unconstrained line is not yet in the constrained set'
  );
  // weld the start to the origin (2 DOF), Horizontal (1 DOF), Distance (1 DOF)
  // - exactly 4 DOF for a 2-point line, so this fully constrains it
  G.sketch.selectPoints([{ e: -1, pt: 1 }, { e: li2, pt: 1 }]);
  assert(G.sketch.applyConstraint('Coincident'), 'weld the line start to the origin');
  await sleep(150);
  G.sketch.select([li2]);
  assert(G.sketch.applyConstraint('Horizontal'), 'apply Horizontal');
  await sleep(150);
  assert(G.sketch.setDimension(li2, 20), 'dimension the line length');
  await sleep(200);
  const idxs = await waitFor(() => {
    const v = G.sketch.constrainedIndices();
    return v.includes(li2) ? v : null;
  }, 3000);
  assert(idxs && idxs.includes(li2), 'the fully-constrained line is now in the constrained set (' + JSON.stringify(idxs) + ')');
  const after = G.sketch.entityColorHex(li2);
  assert(after === '#ffffff', 'the fully-constrained line now renders white (got ' + after + ')');
}

// ---------------------------------------------------------------- health
note('--- editor + engine healthy at end ---');
const fin = G.getState();
assert(fin.status === 'ready', 'app still ready (' + fin.status + ')');
assert(!document.body.innerText.includes('The interface hit an error'), 'no ErrorBoundary');
assert((await rpc('ping')).pong === true, 'engine still responds');
note('sketcher scenario complete');
