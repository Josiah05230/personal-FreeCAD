/* Editing an extrude can change its extent (Blind / Two Sides / To object),
 * and finishing an edit - of a feature or a sketch - leaves the timeline
 * marker where it was (it used to always jump to the end). */

const body = () => G.getState().bodies[0];
const feats = () => (body() ? body().features : []);
const marker = async () => (await rpc('tree.get')).bodies[0].marker ?? null;
const bbox = async () => (await rpc('scene.get')).meshes[0].bbox;
const near = (a, b) => Math.abs(a - b) < 1e-3;

async function sketchRect(a, b) {
  const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', { sketchId: s.sketchId, elements: [{ type: 'rect', a, b }], constraints: [] });
  await G.refresh();
  await idle();
  return s.sketchId;
}
async function extrude(sketchId, length) {
  G.selectSketch(sketchId);
  await sleep(40);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length });
  await idle();
  return feats().filter((f) => f.kind === 'solid').pop().id;
}

note('--- a box, an extrude off it, and a later feature ---');
await rpc('session.reset');
await G.refresh();
await idle();
const s1 = await sketchRect([0, 0], [20, 15]);
await extrude(s1, 5); // box, z 0..5
const s2 = await sketchRect([10, 0], [30, 5]);
const pad2 = await extrude(s2, 8); // z 0..8, overlapping the box
const s3 = await sketchRect([0, 10], [5, 15]);
await extrude(s3, 12); // a later feature, z 0..12
assert(near((await bbox()).max[2], 12), 'the whole model is 12 tall');

note('--- roll the timeline back to the middle extrude ---');
await G.rollTo(pad2);
await idle();
await waitFor(async () => (await marker()) === pad2, 4000);
assertEq(await marker(), pad2, 'marker sits on the middle extrude');

note('--- edit it: Blind -> To object (the box top) ---');
await G.editFeature(pad2);
await waitFor(() => G.getState().op === 'extrude', 4000);
// the box's top face, as shown while editing: flat at z=5, over x < 10
const shown = (await rpc('scene.get')).meshes[0];
const pos = shown.positions;
let top = null;
for (const fg of shown.faceGroups) {
  let ok = true;
  let minx = Infinity;
  for (let t = fg.start; t < fg.start + fg.count; t++) {
    const vi = shown.indices[t];
    if (!near(pos[vi * 3 + 2], 5)) ok = false;
    minx = Math.min(minx, pos[vi * 3]);
  }
  if (ok && minx < 9) {
    top = 'Face' + (fg.face + 1);
    break;
  }
}
assert(!!top, `found the box top face while editing (${top})`);
G.select([
  { kind: 'sketch', sketchId: s2 },
  { kind: 'face', bodyId: shown.id, sub: top, point: [0, 0, 0] }
]);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'To object', offset: 0, length: 8 });
await idle();
let g = await rpc('feature.get', { id: pad2 });
assertEq(g.values.mode, 'To object', 'the extrude is now To object');
assert(g.refs.upTo && g.refs.upTo.kind === 'face', `it knows its target face (${JSON.stringify(g.refs.upTo)})`);
const errs = (await rpc('tree.get')).bodies[0].features.filter((f) => f.error);
assert(!errs.length, `no feature errors (${JSON.stringify(errs.map((f) => [f.id, f.errorText]))})`);
assertEq(await marker(), pad2, 'THE BUG: Update left the marker where it was, not at the end');
assert(near((await bbox()).max[2], 5), `it now stops at the box top (z max ${(await bbox()).max[2]})`);

note('--- edit again: To object -> Two Sides ---');
await G.editFeature(pad2);
await waitFor(() => G.getState().op === 'extrude', 4000);
g = await rpc('feature.get', { id: pad2 });
assertEq(g.values.mode, 'To object', 'the dialog reopens on To object');
await G.applyOp('extrude', { operation: 'Join', mode: 'Two Sides', length: 4, length2: 2 });
await idle();
g = await rpc('feature.get', { id: pad2 });
assertEq(g.values.mode, 'Two Sides', 'the extrude is now Two Sides');
let bb = await bbox();
assert(near(bb.min[2], -2) && near(bb.max[2], 5), `two sides: z ${bb.min[2]}..${bb.max[2]} (want -2..5)`);
assertEq(await marker(), pad2, 'marker still where it was');

note('--- and back to Blind ---');
await G.editFeature(pad2);
await waitFor(() => G.getState().op === 'extrude', 4000);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 7 });
await idle();
g = await rpc('feature.get', { id: pad2 });
assertEq(g.values.mode, 'Blind', 'the extrude is Blind again');
bb = await bbox();
assert(near(bb.min[2], 0) && near(bb.max[2], 7), `blind 7: z ${bb.min[2]}..${bb.max[2]}`);

note('--- cancelling an edit also leaves the marker alone ---');
await G.editFeature(pad2);
await waitFor(() => G.getState().op === 'extrude', 4000);
await G.closeOp();
await idle();
await waitFor(async () => (await marker()) === pad2, 4000);
assertEq(await marker(), pad2, 'marker unchanged after Cancel');

note('--- finishing a sketch edit leaves the marker alone too ---');
await G.editSketch(s2);
await waitFor(() => G.getState().sketchMode, 4000);
await G.finishSketch();
await idle();
assertEq(await marker(), pad2, 'marker unchanged after finishing the sketch edit');

note('--- at the end, the later feature is still fine ---');
await G.rollTo(null);
await idle();
await waitFor(async () => (await marker()) === null, 4000);
assert(!feats().some((f) => f.error), 'no feature errors with everything rolled in');
assert(near((await bbox()).max[2], 12), 'the model is 12 tall again');
