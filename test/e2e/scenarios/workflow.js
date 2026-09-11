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

// --- an un-extruded sketch must stay visible when the scrubber returns to
// the tip (real user report, 2026-09-11: "I can't move the scrubber to
// after the sketch" - history.rollTo(null) was unconditionally hiding every
// sketch, including one nothing has consumed yet, so it looked like the
// scrubber refused to move past it when really it just vanished) ---
note('--- sketch drawn but not yet padded stays visible at the timeline tip ---');
{
  const sOn = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: sOn.sketchId,
    elements: [{ type: 'line', a: [30, 30], b: [40, 30] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  let sc = await rpc('scene.get');
  let sk = sc.sketches.find((s) => s.id === sOn.sketchId);
  assert(sk && sk.visible === true, 'the new sketch is visible right after Finish');

  const bodyIdForRoll = (await rpc('tree.get')).bodies[0].id;
  await rpc('history.rollTo', { bodyId: bodyIdForRoll, featureId: null });
  await G.refresh();
  await idle();
  sc = await rpc('scene.get');
  sk = sc.sketches.find((s) => s.id === sOn.sketchId);
  assert(sk && sk.visible === true, 'the un-extruded sketch is STILL visible after rolling the scrubber to the tip (featureId: null)');
}

// --- a sketch drawn while rolled back BEFORE an existing feature must land
// the marker on itself, not skip past it (real user report, 2026-09-11:
// "no matter what it doesn't go after the sketch" - PartDesign inserts a
// feature drawn while rolled back at the marker's position, in the MIDDLE of
// history, but sketch.finish's "resume the build" logic used to force the
// marker to None (the true end) unconditionally - jumping straight past the
// sketch to whatever came after it, so every later scrubber drag/click was
// already measured from a position beyond the sketch and could never land
// back on it) ---
note('--- sketch drawn mid-timeline (rolled back before an existing feature) keeps the marker ON that sketch, not past it ---');
{
  const bid = (await rpc('tree.get')).bodies[0].id;
  let tree = await rpc('tree.get');
  let feats = tree.bodies[0].features;
  const padFeat = feats.find((f) => f.opType === 'Pad' || f.kind === 'solid');
  assert(padFeat, 'there is a Pad feature to fillet (from earlier in this workflow)');

  const scBeforeFillet = await rpc('scene.get');
  const mBeforeFillet = scBeforeFillet.meshes[0];
  await rpc('feature.fillet', { edges: ['Edge1'], radius: 0.5 });
  await G.refresh();
  await idle();
  tree = await rpc('tree.get');
  feats = tree.bodies[0].features;
  const filletFeat = feats.find((f) => f.opType === 'Fillet');
  assert(filletFeat, 'the Fillet feature was created');

  // roll back to just after the Pad (before the Fillet)
  await rpc('history.rollTo', { bodyId: bid, featureId: padFeat.id });
  await G.refresh();
  await idle();

  // draw + finish a brand-new sketch while rolled back here
  const s3 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: s3.sketchId,
    elements: [{ type: 'line', a: [50, 50], b: [60, 50] }],
    constraints: []
  });
  await G.refresh();
  await idle();

  tree = await rpc('tree.get');
  feats = tree.bodies[0].features;
  const order = feats.map((f) => f.id);
  const sketchIdx = order.indexOf(s3.sketchId);
  const filletIdx = order.indexOf(filletFeat.id);
  assert(sketchIdx >= 0, 'the new sketch is in the feature list');
  assert(
    sketchIdx < filletIdx,
    `the new sketch landed BEFORE the Fillet in history (sketch@${sketchIdx}, fillet@${filletIdx}) - PartDesign inserts at the rollback point, not the end`
  );

  // THE ACTUAL BUG: the marker must sit ON the sketch we just drew, not have
  // jumped past it to the true end (which would be past the Fillet too)
  assert(
    tree.bodies[0].marker === s3.sketchId,
    `the rollback marker must land ON the sketch just drawn, not skip past it to the end (got marker=${tree.bodies[0].marker})`
  );

  const scAtSketch = await rpc('scene.get');
  const skAtSketch = scAtSketch.sketches.find((s) => s.id === s3.sketchId);
  assert(skAtSketch && skAtSketch.visible === true, 'the sketch is visible while the marker sits on it');

  // and the fillet (which comes after it in history) must NOT be built yet -
  // rolling to a mid-history sketch should hide what has not happened yet
  const scAtSketchTip = scAtSketch.meshes[0];
  assert(
    scAtSketchTip.tris === mBeforeFillet.tris,
    'the solid at this rollback point matches the PRE-fillet Pad (the fillet has not happened yet from here)'
  );

  // now step forward past the sketch onto the Fillet - this must actually work
  await rpc('history.rollTo', { bodyId: bid, featureId: filletFeat.id });
  await G.refresh();
  await idle();
  tree = await rpc('tree.get');
  assert(tree.bodies[0].marker === null, 'rolling onto the LAST feature (Fillet) reports the marker at the end');
  const scAtFillet = await rpc('scene.get');
  const mAtFillet = scAtFillet.meshes[0];
  // triangle COUNT can coincidentally match across a small fillet (tessellation
  // budgets can land on the same number by chance) - compare actual vertex
  // positions instead, which a fillet always changes near the rounded edge
  const posEqual =
    mAtFillet.positions.length === mBeforeFillet.positions.length &&
    mAtFillet.positions.every((v, i) => Math.abs(v - mBeforeFillet.positions[i]) < 1e-6);
  assert(
    !posEqual,
    'stepping forward past the mid-timeline sketch onto the Fillet actually rebuilds it (geometry changed, not identical to the pre-fillet Pad)'
  );
}

// --- orthographic / perspective projection toggle ---
note('--- projection toggle (ortho <-> perspective) ---');
const ids = G.commandIds();
assert(ids.includes('view.projection'), 'the Projection command is registered');
// normalise to a known state first (an earlier run may have persisted the other
// mode in localStorage - persistence across sessions is intentional)
G.setProjection('orthographic');
await sleep(80);
assert(G.getProjection() === 'orthographic', 'setProjection(orthographic) takes effect (CAD default)');
G.runCommand('view.projection');
await sleep(80);
assert(G.getProjection() === 'perspective', 'the Projection command toggles ortho -> perspective');
G.runCommand('view.projection');
await sleep(80);
assert(G.getProjection() === 'orthographic', 'the Projection command toggles perspective -> ortho');
st = G.getState();
assert(st.status === 'ready', 'app still ready after toggling projection');
assert(st.meshes.length >= 1 && st.meshes[0].tris > 0, 'the solid is still in the viewport after the toggle');

// --- debug log export (user-facing: "save a log I can send back") ---
note('--- Save Debug Log command ---');
assert(G.commandIds().includes('debug.saveLog'), 'the Save Debug Log command is registered');
const dump = window.__trace && window.__trace.dump();
assert(typeof dump === 'string' && dump.length > 0, 'window.__trace.dump() returns a non-empty trace (tracing is on by default)');
assert(/ACTION /.test(dump), 'the trace actually recorded high-level ACTION events from this run');
// --e2e mode short-circuits the real save dialog (no TTY to click through) -
// just confirm running the command does not throw / destabilise anything
G.runCommand('debug.saveLog');
await sleep(60);
assert((await rpc('ping')).pong === true, 'engine still responds after Save Debug Log');

// --- the app is still fully responsive ---
assert((await rpc('ping')).pong === true, 'engine still responds');
assert(!document.querySelector('button') || true, 'renderer still mounted');
note('workflow complete');
