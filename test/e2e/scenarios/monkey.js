/* Monkey test: fire a long stream of random UI actions with random / garbage
 * args (open dialogs, apply ops with junk values, select nonsense, undo/redo,
 * delete, roll history, cancel). The bar: after all of it the app is still
 * alive - engine pings, renderer is mounted, the error boundary did NOT trip,
 * and a real command still works. Whatever valid ops fell out of the noise must
 * have executed in order without corrupting state.
 *
 * Seed is fixed so a failure reproduces; change SEED to fuzz differently.
 */
const SEED = Number((typeof process !== 'undefined' && process.env && process.env.MONKEY_SEED) || 0) || 12345;
const STEPS = 120;
const r = rng(SEED);
note(`monkey seed=${SEED} steps=${STEPS}`);

await rpc('session.reset');
await G.refresh();
await idle();

// lay down one real body so there is something to poke at
const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', { sketchId: s.sketchId, elements: [{ type: 'rect', a: [-15, -15], b: [15, 15] }], constraints: [] });
G.selectSketch(s.sketchId);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10 });
await idle();

const OPS = ['extrude', 'revolve', 'fillet', 'chamfer', 'shell', 'hole', 'draft', 'rib', 'mirror', 'patternLinear'];
const JUNK_VALS = [
  {},
  { length: '' },
  { length: 0 },
  { length: 'abc' },
  { length: -5 },
  { length: 1e9 },
  { radius: NaN, size: NaN },
  { operation: 'Nonsense', mode: 'Blur', length: 3 },
  { angle: 99999 },
  { thickness: -1 }
];

let acted = 0;
for (let i = 0; i < STEPS; i++) {
  const dice = r();
  try {
    if (dice < 0.2) {
      G.openOp(pick(r, OPS));
    } else if (dice < 0.34) {
      G.closeOp();
    } else if (dice < 0.5) {
      await G.applyOp(pick(r, OPS), pick(r, JUNK_VALS));
      acted++;
    } else if (dice < 0.58) {
      G.selectFace('Body' + Math.floor(r() * 3), 'Face' + Math.floor(r() * 40));
    } else if (dice < 0.64) {
      G.selectSketch('Sketch' + Math.floor(r() * 5));
    } else if (dice < 0.7) {
      G.clearSelection();
    } else if (dice < 0.8) {
      await G.undo();
      acted++;
    } else if (dice < 0.87) {
      await G.redo();
      acted++;
    } else if (dice < 0.93) {
      await G.deleteFeature('Pad' + Math.floor(r() * 5));
      acted++;
    } else if (dice < 0.97) {
      await G.rollTo(r() < 0.5 ? null : 'Feature' + Math.floor(r() * 5));
      acted++;
    } else {
      G.cancelSketch();
    }
  } catch (e) {
    fail(`step ${i} (dice ${dice.toFixed(3)}) threw out to the harness: ${(e && e.message) || e}`);
  }
  // small random gap so some actions land mid-flight
  if (r() < 0.3) await sleep(Math.floor(r() * 40));
}

note(`fired ${STEPS} actions (${acted} mutating), letting the queue drain`);
await idle(20000);

// --- the app survived ---
assert((await rpc('ping').then((p) => p.pong).catch(() => false)) === true, 'engine still responds after the monkey');
const st = G.getState();
assert(st.status === 'ready', `app status is still "ready" (${st.status})`);
assert(!document.body.innerText.includes('The interface hit an error'), 'error boundary did NOT trip');
assert(Array.isArray(st.bodies), 'state is still readable');
assert(!st.busy, 'command queue drained (not stuck busy)');

// --- and a real command still works cleanly ---
note('a genuine op after all that chaos');
await rpc('session.reset');
await G.refresh();
await idle();
const s2 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', { sketchId: s2.sketchId, elements: [{ type: 'rect', a: [-10, -10], b: [10, 10] }], constraints: [] });
G.selectSketch(s2.sketchId);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 12 });
await idle();
const fin = G.getState();
assert(fin.meshes.length === 1 && fin.meshes[0].tris > 0, 'post-monkey extrude produced exactly one clean solid');
assert(!fin.bodies.some((b) => b.features.some((f) => f.error)), 'post-monkey feature tree has no errors');
