/* Angle dimension: (1) the value shown when ctrl+clicking two lines should
 * match the wedge nearest the cursor (0-180 raw angle vs the supplementary
 * 180-x, matching what the glyph actually draws), and (2) typing a value the
 * sketch cannot satisfy should surface an error, not silently no-op. User
 * report, 2026-09-14. */

function viewportEl() {
  const cands = Array.from(document.querySelectorAll('.viewport canvas'));
  let best = cands[0];
  for (const c of cands) {
    if (c.clientWidth * c.clientHeight > best.clientWidth * best.clientHeight) best = c;
  }
  return best;
}
function fire(el, type, x, y, extra) {
  const opts = Object.assign(
    { pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: x, clientY: y,
      bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0 },
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
function setInputValue(elx, value) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  nativeSetter.call(elx, value);
  elx.dispatchEvent(new Event('input', { bubbles: true }));
}
function pressKey(key) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

note('--- angle dimension: value matches cursor wedge, invalid value errors ---');

await rpc('session.reset');
await G.refresh();
await idle();

// two lines meeting at the origin, 60 degrees apart: (0,0)->(10,0) horizontal,
// (0,0)->(10*cos60,10*sin60) at 60deg - a real non-parallel pair, undimensioned
await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
await waitFor(() => G.getState().sketchMode, 4000);
await sleep(60);

// deliberately off-axis and off-origin so testAddEntity's auto-snap
// (anchorToAxes/autoAngle) does not silently weld either line to the
// origin or an axis, which would leave zero real freedom for the angle
// constraint to actually change anything - a realistic floating sketch,
// not a degenerate fully-pinned one. Both lines share vertex BASE; line0
// runs at a slightly off-horizontal angle (2deg) purely so it does not
// auto-snap Horizontal, and line1 is 60deg further around from line0 (not
// from the X axis), so the wedge math below stays exactly right.
const L = 100; // long lines - forgiving pixel targeting after fit()
const BASE = [7, 4];
const baseAng = (11 * Math.PI) / 180; // clear of auto-constrain's H/V snap tolerance
const lnH = G.sketch.addEntity({
  type: 'line',
  a: BASE,
  b: [BASE[0] + L * Math.cos(baseAng), BASE[1] + L * Math.sin(baseAng)]
});
const ang60 = baseAng + (60 * Math.PI) / 180;
const lnA = G.sketch.addEntity({
  type: 'line',
  a: BASE,
  b: [BASE[0] + L * Math.cos(ang60), BASE[1] + L * Math.sin(ang60)]
});
await sleep(60);
note('constraints right after draw (checking no unwanted auto-snap): ' + JSON.stringify(G.sketch.constraints()));

G.fit();
await sleep(150);

// place the dimension editor by clicking a point NEAR the 60-degree wedge
// between the two lines, close to their shared vertex - not the reflex side
const midAng = baseAng + (30 * Math.PI) / 180;
const wedgeUV = [BASE[0] + (L / 4) * Math.cos(midAng), BASE[1] + (L / 4) * Math.sin(midAng)];
const wedgeScreen = G.sketchUVToScreen(wedgeUV[0], wedgeUV[1]);
const lnHMidScreen = G.sketchUVToScreen(BASE[0] + (L / 2) * Math.cos(baseAng), BASE[1] + (L / 2) * Math.sin(baseAng));
const lnAMidScreen = G.sketchUVToScreen(BASE[0] + (L / 2) * Math.cos(ang60), BASE[1] + (L / 2) * Math.sin(ang60));
assert(wedgeScreen && lnHMidScreen && lnAMidScreen, 'wedge + line midpoints project onto the screen');

pressKey('d');
await sleep(60);

clickAt(lnHMidScreen.x, lnHMidScreen.y);
await sleep(80);
note('dimPicks after 1st click: ' + JSON.stringify(G.sketch.dimPicksState()));
assert(G.sketch.dimPicksState().length === 1, 'first click picked the horizontal line');

clickAt(lnAMidScreen.x, lnAMidScreen.y, { ctrlKey: true });
await sleep(80);
note('dimPicks after ctrl-click: ' + JSON.stringify(G.sketch.dimPicksState()));
assert(G.sketch.dimPicksState().length === 2, 'ctrl-click added the second (60deg) line');

// place click - inside the 60-degree wedge, near the origin
clickAt(wedgeScreen.x, wedgeScreen.y);
await sleep(200);

const editorEl = document.querySelector('.dim-editor input, [data-dim-editor] input, .floating-dim input');
note('dim editor input found: ' + JSON.stringify(!!editorEl));
if (editorEl) {
  note('dim editor initial value: ' + JSON.stringify(editorEl.value));
  const shown = parseFloat(editorEl.value);
  assert(
    Math.abs(shown - 60) < 1,
    `REAL CHECK: the angle shown matches the NEAR wedge (60deg, the actual angle between the lines) not the supplementary 120deg - got ${editorEl.value}`
  );

  // FreeCAD's own Angle constraint does not reject an out-of-range value as
  // conflicting/redundant - confirmed via direct sketch.solve: it just finds
  // SOME solution, which for 400 degrees visibly relocates both lines away
  // from their shared vertex entirely. The fix validates the sane range
  // client-side instead of ever sending it to the solver.
  const before0 = G.sketch.entitySnapshot(lnH);
  const before1 = G.sketch.entitySnapshot(lnA);
  setInputValue(editorEl, '400');
  editorEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(300);

  note('notice after invalid (400deg) angle: ' + JSON.stringify(G.getState().notice));
  assert(
    !!G.getState().notice && /360|invalid|between/i.test(G.getState().notice),
    `REAL CHECK: typing an invalid angle (400) surfaces an error notice, not a silent no-op - got ${JSON.stringify(G.getState().notice)}`
  );

  const after0 = G.sketch.entitySnapshot(lnH);
  const after1 = G.sketch.entitySnapshot(lnA);
  note('lines unchanged after the rejected value: ' + JSON.stringify({ after0, after1 }));
  assert(
    JSON.stringify(before0) === JSON.stringify(after0) && JSON.stringify(before1) === JSON.stringify(after1),
    'REAL CHECK: the rejected angle never touched the geometry (no silent partial solve)'
  );

  // now a genuinely reasonable value SHOULD actually change the sketch
  note('dimPicks BEFORE 2nd attempt: ' + JSON.stringify(G.sketch.dimPicksState()));
  pressKey('d');
  await sleep(60);
  clickAt(lnHMidScreen.x, lnHMidScreen.y);
  await sleep(80);
  note('dimPicks after 2nd-round 1st click: ' + JSON.stringify(G.sketch.dimPicksState()));
  clickAt(lnAMidScreen.x, lnAMidScreen.y, { ctrlKey: true });
  await sleep(80);
  note('dimPicks after 2nd-round ctrl-click: ' + JSON.stringify(G.sketch.dimPicksState()));
  clickAt(wedgeScreen.x, wedgeScreen.y);
  await sleep(200);
  const editor2 = document.querySelector('.dim-editor input');
  assert(!!editor2, 'dimension editor reopened for a second attempt');
  note('editor2 initial value: ' + JSON.stringify(editor2 ? editor2.value : null));
  setInputValue(editor2, '30');
  editor2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(300);
  await idle();
  await sleep(200);
  note('ALL entities after 30deg attempt: ' + JSON.stringify(G.sketch.entities()));
  note('ALL constraints after 30deg attempt: ' + JSON.stringify(G.sketch.constraints()));
  const s0 = G.sketch.entitySnapshot(lnH);
  const s1 = G.sketch.entitySnapshot(lnA);
  note('lines after a VALID 30deg angle: ' + JSON.stringify({ s0, s1 }));
  const angA = (Math.atan2(s1.b[1] - s1.a[1], s1.b[0] - s1.a[0]) * 180) / Math.PI;
  const angH = (Math.atan2(s0.b[1] - s0.a[1], s0.b[0] - s0.a[0]) * 180) / Math.PI;
  const gotAngle = Math.abs(angA - angH);
  assert(
    Math.abs(gotAngle - 30) < 1,
    `REAL CHECK: a genuinely valid angle (30deg) actually changed the sketch - got ${gotAngle.toFixed(2)}deg between the lines`
  );
} else {
  assert(false, 'the floating angle dimension editor should have appeared after the placement click');
}

note('--- done ---');
