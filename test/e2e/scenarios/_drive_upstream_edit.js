/* Manual driver (--drive): reproduces the "edit an upstream feature breaks
 * downstream stuff" problem reported 2026-09-22 - builds a realistic
 * multi-feature part (sketch -> extrude -> fillet 4 edges -> sketch on a
 * face -> extrude a boss), then edits the FIRST extrude's length via the
 * real editFeatureDim path (same one "Edit Value..." in the tree uses) and
 * checks what happens to every downstream feature: does it recompute
 * cleanly, does the fillet survive (its edges will have moved), does the
 * face-sketch's plane still resolve, is there any way to see/fix a broken
 * feature short of deleting and redoing everything. */

note('--- dismiss the first-run welcome dialog ---');
for (let i = 0; i < 5; i++) {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    /^Next$|^Start using GWT-CAD$/.test(b.textContent || '')
  );
  if (!btn) break;
  btn.click();
  await sleep(150);
}

note('--- base sketch + extrude (this is the one we will edit later) ---');
await rpc('session.reset');
await G.refresh();
await idle();
const s0 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: s0.sketchId,
  elements: [{ type: 'rect', a: [0, 0], b: [60, 40] }],
  constraints: []
});
await G.refresh();
await idle();
G.selectSketch(s0.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 20 });
await idle();

let state = await rpc('tree.get', {});
const padId = state.bodies[0].features.find((f) => f.kind === 'solid').id;
note('base pad: ' + padId);

note('--- fillet 4 vertical edges (the classic case that breaks on upstream edits - topological renumbering) ---');
const sc = await rpc('scene.get', {});
const box = sc.meshes[0];
const vEdges = box.edges.filter((e) => Math.abs(e.points[2] - e.points[5]) > 1);
note('vertical edges found: ' + vEdges.length);
const edgeNames = vEdges.map((e) => 'Edge' + (e.edge + 1));
const points = vEdges.map((e) => [
  (e.points[0] + e.points[3]) / 2,
  (e.points[1] + e.points[4]) / 2,
  (e.points[2] + e.points[5]) / 2
]);
await rpc('feature.fillet', { edges: edgeNames, radius: 4, points });
await idle();

state = await rpc('tree.get', {});
note('after fillet: ' + JSON.stringify(state.bodies[0].features.map((f) => ({ id: f.id, kind: f.kind, error: f.error }))));
const filletId = state.bodies[0].features.find((f) => f.kind === 'dressup' || /fillet/i.test(f.label || f.opType || '')).id;

note('--- sketch on the TOP face of the filleted body, extrude a boss ---');
const sc2 = await rpc('scene.get', {});
const topFaceBody = sc2.meshes[0];
// top face group = the one whose triangle Z is at the pad's max Z (20)
const s1 = await rpc('sketch.on', { ref: { kind: 'face', bodyId: topFaceBody.id, sub: 'Face2' } });
note('face sketch: ' + JSON.stringify(s1).slice(0, 200));
if (s1.sketchId) {
  await rpc('sketch.finish', {
    sketchId: s1.sketchId,
    elements: [{ type: 'circle', c: [30, 20], r: 8 }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.selectSketch(s1.sketchId);
  await sleep(40);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10 });
  await idle();
}

state = await rpc('tree.get', {});
note('full tree before upstream edit: ' + JSON.stringify(state.bodies[0].features.map((f) => ({ id: f.id, kind: f.kind, opType: f.opType, error: f.error, errorText: f.errorText }))));
const errorsBefore = state.bodies[0].features.filter((f) => f.error).length;
assert(errorsBefore === 0, 'clean part before any upstream edit (0 errors, got ' + errorsBefore + ')');

note('--- THE ACTUAL TEST: change the FIRST extrude length via the REAL UI (right-click the timeline chip -> Edit Value... -> real prompt dialog) so editFeatureDim\'s new error-detection notice gets exercised ---');
const chip = Array.from(document.querySelectorAll('.tl-chip')).find((c) => c.textContent && c.textContent.includes('Extrude1'));
assert(!!chip, 'found the Extrude1 timeline chip');
chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
await sleep(150);
const editValueItem = Array.from(document.querySelectorAll('button, div, li, span')).find((el) => el.textContent === 'Edit Value…');
assert(!!editValueItem, 'found "Edit Value..." in the context menu');
if (editValueItem) editValueItem.click();
await sleep(200);
const dlg = document.querySelector('.prompt-dialog');
note('prompt dialog present: ' + !!dlg);
if (dlg) {
  const input = dlg.querySelector('input');
  if (input) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '35');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const submitBtn = dlg.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.click();
}
await sleep(500);

const hint = document.querySelector('.hintbar');
note('notice hintbar after the real UI edit: ' + (hint ? hint.textContent : null));
assert(!!hint && /failed to recompute/.test(hint.textContent), 'a notice fired telling the user something broke downstream');

state = await rpc('tree.get', {});
const featStates = state.bodies[0].features.map((f) => ({ id: f.id, kind: f.kind, opType: f.opType, error: f.error, errorText: f.errorText }));
note('full tree AFTER upstream edit: ' + JSON.stringify(featStates));
const errorsAfter = featStates.filter((f) => f.error).length;
note('features in error state after the edit: ' + errorsAfter);

const sceneAfter = await rpc('scene.get', {});
note('mesh count after edit: ' + sceneAfter.meshes.length);
const bodyMesh = sceneAfter.meshes.find((m) => m.id === state.bodies[0].id || m.label === 'Body');
note('body mesh bbox after edit: ' + JSON.stringify(bodyMesh ? bodyMesh.bbox : null));

note('--- can the user actually RECOVER from the broken Fillet today? try feature.get + re-pick ---');
const brokenFillet = featStates.find((f) => f.error);
assert(!!brokenFillet, 'confirmed a feature is broken (the Fillet, per topological-naming breakage)');
if (brokenFillet) {
  const fg = await rpc('feature.get', { id: brokenFillet.id }).catch((e) => ({ error: String(e) }));
  note('feature.get on the broken fillet: ' + JSON.stringify(fg));

  // if feature.get worked, try the real recovery flow: re-pick the SAME
  // logical edges (now under whatever new Edge* names the changed pad
  // gives them) via points, same as a live dress-up preview would.
  const sc3 = await rpc('scene.get', {});
  const bodyMesh2 = sc3.meshes.find((m) => m.id === 'Body');
  note('current body mesh present: ' + !!bodyMesh2 + ' bbox: ' + JSON.stringify(bodyMesh2 ? bodyMesh2.bbox : null));
  if (bodyMesh2) {
    const vEdges2 = bodyMesh2.edges.filter((e) => Math.abs(e.points[2] - e.points[5]) > 1);
    const edgeNames2 = vEdges2.map((e) => 'Edge' + (e.edge + 1));
    const points2 = vEdges2.map((e) => [
      (e.points[0] + e.points[3]) / 2,
      (e.points[1] + e.points[4]) / 2,
      (e.points[2] + e.points[5]) / 2
    ]);
    const repick = await rpc('feature.previewSetBase', { id: brokenFillet.id, subs: edgeNames2, points: points2 }).catch((e) => ({ error: String(e) }));
    note('re-pick via feature.previewSetBase result: ' + JSON.stringify(repick).slice(0, 300));
  }

  const stateFinal = await rpc('tree.get', {});
  const finalErrors = stateFinal.bodies[0].features.filter((f) => f.error);
  note('errors after attempted re-pick recovery: ' + JSON.stringify(finalErrors));
}

note('--- leave state up for inspection ---');
await sleep(200);
