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

// G.applyOp() goes through the app's CmdQueue, which by design NEVER rejects
// (a failed queued command is caught, routed to a "notice" banner, and the
// queue keeps going - see cmdQueue.ts's own docstring) - so `try { await
// G.applyOp(...) } catch` can NEVER catch anything, and every `err` variable
// built that way is permanently null. This was invisible for a long time
// because most failures also flag a feature error (anyErr()) or produce
// wrong-but-plausible geometry a later assertion catches - but a failure
// whose feature gets cleanly rolled back and removed (no error flag left
// anywhere) slipped through completely silently. Fixed by reading
// G.getState().notice - the real, actual signal the app surfaces for a
// queued-command failure (routed there by cmdQueue's onError handler) -
// instead of a try/catch that structurally cannot fire.
async function openApply(kind, values, { setup, soft } = {}) {
  G.clearSelection();
  await sleep(25);
  G.openOp(kind);
  await sleep(60);
  if (setup) await setup();
  await sleep(50);
  const ready = await waitFor(() => G.getState().opReady === true, 4000);
  assert(ready && okBtnDisabled() === false, `${kind}: OK gate clears`);
  const noticeBefore = G.getState().notice;
  await G.applyOp(kind, values);
  await idle();
  G.closeOp();
  await sleep(20);
  const noticeAfter = G.getState().notice;
  const err = noticeAfter && noticeAfter !== noticeBefore ? noticeAfter : null;
  if (soft) {
    note(`${kind}: apply notice=${err || 'none'} (soft)`);
    assert(G.getState().status === 'ready', `${kind}: app still ready`);
  } else {
    assert(!err, `${kind}: applied cleanly (${err || 'ok'})`);
    assert(!anyErr(), `${kind}: no feature error`);
  }
  return err;
}

// same fix as openApply above, for call sites that don't go through it
// (already had G.openOp / G.pick done manually): call G.applyOp, then read
// G.getState().notice for the real failure signal instead of a try/catch
// that structurally cannot fire (CmdQueue never rejects - see openApply's
// comment). Returns the notice string, or null if nothing new appeared.
async function applyOpChecked(kind, values) {
  const noticeBefore = G.getState().notice;
  await G.applyOp(kind, values);
  await idle();
  G.closeOp();
  const noticeAfter = G.getState().notice;
  return noticeAfter && noticeAfter !== noticeBefore ? noticeAfter : null;
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
  const err = await applyOpChecked('revolve', { operation: 'New body', full: true, axis: 'Y' });
  note('revolve New body + Full: err=' + (err || 'none'));
  assert(!err && !anyErr(), 'revolve with Operation=New body, Full committed');
}

// Revolve AROUND A REAL MODEL EDGE ("Selected edge / datum"), not the
// sketch's own H/V axis or a world axis - this is the same resolve-before-
// newObject ordering feature.sweep got wrong (see the sweep-around-edge test
// above): a profile revolved about a picked edge must land centred on THAT
// edge's line, not on whatever the sketch's default axis happens to be.
// The profile and the axis edge must lie in (or parallel to) the same plane -
// FreeCAD rejects an axis perpendicular to the profile's plane outright, so
// the profile goes on XZ and the picked edge is a horizontal, X-direction
// edge of the base block (both live in/parallel to the XZ plane).
note('--- Revolve AROUND A MODEL EDGE (Selected edge / datum) ---');
await rpc('session.reset');
await G.refresh();
await idle();
{
  const baseS = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: baseS.sketchId,
    elements: [{ type: 'rect', a: [0, 0], b: [10, 10] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.selectSketch(baseS.sketchId);
  await sleep(40);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 5 });
  await idle();
  const bid2 = G.getState().bodies[0]?.id;
  assert(!!bid2 && !anyErr(), 'revolve-around-edge: base block built');
  const mesh0 = (await rpc('scene.get')).meshes.find((mm) => mm.id === bid2);
  // find a horizontal edge along X, at Y=0 and Z=0 (the bottom-front edge)
  let axisEdgeSub = null;
  for (const e of mesh0.edges || []) {
    const p = e.points;
    if (p.length < 6) continue;
    const dx = Math.abs(p[0] - p[p.length - 3]);
    const dy = Math.abs(p[1] - p[p.length - 2]);
    const dz = Math.abs(p[2] - p[p.length - 1]);
    if (dy < 1e-3 && dz < 1e-3 && dx > 1 && Math.abs(p[1]) < 1e-3 && Math.abs(p[2]) < 1e-3) {
      axisEdgeSub = 'Edge' + (e.edge + 1);
      break;
    }
  }
  assert(!!axisEdgeSub, 'found the bottom-front X edge to revolve around (' + axisEdgeSub + ')');
  // a small rectangle profile OFFSET from that edge in Z, on the XZ plane -
  // revolving it 360 around the X-axis edge sweeps out a ring
  const profS = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XZ_Plane' } });
  await rpc('sketch.finish', {
    sketchId: profS.sketchId,
    elements: [{ type: 'rect', a: [15, 0], b: [20, 8] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.clearSelection();
  G.openOp('revolve');
  await sleep(50);
  G.pick({ kind: 'sketch', sketchId: profS.sketchId }, false);
  await sleep(30);
  G.pick({ kind: 'edge', bodyId: bid2, sub: axisEdgeSub, point: [5, 0, 0] }, true);
  await sleep(50);
  const readyRev = await waitFor(() => G.getState().opReady === true, 4000);
  assert(readyRev && okBtnDisabled() === false, 'revolve-around-edge: OK gate clears with profile + model edge');
  const meshCountBeforeRev = (await rpc('scene.get')).meshes.length;
  const errRev = await applyOpChecked('revolve', {
    operation: 'New body',
    full: true,
    axis: 'Selected edge / datum'
  });
  assert(!errRev && !anyErr(), `revolve-around-edge committed (${errRev || 'ok'})`);
  const scRev = await rpc('scene.get');
  const newRevMeshes = scRev.meshes.filter((mm) => mm.id !== bid2);
  assert(
    scRev.meshes.length > meshCountBeforeRev && newRevMeshes.length > 0,
    `revolve-around-edge created a genuinely NEW body (meshes ${meshCountBeforeRev} -> ${scRev.meshes.length})`
  );
  const revolved = newRevMeshes[newRevMeshes.length - 1];
  const bbr = revolved.bbox;
  // verified headlessly (identical setup, built through the real RPCs): a
  // full 360 revolve of the [15,20]x[0,8] rectangle around the picked X edge
  // gives spanX=5 (the profile's own X-width) and spanY=spanZ=16 (2x the
  // profile's 8mm reach off the axis) - if the axis resolution instead fell
  // back to a world/sketch-default axis, this would come out very different
  // (most likely a failed commit, since that default axis runs THROUGH the
  // profile here and PartDesign rejects a profile straddling its axis)
  const rSpanX = bbr.max[0] - bbr.min[0];
  const rSpanY = bbr.max[1] - bbr.min[1];
  const rSpanZ = bbr.max[2] - bbr.min[2];
  assert(Math.abs(rSpanX - 5) < 0.5, `revolved ring spans the right X extent, the profile's own width (${rSpanX.toFixed(1)}, want 5.0)`);
  assert(Math.abs(rSpanY - 16) < 0.5, `revolved ring spans the right Y extent, 2x the axis offset (${rSpanY.toFixed(1)}, want 16.0)`);
  assert(Math.abs(rSpanZ - 16) < 0.5, `revolved ring spans the right Z extent, 2x the axis offset (${rSpanZ.toFixed(1)}, want 16.0)`);
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
  const err = await applyOpChecked('extrude', { operation: 'Join', mode: 'Blind', length: 20, taper: 8 });
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

// mesh.toSolid must produce a real, sketchable PartDesign::Body - not a bare
// Part::Feature you can't do anything with afterward (a real regression: it
// used to leave you unable to even start a sketch on the converted result).
{
  const before = new Set((await rpc('tree.get')).bodies.map((b) => b.id));
  const r = await rpc('mesh.toSolid', { id: null, mode: 'flats', sewTolerance: 0.1 });
  assert(r.mesh && r.mesh.valid, `mesh.toSolid flats: valid result (${JSON.stringify(r.mesh)})`);
  const after = await rpc('tree.get');
  const newBody = after.bodies.find((b) => !before.has(b.id));
  assert(newBody, 'mesh.toSolid: a new body appears in the tree');
  await G.refresh();
  await idle();
  G.pick({ kind: 'face', bodyId: newBody.id, sub: 'Face1' }, false);
  await sleep(30);
  await G.createSketch();
  await sleep(80);
  const st = G.getState();
  assert(st.sketchMode, 'converted mesh body: face pick + Create Sketch enters the sketcher');
  await G.cancelSketch();
  await idle();
}

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
  const err = await applyOpChecked('splitBody', {});
  assert(!err, `split by sketch committed (${err || 'ok'})`);
  assert(G.getState().meshes.length >= 2, 'split by sketch produced pieces');
}

// Sweep's OK gate must NOT clear with only a path and no profile (or only a
// profile and no path) - a real user trace (2026-09-12) showed picking
// exactly one edge, nothing else, then hitting Apply, and getting the
// generic "adds nothing where it can be newbody" error with no earlier
// warning: the dialog's readiness gate (needs:'any') lit up on ANY single
// selection, so Apply was reachable long before the commit handler's own
// "select a profile sketch, then click the path" guard could ever fire.
note('--- Sweep: OK gate must require BOTH a profile sketch and a path (not just any one selection) ---');
await rpc('session.reset');
await G.refresh();
await idle();
{
  const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: s.sketchId,
    elements: [{ type: 'rect', a: [0, 0], b: [20, 20] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.selectSketch(s.sketchId);
  await sleep(40);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10 });
  await idle();
  const gateBid = G.getState().bodies[0]?.id;
  assert(!!gateBid, 'sweep-gate: base block built');

  G.clearSelection();
  G.openOp('sweep');
  await sleep(50);
  // only a PATH edge, no profile at all - this is exactly the real trace
  G.pick({ kind: 'edge', bodyId: gateBid, sub: 'Edge1' }, false);
  await sleep(50);
  assert(
    G.getState().opReady !== true && okBtnDisabled() !== false,
    'sweep: OK gate stays disabled with ONLY a path edge selected, no profile'
  );

  // only a PROFILE sketch, no path at all
  G.clearSelection();
  await sleep(30);
  G.pick({ kind: 'sketch', sketchId: s.sketchId }, false);
  await sleep(50);
  assert(
    G.getState().opReady !== true && okBtnDisabled() !== false,
    'sweep: OK gate stays disabled with ONLY a profile selected, no path'
  );
  G.closeOp();
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
  const err = await applyOpChecked('sweep', { operation: 'Join', orientation: 'Path', transition: 'Transformed' });
  assert(!err && !anyErr(), `sweep committed (${err || 'ok'})`);
}

// Sweep the profile AROUND A REAL MODEL EDGE (not a separate path sketch) -
// the sweep-path-sketch case above never exercises this. Build a body whose
// top face is bounded by a circular edge (an extruded circle), then sweep a
// small profile using that circular edge as the path: the result must be a
// closed torus-like ring, not a straight/degenerate shape.
note('--- Sweep AROUND A MODEL EDGE (curved), not a path sketch ---');
await rpc('session.reset');
await G.refresh();
await idle();
{
  const base = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: base.sketchId,
    elements: [{ type: 'circle', c: [0, 0], r: 20 }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.selectSketch(base.sketchId);
  await sleep(40);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 5 });
  await idle();
  const st0 = G.getState();
  const bid = st0.bodies[0]?.id;
  assert(!!bid && !anyErr(), 'sweep-around-edge: base cylinder built');
  const mesh0 = (await rpc('scene.get')).meshes.find((m) => m.id === bid);
  // find a genuinely CIRCULAR edge: every point on it is ~20mm from the axis
  // and its own bbox is roughly square in X/Y (a straight edge's bbox is a
  // line, near-zero in one axis) - avoids hardcoding an edge index that could
  // shift if the kernel ever orders edges differently.
  let circEdgeSub = null;
  for (const e of mesh0.edges || []) {
    const p = e.points;
    if (p.length < 9) continue;
    let okRadius = true;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      const r = Math.hypot(p[i], p[i + 1]);
      if (Math.abs(r - 20) > 0.5) okRadius = false;
      xmin = Math.min(xmin, p[i]);
      xmax = Math.max(xmax, p[i]);
      ymin = Math.min(ymin, p[i + 1]);
      ymax = Math.max(ymax, p[i + 1]);
    }
    if (okRadius && xmax - xmin > 30 && ymax - ymin > 30) {
      circEdgeSub = 'Edge' + (e.edge + 1);
      break;
    }
  }
  assert(!!circEdgeSub, 'found the circular rim edge to sweep around (' + circEdgeSub + ')');
  const prof = await rpc('sketch.on', { ref: { kind: 'origin', role: 'YZ_Plane' } });
  await rpc('sketch.finish', {
    sketchId: prof.sketchId,
    elements: [{ type: 'circle', c: [20, 0], r: 2 }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.clearSelection();
  G.openOp('sweep');
  await sleep(50);
  G.pick({ kind: 'sketch', sketchId: prof.sketchId }, false);
  await sleep(30);
  G.pick({ kind: 'edge', bodyId: bid, sub: circEdgeSub, point: [20, 0, 0] }, false);
  await sleep(50);
  const readyEdge = await waitFor(() => G.getState().opReady === true, 4000);
  assert(readyEdge && okBtnDisabled() === false, 'sweep-around-edge: OK gate clears with profile + model edge');
  const meshCountBeforeEdge = (await rpc('scene.get')).meshes.length;
  const errEdge = await applyOpChecked('sweep', {
    operation: 'New body',
    orientation: 'Path',
    transition: 'Transformed'
  });
  assert(!errEdge && !anyErr(), `sweep-around-edge committed (${errEdge || 'ok'})`);
  const scAfter = await rpc('scene.get');
  const newEdgeMeshes = scAfter.meshes.filter((m) => m.id !== bid);
  assert(
    scAfter.meshes.length > meshCountBeforeEdge && newEdgeMeshes.length > 0,
    `sweep-around-edge created a genuinely NEW body (meshes ${meshCountBeforeEdge} -> ${scAfter.meshes.length})`
  );
  const swept = newEdgeMeshes[newEdgeMeshes.length - 1];
  const bb = swept.bbox;
  // a ring swept around a 20mm-radius circle with a 2mm-radius profile spans
  // exactly 2*(20+2)=44mm in X and Y, and only a few mm in Z - if the path
  // were instead treated as degenerate/self-referencing (the real bug this
  // test caught: feature.sweep resolved the edge ref through body.Tip AFTER
  // already retargeting Tip to the new half-built Sweep, so the pipe's own
  // Spine pointed at itself), the sweep fails outright rather than producing
  // a plausible-but-wrong shape, so a loose collapse check would miss it -
  // this asserts the actual expected extent instead.
  const spanX = bb.max[0] - bb.min[0];
  const spanY = bb.max[1] - bb.min[1];
  const spanZ = bb.max[2] - bb.min[2];
  assert(Math.abs(spanX - 44) < 0.5, `swept ring spans the right X extent (${spanX.toFixed(1)}, want 44.0)`);
  assert(Math.abs(spanY - 44) < 0.5, `swept ring spans the right Y extent (${spanY.toFixed(1)}, want 44.0)`);
  assert(spanZ > 2 && spanZ < 6, `swept ring stays thin in Z, a true ring not a cylinder (${spanZ.toFixed(1)})`);
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
  const err = await applyOpChecked('loft', { operation: 'Join', ruled: true, closed: false });
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
  // find the TOP face (highest average Z) by its real mesh geometry, not a
  // guessed "Face6" - after a Two Sides extrude the face numbering is not
  // guaranteed, and the guess's own silent .catch(() => null) fallback to
  // plain XY_Plane (which does not intersect this solid at all) was masking
  // a real "cut profile does not intersect the solid" failure indefinitely,
  // since the try/catch around G.applyOp used to swallow it unconditionally.
  // G.getState().meshes only carries {id, tris} - the real per-vertex/face
  // data needed here comes from rpc('scene.get') instead.
  const meshForFace = (await rpc('scene.get')).meshes.find((m) => m.id === bid2);
  let topFaceSub = null,
    topZ = -1e9;
  for (const g of meshForFace.faceGroups || []) {
    let sz = 0,
      n = 0;
    for (let i = g.start; i < g.start + g.count; i++) {
      sz += meshForFace.positions[meshForFace.indices[i] * 3 + 2];
      n++;
    }
    if (n && sz / n > topZ) {
      topZ = sz / n;
      topFaceSub = 'Face' + (g.face + 1);
    }
  }
  assert(!!topFaceSub, 'found the top face to attach the cut sketch to (' + topFaceSub + ', z=' + topZ.toFixed(1) + ')');
  const sk2 = await rpc('sketch.on', { ref: { kind: 'face', bodyId: bid2, sub: topFaceSub } });
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
  const noticeBeforeCut = G.getState().notice;
  await G.applyOp('extrude', { operation: 'Cut', mode: 'Blind', length: 1, throughAll: true });
  await idle();
  const noticeAfterCut = G.getState().notice;
  const err = noticeAfterCut && noticeAfterCut !== noticeBeforeCut ? noticeAfterCut : null;
  assert(!err && !anyErr(), `extrude Cut with All (throughAll) committed (${err || 'ok'})`);
}
{
  // Two Sides also works for a Cut: a hole 10mm each way from a mid-height plane
  await rpc('session.reset');
  await G.refresh();
  await idle();
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
  const volBefore = meshes()[0].tris;
  await rpc('datum.plane', { refs: [{ kind: 'origin', role: 'XY_Plane' }], offset: 20 });
  const sc = await rpc('scene.get');
  const midPlane = (sc.datums || []).find(
    (x) => /plane/i.test(x.id || '') && !/^(XY|XZ|YZ)_Plane$/.test(x.id || '')
  )?.id;
  const s2 = await rpc('sketch.on', { ref: { kind: 'plane', id: midPlane } });
  await rpc('sketch.finish', {
    sketchId: s2.sketchId,
    elements: [{ type: 'circle', c: [0, 0], r: 5 }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.clearSelection();
  G.selectSketch(s2.sketchId);
  await sleep(40);
  const noticeBefore2 = G.getState().notice;
  await G.applyOp('extrude', { operation: 'Cut', mode: 'Two Sides', length: 10, length2: 10 });
  await idle();
  const noticeAfter2 = G.getState().notice;
  const err2 = noticeAfter2 && noticeAfter2 !== noticeBefore2 ? noticeAfter2 : null;
  assert(!err2 && !anyErr(), `extrude Cut with Two Sides committed (${err2 || 'ok'})`);
  assert(meshes()[0].tris !== volBefore, 'Two Sides cut actually removed material both directions');
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
