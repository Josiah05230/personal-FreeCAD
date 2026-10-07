/* A sub-assembly in the model tree folds open to show what it is made of,
 * level by level, and a part inside it opens in its own tab from there. */

const DIR = '/tmp/gwtcad_nested_' + Date.now();
await window.cad.mkdir(DIR);
const f = (n) => DIR + '/' + n + '.FCStd';

async function part(name, len) {
  await rpc('session.reset');
  const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', { sketchId: s.sketchId, elements: [{ type: 'rect', a: [0, 0], b: [len, 10] }], constraints: [] });
  await rpc('feature.extrude', { sketchId: s.sketchId, length: 5 });
  await rpc('document.saveAs', { path: f(name) });
}
async function asm(name, parts) {
  await rpc('session.reset');
  await rpc('document.saveAs', { path: f(name) });
  await G.openDesignPath(f(name));
  await idle();
  await rpc('assembly.create');
  for (const p of parts) {
    await G.addComponentFile(f(p));
    await G.refresh();
    await idle();
  }
  await rpc('document.save');
}
await part('bolt', 8);
await part('plate', 30);
await asm('sub', ['bolt', 'plate']);   // sub-assembly: bolt + plate
await asm('mid', ['sub', 'bolt']);     // an assembly holding that sub-assembly
await asm('top', ['mid', 'plate']);    // and the top one holding THAT
await G.openDesignPath(f('top'));
await idle();

note('--- the engine reports the whole nesting ---');
const t = await rpc('assembly.tree');
const mid = t.components.find((c) => c.linkedPath === f('mid'));
const plate = t.components.find((c) => c.linkedPath === f('plate'));
assert(mid && mid.isAssembly && !plate.isAssembly, 'mid is an assembly, plate is a part');
const sub = (mid.children || []).find((c) => c.linkedPath === f('sub'));
assert(sub && sub.isAssembly, 'mid contains the sub-assembly');
assertEq((mid.children || []).map((c) => c.linkedPath).sort(), [f('bolt'), f('sub')].sort(), 'mid = sub + bolt');
assertEq((sub.children || []).map((c) => c.linkedPath).sort(), [f('bolt'), f('plate')].sort(), 'sub = bolt + plate (two levels down)');

note('--- the tree folds open level by level ---');
const names = () => [...document.querySelectorAll('.asmpanel-tree .asm-row .asm-name')].map((e) => e.textContent.replace(/[▸▾]/g, '').trim());
const rowOf = (label, nth = 0) => [...document.querySelectorAll('.asmpanel-tree .asm-row')].filter((r) => r.querySelector('.asm-name') && r.querySelector('.asm-name').textContent.replace(/[▸▾]/g, '').trim() === label)[nth];
await waitFor(() => names().includes(mid.label), 4000);
const before = names().length;
assert(!!rowOf(mid.label).querySelector('.asm-fold:not(.none)'), 'the sub-assembly row has a fold arrow');
assert(!rowOf(plate.label).querySelector('.asm-fold:not(.none)'), 'a plain part does not');
rowOf(mid.label).querySelector('.asm-fold').click();
await sleep(80);
assertEq(names().length, before + 2, 'folding mid open shows its two components');
assert(names().includes(sub.label), 'including the nested sub-assembly');
rowOf(sub.label).querySelector('.asm-fold').click();
await sleep(80);
assertEq(names().length, before + 4, 'folding that open shows its two parts');
rowOf(mid.label).querySelector('.asm-fold').click();
await sleep(80);
assertEq(names().length, before, 'folding mid shut hides everything under it');

note('--- a part two levels down opens in its own tab ---');
rowOf(mid.label).querySelector('.asm-fold').click();
await sleep(80);
const deepBolt = (sub.children || []).find((c) => c.linkedPath === f('bolt'));
const deepRow = [...document.querySelectorAll('.asmpanel-tree .asm-row.asm-sub')].find((r) => r.title === f('bolt') && r.querySelector('.asm-name').textContent.includes(deepBolt.label));
assert(!!deepRow, 'the bolt inside sub has its own row');
deepRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 }));
await sleep(80);
const item = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === 'Open in new tab');
assert(!!item, 'right-click offers "Open in new tab"');
item.click();
await waitFor(() => G.getState().docPath === f('bolt'), 8000);
await idle();
assertEq(G.getState().docPath, f('bolt'), 'the bolt is on screen');
assert(G.getState().tabs.some((x) => x.path === f('top') && !x.active), 'the top assembly keeps its tab');
