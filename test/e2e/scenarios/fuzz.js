/* Autonomous interaction fuzzer.
 *
 * Lays a small model, then fires a long seeded random walk over EVERY
 * window.__gwtcad action and EVERY wired ribbon command, with a mix of valid
 * and garbage arguments. After each step it checks invariants and, on the first
 * failure, prints the seed + step + action + a tail of the trace so it
 * reproduces (FUZZ_SEED=<n> FUZZ_STEPS=<n> bash test/e2e/run.sh
 * test/e2e/scenarios/fuzz.js).
 *
 * A step that throws is NOT a failure - the app is allowed to reject garbage.
 * Failures are: engine dead, status 'error', the ErrorBoundary tripped, the
 * command queue stuck, or an unexpectedly BLANK viewport (solids exist at the
 * timeline tip but scene.get returns no mesh).
 */

const SEED = Number(ENV.FUZZ_SEED) || ((Math.random() * 2e9) | 0);
const STEPS = Number(ENV.FUZZ_STEPS) || 80;
const STOP_ON_FAIL = ENV.FUZZ_STOP_ON_FAIL !== '0';
note(`fuzz  seed=${SEED}  steps=${STEPS}   (replay: FUZZ_SEED=${SEED} bash test/e2e/run.sh test/e2e/scenarios/fuzz.js)`);
const r = rng(SEED);
const ri = (n) => Math.floor(r() * n);
const chance = (p) => r() < p;

const OP_KINDS = [
  'extrude', 'revolve', 'rib', 'loft', 'draft', 'combine', 'fillet', 'chamfer',
  'shell', 'hole', 'patternLinear', 'patternCircular', 'mirror', 'datumPlane',
  'datumAxis', 'datumPoint', 'moveBody', 'copyBody', 'splitBody'
];
const PLANES = ['XY_Plane', 'XZ_Plane', 'YZ_Plane'];
const JUNK_VALUES = [
  {}, { length: '' }, { length: 0 }, { length: 'abc' }, { length: -5 },
  { length: 1e9 }, { radius: NaN }, { angle: 'x' }, { thickness: 0 },
  { operation: 'Nonsense', mode: 'To object' }, { diameter: -1, depth: -1 }
];

function goodValues(kind) {
  switch (kind) {
    case 'extrude': return { operation: chance(0.7) ? 'Join' : 'Cut', mode: 'Blind', length: 2 + ri(20) };
    case 'revolve': return { angle: 20 + ri(300), cut: chance(0.3) };
    case 'fillet': return { radius: 1 + ri(4) };
    case 'chamfer': return { size: 1 + ri(4) };
    case 'shell': return { thickness: 1 + ri(3) };
    case 'draft': return { angle: 1 + ri(20) };
    case 'hole': return { diameter: 2 + ri(6), depth: 2 + ri(10) };
    case 'rib': return { thickness: 1 + ri(4) };
    case 'datumPlane': return { mode: 'Distance', offset: ri(30) };
    case 'patternLinear': return { count: 2 + ri(4), spacing: 5 + ri(20) };
    case 'patternCircular': return { count: 2 + ri(6), angle: 360 };
    default: return {};
  }
}
const valuesFor = (kind) => (chance(0.45) ? JUNK_VALUES[ri(JUNK_VALUES.length)] : goodValues(kind));

// pool of geometry to click, refreshed lazily
let geom = { faces: [], edges: [], verts: [], bodyId: 'Body' };
async function refreshGeom() {
  try {
    const sc = await rpc('scene.get');
    const m = sc.meshes[0];
    geom = {
      bodyId: (m && m.id) || 'Body',
      faces: (m && m.faceGroups ? m.faceGroups.map((g) => 'Face' + (g.face + 1)) : []),
      edges: (m && m.edges ? m.edges.map((e) => 'Edge' + (e.edge + 1)) : []),
      verts: (m && m.vertices ? m.vertices.map((v) => 'Vertex' + (v.vertex + 1)) : []),
      sketches: sc.sketches.map((s) => s.id),
      planes: (sc.pickPlanes || []).map((p) => p.id)
    };
  } catch { /* keep last */ }
}
function randomSel() {
  const kinds = [];
  if (geom.faces.length) kinds.push('face');
  if (geom.edges.length) kinds.push('edge');
  if (geom.verts.length) kinds.push('vertex');
  if ((geom.sketches || []).length) kinds.push('sketch');
  kinds.push('plane', 'null', 'null');
  const k = kinds[ri(kinds.length)];
  if (k === 'null') return null;
  if (k === 'sketch') return { kind: 'sketch', sketchId: geom.sketches[ri(geom.sketches.length)] };
  if (k === 'plane') return { kind: 'plane', planeId: '', role: PLANES[ri(3)] };
  const sub = k === 'face' ? geom.faces[ri(geom.faces.length)]
    : k === 'edge' ? geom.edges[ri(geom.edges.length)]
      : geom.verts[ri(geom.verts.length)];
  return { kind: k, bodyId: geom.bodyId, sub, point: [0, 0, 0], normal: [0, 0, 1] };
}
function featIds() {
  const b = G.getState().bodies[0];
  return b ? b.features.map((f) => f.id) : [];
}

let CMD_IDS = [];

// weighted action list: [weight, name, fn]
const ACTIONS = [
  [3, 'pick', async () => G.pick(randomSel(), chance(0.4))],
  [1, 'clearSelection', async () => G.clearSelection()],
  [2, 'openOp', async () => G.openOp(OP_KINDS[ri(OP_KINDS.length)])],
  [1, 'closeOp', async () => G.closeOp()],
  [3, 'applyOp', async () => {
    const k = OP_KINDS[ri(OP_KINDS.length)];
    await G.applyOp(k, valuesFor(k));
  }],
  [2, 'beginSketch', async () => G.beginSketch({ kind: 'origin', role: PLANES[ri(3)] })],
  [1, 'createSketch', async () => G.createSketch()],
  [2, 'finishSketch', async () => G.finishSketch()],
  [2, 'cancelSketch', async () => G.cancelSketch()],
  [1, 'editSketch', async () => { const s = (geom.sketches || [])[0]; if (s) await G.editSketch(s); }],
  [2, 'undo', async () => G.undo()],
  [2, 'redo', async () => G.redo()],
  [1, 'deleteFeature', async () => { const f = featIds(); if (f.length) await G.deleteFeature(f[ri(f.length)]); }],
  [2, 'editFeature', async () => { const f = featIds(); if (f.length) await G.editFeature(f[ri(f.length)]); }],
  [1, 'suppressFeature', async () => { const f = featIds(); if (f.length) await G.suppressFeature(f[ri(f.length)], chance(0.5)); }],
  [1, 'rollTo', async () => { const f = featIds(); await G.rollTo(chance(0.4) || !f.length ? null : f[ri(f.length)]); }],
  [2, 'runCommand', async () => { if (CMD_IDS.length) await G.runCommand(CMD_IDS[ri(CMD_IDS.length)]); }],
  [1, 'refresh', async () => G.refresh()],
  [1, 'fit', async () => G.fit()]
];
const WSUM = ACTIONS.reduce((s, a) => s + a[0], 0);
function nextAction() {
  let x = r() * WSUM;
  for (const a of ACTIONS) { x -= a[0]; if (x <= 0) return a; }
  return ACTIONS[0];
}

async function viewportOK() {
  const tg = await rpc('tree.get');
  const b = tg.bodies[0];
  if (!b) return true;
  const feats = b.features;
  const markerIdx = b.marker ? feats.findIndex((f) => f.id === b.marker) : feats.length - 1;
  let liveSolid = false;
  for (let i = 0; i <= markerIdx && i < feats.length; i++) {
    const f = feats[i];
    if (f.kind === 'solid' && !f.suppressed && !f.error) liveSolid = true;
  }
  if (!liveSolid) return true; // nothing should render - a blank viewport is correct
  const sg = await rpc('scene.get');
  return sg.meshes.some((m) => (m.positions || []).length > 0);
}

// ---------------- lay a base model ----------------
note('base model: rect -> extrude -> rect on face -> extrude -> fillet');
await rpc('session.reset');
await G.refresh();
await idle();
const bs = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', { sketchId: bs.sketchId, elements: [{ type: 'rect', a: [0, 0], b: [30, 20] }], constraints: [] });
await G.refresh();
await idle();
G.selectSketch(bs.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 12 });
await idle();
await refreshGeom();
CMD_IDS = (G.commandIds && G.commandIds()) || [];
note('ribbon commands in play: ' + CMD_IDS.length);
assert(G.getState().bodies[0] && G.getState().bodies[0].features.some((f) => f.kind === 'solid'),
  'base model has a solid to fuzz against');

// ---------------- the random walk ----------------
let failStep = -1;
for (let step = 1; step <= STEPS; step++) {
  const [, name, fn] = nextAction();
  let threw = null;
  try {
    await fn();
  } catch (e) {
    threw = (e && e.message) || String(e);
  }
  const settled = await idle(3500);
  if (step % 25 === 0) await refreshGeom();

  // ---- invariants ----
  const problems = [];
  let pong = false;
  try { pong = (await rpc('ping')).pong === true; } catch { pong = false; }
  if (!pong) problems.push('engine did not pong');
  const st = G.getState();
  if (st.status === 'error') problems.push('status=error');
  try {
    if (document.body.innerText.includes('The interface hit an error')) problems.push('ErrorBoundary tripped');
  } catch { /* ignore */ }
  if (!settled) problems.push('command queue did not settle within 3.5s');
  if (pong && !st.sketchMode) {
    try {
      if (!(await viewportOK())) problems.push('VIEWPORT BLANK (solids at the tip but scene.get has no mesh)');
    } catch (e) { problems.push('viewport check threw: ' + ((e && e.message) || e)); }
  }

  if (problems.length) {
    failStep = step;
    fail(`step ${step} [${name}]${threw ? ' (threw: ' + threw.slice(0, 80) + ')' : ''}  ->  ${problems.join('; ')}`);
    note(`REPLAY: FUZZ_SEED=${SEED} bash test/e2e/run.sh test/e2e/scenarios/fuzz.js`);
    try {
      const dump = window.__trace.dump().split('\n');
      note('--- last 16 trace lines ---');
      for (const l of dump.slice(-16)) note('  ' + l);
    } catch { /* trace off */ }
    if (STOP_ON_FAIL) break;
  }
}

if (failStep === -1) {
  pass(`survived ${STEPS} random steps (seed ${SEED}) - engine alive, no error state, no blank viewport, queue drained`);
}

// ---------------- still fully usable? ----------------
note('post-fuzz: a clean sketch + extrude must still make a solid');
try {
  await G.closeOp();
  await G.cancelSketch();
  await idle();
  await rpc('session.reset');
  await G.refresh();
  await idle();
  const es = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', { sketchId: es.sketchId, elements: [{ type: 'rect', a: [0, 0], b: [10, 10] }], constraints: [] });
  await G.refresh();
  await idle();
  G.selectSketch(es.sketchId);
  await sleep(40);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 5 });
  await idle();
  const sg = await rpc('scene.get');
  assert(sg.meshes.some((m) => (m.positions || []).length > 0), 'a real extrude after the fuzz still renders a solid');
} catch (e) {
  fail('post-fuzz clean op threw: ' + ((e && e.message) || e));
}
assert((await rpc('ping')).pong === true, 'engine still responds at the very end');
note('fuzz complete');
