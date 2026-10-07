/* Closing the tab on screen takes its part out of the viewport: the next
 * open tab's document is shown instead, and closing the last tab opens a
 * fresh one - the closed part never stays up. */

const DIR = '/tmp/gwtcad_tabclose_' + Date.now();
await window.cad.mkdir(DIR);
const enginePath = async () => (await rpc('document.info')).path || null;
const tabs = () => G.getState().tabs;
const clickClose = (name) => {
  const tab = [...document.querySelectorAll('.doctab')].find((t) => t.querySelector('.doctab-name').textContent.trim().replace(/ \*$/, '') === name);
  tab.querySelector('.doctab-close').click();
};

async function makePart(file, len) {
  await rpc('session.reset');
  const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', { sketchId: s.sketchId, elements: [{ type: 'rect', a: [0, 0], b: [len, 10] }], constraints: [] });
  await rpc('feature.extrude', { sketchId: s.sketchId, length: 5 });
  await rpc('document.saveAs', { path: DIR + '/' + file });
}
await makePart('a.FCStd', 20);
await makePart('b.FCStd', 40);
await makePart('c.FCStd', 60);
const A = DIR + '/a.FCStd', B = DIR + '/b.FCStd', C = DIR + '/c.FCStd';
await G.openDesignPath(A);
await idle();
await G.openDesignPath(B);
await idle();
await G.openDesignPath(C);
await idle();
assertEq(tabs().filter((t) => t.path).map((t) => t.path), [A, B, C], 'three parts open in tabs');
assertEq(G.getState().docPath, C, 'c is on screen');

note('--- close a tab that is NOT on screen: nothing else changes ---');
clickClose('a.FCStd');
await idle();
assertEq(tabs().filter((t) => t.path).map((t) => t.path), [B, C], 'a is gone');
assertEq(G.getState().docPath, C, 'c is still on screen');
assertEq(await enginePath(), C, 'and still the engine document');

note('--- close the tab on screen: the next open tab takes over ---');
clickClose('c.FCStd');
await waitFor(() => G.getState().docPath === B, 8000);
await idle();
assertEq(G.getState().docPath, B, 'b is on screen now');
assertEq(await enginePath(), B, 'the engine switched to b');
assertEq(tabs().filter((t) => t.active).map((t) => t.path), [B], 'b is the active tab');
assert(!tabs().some((t) => t.path === C), 'c has no tab');
const w = (await rpc('scene.get')).meshes[0].bbox;
assert(Math.abs(w.max[0] - 40) < 1e-3, `the viewport shows b's model (x max ${w.max[0]})`);

note('--- close the last tab: a new empty design fills the space ---');
clickClose('b.FCStd');
await waitFor(() => G.getState().docPath === null && tabs().length === 1, 8000);
await idle();
assertEq(tabs().map((t) => [t.name, t.path, t.active]), [['Untitled', null, true]], 'one fresh Untitled tab, active');
assertEq(await enginePath(), null, 'the engine holds a new unsaved document');
const left = (await rpc('scene.get')).meshes.filter((m) => (m.positions || []).length);
assertEq(left.length, 0, 'nothing of the closed part is left in the viewport');
