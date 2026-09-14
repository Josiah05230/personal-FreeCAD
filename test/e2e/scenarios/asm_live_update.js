/* Does the assembly actually pick up a change to a linked sub-part's file
 * on disk? Build a part, save it, bring it into an assembly, close
 * everything, edit the part FILE independently (a real separate save, not
 * kept open in the same session), reopen the assembly, and check whether
 * the change shows up. This is the actual mechanism behind "if the part is
 * updated, it updates in the assembly" - verified live, not assumed. */

const PART_PATH = '/tmp/gwtcad_asm_test/part.FCStd';
const ASM_PATH = '/tmp/gwtcad_asm_test/asm.FCStd';

note('--- assembly: does editing a linked sub-part on disk propagate on reopen? ---');

// build + save the sub-part: a 10x10x5 block
await rpc('session.reset');
await G.refresh();
await idle();
const s0 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: s0.sketchId,
  elements: [{ type: 'rect', a: [0, 0], b: [10, 10] }],
  constraints: []
});
await G.refresh();
await idle();
G.selectSketch(s0.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 5 });
await idle();
const padId = G.getState().bodies[0].features.find((f) => f.kind === 'solid').id;
await rpc('document.saveAs', { path: PART_PATH });
await G.refresh();
await idle();
const partBbox1 = (await rpc('scene.get')).meshes[0].bbox;
note('part bbox before edit: ' + JSON.stringify(partBbox1));

// build the assembly, bring the part in as a real linked component
await rpc('session.reset');
await G.refresh();
await idle();
await rpc('document.saveAs', { path: ASM_PATH });
await G.refresh();
await idle();
await rpc('assembly.create');
await G.addComponentFile(PART_PATH);
await G.refresh();
await idle();
const treeAfterAdd = await rpc('assembly.tree');
assert(treeAfterAdd.components.length === 1, 'component linked into the assembly (' + JSON.stringify(treeAfterAdd) + ')');
await rpc('document.save');
await idle();

// close everything in THIS session (simulating the app being closed)
await rpc('session.reset');
await idle();

// independently reopen the PART, extend its extrude length, save - a real,
// separate edit to the linked file
await rpc('document.open', { path: PART_PATH });
await G.refresh();
await idle();
await G.editFeature(padId);
await waitFor(() => G.getState().op === 'extrude', 4000);
assert(G.getState().op === 'extrude', 'reopened the extrude feature for editing (op=' + G.getState().op + ')');
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 25 });
await idle();
await rpc('document.save');
await idle();
const partBbox2 = (await rpc('scene.get')).meshes[0].bbox;
note('part bbox after edit (still in the part session): ' + JSON.stringify(partBbox2));
assert(
  Math.abs(partBbox2.max[2] - partBbox2.min[2] - 25) < 1,
  'sanity: the part itself really is now 25 units tall, not 5'
);

// close the part, reopen the ASSEMBLY - does it reflect the new length?
await rpc('session.reset');
await idle();
await rpc('document.open', { path: ASM_PATH });
await G.refresh();
await idle();
const treeAfterReopen = await rpc('assembly.tree');
assert(treeAfterReopen.components.length === 1, 'component still present after reopening the assembly');

const asmScene2 = await rpc('scene.get');
note('assembly scene mesh count after reopen: ' + asmScene2.meshes.length);
const linkedBbox = asmScene2.meshes[0]?.bbox;
note('linked component bbox after reopening the assembly: ' + JSON.stringify(linkedBbox));
if (linkedBbox) {
  const zExtent = linkedBbox.max[2] - linkedBbox.min[2];
  note('Z extent of the linked component after reopening the assembly: ' + zExtent);
  assert(
    Math.abs(zExtent - 25) < 1,
    `REAL FINDING: the assembly's linked component reflects the part's EDITED length on reopen (expected ~25, got ${zExtent})`
  );
}

note('--- done ---');
