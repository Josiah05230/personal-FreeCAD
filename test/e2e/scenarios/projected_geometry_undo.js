/* Verifies a real user-reported bug: "I can't ctrl-z projected geometry."
 * setProjected() (called every time "Project geometry" adds/removes a
 * reference) never called snapshot() before mutating this.projected, unlike
 * every other geometry-mutating action in SketchController - so Ctrl+Z had
 * no undo step to pop for it at all: the projected reference just stayed on
 * screen no matter how many times the user pressed Ctrl+Z. Fixed by having
 * setProjected() snapshot first, and by threading `projected` through the
 * undo stack's snapshot/restore (it was previously entirely absent from
 * that struct). */

note('--- build a body with a face to project an edge from ---');
await rpc('session.reset');
await G.refresh();
await idle();
const s0 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', { sketchId: s0.sketchId, elements: [{ type: 'rect', a: [0, 0], b: [40, 30] }], constraints: [] });
await G.refresh();
await idle();
G.selectSketch(s0.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 20 });
await idle();
const bid = G.getState().bodies[0].id;

await G.beginSketch({ kind: 'origin', role: 'YZ_Plane' });
await waitFor(() => G.getState().sketchMode, 4000);
await idle();

note('--- projecting an edge is undoable with a real Ctrl+Z keydown ---');
const scene = await rpc('scene.get');
const mesh = scene.meshes[0];
const edge = mesh.edges.find((e) => {
  const p = e.points;
  const dz = Math.abs(p[2] - p[p.length - 1]);
  return dz > 1; // any edge running mostly along Z works for this check
});
assert(!!edge, 'found an edge to project');
const sub = 'Edge' + (edge.edge + 1);

const beforeCount = (G.sketch.projected() || []).length;
const projected = await G.sketch.project(bid, sub);
assert(projected.length > beforeCount, 'projecting the edge added at least one projected entity');
await sleep(80);

window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
await sleep(150);
const afterUndo = G.sketch.projected() || [];
assert(
  afterUndo.length === beforeCount,
  `Ctrl+Z undid the projected-geometry addition (want ${beforeCount} projected entities, got ${afterUndo.length}) - this is the exact bug report: projected geometry could never be undone at all`
);
assert(G.getState().sketchMode, 'Ctrl+Z kept the sketch editor open (did not fall through to the app-level undo)');

note('--- re-project the same edge (sketch-local redo is not implemented anywhere in this editor) ---');
const reprojected = await G.sketch.project(bid, sub);
assert(reprojected.length > beforeCount, 're-projecting the edge restores it (no Ctrl+Y path exists in the sketch editor to test instead)');

note('--- unproject is also undoable ---');
const beforeUnproject = (G.sketch.projected() || []).length;
await G.sketch.unproject();
await sleep(80);
assert((G.sketch.projected() || []).length === 0, 'unproject cleared the projected geometry');
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
await sleep(150);
assert(
  (G.sketch.projected() || []).length === beforeUnproject,
  'Ctrl+Z also undoes an unproject action, restoring the removed projected geometry'
);

note('--- done ---');
await G.cancelSketch().catch(() => {});
