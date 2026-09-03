/* Reopen a committed feature in its real dialog, edit values + references,
 * apply in place. Covers extrude length, fillet radius + edge set, and the
 * timeline rolling to the feature while editing then back to the tip. */

const feats = (st) => (st.bodies[0] ? st.bodies[0].features : []);
const solids = (st) => feats(st).filter((f) => f.kind === 'solid').length;

note('reset + sketch rect + extrude 10');
await rpc('session.reset');
await G.refresh();
await idle();
const s1 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: s1.sketchId,
  elements: [{ type: 'rect', a: [0, 0], b: [20, 10] }],
  constraints: []
});
await G.refresh();
await idle();
G.selectSketch(s1.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10 });
await idle();
let st = G.getState();
assert(feats(st).length === 2 && solids(st) === 1, 'one sketch + one pad');
const pad = feats(st).find((f) => f.kind === 'solid').id;

// ---------- edit the extrude: length 10 -> 24 ----------
note('editFeature the pad, change length to 24');
await G.editFeature(pad);
await waitFor(() => G.getState().op === 'extrude', 4000);
assert(G.getState().op === 'extrude', 'the extrude dialog reopened');
const gp = await rpc('feature.get', { id: pad });
assert(Math.abs((gp.values.length ?? 0) - 10) < 1e-6, `feature.get reports the committed length (${gp.values.length})`);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 24, reversed: false, midplane: false });
await idle();
st = G.getState();
assert(feats(st).length === 2 && solids(st) === 1, `still exactly sketch + pad after edit (got ${feats(st).length})`);
assert(!feats(st).some((f) => f.error), 'no feature error after the edit');
const gp2 = await rpc('feature.get', { id: pad });
assert(Math.abs((gp2.values.length ?? 0) - 24) < 1e-6, `length is now 24 (${gp2.values.length})`);
{
  const b = (await rpc('tree.get')).bodies[0];
  assert(!b.marker, `timeline marker is back at the tip after Update (marker=${b.marker})`);
}

// ---------- fillet, then edit its radius + edge set ----------
note('fillet one vertical edge, then edit radius + add edges');
const sc = await rpc('scene.get');
const m = sc.meshes[0];
// vertical edges = edge polylines whose endpoints share x,y but differ in z
const vEdges = [];
for (const e of m.edges || []) {
  const p = e.points;
  if (p.length >= 6) {
    const dx = Math.abs(p[0] - p[p.length - 3]);
    const dy = Math.abs(p[1] - p[p.length - 2]);
    const dz = Math.abs(p[2] - p[p.length - 1]);
    if (dx < 1e-3 && dy < 1e-3 && dz > 1) vEdges.push('Edge' + (e.edge + 1));
  }
}
note('vertical edges: ' + JSON.stringify(vEdges));
assert(vEdges.length >= 2, 'found at least two vertical edges to fillet');
G.clearSelection();
await sleep(30);
G.openOp('fillet');
await sleep(40);
G.pick({ kind: 'edge', bodyId: m.id, sub: vEdges[0], point: [0, 0, 0] }, false);
await sleep(60);
await G.applyOp('fillet', { radius: 1.5 });
await idle();
st = G.getState();
const fillet = feats(st).find((f) => /fillet/i.test(f.id));
assert(!!fillet, 'a fillet feature was committed');
let fg = await rpc('feature.get', { id: fillet.id });
assert((fg.refs.edges || []).length === 1 && Math.abs(fg.values.radius - 1.5) < 1e-6,
  `fillet has 1 edge @ r1.5 (${JSON.stringify(fg.refs.edges)} r${fg.values.radius})`);

note('editFeature the fillet: radius 3, both edges');
await G.editFeature(fillet.id);
await waitFor(() => G.getState().op === 'fillet', 4000);
G.pick({ kind: 'edge', bodyId: m.id, sub: vEdges[1], point: [0, 0, 0] }, true);
await sleep(60);
await G.applyOp('fillet', { radius: 3 });
await idle();
fg = await rpc('feature.get', { id: fillet.id });
note('fillet after edit: ' + JSON.stringify(fg.refs.edges) + ' r' + fg.values.radius);
assert(Math.abs(fg.values.radius - 3) < 1e-6, 'fillet radius is now 3');
assert((fg.refs.edges || []).length === 2, 'fillet now covers both edges');
st = G.getState();
assert(!feats(st).some((f) => f.error), 'no feature error after the fillet edit');
assert(feats(st).filter((f) => /fillet/i.test(f.id)).length === 1, 'still one fillet feature (edited, not duplicated)');

assert((await rpc('ping')).pong === true, 'engine still responds at end');
note('editfeature complete');
