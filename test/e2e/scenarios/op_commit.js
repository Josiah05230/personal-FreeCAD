/* Every operation dialog must actually let you COMMIT once it has a valid
 * selection and its preview has rendered. This is the class of bug the user
 * hit on Revolve ("it won't let me hit OK even after it renders"): the dialog
 * shows a live preview but its own `ready` gate stays false, so the OK button
 * is disabled forever.
 *
 * For each op: open it, make the minimal valid selection through the real
 * onSelect path, wait for the dialog to report `opReady`, and assert BOTH
 * getState().opReady AND the actual DOM button's `disabled` are cleared. Then
 * apply and assert the engine stayed healthy (feature committed / no error /
 * still pings). Apply is "soft" for ops that need extra geometry we do not
 * build here - the point of this scenario is the OK gate, not every feature.
 */

const feats = (st) => (st.bodies[0] ? st.bodies[0].features : []);
const anyErr = (st) => st.bodies.some((b) => b.features.some((f) => f.error));
const okBtnDisabled = () => {
  const b = document.querySelector('.opdlg-ok');
  return b ? b.disabled : null;
};

// ---------------------------------------------------------------- base body
let bid = null;
let vEdges = [];
let anyEdge = 'Edge1';

async function rebuildBase(label) {
  note(label);
  await rpc('session.reset');
  await G.refresh();
  await idle();
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
  assert(feats(G.getState()).some((f) => f.kind === 'solid'), label + ': base pad built');
  const mesh = (await rpc('scene.get')).meshes[0];
  bid = mesh.id;
  vEdges = [];
  for (const e of mesh.edges || []) {
    const p = e.points;
    if (p.length >= 6) {
      const dx = Math.abs(p[0] - p[p.length - 3]);
      const dy = Math.abs(p[1] - p[p.length - 2]);
      const dz = Math.abs(p[2] - p[p.length - 1]);
      if (dx < 1e-3 && dy < 1e-3 && dz > 1) vEdges.push('Edge' + (e.edge + 1));
    }
  }
  anyEdge = 'Edge' + ((mesh.edges && mesh.edges[0] ? mesh.edges[0].edge : 0) + 1);
  note('vertical edges: ' + JSON.stringify(vEdges) + '  anyEdge=' + anyEdge);
}

await rebuildBase('reset + rect -> extrude 12 (body for the profile / dress-up ops)');

// ---------------------------------------------------------------- the check
/**
 * @param kind       op kind
 * @param setup      async () => void  - make the selection AFTER the dialog opens
 * @param applyVals  values object for applyOp
 * @param opts       { soft?: boolean, needPreview?: boolean }
 */
async function checkCommit(kind, setup, applyVals, opts = {}) {
  const before = feats(G.getState()).length;
  G.clearSelection();
  await sleep(30);
  G.openOp(kind);
  await sleep(70);
  await setup();
  await sleep(60);
  // give any live preview / ready recompute a beat to land
  const gotReady = await waitFor(() => G.getState().opReady === true, 5000);
  const domDisabled = okBtnDisabled();
  assert(gotReady, `${kind}: dialog reports opReady after a valid selection`);
  assert(
    domDisabled === false,
    `${kind}: the OK button is actually enabled (disabled=${domDisabled})`
  );

  let err = null;
  try {
    await G.applyOp(kind, applyVals);
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  await idle();
  G.closeOp();
  await sleep(30);
  const st = G.getState();
  if (opts.soft) {
    note(`${kind}: apply err=${err || 'none'} notice=${st.notice || 'none'} (soft)`);
    assert(st.status === 'ready', `${kind}: app still ready after a soft apply`);
  } else {
    assert(!err, `${kind}: applied without throwing (${err || 'ok'})`);
    assert(!anyErr(st), `${kind}: no feature error after apply`);
    assert(
      feats(st).length >= before,
      `${kind}: timeline did not lose features (${before} -> ${feats(st).length})`
    );
  }
}

// ---------------------------------------------------------------- profile ops
await checkCommit(
  'revolve',
  async () => {
    // profile = a FLAT MODEL FACE (the exact case the user reported), axis = an edge
    G.pick({ kind: 'face', bodyId: bid, sub: 'Face1', point: [0, 0, 0] }, false);
    await sleep(40);
    G.pick({ kind: 'edge', bodyId: bid, sub: vEdges[0] || anyEdge, point: [0, 0, 0] }, true);
  },
  { angle: 90, axis: 'Selected edge / datum', cut: false },
  { soft: true } // face-revolve geometry can legitimately fail; the OK gate is what we assert
);

// ---------------------------------------------------------------- dress-up ops
await checkCommit(
  'fillet',
  async () => {
    G.pick({ kind: 'edge', bodyId: bid, sub: vEdges[0] || anyEdge, point: [0, 0, 0] }, false);
  },
  { radius: 2 }
);

await checkCommit(
  'chamfer',
  async () => {
    G.pick({ kind: 'edge', bodyId: bid, sub: vEdges[1] || vEdges[0] || anyEdge, point: [0, 0, 0] }, false);
  },
  { size: 1.5 }
);

await checkCommit(
  'shell',
  async () => {
    G.pick({ kind: 'face', bodyId: bid, sub: 'Face2', point: [0, 0, 0] }, false);
  },
  { thickness: 2 },
  { soft: true } // which face is "open" depends on Face numbering; gate is the point
);

await checkCommit(
  'hole',
  async () => {
    G.pick({ kind: 'face', bodyId: bid, sub: 'Face1', point: [10, 10, 12] }, false);
  },
  { diameter: 5, depth: 6, throughAll: false, cutType: 'None' },
  { soft: true }
);

// ---------------------------------------------------------------- plane / axis ops
// fresh body so edge / face numbering is stable (the dress-up ops above churned it)
await rebuildBase('reset + rect -> extrude 12 (fresh body for plane / axis / datum ops)');

await checkCommit(
  'mirror',
  async () => {
    G.pick({ kind: 'plane', planeId: 'YZ_Plane', role: 'YZ_Plane' }, false);
  },
  { scope: 'Body', operation: 'Join' }
);

await checkCommit(
  'patternLinear',
  async () => {
    G.pick({ kind: 'plane', planeId: 'X_Axis', role: 'X_Axis' }, false);
  },
  { scope: 'Body', operation: 'Join', count: 3, spacing: 15 },
  { soft: true } // pattern shape validity is finicky; the OK gate is what we assert
);

await checkCommit(
  'patternCircular',
  async () => {
    G.pick({ kind: 'plane', planeId: 'Z_Axis', role: 'Z_Axis' }, false);
  },
  { scope: 'Body', operation: 'Join', count: 4, angle: 360 },
  { soft: true }
);

// ---------------------------------------------------------------- datum ops
await checkCommit(
  'datumPlane',
  async () => {
    G.pick({ kind: 'face', bodyId: bid, sub: 'Face1', point: [0, 0, 0] }, false);
  },
  { offset: 10, angle: 0, flip: false }
);

await checkCommit(
  'datumAxis',
  async () => {
    G.pick({ kind: 'edge', bodyId: bid, sub: vEdges[0] || anyEdge, point: [0, 0, 0] }, false);
  },
  { offset: 0, flip: false },
  { soft: true }
);

await checkCommit(
  'datumPoint',
  async () => {
    G.pick({ kind: 'edge', bodyId: bid, sub: vEdges[0] || anyEdge, point: [0, 0, 0] }, false);
  },
  {},
  { soft: true }
);

// ---------------------------------------------------------------- needs:'none' ops
// these have no selection requirement - opReady must be true the instant they open
for (const k of ['combine', 'moveBody', 'copyBody']) {
  G.clearSelection();
  await sleep(20);
  G.openOp(k);
  await sleep(80);
  const r = G.getState().opReady;
  const d = okBtnDisabled();
  assert(r === true && d === false, `${k}: OK enabled immediately (opReady=${r} disabled=${d})`);
  G.closeOp();
  await sleep(20);
}

// ---------------------------------------------------------------- revolve on a SKETCH too
note('revolve with a sketch profile (not a face) also commits');
await rpc('session.reset');
await G.refresh();
await idle();
const rs = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: rs.sketchId,
  elements: [{ type: 'rect', a: [10, 0], b: [20, 15] }],
  constraints: []
});
await G.refresh();
await idle();
G.clearSelection();
await sleep(20);
G.openOp('revolve');
await sleep(60);
G.selectSketch(rs.sketchId);
await sleep(60);
const rReady = await waitFor(() => G.getState().opReady === true, 5000);
assert(rReady && okBtnDisabled() === false, 'revolve(sketch): OK enabled');
let rErr = null;
try {
  await G.applyOp('revolve', { angle: 270, axis: 'Y', cut: false });
} catch (e) {
  rErr = (e && e.message) || String(e);
}
await idle();
G.closeOp();
assert(!rErr && !anyErr(G.getState()), `revolve(sketch) committed (${rErr || 'ok'})`);

// ---------------------------------------------------------------- wrap up
const fin = G.getState();
assert(fin.status === 'ready', 'app still ready at end (' + fin.status + ')');
assert(!document.body.innerText.includes('The interface hit an error'), 'no ErrorBoundary');
assert((await rpc('ping')).pong === true, 'engine still responds at end');
note('op_commit complete');
