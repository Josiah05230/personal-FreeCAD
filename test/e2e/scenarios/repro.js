/* Reproduces the live-test failures reported 2026-09-01:
 *   1. a bad revolve wipes the whole body instead of erroring cleanly
 *   2. a committed sketch cannot be re-used by a second extrude
 *   3. the extrude dialog lets you pick an edge (meaningless for a profile)
 * Run BEFORE the fixes to confirm the root cause, and again after to verify.
 */

const feats = (st) => (st.bodies[0] ? st.bodies[0].features.length : 0);
const tris = (st) => (st.meshes[0] ? st.meshes[0].tris : 0);
const anyErr = (st) => st.bodies.some((b) => b.features.some((f) => f.error));

note('reset');
await rpc('session.reset');
await G.refresh();
await idle();

// ---------- 1. first extrude, a clean solid ----------
note('sketch rect on XY, extrude 10 (join)');
const s1 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: s1.sketchId,
  elements: [{ type: 'rect', a: [-20, -15], b: [20, 15] }],
  constraints: []
});
await G.refresh();
await idle();
G.selectSketch(s1.sketchId);
await sleep(50);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10 });
await idle();
let st = G.getState();
const baseFeats = feats(st);
const baseTris = tris(st);
assert(baseFeats >= 2, `body has sketch + pad (features=${baseFeats})`);
assert(st.meshes.length === 1 && baseTris > 0, `one solid mesh on screen (tris=${baseTris})`);

// ---------- 2. a BAD revolve must not destroy the body ----------
note('sketch a rect straddling the origin, revolve 360 about its V axis (self-intersecting)');
const s2 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: s2.sketchId,
  elements: [{ type: 'rect', a: [-20, -15], b: [20, 15] }],
  constraints: []
});
await G.refresh();
await idle();
G.selectSketch(s2.sketchId);
await sleep(50);
let revErr = null;
try {
  await G.applyOp('revolve', { angle: 360, cut: false });
} catch (e) {
  revErr = (e && e.message) || String(e);
}
await idle();
st = G.getState();
note('after bad revolve: feats=' + JSON.stringify(st.bodies.map((b) => b.features.map((f) => f.id + ':' + f.kind + (f.error ? '!ERR' : '')))));
note('after bad revolve: meshes=' + JSON.stringify(st.meshes) + ' notice=' + (st.notice || 'none'));
assert(st.meshes.length === 1 && tris(st) >= baseTris * 0.9,
  `the first solid is intact after a bad revolve (tris ${tris(st)} vs base ${baseTris})`);
assert(!anyErr(st), 'no feature left in an error state after a bad revolve');
assert(!st.bodies[0].features.some((f) => /revolution|groove/i.test(f.id) || f.kind === 'revolution'),
  'no half-built revolve feature was left in the body');
assert(feats(st) === baseFeats + 1,
  `nothing rolled back destructively - only the orphan sketch remains (${baseFeats} + 1 = ${feats(st)})`);
assert((await rpc('ping')).pong === true, 'engine still responds after a bad revolve');

// ---------- 3. re-use the first sketch for a second extrude ----------
note('select sketch s1 again and extrude it a second time (F360 lets you re-use a profile)');
await G.refresh();
await idle();
const preReuseFeats = feats(G.getState());
G.selectSketch(s1.sketchId);
await sleep(50);
let reuseErr = null;
try {
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 4, reversed: true });
} catch (e) {
  reuseErr = (e && e.message) || String(e);
}
await idle();
st = G.getState();
note('after re-use extrude: notice=' + (st.notice || 'none') + ' err=' + (reuseErr || 'none'));
note('after re-use extrude: feats=' + JSON.stringify(st.bodies.map((b) => b.features.map((f) => f.id + ':' + f.kind + (f.error ? '!ERR' : '')))));
assert(!reuseErr && (!st.notice || !/already used|draw a new/i.test(st.notice)),
  'no "sketch already used" rejection when re-using a committed sketch');
// re-use duplicates the consumed sketch (PartDesign: one sketch -> one feature)
// so the timeline gains a linked copy + the new pad = +2
assert(feats(st) === preReuseFeats + 2,
  `re-use inserts a profile copy + the new pad (${preReuseFeats} -> ${feats(st)})`);
assert(st.bodies[0].features.filter((f) => f.kind === 'solid').length === 2,
  'the body now has two solid features (the original pad + the re-use pad)');
assert(!anyErr(st), 'no feature in error after re-using the sketch');

// ---------- 4. the extrude dialog should not accept an edge as a pick ----------
note('open extrude, click an edge - it must not enter the selection');
const sc = await rpc('scene.get');
const mm = sc.meshes[0];
const haveEdges = mm && mm.edges && mm.edges.length;
G.openOp('extrude');
await sleep(50);
if (haveEdges) {
  G.clearSelection();
  await sleep(30);
  // G.pick routes through the real onSelect handler (same path a viewport click takes)
  G.pick({ kind: 'edge', bodyId: mm.id, sub: 'Edge1', point: [0, 0, 0] }, false);
  await sleep(80);
  const selNow = G.getState().selection;
  note('selection after clicking an edge with extrude open: ' + JSON.stringify(selNow));
  assert(!selNow.some((k) => /^edge:/i.test(k)),
    'the extrude dialog ignores an edge pick (only a sketch / flat face is a valid profile)');
  // and a valid profile pick (a face) IS still accepted
  G.pick({ kind: 'face', bodyId: mm.id, sub: 'Face1', point: [0, 0, 0], normal: [0, 0, 1] }, false);
  await sleep(80);
  assert(G.getState().selection.some((k) => /^face:/i.test(k)),
    'the extrude dialog still accepts a face pick');
} else {
  note('no edges in scene to test with - skipping edge-filter check');
}
G.closeOp();
await idle();

// ---------- 5. clicking preview-solid faces mid-extrude must not lose the profile ----------
note('sketch a rect, open extrude, then click faces of the live preview + empty space, then Finish');
await rpc('session.reset');
await G.refresh();
await idle();
const s5 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: s5.sketchId,
  elements: [{ type: 'rect', a: [-12, -12], b: [12, 12] }],
  constraints: []
});
await G.refresh();
await idle();
G.selectSketch(s5.sketchId);
await sleep(40);
G.openOp('extrude');
await sleep(60);
// let the live preview build its Pad
await waitFor(() => (G.getState().meshes[0] || {}).tris > 0, 4000);
// now fumble: click a face of the preview solid, then empty space, then another face
G.pick({ kind: 'face', bodyId: 'Body', sub: 'Face3', point: [0, 0, 0], normal: [1, 0, 0] }, false);
await sleep(60);
G.pick(null, false); // empty-space miss-click - must NOT drop the sketch profile
await sleep(60);
G.pick({ kind: 'face', bodyId: 'Body', sub: 'Face6', point: [0, 0, 0], normal: [0, 1, 0] }, false);
await sleep(60);
const selMid = G.getState().selection;
note('selection after the fumbling: ' + JSON.stringify(selMid));
assert(selMid.some((k) => /^sketch:/i.test(k)), 'the sketch profile is still selected after a miss-click');
let applyErr = null;
try {
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10 });
} catch (e) {
  applyErr = (e && e.message) || String(e);
}
await idle();
const st5 = G.getState();
note('after Finish: notice=' + (st5.notice || 'none') + ' err=' + (applyErr || 'none'));
note('after Finish: bodies=' + JSON.stringify(st5.bodies.map((b) => b.features.map((f) => f.id + ':' + f.kind + (f.error ? '!ERR' : '')))));
assert(!applyErr && (!st5.notice || !/no solid|has no solid/i.test(st5.notice)),
  'Finish did not fail with "body has no solid" after clicking preview faces');
assert(st5.bodies[0] && st5.bodies[0].features.filter((f) => f.kind === 'solid').length === 1,
  'exactly one solid pad was committed (the sketch extrude), not zero');
assert(st5.meshes.length === 1 && st5.meshes[0].tris > 0, 'a solid is on screen after Finish');
assert(!st5.bodies.some((b) => b.features.some((f) => f.error)), 'no feature left in error');

assert((await rpc('ping')).pong === true, 'engine still responds at end');
note('repro complete');
