/* Appearances: per-object colour / opacity / finish / edges + document render
 * settings + presets. Verifies the RPCs, the .gwtcad companion round-trip
 * (save + reopen), the partial-merge semantics, and that the real Appearance
 * panel opens through the ribbon and drives the viewport. */

const TMP = '/tmp/claude-1000/-home-jholder-projects/38db2fed-70fa-4706-b4ba-3a8fde1460f6/scratchpad/appearances_e2e.FCStd';

note('--- appearance RPCs ---');
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

// set colour + opacity + finish
await rpc('appearance.set', {
  targetId: bid,
  appearance: { color: [0.2, 0.45, 0.9], opacity: 0.4, finish: 'metal' }
});
let g = await rpc('appearance.get', { targetId: bid });
assert(Math.abs(g.appearance.opacity - 0.4) < 1e-6, 'opacity stored');
assert(g.appearance.finish === 'metal', 'finish stored');
assert(Math.abs(g.appearance.color[2] - 0.9) < 1e-6, 'colour stored');

// merge: change only the finish, colour/opacity must survive
await rpc('appearance.set', { targetId: bid, appearance: { finish: 'matte' }, merge: true });
g = await rpc('appearance.get', { targetId: bid });
assert(g.appearance.finish === 'matte', 'merged finish changed');
assert(Math.abs(g.appearance.opacity - 0.4) < 1e-6, 'merge kept opacity');

// edges sub-record merge
await rpc('appearance.set', { targetId: bid, appearance: { edges: { tangent: 'hide' } } });
g = await rpc('appearance.get', { targetId: bid });
assert(g.appearance.edges && g.appearance.edges.tangent === 'hide', 'edge style stored');

// the mesh buffer in scene.get carries the appearance
let scene = await rpc('scene.get');
let m0 = scene.meshes.find((m) => m.id === bid);
assert(m0 && m0.appearance && m0.appearance.finish === 'matte', 'scene.get mesh carries appearance');
assert(m0.edges.every((e) => 'kind' in e), 'every edge has a kind classification');

// render settings
await rpc('appearance.renderSet', {
  render: { shading: 'hidden-line', lighting: 'three-point', background: 'transparent' }
});
let rs = (await rpc('appearance.renderGet')).render;
assert(rs.shading === 'hidden-line', 'render shading stored');
assert(rs.background === 'transparent', 'render background stored');
// scene.get echoes render settings
scene = await rpc('scene.get');
assert(scene.renderSettings && scene.renderSettings.lighting === 'three-point', 'scene.get echoes renderSettings');

// presets
const preset = await rpc('appearance.presetSave', {
  name: 'E2E Clear',
  appearance: { opacity: 0.1, finish: 'glass' },
  scope: 'object'
});
assert(!!preset.id, 'preset saved with id');
let plist = await rpc('appearance.presetList');
assert(plist.presets.some((p) => p.id === preset.id), 'preset in list');

// save + reopen: appearance + render settings persist in the companion
await rpc('document.saveAs', { path: TMP });
await rpc('session.reset');
await rpc('document.open', { path: TMP });
g = await rpc('appearance.get', { targetId: bid });
assert(g.appearance.finish === 'matte', 'appearance survives save+reopen');
rs = (await rpc('appearance.renderGet')).render;
assert(rs.shading === 'hidden-line', 'render settings survive save+reopen');
plist = await rpc('appearance.presetList');
assert(plist.presets.some((p) => p.name === 'E2E Clear'), 'preset survives save+reopen');

await rpc('appearance.presetDelete', { id: preset.id });
await rpc('appearance.clear', { targetId: bid });
g = await rpc('appearance.get', { targetId: bid });
assert(!g.appearance || Object.keys(g.appearance).length === 0, 'appearance.clear wipes the record');

// ---------------------------------------------------------------- real panel
note('--- Appearance panel through the ribbon ---');
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
assert(ids.includes('mod.appearance'), 'Appearance ribbon command is registered');
assert(ids.includes('appr.render'), 'Render Image command is registered');
G.runCommand('mod.appearance');
await sleep(160);
const panel = document.querySelector('.appearance-panel');
assert(!!panel, 'the Appearance panel opened');
const tabs = document.querySelectorAll('.appr-tabs .materials-fam');
assert(tabs.length >= 5, `appearance tabs rendered (${tabs.length})`);
G.runCommand('mod.appearance');
await sleep(80);
assert(!document.querySelector('.appearance-panel'), 'Appearance command toggles the panel closed');

const fin = G.getState();
assert(fin.status === 'ready', 'app still ready at end (' + fin.status + ')');
assert(!document.body.innerText.includes('The interface hit an error'), 'no ErrorBoundary');
assert((await rpc('ping')).pong === true, 'engine still responds at end');
note('appearances scenario complete');
