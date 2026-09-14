/* Git-based version pinning for assembly sub-components: lock a component
 * to a specific commit (never moves regardless of what the source repo's
 * working tree does later), track a branch's tip live (re-resolved on
 * refresh/reopen), and detect drift (source has moved since the pin).
 *
 * The part file lives inside a REAL git repo so this can commit multiple
 * genuine versions and pin across them - not a synthetic reconstruction.
 * Git repo scaffolding (init, branches, commits) is set up via real `git`
 * calls outside the renderer (this file only sets up FIXTURE STATE, same
 * as asm_live_update.js's file-system setup); everything the app itself
 * does - resolving a pin, linking, drift detection - goes through the real
 * window.cad bridge / RPC, the same surface the real UI uses. */

const REPO = '/tmp/gwtcad_asm_pin_test/part_repo';
const PART_PATH = REPO + '/part.FCStd';
const ASM_PATH = '/tmp/gwtcad_asm_pin_test/asm/asm.FCStd';

note('--- assembly: git-based commit lock + branch tracking + drift detection ---');

async function buildPart(heightZ) {
  await rpc('session.reset');
  await G.refresh();
  await idle();
  const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: s.sketchId,
    elements: [{ type: 'rect', a: [0, 0], b: [10, 10] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.selectSketch(s.sketchId);
  await sleep(40);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: heightZ });
  await idle();
}

async function gitCommit(msg) {
  await window.cad.gitAdd(PART_PATH, ['part.FCStd']);
  const r = await window.cad.gitCommit(PART_PATH, msg);
  return r.hash;
}

// --- v1: 5 tall, committed on main ---
await buildPart(5);
await rpc('document.saveAs', { path: PART_PATH });
await G.refresh();
await idle();
const v1Hash = await gitCommit('v1: 5 tall');
note('v1 commit: ' + v1Hash);
assert(!!v1Hash, 'v1 committed on main');

// --- v2: 25 tall, committed on main (moves the working tree AND main's tip) ---
await buildPart(25);
await rpc('document.saveAs', { path: PART_PATH });
await G.refresh();
await idle();
const v2Hash = await gitCommit('v2: 25 tall');
note('v2 commit: ' + v2Hash);
assert(v2Hash !== v1Hash, 'v2 is a distinct commit from v1');

// --- build the assembly, lock the component to the v1 COMMIT (not main's tip) ---
await rpc('session.reset');
await G.refresh();
await idle();
await rpc('document.saveAs', { path: ASM_PATH });
await G.refresh();
await idle();
await rpc('assembly.create');
await G.addComponentFilePinned(PART_PATH, 'commit', v1Hash);
await G.refresh();
await idle();

const treeAfterPin = await rpc('assembly.tree');
assert(treeAfterPin.components.length === 1, 'pinned component linked into the assembly');
const compId = treeAfterPin.components[0].id;

const sceneAfterPin = await rpc('scene.get');
const pinnedBbox = sceneAfterPin.meshes[0]?.bbox;
note('linked geometry with commit pin=v1: ' + JSON.stringify(pinnedBbox));
assert(
  !!pinnedBbox && Math.abs(pinnedBbox.max[2] - pinnedBbox.min[2] - 5) < 1,
  `REAL FINDING: commit-pinned component resolves to v1's geometry (5 tall) even though the source repo's working tree is now at v2 (25 tall) - got Z extent ${pinnedBbox ? pinnedBbox.max[2] - pinnedBbox.min[2] : 'none'}`
);

// --- drift: the source repo has moved past the pin - was that detected? ---
const pins1 = await window.cad.asmPinRead(ASM_PATH);
note('pin record after linking: ' + JSON.stringify(pins1[compId]));
assert(pins1[compId] && pins1[compId].mode === 'commit' && pins1[compId].ref === v1Hash, 'pin persisted to the companion file with the right mode+ref');
assert(pins1[compId].drift === true, 'drift correctly detected: source repo has commits past the pinned one');

await rpc('document.save');
await idle();

// --- close everything, reopen the assembly: does the commit pin survive
//     and still resolve to v1 (immutable), NOT to whatever main is at now? ---
await rpc('session.reset');
await idle();
await rpc('document.open', { path: ASM_PATH });
await G.refresh();
await idle();
await G.refreshAssemblyPins();
await idle();

const treeAfterReopen = await rpc('assembly.tree');
assert(treeAfterReopen.components.length === 1, 'pinned component still present after reopening the assembly');
const sceneAfterReopen = await rpc('scene.get');
const reboundBbox = sceneAfterReopen.meshes[0]?.bbox;
note('linked geometry after reopen: ' + JSON.stringify(reboundBbox));
assert(
  !!reboundBbox && Math.abs(reboundBbox.max[2] - reboundBbox.min[2] - 5) < 1,
  'commit pin survives reopen and still resolves to v1 (5 tall), never moved to v2'
);

// --- branch tracking: pin a component to the "feature" branch (currently
//     sitting wherever main's tip is, since it hasn't diverged yet), then
//     advance ONLY that branch and confirm a refresh follows its new tip -
//     the defining difference from a commit pin, which must NOT move. ---
note('--- branch tracking phase ---');
await window.cad.gitCreateBranch(PART_PATH, 'feature', 'main');
await idle();

await rpc('session.reset');
await G.refresh();
await idle();
await rpc('assembly.create');
await G.addComponentFilePinned(PART_PATH, 'branch', 'feature');
await G.refresh();
await idle();

const treeBranch1 = await rpc('assembly.tree');
assert(treeBranch1.components.length === 1, 'branch-pinned component linked');
const sceneBranch1 = await rpc('scene.get');
const bbox1 = sceneBranch1.meshes[0]?.bbox;
note('branch pin geometry before advancing feature: ' + JSON.stringify(bbox1));
assert(
  !!bbox1 && Math.abs(bbox1.max[2] - bbox1.min[2] - 25) < 1,
  'branch pin initially resolves to feature tip (== main tip == v2, 25 tall)'
);

// advance ONLY the feature branch with a new commit (checkout feature,
// build+save a 30-tall part, commit) - main is untouched
await window.cad.gitCheckout(PART_PATH, 'feature');
await idle();
await buildPart(30);
await rpc('document.saveAs', { path: PART_PATH });
await G.refresh();
await idle();
const v3Hash = await gitCommit('v3 on feature: 30 tall');
note('feature advanced to: ' + v3Hash);
// leave the repo back on main so it does not interfere with anything else
// that might read the working tree later
await window.cad.gitCheckout(PART_PATH, 'main').catch(() => {});

// reopen the assembly (the earlier session.reset above dropped it out of
// memory) and refresh pins - a branch pin should follow feature's new tip
await rpc('session.reset');
await idle();
await rpc('document.open', { path: ASM_PATH });
await G.refresh();
await idle();

// note: ASM_PATH already has the earlier commit-pinned v1 component saved
// into it (line 92), so this document now holds TWO components - add the
// branch-pinned one alongside it and select scene meshes BY COMPONENT ID,
// never by array position, since mesh order is not guaranteed to match
// link-creation order.
await rpc('assembly.create');
await G.addComponentFilePinned(PART_PATH, 'branch', 'feature');
await G.refresh();
await idle();
await rpc('document.save');
await idle();

const treeWithBoth = await rpc('assembly.tree');
assert(treeWithBoth.components.length === 2, 'both the commit-pinned and branch-pinned components are present');
const newBranchCompId = treeWithBoth.components.find((c) => c.id !== compId)?.id;
assert(!!newBranchCompId, 'found the newly-added branch-pinned component by id');

await G.refreshAssemblyPins();
await idle();
const sceneBranch2 = await rpc('scene.get');
const bbox2 = sceneBranch2.meshes.find((m) => m.id === newBranchCompId)?.bbox;
note('branch pin geometry after refreshAssemblyPins (feature advanced to 30 tall): ' + JSON.stringify(bbox2));
assert(
  !!bbox2 && Math.abs(bbox2.max[2] - bbox2.min[2] - 30) < 1,
  `REAL FINDING: branch-tracked pin follows the branch's tip on refresh (expected 30 tall, got ${bbox2 ? bbox2.max[2] - bbox2.min[2] : 'none'})`
);

// the OTHER (commit-pinned) component must be completely unaffected by any
// of this - still 5 tall, still v1 - proving refreshAssemblyPins only
// touches pins whose ref has actually moved, never live/other components
const bboxUnaffected = sceneBranch2.meshes.find((m) => m.id === compId)?.bbox;
note('commit-pinned component after the branch refresh (must be untouched): ' + JSON.stringify(bboxUnaffected));
assert(
  !!bboxUnaffected && Math.abs(bboxUnaffected.max[2] - bboxUnaffected.min[2] - 5) < 1,
  'commit-pinned component is untouched by refreshAssemblyPins acting on the OTHER (branch-pinned) component'
);

const pins2 = await window.cad.asmPinRead(ASM_PATH);
const branchPinEntry = pins2[newBranchCompId];
assert(!!branchPinEntry && branchPinEntry.resolvedCommit === v3Hash, "branch pin's resolvedCommit updated to the new tip after refresh");

note('--- done ---');
