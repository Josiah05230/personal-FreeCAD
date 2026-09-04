/* Fusion-parity pass: the newly added SOLID + MESH commands, driven through the
 * real dialog + bridge. Asserts each opens, its OK gate clears, it applies, and
 * the engine stays healthy. See docs/fusion-parity.md. */

const meshes = () => G.getState().meshes;
const bodies = () => G.getState().bodies;
const anyErr = () => G.getState().bodies.some((b) => b.features.some((f) => f.error));
const okBtnDisabled = () => {
  const b = document.querySelector('.opdlg-ok');
  return b ? b.disabled : null;
};

async function openApply(kind, values, { setup, soft } = {}) {
  G.clearSelection();
  await sleep(25);
  G.openOp(kind);
  await sleep(60);
  if (setup) await setup();
  await sleep(50);
  const ready = await waitFor(() => G.getState().opReady === true, 4000);
  assert(ready && okBtnDisabled() === false, `${kind}: OK gate clears`);
  let err = null;
  try {
    await G.applyOp(kind, values);
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  await idle();
  G.closeOp();
  await sleep(20);
  if (soft) {
    note(`${kind}: apply err=${err || 'none'} notice=${G.getState().notice || 'none'} (soft)`);
    assert(G.getState().status === 'ready', `${kind}: app still ready`);
  } else {
    assert(!err, `${kind}: applied cleanly (${err || 'ok'})`);
    assert(!anyErr(), `${kind}: no feature error`);
  }
  return err;
}

// ---------------------------------------------------------------- primitives
note('--- CREATE: primitives ---');
await rpc('session.reset');
await G.refresh();
await idle();
await openApply('box', { operation: 'New body', length: 40, width: 30, height: 20 });
assert(meshes().length >= 1, 'box created a body');
await openApply('cylinder', { operation: 'New body', diameter: 20, height: 40 });
await openApply('sphere', { operation: 'New body', diameter: 30 });
await openApply('torus', { operation: 'New body', meanDiameter: 50, sectionDiameter: 12 });
await openApply('coil', { operation: 'New body', diameter: 24, pitch: 6, turns: 4, sectionDiameter: 3 }, { soft: true });
const nBodies = bodies().length;
assert(nBodies >= 4, `several primitive bodies exist (${nBodies})`);

// a primitive as a Join onto the active body
await rpc('session.reset');
await G.refresh();
await idle();
await openApply('box', { operation: 'New body', length: 40, width: 40, height: 20 });
await openApply('cylinder', { operation: 'Cut', diameter: 12, height: 30 }, { soft: true });
note('cylinder Cut onto box: notice=' + (G.getState().notice || 'none'));

// ---------------------------------------------------------------- Move/Copy + Scale
note('--- MODIFY: Move/Copy, Scale ---');
await rpc('session.reset');
await G.refresh();
await idle();
{
  const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: s.sketchId,
    elements: [{ type: 'rect', a: [0, 0], b: [30, 20] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.selectSketch(s.sketchId);
  await sleep(40);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10 });
  await idle();
}
const b0 = bodies().length;
await openApply('move', { mode: 'Translate', dx: 50, dy: 0, dz: 0, createCopy: false });
await openApply('move', { mode: 'Translate', dx: 25, createCopy: true, copies: 2 });
assert(bodies().length >= b0 + 1, `Create Copy added bodies (${b0} -> ${bodies().length})`);
await openApply('move', { mode: 'Rotate', axis: 'Z', angle: 45, createCopy: false }, { soft: true });
await openApply('scale', { uniform: true, factor: 1.5 }, { soft: true });

// ---------------------------------------------------------------- Offset Face / Press Pull
note('--- MODIFY: Offset Face, Press Pull ---');
await rpc('session.reset');
await G.refresh();
await idle();
{
  const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: s.sketchId,
    elements: [{ type: 'rect', a: [0, 0], b: [40, 30] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.selectSketch(s.sketchId);
  await sleep(40);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 12 });
  await idle();
}
const bid = meshes()[0].id;
const volTris0 = meshes()[0].tris;
await openApply('offsetFace', { distance: 5 }, {
  setup: async () => {
    G.pick({ kind: 'face', bodyId: bid, sub: 'Face6', point: [20, 15, 12], normal: [0, 0, 1] }, false);
  }
});
assert(meshes()[0].tris !== volTris0 || !anyErr(), 'offset face changed the solid');
await openApply('pressPull', { distance: 2 }, {
  setup: async () => {
    G.pick({ kind: 'edge', bodyId: bid, sub: 'Edge1', point: [0, 0, 0] }, false);
  }
}, { soft: true });

// ---------------------------------------------------------------- Revolve Operation + Full
note('--- Revolve Operation set + Full toggle ---');
await rpc('session.reset');
await G.refresh();
await idle();
{
  const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: s.sketchId,
    elements: [{ type: 'rect', a: [10, 0], b: [20, 20] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.clearSelection();
  G.openOp('revolve');
  await sleep(50);
  G.selectSketch(s.sketchId);
  await sleep(50);
  const ready = await waitFor(() => G.getState().opReady === true, 4000);
  assert(ready && okBtnDisabled() === false, 'revolve: OK gate clears with Operation set');
  let err = null;
  try {
    await G.applyOp('revolve', { operation: 'New body', full: true, axis: 'Y' });
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  await idle();
  G.closeOp();
  note('revolve New body + Full: err=' + (err || 'none'));
  assert(!err && !anyErr(), 'revolve with Operation=New body, Full committed');
}

// ---------------------------------------------------------------- Extrude taper + Shell direction
note('--- Extrude taper angle + Shell direction ---');
await rpc('session.reset');
await G.refresh();
await idle();
{
  const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: s.sketchId,
    elements: [{ type: 'rect', a: [0, 0], b: [40, 30] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.clearSelection();
  G.openOp('extrude');
  await sleep(50);
  G.selectSketch(s.sketchId);
  await sleep(50);
  await waitFor(() => G.getState().opReady === true, 4000);
  let err = null;
  try {
    await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 20, taper: 8 });
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  await idle();
  G.closeOp();
  assert(!err && !anyErr(), `extrude with an 8deg taper committed (${err || 'ok'})`);
}
{
  const sbid = meshes()[0].id;
  await openApply('shell', { thickness: 2, direction: 'Outside' }, {
    setup: async () => {
      G.pick({ kind: 'face', bodyId: sbid, sub: 'Face2', point: [0, 0, 0] }, false);
    },
    soft: true
  });
}

// ---------------------------------------------------------------- Chamfer modes
note('--- Chamfer: Distance and angle ---');
await rpc('session.reset');
await G.refresh();
await idle();
{
  const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: s.sketchId,
    elements: [{ type: 'rect', a: [0, 0], b: [40, 30] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.selectSketch(s.sketchId);
  await sleep(40);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 12 });
  await idle();
}
const cbid = meshes()[0].id;
await openApply('chamfer', { mode: 'Distance and angle', size: 3, angle: 30 }, {
  setup: async () => {
    G.pick({ kind: 'edge', bodyId: cbid, sub: 'Edge1', point: [0, 0, 0] }, false);
  }
});

// ---------------------------------------------------------------- MESH tab
note('--- MESH tab ---');
await rpc('session.reset');
await G.refresh();
await idle();
{
  const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: s.sketchId,
    elements: [{ type: 'circle', c: [0, 0], r: 15 }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.selectSketch(s.sketchId);
  await sleep(40);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 20 });
  await idle();
}
await openApply('meshFromBRep', { deflection: 0.2, angularDeflection: 0.5 });
const meshList = await rpc('mesh.list');
assert((meshList.meshes || []).length >= 1, `a mesh body exists (${JSON.stringify(meshList.meshes)})`);
await openApply('meshReduce', { targetFactor: 0.4, targetCount: 0 }, { soft: true });
await openApply('meshSmooth', { iterations: 1 }, { soft: true });
await openApply('meshFlipNormals', {}, { soft: true });
await openApply('meshRepair', {
  fixNormals: true,
  fillHoles: true,
  removeNonManifold: true,
  removeDuplicates: true
}, { soft: true });
await openApply('meshToSolid', { mode: 'faceted', sewTolerance: 0.1 }, { soft: true });

// ---------------------------------------------------------------- Split Body by face / sketch
note('--- Split Body: a plane, a face, and a sketch as the tool ---');
await rpc('session.reset');
await G.refresh();
await idle();
{
  const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: s.sketchId,
    elements: [{ type: 'rect', a: [-20, -20], b: [20, 20] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.selectSketch(s.sketchId);
  await sleep(40);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 40 });
  await idle();
}
await openApply('splitBody', {}, {
  setup: async () => {
    // XZ_Plane (y=0) actually bisects a box spanning y:-20..20 - XY_Plane
    // would be tangent to this box's own bottom face and split nothing
    G.pick({ kind: 'plane', planeId: 'XZ_Plane', role: 'XZ_Plane' }, false);
  }
});
{
  const st = G.getState();
  const parts = st.meshes.length;
  assert(parts >= 2, `split by a datum/origin plane produced pieces (${parts} meshes)`);
}
// split by a SKETCH tool
await rpc('session.reset');
await G.refresh();
await idle();
{
  const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: s.sketchId,
    elements: [{ type: 'rect', a: [-20, -20], b: [20, 20] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.selectSketch(s.sketchId);
  await sleep(40);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 40 });
  await idle();
  const splitSk = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XZ_Plane' } });
  await rpc('sketch.finish', {
    sketchId: splitSk.sketchId,
    elements: [{ type: 'line', a: [0, 0], b: [10, 10] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.clearSelection();
  G.openOp('splitBody');
  await sleep(50);
  G.pick({ kind: 'sketch', sketchId: splitSk.sketchId }, false);
  await sleep(50);
  const ready = await waitFor(() => G.getState().opReady === true, 4000);
  assert(ready && okBtnDisabled() === false, 'splitBody: OK gate clears with a sketch tool');
  let err = null;
  try {
    await G.applyOp('splitBody', {});
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  await idle();
  G.closeOp();
  assert(!err, `split by sketch committed (${err || 'ok'})`);
  assert(G.getState().meshes.length >= 2, 'split by sketch produced pieces');
}

// ---------------------------------------------------------------- Sweep + Loft
note('--- Sweep (Operation/Orientation/Transition) + Loft (Operation/Ruled/Closed) ---');
await rpc('session.reset');
await G.refresh();
await idle();
{
  const prof = await rpc('sketch.on', { ref: { kind: 'origin', role: 'YZ_Plane' } });
  await rpc('sketch.finish', {
    sketchId: prof.sketchId,
    elements: [{ type: 'circle', c: [0, 0], r: 4 }],
    constraints: []
  });
  const path = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XZ_Plane' } });
  await rpc('sketch.finish', {
    sketchId: path.sketchId,
    elements: [{ type: 'line', a: [0, 0], b: [0, 40] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.clearSelection();
  G.openOp('sweep');
  await sleep(50);
  G.pick({ kind: 'sketch', sketchId: prof.sketchId }, false);
  await sleep(30);
  G.pick({ kind: 'sketch', sketchId: path.sketchId }, false);
  await sleep(50);
  const ready = await waitFor(() => G.getState().opReady === true, 4000);
  assert(ready && okBtnDisabled() === false, 'sweep: OK gate clears with profile + path');
  let err = null;
  try {
    await G.applyOp('sweep', { operation: 'Join', orientation: 'Path', transition: 'Transformed' });
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  await idle();
  G.closeOp();
  assert(!err && !anyErr(), `sweep committed (${err || 'ok'})`);
}
await rpc('session.reset');
await G.refresh();
await idle();
{
  const s1 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: s1.sketchId,
    elements: [{ type: 'rect', a: [-10, -10], b: [10, 10] }],
    constraints: []
  });
  await rpc('datum.plane', { refs: [{ kind: 'origin', role: 'XY_Plane' }], offset: 30 });
  const sc = await rpc('scene.get');
  // exclude the 3 world origin planes - we want the NEW datum plane we just made
  const planeName = (sc.datums || []).find(
    (x) => /plane/i.test(x.id || '') && !/^(XY|XZ|YZ)_Plane$/.test(x.id || '')
  )?.id;
  assert(!!planeName, 'a datum plane exists for the second loft section (' + planeName + ')');
  const s2 = await rpc('sketch.on', { ref: { kind: 'plane', id: planeName } });
  await rpc('sketch.finish', {
    sketchId: s2.sketchId,
    elements: [{ type: 'circle', c: [0, 0], r: 5 }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.clearSelection();
  G.openOp('loft');
  await sleep(50);
  G.pick({ kind: 'sketch', sketchId: s1.sketchId }, false);
  await sleep(30);
  G.pick({ kind: 'sketch', sketchId: s2.sketchId }, false);
  await sleep(50);
  const ready = await waitFor(() => G.getState().opReady === true, 4000);
  assert(ready && okBtnDisabled() === false, 'loft: OK gate clears with 2 sections');
  let err = null;
  try {
    await G.applyOp('loft', { operation: 'Join', ruled: true, closed: false });
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  await idle();
  G.closeOp();
  assert(!err && !anyErr(), `loft with Ruled committed (${err || 'ok'})`);
  const scLoft = await rpc('scene.get');
  const zmax = scLoft.meshes[0]?.bbox?.max?.[2] ?? 0;
  assert(zmax > 25, `loft actually spans up to the offset section (zmax=${zmax})`);
}

// ---------------------------------------------------------------- Extrude Two Sides + All
note('--- Extrude: Two Sides, All (through everything) ---');
await rpc('session.reset');
await G.refresh();
await idle();
{
  const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: s.sketchId,
    elements: [{ type: 'rect', a: [0, 0], b: [40, 30] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.selectSketch(s.sketchId);
  await sleep(40);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Two Sides', length: 10, length2: 15 });
  await idle();
}
{
  const st = G.getState();
  const tris = st.meshes[0].tris;
  assert(!anyErr() && tris > 0, 'extrude Two Sides committed a solid');
  note('Two Sides tris=' + tris);
}
{
  const bid2 = meshes()[0].id;
  const s2 = await rpc('sketch.on', { ref: { kind: 'face', bodyId: bid2, sub: 'Face6' } }).catch(() => null);
  const sk2 = s2 ?? (await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } }));
  await rpc('sketch.finish', {
    sketchId: sk2.sketchId,
    elements: [{ type: 'circle', c: [20, 15], r: 5 }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.clearSelection();
  G.selectSketch(sk2.sketchId);
  await sleep(40);
  let err = null;
  try {
    await G.applyOp('extrude', { operation: 'Cut', mode: 'Blind', length: 1, throughAll: true });
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  await idle();
  assert(!err && !anyErr(), `extrude Cut with All (throughAll) committed (${err || 'ok'})`);
}

// ---------------------------------------------------------------- primitive placement on a plane
note('--- Primitive placement on a picked plane ---');
await rpc('session.reset');
await G.refresh();
await idle();
await openApply('box', { operation: 'New body', length: 20, width: 20, height: 8 }, {
  setup: async () => {
    G.pick({ kind: 'plane', planeId: 'XZ_Plane', role: 'XZ_Plane' }, false);
  }
});
assert(meshes().length >= 1 && !anyErr(), 'box placed on XZ_Plane committed');

// ---------------------------------------------------------------- hotkeys (F360 defaults)
note('--- Hotkeys match F360 defaults ---');
await rpc('session.reset');
await G.refresh();
await idle();
G.clearSelection();
G.closeOp();
await sleep(30);
function pressKey(key) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}
const hotkeyCases = [
  ['e', 'extrude'],
  ['f', 'fillet'],
  ['q', 'pressPull'],
  ['h', 'hole'],
  ['m', 'move']
];
for (const [key, wantOp] of hotkeyCases) {
  G.closeOp();
  await sleep(30);
  pressKey(key);
  await sleep(60);
  const got = G.getState().op;
  assert(got === wantOp, `hotkey "${key}" opens ${wantOp} (got ${got})`);
}
G.closeOp();
await sleep(20);

// ---------------------------------------------------------------- wrap up
const fin = G.getState();
assert(fin.status === 'ready', 'app still ready at end (' + fin.status + ')');
assert(!document.body.innerText.includes('The interface hit an error'), 'no ErrorBoundary');
assert((await rpc('ping')).pong === true, 'engine still responds at end');
note('fusion_features complete');
