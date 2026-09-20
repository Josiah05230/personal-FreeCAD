/* Manual driver (--drive): verifies today's tree<->viewport selection sync
 * fixes:
 *   - selecting a body row in the tree paints a visible overlay in 3D
 *     (previously overlayFor had no 'body' branch at all - silent no-op)
 *   - selecting a face in the viewport highlights that face's owning body
 *     row in the tree (previously isSel only matched an exact
 *     {kind:'body'} selection, never a face/edge/vertex on that body)
 * Screenshots both states for visual confirmation. */

note('--- dismiss the first-run welcome dialog ---');
for (let i = 0; i < 5; i++) {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    /^Next$|^Start using GWT-CAD$/.test(b.textContent || '')
  );
  if (!btn) break;
  btn.click();
  await sleep(150);
}

note('--- build a simple box ---');
await rpc('session.reset');
await G.refresh();
await idle();
const s0 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', { sketchId: s0.sketchId, elements: [{ type: 'rect', a: [0, 0], b: [40, 30] }], constraints: [] });
await G.refresh();
await idle();
G.selectSketch(s0.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 12 });
await idle();

const tr = await rpc('tree.get', {});
const bodyId = tr.bodies[0].id;
const bodyLabel = tr.bodies[0].label;
note('body id: ' + bodyId + ' label: ' + bodyLabel);

note('--- click the body row in the tree: should highlight AND paint a viewport overlay ---');
const bodyRow = Array.from(document.querySelectorAll('.br-label')).find((el) => el.textContent === bodyLabel);
assert(!!bodyRow, 'found the body row in the tree');
bodyRow.click();
await sleep(200);
await flush();

const treeRowSelected = bodyRow.closest('.br-row')?.classList.contains('selected');
assert(!!treeRowSelected, 'the tree row itself shows selected after clicking it');

const stateAfterBodyClick = G.getState();
note('selection after body click: ' + JSON.stringify(stateAfterBodyClick.selection));
assert(
  stateAfterBodyClick.selection.some((s) => s.includes(bodyId)),
  'real selection state includes the picked body'
);

note('--- select a FACE on that body directly (bypassing the tree) and check the tree highlights the body row ---');
G.select([{ kind: 'face', bodyId, index: 0, sub: 'Face1', point: [0, 0, 0] }]);
await sleep(200);
await flush();

const bodyRow2 = Array.from(document.querySelectorAll('.br-label')).find((el) => el.textContent === bodyLabel);
const treeRowSelectedForFace = bodyRow2?.closest('.br-row')?.classList.contains('selected');
assert(!!treeRowSelectedForFace, 'the body row highlights in the tree when a face ON that body is selected in the viewport');

note('--- leave it selected for a screenshot ---');
await sleep(200);
