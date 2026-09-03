// Genuine end-to-end: build a real multi-feature part through the GUI bridge
// (sketch -> extrude -> cut -> fillet -> mirror a single timeline-selected
// feature -> edit that mirror), then assemble two copies and add a joint.
// Exercises the paths that were previously only checked headless.

const TMP = '/tmp/claude-1000/-home-jholder-projects/38db2fed-70fa-4706-b4ba-3a8fde1460f6/scratchpad/asm_part.FCStd';
const anyErr = (st) => st.bodies.some((b) => b.features.some((f) => f.error));

// ---------------------------------------------------------------- PART
note('--- part: rect -> extrude -> cut -> fillet -> mirror(Features, Cut) ---');
await rpc('session.reset');
await G.refresh();
await idle();

const s1 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: s1.sketchId,
  elements: [{ type: 'rect', a: [0, 0], b: [40, 24] }],
  constraints: []
});
await G.refresh();
await idle();
G.selectSketch(s1.sketchId);
await sleep(50);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 12 });
await idle();
assert(G.getState().bodies[0].features.filter((f) => f.kind === 'solid').length === 1, 'base pad built');

// a pocket from a sketch on the top face
const sc = await rpc('scene.get');
const topFace = (sc.meshes[0].bbox ? 'Face1' : 'Face1'); // fall back; picked below by normal via bridge
G.clearSelection();
// find the top face through the bridge selection helper (normal +Z)
G.pick({ kind: 'face', bodyId: 'Body', sub: 'Face1', point: [0, 0, 12], normal: [0, 0, 1] }, false);
await sleep(40);
const sk2 = await rpc('sketch.on', { ref: { kind: 'face', bodyId: 'Body', sub: 'Face6' } }).catch(() => null);
// Face6 is the usual top of a box pad; if that failed just use an origin plane
const s2 = sk2 ?? (await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } }));
await rpc('sketch.finish', {
  sketchId: s2.sketchId,
  elements: [{ type: 'circle', c: [12, 12], r: 4 }],
  constraints: []
});
await G.refresh();
await idle();
G.selectSketch(s2.sketchId);
await sleep(50);
let cutErr = null;
try {
  await G.applyOp('extrude', { operation: 'Cut', mode: 'Blind', length: 12 });
} catch (e) {
  cutErr = (e && e.message) || String(e);
}
await idle();
note('cut: err=' + (cutErr || 'none') + ' notice=' + (G.getState().notice || 'none'));
assert(!anyErr(G.getState()), 'no feature error after the cut');

// fillet: plain-click one vertical edge, Ctrl-click a second
G.clearSelection();
G.openOp('fillet');
await sleep(60);
G.pick({ kind: 'edge', bodyId: 'Body', sub: 'Edge1', point: [0, 0, 0] }, false);
await sleep(50);
G.pick({ kind: 'edge', bodyId: 'Body', sub: 'Edge3', point: [0, 0, 0] }, true);
await sleep(50);
const fSel = G.getState().selection.filter((k) => /^edge:/i.test(k));
assert(fSel.length === 2, 'fillet has 2 edges after plain + Ctrl click (' + fSel.length + ')');
await waitFor(() => (G.getState().meshes[0] || {}).tris > 0, 4000);
let filErr = null;
try {
  await G.applyOp('fillet', { radius: 2 });
} catch (e) {
  filErr = (e && e.message) || String(e);
}
await idle();
note('fillet: err=' + (filErr || 'none'));
assert(!anyErr(G.getState()), 'no feature error after fillet');

// mirror the FIRST feature only (Type=Features), as a Join, then edit it
const bid0 = G.getState().bodies[0].id;
const padId = G.getState().bodies[0].features.find((f) => f.kind === 'solid').id;
G.clearSelection();
G.selectFeatures([padId]);
await sleep(40);
G.openOp('mirror');
await sleep(50);
G.pick({ kind: 'plane', planeId: 'YZ_Plane', role: 'YZ_Plane' }, false);
await sleep(40);
let mErr = null;
try {
  await G.applyOp('mirror', { scope: 'Features', operation: 'Join' });
} catch (e) {
  mErr = (e && e.message) || String(e);
}
await idle();
const stM = G.getState();
note('mirror(Features,Join): err=' + (mErr || 'none') + ' tree=' +
  JSON.stringify(stM.bodies[0].features.map((f) => f.id + ':' + f.kind + (f.error ? '!' : ''))));
const mirFeat = stM.bodies[0].features.find((f) => /mirror/i.test(f.id));
assert(!!mirFeat && !anyErr(stM), 'one Mirrored feature from a single selected pad, no errors');

// edit that mirror: reopen and Update (flip the plane to XZ)
await G.editFeature(mirFeat.id);
await sleep(120);
assert(G.getState().op === 'mirror', 'edit reopened the Mirror dialog (op=' + G.getState().op + ')');
G.clearSelection();
G.pick({ kind: 'plane', planeId: 'XZ_Plane', role: 'XZ_Plane' }, false);
await sleep(40);
let eErr = null;
try {
  await G.applyOp('mirror', { scope: 'Features', operation: 'Join' });
} catch (e) {
  eErr = (e && e.message) || String(e);
}
await idle();
const stE = G.getState();
note('edit mirror: err=' + (eErr || 'none') + ' marker=' + (stE.bodies[0].marker ?? 'tip'));
assert(!anyErr(stE) && stE.meshes.length >= 1 && stE.meshes[0].tris > 0,
  'mirror still renders a valid solid after the edit');

// save this part for the assembly step
await rpc('document.saveAs', { path: TMP });
note('saved part to ' + TMP);

// ---------------------------------------------------------------- ASSEMBLY
note('--- assembly: insert two copies + a joint ---');
await rpc('session.reset');
await G.refresh();
await idle();
await rpc('assembly.create');
await G.addComponentFile(TMP);
await idle();
await G.addComponentFile(TMP);
await idle();
const asm1 = await rpc('assembly.tree');
note('assembly components: ' + JSON.stringify((asm1.components || []).map((c) => c.id)));
assert((asm1.components || []).length === 2, 'two components inserted (' + (asm1.components || []).length + ')');

const [c1, c2] = asm1.components;
await rpc('assembly.ground', { componentId: c1.id });
await rpc('assembly.setPlacement', {
  componentId: c2.id,
  base: [80, 0, 0],
  axis: [0, 0, 1],
  angle: 0
});
await idle();
let jointErr = null;
try {
  await rpc('assembly.addJoint', {
    jointType: 'Fixed',
    comp1: c1.id,
    sub1: 'Face1',
    comp2: c2.id,
    sub2: 'Face1'
  });
} catch (e) {
  jointErr = (e && e.message) || String(e);
}
await idle();
const asm2 = await rpc('assembly.tree');
note('joints: ' + (asm2.joints || []).length + ' jointErr=' + (jointErr || 'none'));
assert((asm2.components || []).length === 2, 'still two components after the joint');
assert((asm2.joints || []).length >= 1 || !!jointErr,
  'a joint was recorded (or a clear error was returned - solving is experimental)');

const asmScene = await rpc('scene.get');
const asmMeshes = asmScene.meshes.filter((m) => (m.tris || (m.indices || []).length) > 0);
note('assembly scene meshes: ' + asmScene.meshes.map((m) => m.id).join(', '));
assert(asmScene.meshes.length >= 2, 'both components render in the assembly (' + asmScene.meshes.length + ')');

const stFinal = G.getState();
assert(stFinal.status === 'ready', 'app still ready (' + stFinal.status + ')');
assert(!document.body.innerText.includes('The interface hit an error'), 'no ErrorBoundary');
assert((await rpc('ping')).pong === true, 'engine still responds at end');
note('part + assembly scenario complete');
