/* Real synthetic pointer events at the timeline scrubber itself (the actual
 * draggable marker element / chips at the bottom of the window), not just the
 * RPC methods it calls. Every earlier fix for "the scrubber won't go past the
 * sketch" (2026-09-11) was verified only through direct rpc('history.rollTo',
 * ...) calls - which proved the BACKEND state (marker position, visibility)
 * was correct, but never proved the on-screen widget itself actually reaches
 * that state when a real mouse drags it. This scenario closes that gap. */

function fireOn(el, type, x, y, extra) {
  const opts = Object.assign(
    {
      pointerId: 2,
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

/** drag an element from its own center to an absolute (x1,y1) client point.
 * A real mouse can never physically move within the same JS tick as its own
 * down event - React needs a commit + effect flush (setDragging(true) ->
 * the drag useEffect attaching window listeners) before the first move can
 * land on anything. So this yields once after pointerdown, same as any
 * genuine drag naturally would, instead of firing everything synchronously. */
async function dragElement(el, x1, y1) {
  const r = el.getBoundingClientRect();
  const x0 = r.left + r.width / 2;
  const y0 = r.top + r.height / 2;
  const held = { buttons: 1 };
  fireOn(el, 'pointerdown', x0, y0, held);
  await sleep(30);
  for (let i = 1; i <= 8; i++) {
    const x = x0 + ((x1 - x0) * i) / 8;
    const y = y0 + ((y1 - y0) * i) / 8;
    window.dispatchEvent(new PointerEvent('pointermove', Object.assign({ clientX: x, clientY: y, bubbles: true }, held)));
    await sleep(16);
  }
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: x1, clientY: y1, bubbles: true, buttons: 0 }));
}

function timelineChips() {
  return Array.from(document.querySelectorAll('.tl-chip'));
}

function timelineMarker() {
  return document.querySelector('.tl-marker');
}

note('reset document');
await rpc('session.reset');
await G.refresh();
await idle();

note('--- build Sketch -> Pad -> Fillet, then roll back and draw a NEW sketch mid-timeline ---');
const s1 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: s1.sketchId,
  elements: [{ type: 'rect', a: [-15, -15], b: [15, 15] }],
  constraints: []
});
await G.refresh();
await idle();
G.selectSketch(s1.sketchId);
await sleep(50);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10, midplane: false, reversed: false });
await idle();

let scene = await rpc('scene.get');
const mesh = scene.meshes[0];
await rpc('feature.fillet', { edges: ['Edge1'], radius: 1.0 });
await G.refresh();
await idle();

let tree = await rpc('tree.get');
let feats = tree.bodies[0].features;
const bodyId = tree.bodies[0].id;
const padFeat = feats.find((f) => f.opType === 'Extrude');
const filletFeat = feats.find((f) => f.opType === 'Fillet');
assert(padFeat && filletFeat, 'have both a Pad and a Fillet feature to work with');

// roll back to before the Fillet, then draw a sketch while rolled back
await rpc('history.rollTo', { bodyId, featureId: padFeat.id });
await G.refresh();
await idle();

const s2 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: s2.sketchId,
  elements: [{ type: 'line', a: [40, 40], b: [50, 40] }],
  constraints: []
});
await G.refresh();
await idle();

tree = await rpc('tree.get');
feats = tree.bodies[0].features;
const order = feats.map((f) => f.id);
note('feature order after drawing a sketch while rolled back: ' + JSON.stringify(order));
assert(order.indexOf(s2.sketchId) >= 0, 'the new sketch is in the timeline');
assert(order.indexOf(s2.sketchId) < order.indexOf(filletFeat.id), 'the new sketch sits BEFORE the Fillet in the real feature list');
assert(tree.bodies[0].marker === s2.sketchId, 'backend marker sits on the new sketch right after Finish (real RPC state)');

// -------------------------------------------------------------- the actual UI
note('--- the ACTUAL scrubber widget: does dragging the marker reach the sketch chip? ---');

let chips = timelineChips();
assert(chips.length === order.length, `one .tl-chip per feature (${chips.length} rendered vs ${order.length} features)`);

const sketchChipIdx = order.indexOf(s2.sketchId);
const sketchChip = chips[sketchChipIdx];
assert(sketchChip, 'the new sketch has a rendered chip element');

// where does the marker element ACTUALLY render right now (backend says it
// should be sitting right after the sketch chip)?
let marker = timelineMarker();
assert(marker, 'the marker element is rendered');
const markerRectBefore = marker.getBoundingClientRect();
const sketchChipRect = sketchChip.getBoundingClientRect();
note(
  'marker.left=' + markerRectBefore.left + ' sketchChip.right=' + sketchChipRect.right +
  ' sketchChip.left=' + sketchChipRect.left
);
assert(
  Math.abs(markerRectBefore.left - sketchChipRect.right) < 4,
  `the marker visually sits right after the sketch chip it is supposed to be on (marker@${markerRectBefore.left}, sketch chip ends@${sketchChipRect.right})`
);

// now drag the marker FORWARD onto the Fillet chip, using real pointer events
// on the actual DOM marker element - this is what the user's mouse does
const filletChipIdx = order.indexOf(filletFeat.id);
const filletChip = chips[filletChipIdx];
const filletRect = filletChip.getBoundingClientRect();
await dragElement(marker, filletRect.left + filletRect.width / 2, filletRect.top + filletRect.height / 2);
await sleep(150);
await idle();

tree = await rpc('tree.get');
note('backend marker after real drag onto the Fillet chip: ' + JSON.stringify(tree.bodies[0].marker));
assert(tree.bodies[0].marker === null, 'dragging the marker onto the LAST chip (Fillet) rolls to the true end (marker: null)');

// and the marker element itself must have visually moved past the sketch chip
marker = timelineMarker();
const markerRectAfter = marker.getBoundingClientRect();
assert(
  markerRectAfter.left > sketchChipRect.right + 10,
  `the marker actually moved past the sketch chip on screen after the real drag (was@${markerRectBefore.left}, now@${markerRectAfter.left}, sketch chip ends@${sketchChipRect.right})`
);

// drag it BACK onto the sketch chip and confirm it lands there too (not stuck)
await dragElement(marker, sketchChipRect.left + sketchChipRect.width / 2, sketchChipRect.top + sketchChipRect.height / 2);
await sleep(150);
await idle();
tree = await rpc('tree.get');
note('backend marker after dragging BACK onto the sketch chip: ' + JSON.stringify(tree.bodies[0].marker));
assert(tree.bodies[0].marker === s2.sketchId, 'dragging the marker back onto the sketch chip actually lands on it (not stuck on Fillet/Pad)');

marker = timelineMarker();
const markerRectBack = marker.getBoundingClientRect();
assert(
  Math.abs(markerRectBack.left - sketchChipRect.right) < 4,
  `the marker visually returns to right after the sketch chip (now@${markerRectBack.left}, sketch chip ends@${sketchChipRect.right})`
);

// --------------------------------------------------------------------------
// A sketch drawn AFTER everything else (the true end, not mid-timeline) -
// this is the user's ACTUAL file's exact structure (Sketch, Pad, Fillet,
// Sketch001) and their exact follow-up report: "it seems to happen when the
// last item in the tree is the sketch". markerAt's fallback used to resolve
// to the last SOLID feature's index (tipIdx, e.g. Fillet) whenever the
// marker was null/"at the end", instead of the real last index - so the
// scrubber visually rendered stuck one chip short of the trailing sketch,
// looking exactly like dragging to the end could never reach it, even
// though the backend had genuinely rolled all the way there.
note('--- sketch drawn AFTER the last solid (trailing, not mid-timeline) - the scrubber must visually reach it at the end ---');
await rpc('session.reset');
await G.refresh();
await idle();
{
  const sA = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: sA.sketchId,
    elements: [{ type: 'rect', a: [-15, -15], b: [15, 15] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.selectSketch(sA.sketchId);
  await sleep(50);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10, midplane: false, reversed: false });
  await idle();
  await rpc('feature.fillet', { edges: ['Edge1'], radius: 1.0 });
  await G.refresh();
  await idle();

  // now, WITHOUT rolling back, draw a second sketch - it lands at the true
  // end, after the Fillet
  const sB = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: sB.sketchId,
    elements: [{ type: 'line', a: [40, 40], b: [50, 40] }],
    constraints: []
  });
  await G.refresh();
  await idle();

  let tt = await rpc('tree.get');
  let ff = tt.bodies[0].features;
  const ord = ff.map((f) => f.id);
  note('trailing-sketch feature order: ' + JSON.stringify(ord));
  assert(ord[ord.length - 1] === sB.sketchId, 'the new sketch is genuinely the LAST feature (trailing, not mid-timeline)');
  assert(tt.bodies[0].marker === null, 'backend marker is null (truly at the end) right after drawing the trailing sketch');

  const chipsT = timelineChips();
  assert(chipsT.length === ord.length, `one chip per feature (${chipsT.length} vs ${ord.length})`);
  const lastChip = chipsT[chipsT.length - 1];
  const lastChipRect = lastChip.getBoundingClientRect();
  const mk = timelineMarker();
  const mkRect = mk.getBoundingClientRect();
  note('marker.left=' + mkRect.left + ' lastChip(sketch).right=' + lastChipRect.right);
  assert(
    Math.abs(mkRect.left - lastChipRect.right) < 4,
    `THE BUG: the scrubber marker must render right after the trailing sketch chip (the true end), not stuck at the previous solid feature (marker@${mkRect.left}, trailing sketch chip ends@${lastChipRect.right})`
  );

  // and the trailing sketch itself must not render as "rolled" / greyed out,
  // since we are genuinely at the end and nothing is ahead of it
  assert(!lastChip.className.includes('rolled'), 'the trailing sketch chip is not greyed out as "rolled" - it is the current end of history');
}

note('timeline_input scenario complete');
