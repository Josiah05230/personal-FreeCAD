/* Verifies a real user-reported bug: an arc whose centre AND start rim are
 * both Coincident-welded to fixed PROJECTED (external) geometry could still
 * be freely dragged through a huge range of radii, because two separate
 * defects combined to break the solve:
 *
 * 1. The throwaway scratch sketch used by sketch.solve/dragStart/dragMove
 *    never materialized `this.projected` as real geometry - a Coincident
 *    referencing a projected point's negative geoId pointed at nothing, so
 *    the solver treated it as a no-op ("redundant"), leaving the radius
 *    genuinely free even though the constraint LOOKED like it should lock it.
 * 2. Separately, a line drawn between two such projected points that happen
 *    to share an X (or Y) coordinate got an auto-Vertical/Horizontal
 *    constraint that is itself genuinely redundant with the two coincidences
 *    - and FreeCAD's solver hard-fails the ENTIRE sketch (not just that one
 *    constraint) when a real redundancy is present, so an unrelated arc
 *    elsewhere in the same sketch also silently failed to solve.
 *
 * This reproduces the exact real trace: project two points from a body edge
 * that share an X coordinate, draw a line between them (which used to get a
 * redundant auto-Vertical), then draw an arc whose centre/start weld to the
 * same two points, then drag the arc's ring - the radius must not move. */

note('--- build a body with a vertical edge to project two same-X points from ---');
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
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 20 });
await idle();

await G.beginSketch({ kind: 'origin', role: 'YZ_Plane' });
await waitFor(() => G.getState().sketchMode, 4000);
await idle();

// project one of the body's vertical edges (constant X on the YZ sketch
// plane, running along Z) - its two endpoints share that X coordinate,
// exactly like the real trace's two projected points both sitting at
// x=-77.2313.
const scene = await rpc('scene.get');
const mesh = scene.meshes[0];
const vertEdge = mesh.edges.find((e) => {
  const p = e.points;
  const dz = Math.abs(p[2] - p[p.length - 1]);
  const dx = Math.abs(p[0] - p[p.length - 2]);
  const dy = Math.abs(p[1] - p[p.length - 3]);
  return dz > 1 && dx < 1e-3 && dy < 1e-3; // runs mostly along Z, constant X/Y
});
assert(!!vertEdge, 'found a vertical edge to project (endpoints share an X on the YZ plane)');
const sub = 'Edge' + (vertEdge.edge + 1);
const projected = await G.sketch.project(mesh.id, sub);
assert(projected.length > 0, 'projected the vertical edge into the sketch');
const projEnt = projected[0];
note('projected entity: ' + JSON.stringify(projEnt));

const PROJ_BASE = 100000;
const [pa, pb] = [projEnt.a, projEnt.b];

note('--- line between the two projected points (shares an X coordinate - used to get a redundant auto-Vertical) ---');
const lineIdx = G.sketch.addEntity(
  { type: 'line', a: pb, b: pa },
  [{ idx: PROJ_BASE, pt: 1 }, { idx: PROJ_BASE, pt: 2 }]
);
await sleep(60);
const consAfterLine = G.sketch.newConstraints();
note('constraints after the projected-to-projected line: ' + JSON.stringify(consAfterLine));
const hasRedundantAngle = consAfterLine.some(
  (c) => (c.type === 'Vertical' || c.type === 'Horizontal') && c.refs.some((r) => r.new === lineIdx)
);
assert(
  !hasRedundantAngle,
  'a line whose BOTH endpoints are freshly welded to fixed projected geometry does NOT also get an auto Vertical/Horizontal - that would be genuinely redundant and can hard-fail the WHOLE sketch solve, not just this line'
);

note('--- arc whose centre + start weld to the SAME two projected points ---');
const arcIdx = G.sketch.commitTool(
  'arc',
  [pa, pb, [pa[0] - 2, pa[1] + 1]],
  [{ idx: PROJ_BASE, pt: 1 }, { idx: PROJ_BASE, pt: 2 }, null]
);
await sleep(60);
const consAfterArc = G.sketch.newConstraints();
note('constraints after the arc: ' + JSON.stringify(consAfterArc));

const dist = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
note('expected locked radius (distance between the two projected points): ' + dist);

await sleep(300); // let the debounced live solve run
const before = G.sketch.entities().find((e, i) => i === arcIdx);
note('arc geometry after live solve, before any drag: ' + JSON.stringify(before));
assert(!!before, 'the arc entity exists after solve');
assert(
  Math.abs(before.r - dist) < 1e-3,
  'the live solve locked the arc radius to the distance between its two projected-geometry welds (got ' +
    before.r +
    ', expected ' +
    dist +
    ') - this is the actual bug: the radius used to stay at its raw seed value because the projected geometry was never materialized in the scratch sketch the solve ran against'
);

note('--- dragging the arc ring must NOT change the locked radius ---');
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
function pressKey(key) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}
pressKey('Escape'); // drop back to select tool
await sleep(60);

// grab a screen point on the arc's ring (not an endpoint) and drag it far -
// a real ring-drag, matching the trace's `posId:0` grab.
const midAngle = Math.atan2((pa[1] + pb[1]) / 2 - pa[1], 0) || 0.5;
const ringWorldPt = [pa[0] - dist * 0.7, pa[1] + dist * 0.3];
const p0 = G.sketchUVToScreen(ringWorldPt[0], ringWorldPt[1]);
assert(!!p0, 'projected a point on the arc ring to screen coordinates');
if (p0) {
  const el = viewportEl();
  fire(el, 'pointermove', p0.x, p0.y);
  fire(el, 'pointerdown', p0.x, p0.y);
  for (let i = 1; i <= 5; i++) {
    fire(el, 'pointermove', p0.x + i * 30, p0.y + i * 10, { buttons: 1 });
  }
  fire(el, 'pointerup', p0.x + 150, p0.y + 50);
  await sleep(200);
}

const after = G.sketch.entities().find((e, i) => i === arcIdx);
note('arc geometry after ring-drag attempt: ' + JSON.stringify(after));
assert(!!after, 'the arc entity still exists after the drag attempt');
assert(
  Math.abs(after.r - dist) < 1e-3,
  'the arc radius must stay locked at ' +
    dist +
    ' even after a ring-drag (got ' +
    after.r +
    ') - dragging a fully radius-determined arc must not be able to change its radius at all'
);

note('--- done ---');
await G.cancelSketch().catch(() => {});
