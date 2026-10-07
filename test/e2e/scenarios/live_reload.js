/* A file this window has open changes on disk (another GWT-CAD window, or
 * a script, saved it): with nothing unsaved the window reloads by itself;
 * with unsaved edits it asks. Stood in for here by putting another file's
 * bytes over the open one. The window's own saves never count. */

const DIR = '/tmp/gwtcad_live_' + Date.now();
await window.cad.mkdir(DIR);
const f = (n) => DIR + '/' + n + '.FCStd';
const height = async () => {
  const bbs = (await rpc('scene.get')).meshes.filter((m) => (m.positions || []).length).map((m) => m.bbox);
  return Math.max(...bbs.map((b) => b.max[2])) - Math.min(...bbs.map((b) => b.min[2]));
};
const banner = () => document.querySelector('.disk-change');

async function part(name, h) {
  await rpc('session.reset');
  const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', { sketchId: s.sketchId, elements: [{ type: 'rect', a: [0, 0], b: [10, 10] }], constraints: [] });
  await rpc('feature.extrude', { sketchId: s.sketchId, length: h });
  await rpc('document.saveAs', { path: f(name) });
}
await part('part', 5);
await part('v2', 12);   // what "the other window" will save over part
await part('v3', 20);
await part('v4', 31);
await rpc('session.reset');
await rpc('document.saveAs', { path: f('asm') });
await G.openDesignPath(f('asm'));
await idle();
await rpc('assembly.create');
await G.addComponentFile(f('part'));
await G.refresh();
await idle();
await rpc('document.save');

note('--- the open part changes on disk: it reloads by itself ---');
await G.openDesignPath(f('part'));
await idle();
assert(Math.abs((await height()) - 5) < 1e-3, 'the part is 5 tall');
await window.cad.e2eCopyOver(f('v2'), f('part'));
await waitFor(async () => Math.abs((await height()) - 12) < 1e-3, 8000);
await idle();
assert(Math.abs((await height()) - 12) < 1e-3, `reloaded to the saved-elsewhere version, 12 tall (${await height()})`);
assertEq(G.getState().docPath, f('part'), 'same document, same tab');
assert(!banner(), 'no question asked - nothing was unsaved');

note('--- this window saving its own file is not an outside change ---');
const pad = G.getState().bodies[0].features.find((x) => x.kind === 'solid').id;
await G.editFeature(pad);
await waitFor(() => G.getState().op === 'extrude', 4000);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 14 });
await idle();
await G.saveDoc();
await idle();
await sleep(2600); // several polls
assert(!banner(), 'no banner after saving here');
assert(Math.abs((await height()) - 14) < 1e-3, 'and the model is what was just saved (14)');

note('--- with unsaved edits here, it asks instead ---');
await G.editFeature(pad);
await waitFor(() => G.getState().op === 'extrude', 4000);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 16 });
await idle();
await window.cad.e2eCopyOver(f('v3'), f('part'));
await waitFor(() => !!banner(), 8000);
assert(!!banner() && /changed on disk/.test(banner().textContent), 'a banner says the file changed on disk');
assert(Math.abs((await height()) - 16) < 1e-3, 'my unsaved edit (16) is still on screen');
[...banner().querySelectorAll('button')].find((b) => /Reload/.test(b.textContent)).click();
await waitFor(async () => Math.abs((await height()) - 20) < 1e-3, 8000);
assert(Math.abs((await height()) - 20) < 1e-3, 'Reload takes the version on disk (20)');
await waitFor(() => !banner(), 4000);
await sleep(1500);
assert(!banner(), 'and the banner is gone');

note('--- an open ASSEMBLY updates when a part it links is saved elsewhere ---');
await G.openDesignPath(f('asm'));
await idle();
assert(Math.abs((await height()) - 20) < 1e-3, 'the assembly shows the part at 20');
await window.cad.e2eCopyOver(f('v4'), f('part'));
await waitFor(async () => Math.abs((await height()) - 31) < 1e-3, 10000);
await idle();
assert(Math.abs((await height()) - 31) < 1e-3, `the assembly updated by itself to 31 (${await height()})`);
assertEq(G.getState().docPath, f('asm'), 'still on the assembly');
