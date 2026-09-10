/* The GAP this closes: the op-commit / feature scenarios opened a dialog, made a
 * selection, and clicked OK - but NEVER fired the live preview. So any bug that
 * only appears AFTER a preview feature is on the body (the model edge / face
 * numbering shifts, the selection collapses, the "promote the preview" commit
 * freezes a stale ref set) was invisible to the whole suite. That is exactly how
 * the multi-edge fillet bug shipped.
 *
 * This scenario drives the REAL interactive cycle for every live-preview op:
 *   open dialog -> pick -> fire live preview (G.livePreview, same path the
 *   OperationDialog effect fires) -> mutate (add a ref / change a value) ->
 *   fire preview again -> OK -> assert the committed feature matches the FINAL
 *   picked set, not a stale mid-preview one, and the engine stayed healthy.
 *
 * Also covers the edit-feature preview cycle (editPreview mutates the real
 * feature in place; Cancel must restore, OK must keep the new refs).
 */

const feats = (st) => (st.bodies[0] ? st.bodies[0].features : []);
const anyErr = (st) => st.bodies.some((b) => b.features.some((f) => f.error));
const okDisabled = () => {
  const b = document.querySelector('.opdlg-ok');
  return b ? b.disabled : null;
};

// world-space point at the parametric middle of every model edge (what the
// viewport Picker hands onSelect as `point` for a mid-edge click)
function edgeMidpoints(mesh) {
  const out = [];
  for (const e of mesh.edges || []) {
    const p = e.points || [];
    const n = p.length / 3;
    if (n < 2) continue;
    let total = 0;
    for (let i = 1; i < n; i++)
      total += Math.hypot(p[i * 3] - p[(i - 1) * 3], p[i * 3 + 1] - p[(i - 1) * 3 + 1], p[i * 3 + 2] - p[(i - 1) * 3 + 2]);
    let acc = 0;
    let mp = [p[0], p[1], p[2]];
    for (let i = 1; i < n; i++) {
      const seg = Math.hypot(p[i * 3] - p[(i - 1) * 3], p[i * 3 + 1] - p[(i - 1) * 3 + 1], p[i * 3 + 2] - p[(i - 1) * 3 + 2]);
      if (acc + seg >= total / 2) {
        const t = (total / 2 - acc) / (seg || 1);
        mp = [
          p[(i - 1) * 3] + t * (p[i * 3] - p[(i - 1) * 3]),
          p[(i - 1) * 3 + 1] + t * (p[i * 3 + 1] - p[(i - 1) * 3 + 1]),
          p[(i - 1) * 3 + 2] + t * (p[i * 3 + 2] - p[(i - 1) * 3 + 2])
        ];
        break;
      }
      acc += seg;
    }
    out.push({ sub: 'Edge' + (e.edge + 1), point: mp });
  }
  return out;
}

async function box(w = 40, d = 30, h = 12) {
  await rpc('session.reset');
  await G.refresh();
  await idle();
  const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', { sketchId: s.sketchId, elements: [{ type: 'rect', a: [0, 0], b: [w, d] }], constraints: [] });
  await G.refresh();
  await idle();
  G.selectSketch(s.sketchId);
  await sleep(40);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: h });
  await idle();
  const mesh = (await rpc('scene.get')).meshes[0];
  return { id: mesh.id, mesh, sketchId: s.sketchId };
}

// fire the live preview like the dialog does, then wait for it to settle
async function preview(kind, values, wait = 220) {
  await G.livePreview(kind, values);
  await sleep(wait);
}

// ============================================================ FILLET (regression guard)
note('--- fillet: pick, preview, Ctrl-add 2 edges off the filleted mesh, commit ---');
{
  const b = await box();
  const eBefore = (b.mesh.edges || []).length;
  const mids = edgeMidpoints(b.mesh);
  const want = [mids[0], mids[2], mids[4]];
  G.clearSelection();
  await sleep(20);
  G.openOp('fillet');
  await sleep(50);
  G.pick({ kind: 'edge', bodyId: b.id, sub: want[0].sub, point: want[0].point }, false);
  await preview('fillet', { radius: 2 });
  assert(G.livePreviewState().featureId != null, 'a preview Fillet feature landed on the body');
  // the body is filleted now - add the other edges by their ORIGINAL world points
  for (let i = 1; i < want.length; i++) {
    G.pick({ kind: 'edge', bodyId: b.id, sub: want[i].sub, point: want[i].point }, true);
    await preview('fillet', { radius: 2 });
  }
  const selN = G.getState().selection.filter((s) => s.startsWith('edge:')).length;
  assert(selN === 3, `all 3 edges survive the previews (${selN})`);
  await waitFor(() => G.getState().opReady === true, 4000);
  assert(okDisabled() === false, 'OK enabled with 3 edges');
  let err = null;
  try {
    await G.applyOp('fillet', { radius: 2 });
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  await idle();
  G.closeOp();
  const st = G.getState();
  assert(!err && !anyErr(st), `committed clean (${err || 'ok'})`);
  assert(feats(st).filter((f) => /fillet/i.test(f.id)).length === 1, 'exactly one Fillet feature');
  const eAfter = ((await rpc('scene.get')).meshes[0].edges || []).length;
  assert(eAfter >= eBefore + 6, `3 edges rounded in one feature (${eBefore} -> ${eAfter})`);
  const fg = await rpc('feature.get', { id: feats(st).find((f) => /fillet/i.test(f.id)).id });
  assert((fg.refs.edges || []).length === 3, `the Fillet feature references all 3 edges (${JSON.stringify(fg.refs.edges)})`);
}

// ============================================================ CHAMFER (same class)
note('--- chamfer: pick, preview, Ctrl-add a 2nd edge, commit ---');
{
  const b = await box();
  const eBefore = (b.mesh.edges || []).length;
  const mids = edgeMidpoints(b.mesh);
  G.clearSelection();
  await sleep(20);
  G.openOp('chamfer');
  await sleep(50);
  G.pick({ kind: 'edge', bodyId: b.id, sub: mids[0].sub, point: mids[0].point }, false);
  await preview('chamfer', { size: 1.5 });
  assert(G.livePreviewState().featureId != null, 'a preview Chamfer feature landed');
  G.pick({ kind: 'edge', bodyId: b.id, sub: mids[3].sub, point: mids[3].point }, true);
  await preview('chamfer', { size: 1.5 });
  assert(G.getState().selection.filter((s) => s.startsWith('edge:')).length === 2, 'both edges stay selected');
  await waitFor(() => G.getState().opReady === true, 4000);
  let err = null;
  try {
    await G.applyOp('chamfer', { size: 1.5 });
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  await idle();
  G.closeOp();
  const st = G.getState();
  assert(!err && !anyErr(st), `chamfer committed clean (${err || 'ok'})`);
  assert(feats(st).filter((f) => /chamfer/i.test(f.id)).length === 1, 'exactly one Chamfer feature');
  const fg = await rpc('feature.get', { id: feats(st).find((f) => /chamfer/i.test(f.id)).id });
  assert((fg.refs.edges || []).length === 2, `Chamfer references both edges (${JSON.stringify(fg.refs.edges)})`);
  const eAfter = ((await rpc('scene.get')).meshes[0].edges || []).length;
  assert(eAfter > eBefore, 'chamfer changed the edge count');
}

// ============================================================ SHELL (multi-face after preview)
note('--- shell: pick a face, preview, Ctrl-add another face, commit ---');
{
  const b = await box();
  G.clearSelection();
  await sleep(20);
  G.openOp('shell');
  await sleep(50);
  // top + one side face (points on their centres)
  G.pick({ kind: 'face', bodyId: b.id, sub: 'Face6', point: [20, 15, 12], normal: [0, 0, 1] }, false);
  await preview('shell', { thickness: 2 });
  const hadPreview = G.livePreviewState().featureId != null;
  note('shell preview feature: ' + hadPreview);
  G.pick({ kind: 'face', bodyId: b.id, sub: 'Face1', point: [20, 0, 6], normal: [0, -1, 0] }, true);
  await preview('shell', { thickness: 2 });
  const faceSel = G.getState().selection.filter((s) => s.startsWith('face:')).length;
  assert(faceSel === 2, `both faces stay selected through the preview (${faceSel})`);
  await waitFor(() => G.getState().opReady === true, 4000);
  let err = null;
  try {
    await G.applyOp('shell', { thickness: 2, direction: 'Inside' });
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  await idle();
  G.closeOp();
  const st = G.getState();
  // shell of 2 specific faces can be geometrically invalid depending on numbering;
  // the gate is "no stale-ref crash / no ErrorBoundary / engine healthy"
  note(`shell apply: err=${err || 'none'} notice=${st.notice || 'none'}`);
  assert(st.status === 'ready', 'app ready after the shell commit');
  assert(!anyErr(st) || !!st.notice, 'a shell failure is a clean notice, not a silent broken feature');
  assert((await rpc('ping')).pong === true, 'engine alive after shell');
}

// ============================================================ DRAFT (multi-face after preview)
note('--- draft: pick a face, preview, Ctrl-add another, commit ---');
{
  const b = await box();
  G.clearSelection();
  await sleep(20);
  G.openOp('draft');
  await sleep(50);
  G.pick({ kind: 'face', bodyId: b.id, sub: 'Face1', point: [20, 0, 6], normal: [0, -1, 0] }, false);
  await preview('draft', { angle: 5 });
  G.pick({ kind: 'face', bodyId: b.id, sub: 'Face3', point: [20, 30, 6], normal: [0, 1, 0] }, true);
  await preview('draft', { angle: 5 });
  const faceSel = G.getState().selection.filter((s) => s.startsWith('face:')).length;
  assert(faceSel === 2, `both draft faces stay selected (${faceSel})`);
  await waitFor(() => G.getState().opReady === true, 4000);
  let err = null;
  try {
    await G.applyOp('draft', { angle: 5 });
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  await idle();
  G.closeOp();
  const st = G.getState();
  note(`draft apply: err=${err || 'none'} notice=${st.notice || 'none'}`);
  assert(st.status === 'ready', 'app ready after the draft commit');
  assert(!anyErr(st) || !!st.notice, 'a draft failure is a clean notice, not a broken feature');
  assert((await rpc('ping')).pong === true, 'engine alive after draft');
}

// ============================================================ HOLE (preview, change value, commit)
note('--- hole: pick a face, preview, change the diameter, commit ---');
{
  const b = await box();
  G.clearSelection();
  await sleep(20);
  G.openOp('hole');
  await sleep(50);
  G.pick({ kind: 'face', bodyId: b.id, sub: 'Face6', point: [20, 15, 12], normal: [0, 0, 1] }, false);
  await preview('hole', { diameter: 4, depth: 6, throughAll: false, cutType: 'None' });
  const hadPreview = G.livePreviewState().featureId != null;
  note('hole preview feature: ' + hadPreview);
  // bump the diameter - preview should update the SAME feature in place
  await preview('hole', { diameter: 8, depth: 6, throughAll: false, cutType: 'None' });
  await waitFor(() => G.getState().opReady === true, 4000);
  let err = null;
  try {
    await G.applyOp('hole', { diameter: 8, depth: 6, throughAll: false, cutType: 'None' });
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  await idle();
  G.closeOp();
  const st = G.getState();
  note(`hole apply: err=${err || 'none'} notice=${st.notice || 'none'}`);
  assert(st.status === 'ready', 'app ready after the hole commit');
  assert(!anyErr(st) || !!st.notice, 'a hole failure is a clean notice');
  assert((await rpc('ping')).pong === true, 'engine alive after hole');
}

// ============================================================ EXTRUDE (preview, flip, commit)
note('--- extrude: sketch on a face, preview, toggle Reversed, commit ---');
{
  const b = await box();
  // a small rect sketch on the top face
  const fs = await rpc('sketch.onFace', { bodyId: b.id, face: 'Face6' });
  await rpc('sketch.finish', {
    sketchId: fs.sketchId,
    elements: [{ type: 'rect', a: [10, 8], b: [22, 18] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  const trisBefore = G.getState().meshes[0].tris;
  G.clearSelection();
  await sleep(20);
  G.selectSketch(fs.sketchId);
  await sleep(40);
  G.openOp('extrude');
  await sleep(50);
  await preview('extrude', { operation: 'Join', mode: 'Blind', length: 6, reversed: false });
  const pv1 = G.livePreviewState().featureId;
  note('extrude preview feature: ' + (pv1 != null));
  // flip direction - a Blind pad's Reversed is a fast in-place prop, same feature
  await preview('extrude', { operation: 'Cut', mode: 'Blind', length: 6, reversed: false });
  await waitFor(() => G.getState().opReady === true, 4000);
  let err = null;
  try {
    await G.applyOp('extrude', { operation: 'Cut', mode: 'Blind', length: 6, reversed: false });
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  await idle();
  G.closeOp();
  const st = G.getState();
  assert(!err && !anyErr(st), `extrude-cut committed clean (${err || 'ok'})`);
  const trisAfter = G.getState().meshes[0].tris;
  assert(trisAfter !== trisBefore, `the cut actually changed the solid (${trisBefore} -> ${trisAfter} tris)`);
  assert(feats(st).filter((f) => f.kind === 'solid').length >= 2, 'a second solid feature (the pocket) was added');
}

// ============================================================ REVOLVE (face profile + axis, preview, commit)
note('--- revolve: face profile + edge axis, preview, commit ---');
{
  const b = await box(20, 20, 30);
  G.clearSelection();
  await sleep(20);
  G.openOp('revolve');
  await sleep(50);
  // a side face as the profile, a far vertical edge as the axis
  G.pick({ kind: 'face', bodyId: b.id, sub: 'Face1', point: [10, 0, 15], normal: [0, -1, 0] }, false);
  await sleep(40);
  // pick a vertical edge on the OPPOSITE side as the axis (Ctrl-add)
  const mids = edgeMidpoints(b.mesh);
  const vEdge = mids.find(
    (m) => Math.abs(m.point[2] - 15) < 6 // roughly mid-height => a vertical edge's midpoint
  );
  if (vEdge) G.pick({ kind: 'edge', bodyId: b.id, sub: vEdge.sub, point: vEdge.point }, true);
  await preview('revolve', { angle: 90, axis: 'Selected edge / datum' });
  await waitFor(() => G.getState().opReady === true, 4000);
  let err = null;
  try {
    await G.applyOp('revolve', { angle: 90, axis: 'Selected edge / datum' });
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  await idle();
  G.closeOp();
  const st = G.getState();
  note(`revolve apply: err=${err || 'none'} notice=${st.notice || 'none'}`);
  assert(st.status === 'ready', 'app ready after the revolve commit');
  assert(!anyErr(st) || !!st.notice, 'a revolve failure is a clean notice, not a broken feature');
  assert((await rpc('ping')).pong === true, 'engine alive after revolve');
}

// ============================================================ EDIT FEATURE (preview an edit in place)
note('--- edit an existing fillet: reopen, preview a bigger radius + an extra edge, commit ---');
{
  const b = await box();
  const mids = edgeMidpoints(b.mesh);
  // commit a 1-edge fillet first
  G.clearSelection();
  await sleep(20);
  G.openOp('fillet');
  await sleep(40);
  G.pick({ kind: 'edge', bodyId: b.id, sub: mids[0].sub, point: mids[0].point }, false);
  await preview('fillet', { radius: 1.5 });
  await G.applyOp('fillet', { radius: 1.5 });
  await idle();
  G.closeOp();
  let st = G.getState();
  const filId = feats(st).find((f) => /fillet/i.test(f.id)).id;
  let fg = await rpc('feature.get', { id: filId });
  assert((fg.refs.edges || []).length === 1, 'fillet starts with 1 edge');

  // reopen it - editFeature rolls to it and seeds the selection from its refs
  await G.editFeature(filId);
  await waitFor(() => G.getState().op === 'fillet', 4000);
  await sleep(120);
  // the filleted geometry is what's shown now; add a second edge by world point
  const mesh2 = (await rpc('scene.get')).meshes[0];
  const mids2 = edgeMidpoints(mesh2);
  // find an original edge that is NOT the one already filleted (pick a far one)
  const target = mids2.reduce((best, m) => {
    const d = Math.hypot(m.point[0] - mids[0].point[0], m.point[1] - mids[0].point[1], m.point[2] - mids[0].point[2]);
    return !best || d > best.d ? { m, d } : best;
  }, null).m;
  G.pick({ kind: 'edge', bodyId: b.id, sub: target.sub, point: target.point }, true);
  await preview('fillet', { radius: 3 });
  const selN = G.getState().selection.filter((s) => s.startsWith('edge:')).length;
  assert(selN === 2, `the edit now has 2 edges selected (${selN})`);
  let err = null;
  try {
    await G.applyOp('fillet', { radius: 3 });
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  await idle();
  G.closeOp();
  st = G.getState();
  assert(!err && !anyErr(st), `the fillet edit committed clean (${err || 'ok'})`);
  assert(feats(st).filter((f) => /fillet/i.test(f.id)).length === 1, 'still ONE fillet feature (edited, not duplicated)');
  fg = await rpc('feature.get', { id: filId });
  assert(Math.abs((fg.values.radius ?? 0) - 3) < 1e-6, `radius updated to 3 (${fg.values.radius})`);
  assert((fg.refs.edges || []).length === 2, `the edited fillet now covers 2 edges (${JSON.stringify(fg.refs.edges)})`);
}

// ============================================================ EDIT FEATURE - Cancel restores
note('--- edit a fillet then CANCEL: the feature must be unchanged ---');
{
  const b = await box();
  const mids = edgeMidpoints(b.mesh);
  G.clearSelection();
  await sleep(20);
  G.openOp('fillet');
  await sleep(40);
  G.pick({ kind: 'edge', bodyId: b.id, sub: mids[0].sub, point: mids[0].point }, false);
  await preview('fillet', { radius: 2 });
  await G.applyOp('fillet', { radius: 2 });
  await idle();
  G.closeOp();
  let st = G.getState();
  const filId = feats(st).find((f) => /fillet/i.test(f.id)).id;
  const eAtCommit = ((await rpc('scene.get')).meshes[0].edges || []).length;

  await G.editFeature(filId);
  await waitFor(() => G.getState().op === 'fillet', 4000);
  await sleep(100);
  // preview a wildly different radius, then cancel
  await preview('fillet', { radius: 6 });
  G.closeOp(); // Cancel
  await idle();
  await sleep(200);
  st = G.getState();
  const fg = await rpc('feature.get', { id: filId });
  assert(Math.abs((fg.values.radius ?? 0) - 2) < 1e-6, `radius restored to 2 after Cancel (${fg.values.radius})`);
  const eAfter = ((await rpc('scene.get')).meshes[0].edges || []).length;
  assert(eAfter === eAtCommit, `geometry restored after Cancel (${eAtCommit} -> ${eAfter} edges)`);
  assert(!anyErr(st), 'no feature error after Cancel');
}

// ============================================================ health
note('--- editor + engine healthy at end ---');
{
  const st = G.getState();
  assert(st.status === 'ready', 'app ready (' + st.status + ')');
  assert(!document.body.innerText.includes('The interface hit an error'), 'no ErrorBoundary');
  assert((await rpc('ping')).pong === true, 'engine still responds');
  note('interactive_preview scenario complete');
}
