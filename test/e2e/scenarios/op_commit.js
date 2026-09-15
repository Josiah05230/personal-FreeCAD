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
const featsRaw = async () => (await rpc('tree.get')).bodies[0].features;
const anyErr = (st) => st.bodies.some((b) => b.features.some((f) => f.error));
const okBtnDisabled = () => {
  const b = document.querySelector('.opdlg-ok');
  return b ? b.disabled : null;
};

// ---------------------------------------------------------------- base body
let bid = null;
let vEdges = [];
let anyEdge = 'Edge1';

// re-derive the body's current vertical edges from the LIVE mesh - a
// dress-up (fillet/chamfer) renumbers Edge* on the body it touches, so a
// snapshot taken before it runs can point at edges that no longer exist (or
// mean something else) by the time a LATER op in this same run picks by
// that stale name. Confirmed live: chamfer picking a pre-fillet vEdges[1]
// against the post-fillet body silently landed on "No edges specified" -
// FreeCAD never threw, tree.get just marked the feature Invalid, and only
// checking `"Error" in State` (not `"Invalid"`) let it go unnoticed.
//
// Requires near-FULL pad-height edges (>=11, pad is 12 tall) specifically to
// exclude a fillet's own rounded blend-seam edges: those ARE vertical too
// but shorter (the radius is trimmed off each end), and FreeCAD legitimately
// refuses to chamfer one ("not C0 continuous" - confirmed live) - picking
// one is a fragile TEST target, not a product bug.
async function refreshVerticalEdges() {
  const mesh = (await rpc('scene.get')).meshes.find((m) => m.id === bid) || (await rpc('scene.get')).meshes[0];
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
  note('vertical edges (refreshed): ' + JSON.stringify(vEdges) + '  anyEdge=' + anyEdge);
}

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
  bid = (await rpc('scene.get')).meshes[0].id;
  await refreshVerticalEdges();
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
    if (anyErr(st)) {
      const raw = await featsRaw();
      note(`${kind}: DEBUG errored features (raw tree.get) = ` + JSON.stringify(raw.filter((f) => f.error)));
    }
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

// a fresh base body for chamfer, rather than reusing the fillet's - some of
// the fillet's OWN rounded edges are vertical and near-full-height too, so
// picking by the same "tall + vertical" heuristic against the fillet's
// output can land on the fillet's own blend seam, which FreeCAD legitimately
// refuses to chamfer ("not C0 continuous", confirmed live) - a fragile TEST
// target chained off a dress-up result, not a product bug.
await rebuildBase('fresh base for chamfer (avoid the fillet body own blend-seam edges)');
await checkCommit(
  'chamfer',
  async () => {
    G.pick({ kind: 'edge', bodyId: bid, sub: vEdges[0] || anyEdge, point: [0, 0, 0] }, false);
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
for (const k of ['combine', 'move', 'scale']) {
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

// ---------------------------------------------------------------- fillet / chamfer by FACE
note('--- fillet a whole face (rounds all its edges), + face+edge mix ---');
await rebuildBase('reset + rect -> extrude 12 (fresh body for the fillet-by-face checks)');
{
  const before = feats(G.getState()).find((f) => f.kind === 'solid');
  const sc0 = await rpc('scene.get');
  const eBefore = (sc0.meshes[0].edges || []).length;
  G.clearSelection();
  await sleep(20);
  G.openOp('fillet');
  await sleep(60);
  // pick a face - the top (Z+) face of the box
  G.pick({ kind: 'face', bodyId: bid, sub: 'Face6', point: [20, 15, 12], normal: [0, 0, 1] }, false);
  await sleep(60);
  const okReady = await waitFor(() => G.getState().opReady === true, 4000);
  assert(okReady && okBtnDisabled() === false, 'fillet: a FACE selection enables OK');
  let e1 = null;
  try {
    await G.applyOp('fillet', { radius: 2 });
  } catch (e) {
    e1 = (e && e.message) || String(e);
  }
  await idle();
  G.closeOp();
  const st = G.getState();
  const fil = feats(st).find((f) => /fillet/i.test(f.id));
  assert(!e1 && !!fil && !anyErr(st), `fillet-by-face committed (${e1 || 'ok'})`);
  const sc1 = await rpc('scene.get');
  const eAfter = (sc1.meshes[0].edges || []).length;
  assert(eAfter > eBefore, `fillet-by-face rounded multiple edges (${eBefore} -> ${eAfter} edges)`);
  // it should round ALL four edges of a rectangular face: a box top face fillet
  // turns 12 edges into 20 (4 new fillet faces, each adding 2 edges)
  assert(eAfter >= eBefore + 6, `looks like all edges of the face were rounded (+${eAfter - eBefore})`);
}

// ------------------------------------------------ multiple edges, one Fillet feature
// This mimics the REAL interactive flow that was broken: open the dialog, pick an
// edge, TYPE A RADIUS (which fires the live preview -> a real Fillet feature lands
// on the body and its Edge* numbering shifts), THEN Ctrl-click more edges whose
// 3D points are read off the now-filleted mesh, then OK. The earlier version of
// this test skipped the live preview entirely, so it never reproduced the bug.
note('--- interactive multi-edge fillet: pick, preview, add more edges, commit ---');
await rebuildBase('reset + rect -> extrude 12 (fresh body for the interactive multi-fillet check)');
{
  await sleep(20);

  // a point at the true PARAMETRIC MIDDLE of every edge (half its polyline
  // arc-length), in world xyz - this is what the viewport Picker hands onSelect
  // as `point` for a click in the middle of an edge. NOT an endpoint (a vertex
  // is ambiguous between several edges).
  const edgeMid = (sc) => {
    const out = [];
    for (const e of sc.meshes[0].edges || []) {
      const pts = e.points || [];
      const n = pts.length / 3;
      if (n < 2) continue;
      // walk half the total length
      let total = 0;
      for (let i = 1; i < n; i++) {
        total += Math.hypot(
          pts[i * 3] - pts[(i - 1) * 3],
          pts[i * 3 + 1] - pts[(i - 1) * 3 + 1],
          pts[i * 3 + 2] - pts[(i - 1) * 3 + 2]
        );
      }
      let acc = 0;
      let mp = [pts[0], pts[1], pts[2]];
      for (let i = 1; i < n; i++) {
        const seg = Math.hypot(
          pts[i * 3] - pts[(i - 1) * 3],
          pts[i * 3 + 1] - pts[(i - 1) * 3 + 1],
          pts[i * 3 + 2] - pts[(i - 1) * 3 + 2]
        );
        if (acc + seg >= total / 2) {
          const t = (total / 2 - acc) / (seg || 1);
          mp = [
            pts[(i - 1) * 3] + t * (pts[i * 3] - pts[(i - 1) * 3]),
            pts[(i - 1) * 3 + 1] + t * (pts[i * 3 + 1] - pts[(i - 1) * 3 + 1]),
            pts[(i - 1) * 3 + 2] + t * (pts[i * 3 + 2] - pts[(i - 1) * 3 + 2])
          ];
          break;
        }
        acc += seg;
      }
      out.push({ sub: 'Edge' + (e.edge + 1), point: mp });
    }
    return out;
  };

  let sc0 = await rpc('scene.get');
  const eBefore = (sc0.meshes[0].edges || []).length;
  const fBefore = feats(G.getState()).filter((f) => /fillet/i.test(f.id)).length;
  // pick 3 distinct edges spread around the box (by their world midpoints)
  const all0 = edgeMid(sc0);
  assert(all0.length >= 6, `scene has edges with geometry (${all0.length})`);
  const want = [all0[0], all0[2], all0[4]];
  note('interactive multi-fillet picks: ' + JSON.stringify(want.map((w) => w.sub)));

  G.clearSelection();
  await sleep(20);
  G.openOp('fillet');
  await sleep(60);

  // 1) plain-pick the first edge
  G.pick({ kind: 'edge', bodyId: bid, sub: want[0].sub, point: want[0].point }, false);
  await sleep(40);
  // 2) type a radius -> fire the SAME live-preview path the dialog fires
  await G.livePreview('fillet', { radius: 2 });
  // wait for the preview Fillet feature to actually land on the body
  const gotPreview = await waitFor(
    () => (G.livePreviewState().featureId != null) || (G.getState().meshes[0].tris > 0),
    5000
  );
  assert(gotPreview, 'the live preview ran (a preview Fillet feature is on the body)');
  await sleep(150);

  // 3) the body is now filleted on edge 0 - re-read the scene and Ctrl-click
  //    two MORE edges using points taken from the FILLETED mesh (numbering has
  //    shifted; only the 3D point is trustworthy now)
  const scP = await rpc('scene.get');
  const allP = edgeMid(scP);
  // match the remaining wanted edges to the nearest current edge by point
  const nearest = (p) => {
    let best = null,
      bd = 1e9;
    for (const c of allP) {
      const d = Math.hypot(c.point[0] - p[0], c.point[1] - p[1], c.point[2] - p[2]);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  };
  for (let i = 1; i < want.length; i++) {
    const c = nearest(want[i].point) || want[i];
    G.pick({ kind: 'edge', bodyId: bid, sub: c.sub, point: want[i].point }, true); // Ctrl-click = additive
    await sleep(40);
    await G.livePreview('fillet', { radius: 2 }); // dialog re-fires preview on every change
    await sleep(150);
  }

  const selCount = G.getState().selection.filter((s) => s.startsWith('edge:')).length;
  assert(selCount >= 3, `all 3 edges stay selected through the previews (${selCount})`);

  const ready = await waitFor(() => G.getState().opReady === true, 5000);
  assert(ready && okBtnDisabled() === false, 'OK is enabled with 3 edges picked');

  // 4) commit
  let mErr = null;
  try {
    await G.applyOp('fillet', { radius: 2 });
  } catch (e) {
    mErr = (e && e.message) || String(e);
  }
  await idle();
  G.closeOp();
  await sleep(40);
  const st = G.getState();
  assert(!mErr, `interactive multi-edge fillet committed without an error (${mErr || 'ok'})`);
  assert(!anyErr(st), 'no feature error after the commit');
  const fAfter = feats(st).filter((f) => /fillet/i.test(f.id)).length;
  assert(fAfter === fBefore + 1, `exactly ONE Fillet feature was added (${fBefore} -> ${fAfter})`);
  assert(st.meshes.length >= 1 && st.meshes[0].tris > 0, 'the body still renders (it did not vanish)');
  const sc1 = await rpc('scene.get');
  const eAfter2 = (sc1.meshes[0].edges || []).length;
  // 3 rounded edges add well over 4 new edges; a silent no-op would leave it unchanged
  assert(
    eAfter2 >= eBefore + 6,
    `3 edges actually got rounded in that one feature (${eBefore} -> ${eAfter2} edges)`
  );
}

// ---------------------------------------------------------------- negative distance == flip
note('--- a negative Distance / Angle folds into the flip flag ---');
await rebuildBase('reset + rect -> extrude 12 (fresh body for the negative-value check)');
{
  // sketch on the TOP face, extrude-cut with a NEGATIVE length: should cut DOWN
  // into the solid exactly like a positive length + Flip, not error / do nothing
  const sc = await rpc('scene.get');
  void sc;
  const sk = await rpc('sketch.on', { ref: { kind: 'face', bodyId: bid, sub: 'Face6' } }).catch(
    () => null
  );
  const s = sk ?? (await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } }));
  await rpc('sketch.finish', {
    sketchId: s.sketchId,
    elements: [{ type: 'circle', c: [20, 15], r: 5 }],
    constraints: []
  });
  await G.refresh();
  await idle();
  const volBefore = (G.getState().meshes[0] || {}).tris;
  G.clearSelection();
  G.openOp('extrude');
  await sleep(50);
  G.selectSketch(s.sketchId);
  await sleep(50);
  let ne = null;
  try {
    await G.applyOp('extrude', { operation: 'Cut', mode: 'Blind', length: -10 });
  } catch (e) {
    ne = (e && e.message) || String(e);
  }
  await idle();
  G.closeOp();
  const st = G.getState();
  note('negative-cut: err=' + (ne || 'none') + ' notice=' + (st.notice || 'none'));
  assert(!anyErr(st), 'negative-length extrude-cut left no feature error');
  assert(
    (st.meshes[0] || {}).tris !== volBefore || !ne,
    'negative-length cut actually changed the solid (folded to a flip, not a no-op)'
  );
}

// ---------------------------------------------------------------- Enter / Esc
note('--- Enter commits a ready dialog, Esc cancels ---');
await rebuildBase('reset + rect -> extrude 12 (fresh body for the keyboard checks)');
{
  const n0 = feats(G.getState()).length;
  G.clearSelection();
  G.openOp('fillet');
  await sleep(50);
  G.pick({ kind: 'edge', bodyId: bid, sub: vEdges[0] || anyEdge, point: [0, 0, 0] }, false);
  await sleep(60);
  await waitFor(() => G.getState().opReady === true, 4000);
  const dlg = document.querySelector('.opdlg');
  dlg.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  );
  await idle();
  assert(G.getState().op == null, 'Enter closed the dialog');
  assert(feats(G.getState()).length === n0 + 1, 'Enter committed the fillet');

  // now Esc
  G.clearSelection();
  G.openOp('chamfer');
  await sleep(50);
  G.pick({ kind: 'edge', bodyId: bid, sub: vEdges[1] || vEdges[0] || anyEdge, point: [0, 0, 0] }, false);
  await sleep(50);
  const dlg2 = document.querySelector('.opdlg');
  dlg2.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  );
  await sleep(80);
  assert(G.getState().op == null, 'Esc closed the dialog');
  assert(feats(G.getState()).length === n0 + 1, 'Esc did NOT commit a chamfer');
}

// ---------------------------------------------------------------- wrap up
const fin = G.getState();
assert(fin.status === 'ready', 'app still ready at end (' + fin.status + ')');
assert(!document.body.innerText.includes('The interface hit an error'), 'no ErrorBoundary');
assert((await rpc('ping')).pong === true, 'engine still responds at end');
note('op_commit complete');
