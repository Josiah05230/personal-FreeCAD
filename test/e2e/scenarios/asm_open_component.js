/* Right-click a component in an assembly's tree -> "Open in new tab": the
 * part opens in its own tab, the assembly's tab stays; leaving the part's
 * tab SAVES it, and the assembly shows the change when you come back. */

const DIR = '/tmp/gwtcad_asmcomp_' + Date.now();
await window.cad.mkdir(DIR);
const PART = DIR + '/part.FCStd';
const ASM = DIR + '/asm.FCStd';
const tabs = () => G.getState().tabs;
const height = async () => {
  const bbs = (await rpc('scene.get')).meshes.filter((m) => (m.positions || []).length).map((m) => m.bbox);
  return Math.max(...bbs.map((b) => b.max[2])) - Math.min(...bbs.map((b) => b.min[2]));
};
const clickTab = (name) =>
  [...document.querySelectorAll('.doctab')].find((t) => t.querySelector('.doctab-name').textContent.trim().replace(/ \*$/, '') === name).click();

note('--- a part, and an assembly that links it ---');
await rpc('session.reset');
const s0 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', { sketchId: s0.sketchId, elements: [{ type: 'rect', a: [0, 0], b: [10, 10] }], constraints: [] });
await rpc('feature.extrude', { sketchId: s0.sketchId, length: 5 });
await rpc('document.saveAs', { path: PART });
await rpc('session.reset');
await rpc('document.saveAs', { path: ASM });
await G.openDesignPath(ASM);
await idle();
await rpc('assembly.create');
await G.addComponentFile(PART);
await G.refresh();
await idle();
await rpc('document.save');
await G.openDesignPath(ASM);
await idle();
const comp = (await rpc('assembly.tree')).components[0];
assert(!!comp && comp.linkedPath === PART, `the assembly has the part as a component (${comp && comp.linkedPath})`);
assert(Math.abs((await height()) - 5) < 1e-3, 'the assembly shows the part 5 tall');

note('--- the tree offers it: right-click the component ---');
const row = [...document.querySelectorAll('.asm-row')].find((r) => r.querySelector('.asm-name'));
assert(!!row, 'the component has a row in the Assembly section');
row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 }));
await sleep(80);
const item = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === 'Open in new tab');
assert(!!item, 'its right-click menu has "Open in new tab"');

note('--- open it in a new tab ---');
G.autosaveConfig({ enabled: true }); // save-on-leave, as outside the test harness
item.click();
await waitFor(() => G.getState().docPath === PART, 8000);
await idle();
assertEq(G.getState().docPath, PART, 'the part is on screen');
assertEq(tabs().map((t) => [t.path, t.active]), [[ASM, false], [PART, true]], 'in its own tab; the assembly tab is still there');

note('--- change the part, then just click back to the assembly ---');
const pad = G.getState().bodies[0].features.find((f) => f.kind === 'solid').id;
await G.editFeature(pad);
await waitFor(() => G.getState().op === 'extrude', 4000);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 25 });
await idle();
assert(tabs().find((t) => t.path === PART).name !== undefined, 'part edited');
clickTab('asm.FCStd');
await waitFor(() => G.getState().docPath === ASM, 10000);
await idle();
assertEq(G.getState().docPath, ASM, 'back on the assembly');
assert(Math.abs((await height()) - 25) < 1e-3, `THE POINT: the assembly shows the edited part, 25 tall (${await height()})`);

note('--- and the part file itself was saved by leaving its tab ---');
await rpc('session.reset');
await rpc('document.open', { path: PART });
await G.refresh();
await idle();
assert(Math.abs((await height()) - 25) < 1e-3, 'the part on disk is 25 tall');
