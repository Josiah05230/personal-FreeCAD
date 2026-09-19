/* Verifies the live closed-loop fill detects a profile that closes through
 * an ARC or through PROJECTED geometry, not just plain drawn lines (the
 * user's report: "detecting a closed loop or not mid-sketch" was broken for
 * exactly these two cases - lineLoops() used to only ever look at
 * this.entities.filter(type === 'line'), silently excluding arcs and
 * this.projected entirely). */

note('--- closed loop through an ARC fills live, mid-sketch ---');
await rpc('session.reset');
await G.refresh();
await idle();
await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
await waitFor(() => G.getState().sketchMode, 4000);

// a "stadium" shape: two lines + two arcs, closing entirely through curves
// on two sides - if the fill only considered lines, this would never
// register as closed even once every join is genuinely welded.
const l1 = G.sketch.addEntity({ type: 'line', a: [-10, 8], b: [10, 8] });
const a1 = G.sketch.addEntity({ type: 'arc', c: [10, 0], r: 8, a0: Math.PI / 2, a1: -Math.PI / 2 });
const l2 = G.sketch.addEntity({ type: 'line', a: [10, -8], b: [-10, -8] });
const a2 = G.sketch.addEntity({ type: 'arc', c: [-10, 0], r: 8, a0: -Math.PI / 2, a1: Math.PI / 2 });
await sleep(60);

G.sketch.selectPoints([{ e: l1, pt: 2 }, { e: a1, pt: 1 }]);
assert(G.sketch.applyConstraint('Coincident'), 'weld line1 end to arc1 start');
G.sketch.selectPoints([{ e: a1, pt: 2 }, { e: l2, pt: 1 }]);
assert(G.sketch.applyConstraint('Coincident'), 'weld arc1 end to line2 start');
G.sketch.selectPoints([{ e: l2, pt: 2 }, { e: a2, pt: 1 }]);
assert(G.sketch.applyConstraint('Coincident'), 'weld line2 end to arc2 start');
G.sketch.selectPoints([{ e: a2, pt: 2 }, { e: l1, pt: 1 }]);
assert(G.sketch.applyConstraint('Coincident'), 'weld arc2 end to line1 start (closes the loop)');
await sleep(300);

const fillCountArc = G.sketch.fillCount();
note('fillCount() after welding the arc-closed stadium: ' + fillCountArc);
assert(fillCountArc > 0, 'a stadium closed via two arcs registers a live fill (mid-sketch, before Finish) - lineLoops() used to only look at plain lines');

note('--- closed loop through PROJECTED geometry fills live, mid-sketch ---');
await rpc('session.reset');
await G.refresh();
await idle();

const s0 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: s0.sketchId,
  elements: [{ type: 'rect', a: [0, 0], b: [40, 30] }],
  constraints: []
});
await G.refresh();
await idle();
G.selectSketch(s0.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10 });
await idle();

await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
await waitFor(() => G.getState().sketchMode, 4000);
await idle();

// project one edge of the body's own top face (Z=10, the extrude height) -
// on this XY-plane sketch that projects as a real 40mm-long line along one
// side of the rectangle, exactly like using a model edge as one side of a
// new profile in real use.
const scene = await rpc('scene.get');
const mesh = scene.meshes[0];
const topEdge = mesh.edges.find((e) => {
  const p = e.points;
  const z0 = Math.abs(p[2] - 10);
  const z1 = Math.abs(p[p.length - 1] - 10);
  const dy = Math.abs(p[1] - p[p.length - 2]);
  return z0 < 1e-2 && z1 < 1e-2 && dy < 1e-3;
});
assert(!!topEdge, 'found a top edge to project (Z=10, running along X)');
const sub = 'Edge' + (topEdge.edge + 1);
const projected = await G.sketch.project(mesh.id, sub);
assert(projected.length > 0, 'projected the top edge into the sketch');

const projEnt = projected[0];
note('projected entity: ' + JSON.stringify(projEnt));
assert(projEnt.type === 'line', 'the projected top edge is a line (matches the XY sketch plane)');

// close the loop with 3 fresh lines against the projected edge's own
// endpoints - a real profile using ONE projected side + 3 drawn sides
const [pa, pb] = [projEnt.a, projEnt.b];
const other1 = [pa[0], pa[1] - 20];
const other2 = [pb[0], pb[1] - 20];
const PROJ_BASE = 100000;
const pl1 = G.sketch.addEntity({ type: 'line', a: pa, b: other1 }, [{ idx: PROJ_BASE, pt: 1 }, null]);
const pl2 = G.sketch.addEntity({ type: 'line', a: other1, b: other2 });
const pl3 = G.sketch.addEntity({ type: 'line', a: other2, b: pb }, [null, { idx: PROJ_BASE, pt: 2 }]);
await sleep(60);

G.sketch.selectPoints([{ e: pl1, pt: 1 }, { e: PROJ_BASE, pt: 1 }]);
assert(G.sketch.applyConstraint('Coincident'), 'weld the first drawn line onto the projected edge start');
G.sketch.selectPoints([{ e: pl1, pt: 2 }, { e: pl2, pt: 1 }]);
assert(G.sketch.applyConstraint('Coincident'), 'weld line1 to line2');
G.sketch.selectPoints([{ e: pl2, pt: 2 }, { e: pl3, pt: 1 }]);
assert(G.sketch.applyConstraint('Coincident'), 'weld line2 to line3');
G.sketch.selectPoints([{ e: pl3, pt: 2 }, { e: PROJ_BASE, pt: 2 }]);
assert(G.sketch.applyConstraint('Coincident'), 'weld line3 back onto the projected edge end (closes the loop)');
await sleep(300);

const fillCountProj = G.sketch.fillCount();
note('fillCount() after closing a loop through a projected edge: ' + fillCountProj);
assert(
  fillCountProj > 0,
  'a profile that closes through PROJECTED geometry registers a live fill (mid-sketch) - lineLoops() used to ignore this.projected entirely'
);

note('--- done ---');
await G.cancelSketch().catch(() => {});
