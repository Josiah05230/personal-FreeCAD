/* Move/Copy on bodies, F360 style, through the REAL dialog + viewport:
 *   - the target bodies move live while the dialog is open (client-side
 *     preview, the engine is untouched until OK) and Cancel / Esc restore them
 *   - the on-canvas manipulator: a real pointer drag on an arrow / ring
 *     updates the dialog's fields and never picks or orbits
 *   - Objects box: click a body (real viewport click on an imported
 *     Part::Feature), plain click replaces, Ctrl-click adds, browser-row pick
 *   - Point to Point: OK stays disabled until BOTH points are picked (the
 *     user hit a silent [0,0,0] -> [0,0,0] no-op commit here)
 *   - the committed move persists after a scene refresh
 * Imported bodies come from a STEP round trip so they are plain
 * Part::Feature objects like a vendor model (the user's report was on
 * CMC0020, 4 imported SupplierModel bodies). Set E2E_MOVE_FCSTD to a SCRATCH
 * COPY of a real file to also move its first body (never a real file - this
 * does not save, but the doc is opened read-write).
 */

const okBtn = () => document.querySelector('.opdlg-ok');
const xs = () => G.moveXformState();
const near = (a, b, tol = 0.05) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol);
const fmt = (p) => (p ? '[' + p.map((x) => Number(x).toFixed(2)).join(',') + ']' : String(p));

function viewportEl() {
  const cands = Array.from(document.querySelectorAll('.viewport canvas'));
  let best = cands[0];
  for (const c of cands) if (c.clientWidth * c.clientHeight > best.clientWidth * best.clientHeight) best = c;
  return best;
}
function fire(el, type, x, y, extra) {
  const opts = Object.assign(
    {
      pointerId: 1,
      isPrimary: true,
      pointerType: 'mouse',
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === 'pointerdown' ? 1 : 0
    },
    extra || {}
  );
  el.dispatchEvent(new PointerEvent(type, opts));
}
function clickAt(x, y, extra) {
  const el = viewportEl();
  fire(el, 'pointermove', x, y, extra);
  fire(el, 'pointerdown', x, y, extra);
  fire(el, 'pointerup', x, y, Object.assign({ buttons: 0 }, extra || {}));
}
async function dragTo(x0, y0, x1, y1) {
  const el = viewportEl();
  fire(el, 'pointermove', x0, y0);
  fire(el, 'pointerdown', x0, y0);
  for (let i = 1; i <= 8; i++) {
    fire(el, 'pointermove', x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8, { buttons: 1 });
    await sleep(10);
  }
  fire(el, 'pointerup', x1, y1, { buttons: 0 });
}

/** the dialog control whose label text is `label` */
function field(label) {
  for (const l of document.querySelectorAll('.opdlg-field')) {
    const s = l.querySelector('span');
    if (s && s.textContent === label) return l.querySelector('input, select');
  }
  return null;
}
function setField(label, value) {
  const el = field(label);
  if (!el) return false;
  if (el.type === 'checkbox') {
    if (el.checked !== Boolean(value)) el.click();
    return true;
  }
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value));
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  return true;
}
const fieldNum = (label) => Number((field(label) || {}).value);

async function sceneMesh(id) {
  return (await rpc('scene.get')).meshes.find((m) => m.id === id);
}
const centre = (m) => m.bbox.min.map((v, i) => (v + m.bbox.max[i]) / 2);
/** screen point of a body's top face centre (z max) */
function topScreen(m) {
  const c = centre(m);
  return G.projectToScreen([c[0], c[1], m.bbox.max[2]]);
}
async function openMove() {
  G.closeOp();
  await sleep(30);
  G.clearSelection();
  await sleep(30);
  G.openOp('move');
  await sleep(120);
  await flush();
}

// ------------------------------------------------------------------ setup
note('--- setup: two imported (Part::Feature) bodies ---');
await rpc('session.reset');
await G.refresh();
await idle();
await rpc('primitive.box', { length: 20, width: 20, height: 20, operation: 'newbody' });
await G.refresh();
await idle();
const STEP = '/tmp/gwtcad-e2e-move-box.step';
await rpc('io.exportStep', { path: STEP });
await rpc('session.reset');
await G.refresh();
await idle();
const impA = await rpc('io.importModel', { path: STEP });
const impB = await rpc('io.importModel', { path: STEP });
const A = impA.imported[0];
const B = impB.imported[0];
assert(A && B && A !== B, `two imported bodies (${A}, ${B})`);
await rpc('body.moveCopy', { ids: [B], mode: 'translate', dx: 60 });
await G.refresh();
await idle();
G.fit();
await sleep(80);
let mA = await sceneMesh(A);
let mB = await sceneMesh(B);
const a0 = mA.bbox.min.slice();
const b0 = mB.bbox.min.slice();
note(`A bbox.min=${fmt(a0)}  B bbox.min=${fmt(b0)}`);
assert(near(b0, [a0[0] + 60, a0[1], a0[2]], 0.01), 'B sits 60mm along X from A');

// ------------------------------------------------------------------ Objects box
note('--- Objects box: real clicks on imported bodies ---');
await openMove();
assert(G.getState().op === 'move', 'Move dialog open');
assert(G.getState().opReady === false && okBtn() && okBtn().disabled, 'no target yet: OK disabled (two bodies, nothing picked)');
let p = topScreen(mA);
clickAt(p.x, p.y);
await sleep(80);
await flush();
assertEq(G.getState().selection, [`body:${A}`], 'plain click on a face of A targets body A (promoted to the whole body)');
assert(G.getState().opReady === true && !okBtn().disabled, 'one target: OK enabled');
const chip = document.querySelector('.opdlg-slot-chip');
assert(chip && chip.textContent.length > 0 && chip.textContent !== 'Body', `Objects chip shows the body label (${chip && chip.textContent})`);
p = topScreen(mB);
clickAt(p.x, p.y, { ctrlKey: true });
await sleep(80);
await flush();
assertEq(G.getState().selection.slice().sort(), [`body:${A}`, `body:${B}`].sort(), 'Ctrl-click adds body B');
clickAt(p.x, p.y);
await sleep(80);
await flush();
assertEq(G.getState().selection, [`body:${B}`], 'plain click on B replaces the targets with B');
G.pick({ kind: 'body', bodyId: A }, false); // the browser row path (handlers.onSelect)
await sleep(60);
await flush();
assertEq(G.getState().selection, [`body:${A}`], 'browser-row pick of A replaces the targets');

// ------------------------------------------------------------------ live preview
note('--- live preview: typed values move the body before OK ---');
setField('Distance X', 15);
setField('Distance Y', -5);
await sleep(60);
await flush();
let st = xs();
assert(near(st.nodes[A], [15, -5, 0]), `A previewed at +15,-5,0 (node ${fmt(st.nodes[A])})`);
assert(near(st.nodes[B], [0, 0, 0], 1e-9), 'B untouched by the preview');
assert(st.gizmo && near(st.gizmo, centre(mA).map((c, i) => c + [15, -5, 0][i])), `manipulator rides with the body (${fmt(st.gizmo)})`);
mA = await sceneMesh(A);
assert(near(mA.bbox.min, a0, 1e-6), 'engine not touched by the preview');
document.querySelector('.opdlg-cancel').click();
await sleep(60);
await flush();
st = xs();
assert(G.getState().op === null, 'Cancel closes the dialog');
assert(near(st.nodes[A], [0, 0, 0], 0), `Cancel restores A exactly (node ${fmt(st.nodes[A])})`);
assert(st.gizmo === null && st.ghosts === 0, 'Cancel removes the manipulator');

// Esc from the dialog (rotate preview) restores too
await openMove();
G.pick({ kind: 'body', bodyId: A }, false);
await sleep(40);
setField('Move type', 'Rotate');
await sleep(40);
setField('Axis', 'Z');
setField('Angle', 90);
await sleep(60);
await flush();
st = xs();
// 90 deg about Z through A's centre c: the node origin lands at c - R c
{
  const c = centre(mA);
  const want = [c[0] + c[1], c[1] - c[0], 0];
  assert(near(st.nodes[A], want), `rotate preview about the body centre (node ${fmt(st.nodes[A])}, want ${fmt(want)})`);
}
field('Angle').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await sleep(60);
await flush();
assert(G.getState().op === null && near(xs().nodes[A], [0, 0, 0], 0), 'Esc cancels and restores A exactly');

// Create Copy previews ghost copies, originals stay
await openMove();
G.pick({ kind: 'body', bodyId: B }, false);
await sleep(40);
setField('Distance Z', 30);
setField('Create Copy', true);
await sleep(40);
setField('Copies', 2);
await sleep(60);
await flush();
st = xs();
assert(st.ghosts > 0 && near(st.nodes[B], [0, 0, 0], 0), `Create Copy: ghost copies drawn (${st.ghosts} nodes), original B stays`);
document.querySelector('.opdlg-cancel').click();
await sleep(60);
await flush();
assert(xs().ghosts === 0, 'Cancel drops the copy ghosts');

// ------------------------------------------------------------------ manipulator drag
note('--- manipulator: real pointer drag on the X arrow ---');
await openMove();
G.pick({ kind: 'body', bodyId: A }, false);
await sleep(80);
await flush();
const cam0 = G.cameraDebug();
const grab = G.moveGizmoGrabPoint('X');
assert(!!grab, 'X arrow is on screen');
const s0 = G.projectToScreen(grab);
const s1 = G.projectToScreen([grab[0] + 10, grab[1], grab[2]]);
const len = Math.hypot(s1.x - s0.x, s1.y - s0.y);
const ux = (s1.x - s0.x) / len;
const uy = (s1.y - s0.y) / len;
await dragTo(s0.x, s0.y, s0.x + ux * 60, s0.y + uy * 60);
await sleep(80);
await flush();
const dx = fieldNum('Distance X');
assert(dx > 1, `dragging the X arrow wrote Distance X (${dx})`);
assert(Math.abs(fieldNum('Distance Y')) < 0.02 && Math.abs(fieldNum('Distance Z')) < 0.02, 'X arrow drag leaves Y / Z at 0');
st = xs();
assert(near(st.nodes[A], [dx, 0, 0], 0.02), `body follows the drag (node ${fmt(st.nodes[A])} vs dx ${dx})`);
assertEq(G.getState().selection, [`body:${A}`], 'the drag did not pick anything');
const cam1 = G.cameraDebug();
assert(near(cam0.pos, cam1.pos, 1e-6), 'the drag did not orbit / pan the camera');
// ring drag in Rotate mode
setField('Move type', 'Rotate');
await sleep(80);
await flush();
const rg = G.moveGizmoGrabPoint('Z');
assert(!!rg, 'Z rotation ring is on screen');
const r0 = G.projectToScreen(rg);
const ctr = G.projectToScreen(xs().gizmo);
// drag tangentially around the ring's centre
const tx = -(r0.y - ctr.y);
const ty = r0.x - ctr.x;
const tl = Math.hypot(tx, ty) || 1;
await dragTo(r0.x, r0.y, r0.x + (tx / tl) * 50, r0.y + (ty / tl) * 50);
await sleep(80);
await flush();
const ang = fieldNum('Angle');
assert(Math.abs(ang) > 1 && field('Axis').value === 'Z', `dragging the Z ring wrote the angle (${ang}, axis ${field('Axis').value})`);
document.querySelector('.opdlg-cancel').click();
await sleep(60);
await flush();
assert(near(xs().nodes[A], [0, 0, 0], 0), 'Cancel after a drag restores A exactly');

// ------------------------------------------------------------------ point to point
note('--- Point to Point: OK gated until both points are picked ---');
mA = await sceneMesh(A);
mB = await sceneMesh(B);
const vtx = (m, pick) => {
  let best = null;
  for (const v of m.vertices || []) if (!best || pick(v.p, best.p)) best = v;
  return best;
};
// A's max corner -> B's min corner (they then touch corner to corner)
const vFrom = vtx(mA, (p, q) => p[0] + p[1] + p[2] > q[0] + q[1] + q[2]);
const vTo = vtx(mB, (p, q) => p[0] + p[1] + p[2] < q[0] + q[1] + q[2]);
await openMove();
G.pick({ kind: 'body', bodyId: A }, false);
await sleep(40);
setField('Move type', 'Point to Point');
await sleep(80);
await flush();
assert(G.getState().opReady === false && okBtn().disabled, 'Point to Point with no points: OK disabled');
G.pick({ kind: 'vertex', bodyId: A, index: 0, sub: `Vertex${vFrom.vertex + 1}`, point: vFrom.p }, false);
await sleep(60);
await flush();
assert(G.getState().opReady === false && okBtn().disabled, 'only the origin point: OK still disabled');
assertEq(G.getState().selection.filter((s) => s.startsWith('body:')), [`body:${A}`], 'the point pick did not replace the target body');
G.pick({ kind: 'vertex', bodyId: B, index: 0, sub: `Vertex${vTo.vertex + 1}`, point: vTo.p }, false);
await sleep(60);
await flush();
assert(G.getState().opReady === true && !okBtn().disabled, 'both points picked: OK enabled');
const d = vTo.p.map((v, i) => v - vFrom.p[i]);
assert(near(xs().nodes[A], d), `point-to-point preview moves A by to - from (${fmt(xs().nodes[A])} vs ${fmt(d)})`);
okBtn().click();
await idle();
await sleep(100);
await flush();
mA = await sceneMesh(A);
assert(near(mA.bbox.min, a0.map((v, i) => v + d[i]), 0.01), `committed: A's geometry moved by to - from (min ${fmt(mA.bbox.min)})`);
assert(near(xs().nodes[A], [0, 0, 0], 0), 'after commit the node shows the real moved geometry (no preview left on it)');
mB = await sceneMesh(B);
assert(near(mB.bbox.min, b0, 1e-6), 'B unchanged by moving A');
await G.refresh();
await idle();
mA = await sceneMesh(A);
assert(near(mA.bbox.min, a0.map((v, i) => v + d[i]), 0.01), 'the move persists after a scene refresh');
assert(!!(await rpc('tree.get')), 'engine healthy');

// ------------------------------------------------------------------ translate commit via OK
note('--- translate commit through the real OK button ---');
await openMove();
G.pick({ kind: 'body', bodyId: B }, false);
await sleep(40);
setField('Distance X', 10);
await sleep(60);
okBtn().click();
await idle();
await sleep(100);
mB = await sceneMesh(B);
assert(near(mB.bbox.min, [b0[0] + 10, b0[1], b0[2]], 0.01), `B moved +10 X on OK (${fmt(mB.bbox.min)})`);

// ------------------------------------------------------------------ optional real file
if (ENV.E2E_MOVE_FCSTD) {
  note('--- real file (scratch copy): ' + ENV.E2E_MOVE_FCSTD + ' ---');
  await rpc('document.open', { path: ENV.E2E_MOVE_FCSTD });
  await G.refresh();
  await idle();
  G.fit();
  await sleep(100);
  const ms = (await rpc('scene.get')).meshes;
  note('bodies: ' + ms.map((m) => m.id + '(' + m.label + ')').join(', '));
  const tgt = ms.find((m) => /SupplierModel001/.test(m.id)) || ms[0];
  const bb0 = tgt.bbox.min.slice();
  await openMove();
  assert(G.getState().opReady === false, 'real file: nothing targeted yet');
  G.pick({ kind: 'body', bodyId: tgt.id }, false);
  await sleep(60);
  setField('Distance X', 10);
  await sleep(80);
  await flush();
  assert(near(xs().nodes[tgt.id], [10, 0, 0]), `real file: ${tgt.id} previews +10 X (${fmt(xs().nodes[tgt.id])})`);
  okBtn().click();
  await idle();
  await sleep(150);
  const after = await sceneMesh(tgt.id);
  assert(near(after.bbox.min, [bb0[0] + 10, bb0[1], bb0[2]], 0.02), `real file: ${tgt.id} moved +10 X (${fmt(bb0)} -> ${fmt(after.bbox.min)})`);
  assert(near(xs().nodes[tgt.id], [0, 0, 0], 0), 'real file: preview cleared after commit');
}
