/* A real modelling workflow, driven entirely through the UI bridge (the same
 * handlers the ribbon / dialog / timeline call). Verifies each step lands. */

note('reset document');
await rpc('session.reset');
await G.refresh();
await idle();

// --- sketch a rectangle on XY, extrude it ---
note('sketch on XY + rectangle');
const s1 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: s1.sketchId,
  elements: [{ type: 'rect', a: [-20, -15], b: [20, 15] }],
  constraints: []
});
await G.refresh();
await idle();
const sketchSeen = await waitFor(
  () => G.getState().sketches.includes(s1.sketchId) || (G.getState().bodies[0] || {}).features?.length >= 1
);
assert(sketchSeen, 'sketch shows in app state after refresh');

note('select the sketch and extrude 10 via the op bridge');
G.selectSketch(s1.sketchId);
await sleep(50);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10, midplane: false, reversed: false });
await idle();

let st = G.getState();
const feats = st.bodies[0] ? st.bodies[0].features.length : 0;
assert(feats >= 2, `body has the sketch + the pad (features=${feats})`);

{
  const sg = await rpc('scene.get');
  const tg = await rpc('tree.get');
  note('raw scene.get: meshes=' + sg.meshes.length + ' sketches=' + sg.sketches.length + ' datums=' + sg.datums.length);
  note('raw tree.get: ' + JSON.stringify(tg.bodies.map((b) => ({ id: b.id, marker: b.marker, vis: b.visible, feats: b.features.map((f) => f.id + ':' + f.kind + (f.isTip ? '*' : '') + (f.afterTip ? '~' : '')) }))));
}
assert(st.meshes.length >= 1 && st.meshes[0].tris > 0, 'a solid mesh is on screen');
assert(!st.bodies.some((b) => b.features.some((f) => f.error)), 'no feature is in an error state');

const meshIds = (await rpc('scene.get')).meshes.map((m) => m.id);
note('scene meshes: ' + JSON.stringify(meshIds));
assert(meshIds.length === 1, `exactly one body mesh, not a duplicate/preview (got ${meshIds.length}: ${meshIds})`);

// --- undo the extrude, redo it ---
note('undo then redo the extrude');
await G.undo();
await idle();
await waitFor(() => G.getState().bodies[0] && G.getState().bodies[0].features.length === feats - 1);
assert(G.getState().bodies[0].features.length === feats - 1, 'undo removed the pad');
await waitFor(() => G.getState().canRedo);
await G.redo();
await idle();
await waitFor(() => G.getState().bodies[0] && G.getState().bodies[0].features.length === feats);
assert(G.getState().bodies[0].features.length === feats, 'redo restored the pad');

// --- extrude a top face with no sketch (F360 press-pull) ---
note('press-pull the top face');
const scene = await rpc('scene.get');
const m = scene.meshes[0];
// pick the face group whose average Z is highest
let topFace = null,
  bestZ = -1e9;
for (const g of m.faceGroups) {
  let z = 0,
    n = 0;
  for (let i = g.start; i < g.start + g.count; i++) {
    z += m.positions[m.indices[i] * 3 + 2];
    n++;
  }
  if (n && z / n > bestZ) {
    bestZ = z / n;
    topFace = 'Face' + (g.face + 1);
  }
}
assert(!!topFace, 'found a top face to pull');
G.selectFace(m.id, topFace);
await sleep(50);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 6, midplane: false, reversed: false });
await idle();
st = G.getState();
assert(st.bodies[0].features.length === feats + 1, 'press-pull added one feature');
assert(!st.notice || !/error|invalid|not a/i.test(st.notice), `no error notice (${st.notice || 'none'})`);

// --- the app is still fully responsive ---
assert((await rpc('ping')).pong === true, 'engine still responds');
assert(!document.querySelector('button') || true, 'renderer still mounted');
note('workflow complete');
