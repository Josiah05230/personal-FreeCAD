/* Every editable feature type reopens in its dialog with what it was made
 * with, and every field changed there actually lands. Features are made
 * directly (creation is covered elsewhere); the edit goes through the real
 * editFeature -> dialog -> Update path. */

const tree = async () => (await rpc('tree.get')).bodies;
const allFeats = async () => (await tree()).flatMap((b) => b.features);
const noErrors = async (what) => {
  const bad = (await allFeats()).filter((f) => f.error);
  assert(!bad.length, `${what}: no feature errors ${bad.length ? JSON.stringify(bad.map((f) => [f.id, f.errorText])) : ''}`);
};
const vol = async () => {
  const ids = (await tree()).filter((b) => b.features.length).map((b) => b.id);
  const m = await rpc('inspect.centerOfMass', { ids });
  return (m.bodies || m.results || [m]).reduce((a, b) => a + (b.volume || 0), 0);
};
const near = (a, b, t = 1e-3) => Math.abs(a - b) < t;
const newest = async (re) => (await allFeats()).filter((f) => re.test(f.id)).pop().id;

async function fresh() {
  await rpc('session.reset');
  await G.refresh();
  await idle();
}
async function sketchOn(ref, elements) {
  const s = await rpc('sketch.on', { ref });
  await rpc('sketch.finish', { sketchId: s.sketchId, elements, constraints: [] });
  await G.refresh();
  await idle();
  return s.sketchId;
}
const XY = { kind: 'origin', role: 'XY_Plane' };
const XZ = { kind: 'origin', role: 'XZ_Plane' };
async function box(l = 20, w = 20, h = 10) {
  const s = await sketchOn(XY, [{ type: 'rect', a: [0, 0], b: [l, w] }]);
  await rpc('feature.extrude', { sketchId: s, length: h });
  await G.refresh();
  await idle();
  return s;
}
// reopen `id` and Update with `values` (merged over what the dialog loaded)
async function edit(id, values) {
  await G.editFeature(id);
  await waitFor(() => !!G.getState().op, 4000);
  const kind = G.getState().op;
  const loaded = (await rpc('feature.get', { id })).values || {};
  await G.applyOp(kind, { ...loaded, ...values });
  await idle();
  return (await rpc('feature.get', { id })).values;
}

note('--- revolve: full -> 90 degrees, axis sketch vertical -> sketch horizontal ---');
await fresh();
{
  const s = await sketchOn(XZ, [{ type: 'rect', a: [5, 5], b: [10, 10] }]);
  await rpc('feature.revolve', { sketchId: s, angle: 360, axis: 'V' });
  await G.refresh();
  await idle();
  const id = await newest(/^Revolution/);
  let g = (await rpc('feature.get', { id })).values;
  assert(g.full === true && g.axis === 'Sketch vertical', `loads full + axis (${g.full}, ${g.axis})`);
  const v0 = await vol();
  g = await edit(id, { full: false, angle: 90 });
  assert(near(g.angle, 90) && g.full === false, `angle is now 90 (${g.angle})`);
  assert(near(await vol(), v0 / 4, v0 * 0.01), 'a quarter of the volume');
  g = await edit(id, { axis: 'Sketch horizontal' });
  assertEq(g.axis, 'Sketch horizontal', 'axis switched to sketch horizontal');
  await noErrors('revolve');
}

note('--- chamfer: equal -> distance and angle -> two distances ---');
await fresh();
{
  await box();
  await rpc('feature.chamfer', { edges: ['Edge1'], size: 2 });
  await G.refresh();
  await idle();
  const id = await newest(/^Chamfer/);
  let g = await edit(id, { mode: 'Distance and angle', size: 2, angle: 30 });
  assert(g.mode === 'Distance and angle' && near(g.angle, 30), `distance and angle 30 (${g.mode}, ${g.angle})`);
  g = await edit(id, { mode: 'Two distances', size: 2, size2: 3 });
  assert(g.mode === 'Two distances' && near(g.size2, 3), `two distances 2/3 (${g.mode}, ${g.size2})`);
  await noErrors('chamfer');
  // creating one as distance-and-angle used to silently stay "Equal"
  await rpc('feature.chamfer', { edges: ['Edge5'], size: 1, mode: 'Distance and angle', angle: 30 });
  await G.refresh();
  await idle();
  const g2 = (await rpc('feature.get', { id: await newest(/^Chamfer/) })).values;
  assert(g2.mode === 'Distance and angle' && near(g2.angle, 30), `a new distance-and-angle chamfer is one (${g2.mode}, ${g2.angle})`);
}

note('--- shell: inside -> outside -> both ---');
await fresh();
{
  await box();
  await rpc('feature.shell', { faces: ['Face6'], thickness: 1 });
  await G.refresh();
  await idle();
  const id = await newest(/^Thickness|^Shell/);
  let g = (await rpc('feature.get', { id })).values;
  assertEq(g.direction, 'Inside', 'loads Inside');
  g = await edit(id, { direction: 'Outside' });
  assertEq(g.direction, 'Outside', 'now Outside');
  g = await edit(id, { direction: 'Both', thickness: 1.5 });
  assert(g.direction === 'Both' && near(g.thickness, 1.5), `now Both, 1.5 (${g.direction}, ${g.thickness})`);
  await noErrors('shell');
}

note('--- hole: blind -> through all + counterbore ---');
await fresh();
{
  await box(30, 30, 10);
  await rpc('feature.hole', { face: 'Face6', point: [15, 15, 10], diameter: 5, depth: 4 });
  await G.refresh();
  await idle();
  const id = await newest(/^Hole|^Pocket/);
  let g = await edit(id, { throughAll: true, cutType: 'Counterbore', cutDiameter: 9, cutDepth: 2 });
  assert(g.throughAll === true, 'through all');
  assert(g.cutType === 'Counterbore' && near(g.cutDiameter, 9) && near(g.cutDepth, 2),
    `counterbore 9 x 2 (${g.cutType} ${g.cutDiameter} ${g.cutDepth})`);
  g = await edit(id, { throughAll: false, depth: 6, cutType: 'None' });
  assert(g.throughAll === false && near(g.depth, 6) && g.cutType === 'None', `back to blind 6, no head (${g.depth} ${g.cutType})`);
  await noErrors('hole');
}

note('--- loft: smooth -> ruled ---');
await fresh();
{
  const a = await sketchOn(XY, [{ type: 'rect', a: [0, 0], b: [10, 10] }]);
  await rpc('datum.plane', { basePlane: 'XY', offset: 20 });
  await G.refresh();
  await idle();
  const pl = await newest(/^DatumPlane/);
  const b = await sketchOn({ kind: 'plane', id: pl }, [{ type: 'circle', c: [5, 5], r: 3 }]);
  await rpc('feature.loft', { sketchIds: [a, b] });
  await G.refresh();
  await idle();
  const id = await newest(/^Loft|^AdditiveLoft/);
  let g = (await rpc('feature.get', { id }));
  assertEq(g.refs.sketches, [a, b], 'loads its profiles in order');
  g = await edit(id, { ruled: true });
  assert(g.ruled === true, 'now ruled');
  await noErrors('loft');
}

note('--- datum plane: offset 10 -> 25 flipped, then re-attached to XZ ---');
await fresh();
{
  await rpc('datum.plane', { basePlane: 'XY', offset: 10 });
  await G.refresh();
  await idle();
  const id = await newest(/^DatumPlane/);
  let g = await edit(id, { offset: 25, flip: true });
  assert(near(g.offset, 25) && g.flip === true, `offset 25 flipped (${g.offset}, ${g.flip})`);
  await G.editFeature(id);
  await waitFor(() => !!G.getState().op, 4000);
  G.select([{ kind: 'plane', planeId: '', role: 'XZ_Plane' }]);
  await sleep(40);
  await G.applyOp('datumPlane', { offset: 5, angle: 0, flip: false });
  await idle();
  const r = (await rpc('feature.get', { id })).refs.datumRefs;
  assertEq(r, [{ kind: 'origin', role: 'XZ_Plane' }], 'now attached to XZ');
  await noErrors('datum plane');
}

note('--- box / cylinder / sphere / torus: change every dimension ---');
await fresh();
{
  await rpc('primitive.box', { length: 40, width: 30, height: 20 });
  await G.refresh();
  await idle();
  let id = await newest(/^Box/);
  let g = await edit(id, { length: 50, width: 10, height: 5 });
  assert(near(g.length, 50) && near(g.width, 10) && near(g.height, 5), `box 50x10x5 (${g.length}x${g.width}x${g.height})`);
  assert(near(await vol(), 2500, 1), 'box volume 2500');

  await fresh();
  await rpc('primitive.cylinder', { diameter: 20, height: 10 });
  await G.refresh();
  await idle();
  id = await newest(/^Cylinder/);
  g = await edit(id, { diameter: 10, height: 30 });
  assert(near(g.diameter, 10) && near(g.height, 30), `cylinder d10 h30 (${g.diameter}, ${g.height})`);

  await fresh();
  await rpc('primitive.sphere', { diameter: 20 });
  await G.refresh();
  await idle();
  id = await newest(/^Sphere/);
  g = await edit(id, { diameter: 30 });
  assert(near(g.diameter, 30), `sphere d30 (${g.diameter})`);

  await fresh();
  await rpc('primitive.torus', { meanDiameter: 60, sectionDiameter: 10 });
  await G.refresh();
  await idle();
  id = await newest(/^Torus/);
  g = await edit(id, { meanDiameter: 80, sectionDiameter: 20 });
  assert(near(g.meanDiameter, 80) && near(g.sectionDiameter, 20), `torus 80/20 (${g.meanDiameter}, ${g.sectionDiameter})`);
  await noErrors('primitives');
}

note('--- rib: thickness 2 -> 5 ---');
await fresh();
{
  await box(30, 30, 10);
  const s = await sketchOn(XZ, [{ type: 'line', a: [0, 0], b: [30, 10] }]);
  await rpc('feature.rib', { sketchId: s, thickness: 2 });
  await G.refresh();
  await idle();
  const id = (await allFeats()).filter((f) => f.kind === 'solid').pop().id;
  let g = (await rpc('feature.get', { id }));
  assertEq(g.kind, 'rib', 'reopens as a rib, not an extrude');
  const v0 = await vol();
  g = await edit(id, { thickness: 5 });
  assert(near(g.thickness, 5), `thickness 5 (${g.thickness})`);
  const v1 = await vol();
  assert(v1 > v0 + 1, `the rib got thicker (volume ${v0.toFixed(1)} -> ${v1.toFixed(1)})`);
  await noErrors('rib');
}

note('--- combine: fuse -> cut ---');
await fresh();
{
  await rpc('primitive.box', { length: 20, width: 20, height: 20 });
  await rpc('primitive.box', { length: 10, width: 10, height: 40 });
  await G.refresh();
  await idle();
  const bodies = (await tree()).filter((b) => b.features.length); // not the empty starter body
  await rpc('feature.combine', { op: 'Fuse', baseBodyId: bodies[0].id, toolBodyIds: [bodies[1].id] });
  await G.refresh();
  await idle();
  const id = (await tree()).flatMap((b) => b.features).filter((f) => /^Boolean/.test(f.id)).pop().id;
  let g = (await rpc('feature.get', { id }));
  assert(g.kind === 'combine' && g.values.op === 'Fuse', `reopens as Combine/Fuse (${g.kind} ${g.values && g.values.op})`);
  g = await edit(id, { op: 'Cut' });
  assertEq(g.op, 'Cut', 'now Cut');
  await noErrors('combine');
}
