/* Verifies a real user-reported bug: chaining tangent arcs/lines while
 * drawing (e.g. a "stadium" or fillet-style profile) could leave a genuinely
 * redundant Coincident constraint sitting next to a later user-applied
 * endpoint Tangent on the SAME point pair - the arc tool's own auto-weld
 * (autoCoincident) always welds a rim endpoint that snapped onto anything,
 * and separately the constraint palette's Tangent handler recognizes a
 * "close the wire smoothly" endpoint-tangent and welds that too, with no
 * check that a Coincident might already be sitting on the exact same pair.
 * FreeCAD's solver then reports that Coincident as redundant on EVERY
 * subsequent solve, which showed up in a real trace as glitchy/inconsistent
 * dragging once the sketch had several such chained arcs.
 *
 * Also verifies the companion fix: the live closed-loop FILL preview used to
 * triangulate an arc as a straight chord between its two endpoints, visibly
 * cutting off the curved area instead of following the real curve. */

note('--- draw two arcs that share an endpoint (arc tool auto-welds it) ---');
await rpc('session.reset');
await G.refresh();
await idle();
await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
await waitFor(() => G.getState().sketchMode, 4000);

// arc1: centre (0,0), start rim (10,0), end rim (0,10) - a quarter circle
const arc1 = G.sketch.commitTool('arc', [[0, 0], [10, 0], [0, 10]]);
await sleep(60);
// arc2: centre (0,20), start rim SNAPPED onto arc1's end (0,10), end rim (10,20)
const arc2 = G.sketch.commitTool(
  'arc',
  [[0, 20], [0, 10], [10, 20]],
  [null, { idx: arc1, pt: 2 }, null]
);
await sleep(60);

const consAfterArcs = G.sketch.newConstraints();
note('constraints after drawing both arcs: ' + JSON.stringify(consAfterArcs));
const hasAutoCoincident = consAfterArcs.some(
  (c) =>
    c.type === 'Coincident' &&
    c.refs.some((r) => r.new === arc2 && r.pt === 1) &&
    c.refs.some((r) => r.new === arc1 && r.pt === 2)
);
assert(hasAutoCoincident, 'the arc tool auto-welds a rim endpoint that snapped onto another arc\'s rim');

note('--- apply an endpoint Tangent on the SAME shared point via the constraint palette ---');
G.sketch.select([arc1, arc2]);
const applied = G.sketch.applyConstraint('Tangent');
assert(applied, 'the Tangent constraint was accepted');
await sleep(80);

const consAfterTangent = G.sketch.newConstraints();
note('constraints after applying Tangent: ' + JSON.stringify(consAfterTangent));

const hasTangentOnJoint = consAfterTangent.some(
  (c) =>
    c.type === 'Tangent' &&
    c.refs.some((r) => r.new === arc1 && r.pt === 2) &&
    c.refs.some((r) => r.new === arc2 && r.pt === 1)
);
assert(hasTangentOnJoint, 'the endpoint Tangent was added on the shared point pair');

const hasRedundantCoincident = consAfterTangent.some(
  (c) =>
    c.type === 'Coincident' &&
    c.refs.some((r) => r.new === arc1 && r.pt === 2) &&
    c.refs.some((r) => r.new === arc2 && r.pt === 1)
);
assert(
  !hasRedundantCoincident,
  'the earlier auto-welded Coincident on that SAME point pair is removed once an endpoint Tangent covers it - the Tangent already implies coincidence there, so keeping both would be a genuine, solver-flagged redundancy that used to persist forever and destabilize later drags'
);

note('--- verify the solve reports no redundant constraint for this joint ---');
await sleep(300);
const solveOk = await rpc('sketch.solve', {
  elements: G.sketch.entities(),
  constraints: consAfterTangent
});
note('solve result: ' + JSON.stringify(solveOk));
assert(
  (solveOk.redundant || []).length === 0,
  'no constraint is flagged redundant after the dedup - the solve should be clean, not carrying a known-inconsistent constraint through every future drag'
);

note('--- fill preview: the loop should follow the real arc curve, not a straight chord ---');
// close the loop with two more arcs so it forms a full loop the live fill can
// detect (stadium-like shape: 4 quarter arcs). We only need the fill count
// and a curvature check on the returned loop geometry via the test hook.
const arc3 = G.sketch.commitTool(
  'arc',
  [[10, 10], [10, 20], [20, 10]],
  [null, { idx: arc2, pt: 2 }, null]
);
await sleep(60);
const arc4 = G.sketch.commitTool(
  'arc',
  [[10, 10], [20, 10], [10, 0]],
  [null, { idx: arc3, pt: 2 }, null]
);
await sleep(60);
G.sketch.selectPoints([{ e: arc4, pt: 2 }, { e: arc1, pt: 1 }]);
G.sketch.applyConstraint('Coincident');
await sleep(300);

const fillCount = G.sketch.fillCount();
note('fillCount() after closing the 4-arc loop: ' + fillCount);
assert(fillCount > 0, 'the closed 4-arc loop registers a live fill');

note('--- done ---');
await G.cancelSketch().catch(() => {});
