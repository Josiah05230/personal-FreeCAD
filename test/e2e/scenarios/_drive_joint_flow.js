/* Manual driver (--drive): verifies the new Creo-style guided joint flow
 * end to end: build two saved part files, assemble them, run the ribbon's
 * Joint command, pick a real face on each component via actual pointer
 * events, confirm the geometry-based suggestion appears, accept it, and
 * check the joint round-trips through drawing.pageContents-equivalent
 * (assembly.tree). Also checks the Assembly tree section renders (not a
 * floating panel) and doesn't overlap the ViewCube. */

function fire(el, type, x, y, extra) {
  const opts = Object.assign(
    { pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0 },
    extra || {}
  );
  el.dispatchEvent(new PointerEvent(type, opts));
}

note('--- dismiss the first-run welcome dialog ---');
for (let i = 0; i < 5; i++) {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    /^Next$|^Start using GWT-CAD$/.test(b.textContent || '')
  );
  if (!btn) break;
  btn.click();
  await sleep(150);
}

note('--- build and save two separate box parts ---');
await rpc('session.reset');
let s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', { sketchId: s.sketchId, elements: [{ type: 'rect', a: [0, 0], b: [40, 30] }], constraints: [] });
await G.refresh();
await idle();
G.selectSketch(s.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 12 });
await idle();
await rpc('document.saveAs', { path: '/tmp/gwtcad-scratch/JointPartA.FCStd' });

await rpc('session.reset');
s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', { sketchId: s.sketchId, elements: [{ type: 'rect', a: [0, 0], b: [20, 20] }], constraints: [] });
await G.refresh();
await idle();
G.selectSketch(s.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 8 });
await idle();
await rpc('document.saveAs', { path: '/tmp/gwtcad-scratch/JointPartB.FCStd' });

note('--- fresh session, assemble both parts (offset apart - add_component places everything at the origin, which would leave B hidden inside A) ---');
await rpc('session.reset');
const addedA = await rpc('assembly.addComponent', { path: '/tmp/gwtcad-scratch/JointPartA.FCStd' });
const addedB = await rpc('assembly.addComponent', { path: '/tmp/gwtcad-scratch/JointPartB.FCStd' });
note('addedA: ' + JSON.stringify(addedA).slice(0, 200));
const idA = addedA.components[addedA.components.length - 1].id;
const idB = addedB.components[addedB.components.length - 1].id;
await rpc('assembly.setPlacement', { componentId: idB, base: [60, 0, 0], axis: [0, 0, 1], angle: 0 });
await G.refresh();
await idle();
await sleep(300);

const tr1 = await rpc('assembly.tree', {});
note('assembly tree: ' + JSON.stringify(tr1));
assert(tr1.components.length === 2, 'both components are in the assembly (got ' + tr1.components.length + ')');
const [compA, compB] = tr1.components;

note('--- the Assembly section should be a tree row, not a floating panel over the ViewCube ---');
const asmFloating = document.querySelector('.asmpanel');
assert(!asmFloating, 'no leftover floating .asmpanel element exists');
const asmTreeSection = Array.from(document.querySelectorAll('.br-label')).find((el) => el.textContent === 'Assembly');
assert(!!asmTreeSection, 'found an "Assembly" row in the Browser tree');
const viewCube = document.querySelector('.viewcube');
const vcBB = viewCube ? viewCube.getBoundingClientRect() : null;
const asmBB = asmTreeSection ? asmTreeSection.closest('.br-node').getBoundingClientRect() : null;
note('viewcube bbox: ' + JSON.stringify(vcBB) + ' assembly row bbox: ' + JSON.stringify(asmBB));
const overlaps = vcBB && asmBB && !(asmBB.right < vcBB.left || asmBB.left > vcBB.right || asmBB.bottom < vcBB.top || asmBB.top > vcBB.bottom);
assert(!overlaps, 'the Assembly tree row does not overlap the ViewCube');

note('--- run the Joint command from the ribbon ---');
G.runCommand('asm.joint');
await sleep(200);
const hint1 = document.querySelector('.hintbar');
note('hint after starting Joint: ' + (hint1 ? hint1.textContent : null));
assert(!!hint1 && /FIRST component/.test(hint1.textContent), 'a status hint asks to pick a reference on the first component');

note('--- pick a face on component A, then component B, via real pointer events at their PROJECTED screen positions ---');
// there are TWO <canvas> elements under .viewport (the main viewport's
// three.js renderer, appended directly to the .viewport host div, AND the
// ViewCube's own separate mini three.js scene, nested inside .viewcube-wrap
// which is ALSO a child of .viewport) - ".viewport canvas" matches both and
// silently grabbed the tiny ViewCube one first, so no pointerdown ever
// reached the real viewport's listener. Exclude anything under .viewcube-wrap.
const canvas = Array.from(document.querySelectorAll('.viewport canvas')).find(
  (c) => !c.closest('.viewcube-wrap')
);
assert(!!canvas, 'found the main 3D viewport canvas (not the ViewCube\'s)');
G.fit();
await sleep(150);

// each component's own top-face centre in world space: placement base +
// (half its known footprint in X/Y, full height in Z) - close enough to
// land ON the body (not empty space) for a raycast pick regardless of
// which face resolves, since we only need SOME face on each component.
const topOfA = [tr1.components[0].placement.base[0] + 20, tr1.components[0].placement.base[1] + 15, tr1.components[0].placement.base[2] + 12];
const topOfB = [tr1.components[1].placement.base[0] + 10, tr1.components[1].placement.base[1] + 10, tr1.components[1].placement.base[2] + 8];
const scrA = G.projectToScreen(topOfA);
const scrB = G.projectToScreen(topOfB);
note('projected screen points: A=' + JSON.stringify(scrA) + ' B=' + JSON.stringify(scrB));
assert(!!scrA && !!scrB, 'both components project to on-screen points');

const elAtA = document.elementFromPoint(scrA.x, scrA.y);
note('element at A\'s projected point: ' + (elAtA ? elAtA.tagName + '.' + elAtA.className : null) + ' === canvas? ' + (elAtA === canvas));
const cbb0 = canvas.getBoundingClientRect();
note('canvas bbox: ' + JSON.stringify(cbb0));

fire(canvas, 'pointerdown', scrA.x, scrA.y);
fire(canvas, 'pointerup', scrA.x, scrA.y);
await sleep(200);
const hint2 = document.querySelector('.hintbar');
note('hint after first pick: ' + (hint2 ? hint2.textContent : null));
assert(!!hint2 && /second/.test(hint2.textContent), 'status hint moved on to asking for the second component (got: ' + (hint2 ? hint2.textContent : 'none') + ')');

fire(canvas, 'pointerdown', scrB.x, scrB.y);
fire(canvas, 'pointerup', scrB.x, scrB.y);
await sleep(400);

const confirmBar = document.querySelector('.asm-jointconfirm');
note('confirm bar present: ' + !!confirmBar + (confirmBar ? ' text: ' + confirmBar.textContent : ''));
assert(!!confirmBar, 'a constraint-type confirm bar appeared after both references were picked');

const createBtn = confirmBar && Array.from(confirmBar.querySelectorAll('button')).find((b) => b.textContent === 'Create');
assert(!!createBtn, 'found the Create button');
if (createBtn) {
  createBtn.click();
  await sleep(400);
}

const tr2 = await rpc('assembly.tree', {});
note('assembly tree after joint creation: ' + JSON.stringify(tr2.joints));
assert(tr2.joints.length === 1, 'exactly one joint was created (got ' + tr2.joints.length + ')');

const gone = !document.querySelector('.hintbar') && !document.querySelector('.asm-jointconfirm');
assert(gone, 'the joint-flow UI cleared itself after creating the joint');

note('--- leave state up for inspection via screenshot ---');
await sleep(200);
