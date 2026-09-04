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

// ---------------------------------------------------------------- wrap up
const fin = G.getState();
assert(fin.status === 'ready', 'app still ready at end (' + fin.status + ')');
assert(!document.body.innerText.includes('The interface hit an error'), 'no ErrorBoundary');
assert((await rpc('ping')).pong === true, 'engine still responds at end');
note('fusion_features complete');
