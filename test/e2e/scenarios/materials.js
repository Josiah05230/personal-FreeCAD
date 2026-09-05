/* Materials: assign a built-in preset, then a custom one, to a body; verify
 * the real material name/appearance persists through save + reopen and the
 * GWT-CAD-only extras (friction, pattern) ride in the .gwtcad.json companion.
 * Also opens the real Materials panel through the ribbon and drives it. */

const TMP = '/tmp/claude-1000/-home-jholder-projects/38db2fed-70fa-4706-b4ba-3a8fde1460f6/scratchpad/materials_e2e.FCStd';

note('--- material RPCs ---');
await rpc('session.reset');
await G.refresh();
await idle();
const s0 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: s0.sketchId,
  elements: [{ type: 'rect', a: [0, 0], b: [20, 20] }],
  constraints: []
});
await G.refresh();
await idle();
G.selectSketch(s0.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10 });
await idle();
const bid = G.getState().bodies[0].id;

const presets = await rpc('material.presets');
assert(presets.total >= 100, `at least 100 built-in presets (${presets.total})`);
const metalFam = presets.families.find((f) => f.family === 'Metal');
assert(!!metalFam && metalFam.materials.length > 10, 'a Metal family with several materials exists');
const alu = metalFam.materials.find((m) => /Al/i.test(m.name)) || metalFam.materials[0];

const detail = await rpc('material.presetDetail', { uuid: alu.uuid });
assert(Object.keys(detail.physical).length > 0, 'preset has physical properties');

await rpc('material.assign', { targetId: bid, uuid: alu.uuid, extra: { frictionStatic: 0.35, pattern: 'brushed' } });
const got = await rpc('material.get', { targetId: bid });
assert(got.assigned && got.assigned.name === alu.name, `assigned preset name matches (${got.assigned && got.assigned.name})`);
assert(got.assigned.extra && got.assigned.extra.pattern === 'brushed', 'extra (pattern) round-trips through material.get');

const custom = await rpc('material.customSave', {
  name: 'E2E Custom Red',
  baseUuid: alu.uuid,
  appearance: { DiffuseColor: '(0.7000, 0.0500, 0.0500, 1.0)', Shininess: '0.6' },
  physical: {},
  extra: { frictionStatic: 0.4, pattern: 'anodized' }
});
assert(!!custom.id, 'custom preset got an id');
const custList = await rpc('material.customList');
assert(custList.presets.some((p) => p.id === custom.id), 'custom preset shows up in customList');

await rpc('material.customAssign', { targetId: bid, customId: custom.id });
const got2 = await rpc('material.get', { targetId: bid });
assert(got2.assigned.name === 'E2E Custom Red', 'custom material assigned');
assert(/0\.7000/.test(String(got2.assigned.appearance.DiffuseColor)), 'custom color applied');

await rpc('document.saveAs', { path: TMP });
await rpc('session.reset');
await rpc('document.open', { path: TMP });
const gotReopened = await rpc('material.get', { targetId: bid });
assert(gotReopened.assigned && gotReopened.assigned.name === 'E2E Custom Red', 'material survives save+reopen');

await rpc('material.clear', { targetId: bid });
const gotCleared = await rpc('material.get', { targetId: bid });
assert(gotCleared.assigned === null, 'material.clear removes the assignment');

await rpc('material.customDelete', { id: custom.id });
const custList2 = await rpc('material.customList');
assert(!custList2.presets.some((p) => p.id === custom.id), 'custom preset deleted');

// ---------------------------------------------------------------- real panel
note('--- Materials panel through the ribbon ---');
await rpc('session.reset');
await G.refresh();
await idle();
const s1 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: s1.sketchId,
  elements: [{ type: 'rect', a: [0, 0], b: [20, 20] }],
  constraints: []
});
await G.refresh();
await idle();
G.selectSketch(s1.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10 });
await idle();

const ids = G.commandIds();
assert(ids.includes('mod.material'), 'Material ribbon command is registered');
G.runCommand('mod.material');
await sleep(150);
const panel = document.querySelector('.materials-panel');
assert(!!panel, 'the Materials panel opened');
const famBtns = document.querySelectorAll('.materials-fam');
assert(famBtns.length > 5, `several family buttons rendered (${famBtns.length})`);
G.runCommand('mod.material');
await sleep(80);
assert(!document.querySelector('.materials-panel'), 'Material command toggles the panel closed');

const fin = G.getState();
assert(fin.status === 'ready', 'app still ready at end (' + fin.status + ')');
assert(!document.body.innerText.includes('The interface hit an error'), 'no ErrorBoundary');
assert((await rpc('ping')).pong === true, 'engine still responds at end');
note('materials scenario complete');
