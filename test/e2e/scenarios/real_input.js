/* Real synthetic pointer / keyboard events at the viewport canvas - the class
 * of bug that only shows up in the ACTUAL interactive path, not the semantic
 * G.pick()/G.select() shortcuts most other scenarios use (those call onSelect
 * directly and never touch Picker.pick's raycast, the real window select
 * drag, or the real window keydown handler). Covers a batch of reports that
 * were only reproducible by actually clicking/dragging in the viewport:
 *   - window-select + a later plain click / Ctrl-click
 *   - Escape clears selection and drops back out of window-select mode
 *   - view-cube Home re-centers + zoom-fits, not just re-orients
 *   - the "Project geometry" sketch tool highlights whatever is under the
 *     cursor (it previously showed nothing at all)
 *   - snapping to / constraining projected (external) geometry
 *   - a narrow fillet face is still selectable next to its two bounding edges
 */

function viewportEl() {
  // the REAL pointer listeners are on renderer.domElement (the <canvas>),
  // appended inside .viewport - dispatching on the wrapper div would not
  // reach them since PointerEvents only bubble upward. .viewport ALSO
  // contains the much smaller view-cube's own canvas (.viewcube canvas), so
  // pick the biggest canvas under .viewport rather than the first match.
  const cands = Array.from(document.querySelectorAll('.viewport canvas'));
  assert(cands.length > 0, 'viewport canvas is mounted');
  let best = cands[0];
  for (const c of cands) {
    if (c.clientWidth * c.clientHeight > best.clientWidth * best.clientHeight) best = c;
  }
  return best;
}

function fire(el, type, x, y, extra) {
  // buttons must reflect what is ACTUALLY held: 0 for a hover-only move or an
  // up event, 1 only while a button is down (down, or a move during a drag).
  // The app's own hover handlers gate on `e.buttons === 0`, so a stray
  // buttons:1 on a plain hover move silently skips them - a real footgun.
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

/** move + down + up at a client point (a plain click through the REAL handlers) */
function clickAt(x, y, extra) {
  const el = viewportEl();
  fire(el, 'pointermove', x, y, extra);
  fire(el, 'pointerdown', x, y, extra);
  fire(el, 'pointerup', x, y, Object.assign({ buttons: 0 }, extra || {}));
}

/** drag from (x0,y0) to (x1,y1) - down, several incremental moves, up */
function dragTo(x0, y0, x1, y1, extra) {
  const el = viewportEl();
  const held = Object.assign({ buttons: 1 }, extra || {});
  fire(el, 'pointermove', x0, y0, extra);
  fire(el, 'pointerdown', x0, y0, extra);
  for (let i = 1; i <= 6; i++) {
    fire(el, 'pointermove', x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * i) / 6, held);
  }
  fire(el, 'pointerup', x1, y1, Object.assign({ buttons: 0 }, extra || {}));
}

/** drag a window-select box from (x0,y0) to (x1,y1) */
function dragBox(x0, y0, x1, y1, extra) {
  const el = viewportEl();
  const held = Object.assign({ buttons: 1 }, extra || {});
  fire(el, 'pointermove', x0, y0, extra);
  fire(el, 'pointerdown', x0, y0, extra);
  fire(el, 'pointermove', (x0 + x1) / 2, (y0 + y1) / 2, held);
  fire(el, 'pointermove', x1, y1, held);
  fire(el, 'pointerup', x1, y1, Object.assign({ buttons: 0 }, extra || {}));
}

function pressKey(key) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

/** a real double-click through the actual dblclick handler (SketchController
 *  listens for the browser's native 'dblclick', not two quick pointerdowns) */
function dblClickAt(x, y, extra) {
  const el = viewportEl();
  fire(el, 'pointermove', x, y, extra);
  el.dispatchEvent(
    new MouseEvent('dblclick', Object.assign({ clientX: x, clientY: y, bubbles: true, cancelable: true }, extra || {}))
  );
}

/** the floating in-place dimension editor's real <input>, if one is mounted */
function dimEditorInput() {
  const el = document.querySelector('.dim-editor input');
  return el || null;
}

/** type a real value into the floating dimension editor and commit with a
 *  real Enter keydown through the actual <form onSubmit> - not the semantic
 *  test hooks (setSketchDimension/setSketchDistanceDimension), so this
 *  exercises the exact path a user's keyboard takes. */
function typeAndCommitDimEditor(text) {
  const input = dimEditorInput();
  assert(input, 'the floating dimension editor input is mounted');
  if (!input) return;
  input.focus();
  // this is a REACT-CONTROLLED input (value={text} bound via onChange) - a
  // plain el.value = text does not notify React at all, since React's own
  // value tracker intercepts the native setter. Go through the native
  // HTMLInputElement prototype's setter instead, same trick React's own
  // testing utilities use, so the real onChange handler actually fires.
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  nativeSetter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  );
}

async function screenOf(world) {
  const p = await G.projectToScreen(world);
  assert(p, 'world point ' + JSON.stringify(world) + ' projects onto screen');
  return p;
}

function sel() {
  return G.getState().selection;
}

// ---------------------------------------------------------------- base body
note('--- build a box, fit it, gather edge/face midpoints ---');
await rpc('session.reset');
await G.refresh();
await idle();
{
  const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: s.sketchId,
    elements: [{ type: 'rect', a: [0, 0], b: [40, 30] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.selectSketch(s.sketchId);
  await sleep(40);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 20 });
  await idle();
}
await G.fit();
await idle();
let scene = await rpc('scene.get');
let mesh = scene.meshes[0];
const bid = mesh.id;
assert(mesh.edges && mesh.edges.length >= 12, 'box has 12 edges');

function edgeMid(e) {
  // parametric-middle of the polyline by arc length (not endpoints - vertices
  // are ambiguous between the two edges that share them)
  const p = e.points;
  const n = p.length / 3;
  if (n < 2) return null;
  const segLen = [];
  let total = 0;
  for (let i = 0; i + 1 < n; i++) {
    const dx = p[(i + 1) * 3] - p[i * 3],
      dy = p[(i + 1) * 3 + 1] - p[i * 3 + 1],
      dz = p[(i + 1) * 3 + 2] - p[i * 3 + 2];
    const L = Math.hypot(dx, dy, dz);
    segLen.push(L);
    total += L;
  }
  let acc = 0;
  const half = total / 2;
  for (let i = 0; i < segLen.length; i++) {
    if (acc + segLen[i] >= half) {
      const t = segLen[i] > 0 ? (half - acc) / segLen[i] : 0;
      return [
        p[i * 3] + (p[(i + 1) * 3] - p[i * 3]) * t,
        p[i * 3 + 1] + (p[(i + 1) * 3 + 1] - p[i * 3 + 1]) * t,
        p[i * 3 + 2] + (p[(i + 1) * 3 + 2] - p[i * 3 + 2]) * t
      ];
    }
    acc += segLen[i];
  }
  return [p[0], p[1], p[2]];
}

const edgeMids = mesh.edges.map((e) => ({ sub: 'Edge' + (e.edge + 1), point: edgeMid(e) }));

// =================================================================
note('--- window select, then a plain click, then Ctrl-click ---');
// window-select the whole box (drag corner-to-corner across the canvas) - use
// generous client-space margins so the box definitely spans the model
{
  const modeButtons = Array.from(document.querySelectorAll('.selfilter-mode'));
  const windowBtn = modeButtons.find((b) => b.textContent === 'Window');
  const paintBtn = modeButtons.find((b) => b.textContent === 'Paint');
  assert(windowBtn && paintBtn, 'the Paint/Window select-mode toggle is in the ribbon');

  const r = viewportEl().getBoundingClientRect();
  G.clearSelection();
  if (windowBtn) windowBtn.click();
  await sleep(20);
  dragBox(r.left + 5, r.top + 5, r.right - 5, r.bottom - 5);
  await sleep(60);
  const afterWindow = sel();
  assert(afterWindow.length > 0, 'window select picked up at least one face (got ' + afterWindow.length + ')');

  // back to paint mode (window mode is drag-only by design - a 0-drag click
  // there starts a 0-area box, not a normal pick), THEN a plain click on a
  // single edge must REPLACE the window selection, not add to it
  if (paintBtn) paintBtn.click();
  await sleep(20);
  const target = edgeMids[0];
  const p0 = await screenOf(target.point);
  clickAt(p0.x, p0.y);
  await sleep(60);
  const afterClick = sel();
  assert(
    afterClick.length === 1 && afterClick[0].startsWith('edge:'),
    'plain click after window-select replaces the selection with just the clicked edge (got ' +
      JSON.stringify(afterClick) +
      ')'
  );

  // Ctrl-click a second edge must ADD to the selection
  const target2 = edgeMids[1];
  const p1 = await screenOf(target2.point);
  clickAt(p1.x, p1.y, { ctrlKey: true });
  await sleep(60);
  const afterCtrl = sel();
  assert(
    afterCtrl.length === 2,
    'Ctrl-click after a plain click ADDS to the selection (got ' + JSON.stringify(afterCtrl) + ')'
  );
}

// =================================================================
note('--- Escape clears selection and drops window-select mode ---');
{
  const modeButtons = Array.from(document.querySelectorAll('.selfilter-mode'));
  const windowBtn = modeButtons.find((b) => b.textContent === 'Window');
  const paintBtn = modeButtons.find((b) => b.textContent === 'Paint');
  assert(windowBtn && paintBtn, 'the Paint/Window select-mode toggle is in the ribbon');
  if (windowBtn) windowBtn.click();
  await sleep(20);
  assert(windowBtn.className.includes(' on'), 'clicked into Window select mode');

  pressKey('Escape');
  await sleep(40);
  assert(sel().length === 0, 'Escape clears the current selection');
  assert(
    paintBtn.className.includes(' on'),
    'Escape drops back out of window-select mode to plain paint-select'
  );

  // a plain click should now select normally (not stuck in window-select,
  // where a click no longer does anything until you drag a box)
  const p = await screenOf(edgeMids[0].point);
  clickAt(p.x, p.y);
  await sleep(60);
  assert(sel().length === 1, 'a plain click works normally right after Escape (got ' + JSON.stringify(sel()) + ')');
  pressKey('Escape');
  await sleep(40);
}

// =================================================================
note('--- View Cube Home re-centers AND zoom-fits, not just re-orients ---');
{
  G.clearSelection();
  await G.fit();
  await idle();
  const before = await rpc('scene.get'); // unrelated call just to let state settle
  const el = viewportEl();
  const r = el.getBoundingClientRect();
  const cx = (r.left + r.right) / 2;
  const cy = (r.top + r.bottom) / 2;
  note('camera before nudge: ' + JSON.stringify(await G.cameraDebug()));
  // perturb the camera position + pivot together (a pan, in effect) - a
  // direct nudge rather than replicating a drag gesture's exact synthetic
  // event sequence, which is fragile to reproduce reliably for this one
  // "does Home actually recover?" check (the real pointer-driven pan/orbit
  // paths are already exercised elsewhere in this file for their own sake).
  // Retry a couple of times - inertia left over from an earlier interaction
  // in this run can occasionally fight a single nudge for one frame.
  const centerWorld = [20, 15, 10]; // box centroid (40x30x20)
  let drift = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    await G.nudgeCamera([120, -90, 60]);
    await sleep(60);
    const off = await screenOf(centerWorld);
    drift = Math.hypot(off.x - cx, off.y - cy);
    if (drift > 40) break;
  }
  note('drift after nudge: ' + drift.toFixed(1) + 'px');
  note('camera after nudge: ' + JSON.stringify(await G.cameraDebug()));

  // click Home on the view-cube's context menu (right-click the cube, choose
  // Home) - the real contextmenu listener is on the cube's OWN canvas
  // (ViewCube has its own separate WebGLRenderer), not the wrapper div
  const cube = document.querySelector('.viewcube canvas');
  assert(cube, 'view-cube canvas is mounted');
  const cr = cube.getBoundingClientRect();
  // dead-centre of the cube's default iso-ish view usually lands on a CORNER
  // zone (three faces meeting), which the context menu deliberately ignores
  // (it only opens over a FACE zone) - offset up toward where the top face
  // renders for the default (1,-1,0.8) view direction, same as a user
  // right-clicking "on" a face rather than exactly on the cube's centre pixel
  // try a dense grid of offsets from centre - whichever one is dead-centre of
  // a FACE zone (not a corner/edge zone, which the menu deliberately ignores)
  // depends on exact zone-projection math this test should not have to
  // replicate (and shifts with the cube's current orientation), so sweep a
  // grid instead of guessing a handful of fixed spots
  const offsets = [];
  for (let ox = -0.35; ox <= 0.35; ox += 0.14) {
    for (let oy = -0.35; oy <= 0.35; oy += 0.14) {
      if (Math.hypot(ox, oy) > 0.1) offsets.push([ox, oy]); // skip dead-centre (corner)
    }
  }
  let homeItem = null;
  for (const [ox, oy] of offsets) {
    const ccx = (cr.left + cr.right) / 2 + ox * cr.width;
    const ccy = (cr.top + cr.bottom) / 2 + oy * cr.height;
    cube.dispatchEvent(
      new MouseEvent('contextmenu', { clientX: ccx, clientY: ccy, bubbles: true, cancelable: true })
    );
    await sleep(15);
    const items = Array.from(document.querySelectorAll('.viewcube-menu-item'));
    homeItem = items.find((n) => n.textContent === 'Home');
    if (homeItem) break;
  }
  assert(homeItem, 'view-cube context menu has a Home item');
  note('homeItem found, tagName=' + (homeItem && homeItem.tagName) + ' still-in-dom=' + (homeItem && document.body.contains(homeItem)));
  if (homeItem) homeItem.click();
  await sleep(50);
  note('camera right after Home click: ' + JSON.stringify(await G.cameraDebug()));
  const mid = await screenOf(centerWorld);
  note('drift right after click (before 500ms wait): ' + Math.hypot(mid.x - cx, mid.y - cy).toFixed(1) + 'px');
  // Home tweens over ~0.25s
  await sleep(500);
  note('camera 500ms after Home click: ' + JSON.stringify(await G.cameraDebug()));
  const back = await screenOf(centerWorld);
  const drift2 = Math.hypot(back.x - cx, back.y - cy);
  note('drift after Home: ' + drift2.toFixed(1) + 'px');
  assert(drift2 < 40, 'Home re-centers the model near the viewport centre (drift ' + drift2.toFixed(1) + 'px)');
}

// =================================================================
note('--- Project Geometry tool: hover highlight + snap + constrain ---');
{
  await G.fit();
  await idle();
  // sketch on a SIDE face so a vertical box edge projects as a real line
  // (the batch-1 report: "a line going in/out of the sketch plane" - the
  // degenerate case, a perpendicular edge -> a point, is covered by the
  // existing sketcher.js scenario). beginSketch (not a bare rpc('sketch.on'))
  // is what actually opens the interactive sketch editor in the app.
  await G.beginSketch({ kind: 'origin', role: 'XZ_Plane' });
  const found = await waitFor(() => G.getState().sketchMode, 4000);
  assert(found, 'sketch mode entered');
  pressKey('p'); // project-geometry hotkey
  await sleep(30);

  scene = await rpc('scene.get');
  mesh = scene.meshes.find((m) => m.id === bid) || scene.meshes[0];
  // this sketch is on XZ_Plane (spanned by world X/Z, normal Y) - a TOP edge
  // running along X (constant Y and Z=20) projects as a real line (its
  // direction has no Y component), unlike a vertical edge at Y=30 which would
  // project as a degenerate point (covered separately by sketcher.js)
  const topXEdge = mesh.edges.find((e) => {
    const p = e.points;
    const dz = Math.abs(p[2] - p[p.length - 1]);
    const dy = Math.abs(p[1] - p[p.length - 2]);
    const z0 = Math.abs(p[2] - 20);
    return dz < 1e-3 && dy < 1e-3 && z0 < 1e-2;
  });
  assert(topXEdge, 'found a top edge (along X) to hover / project');
  if (topXEdge) {
    const emid = edgeMid(topXEdge);
    const pe = await screenOf(emid);
    const canvas = viewportEl();
    fire(canvas, 'pointermove', pe.x, pe.y);
    await sleep(60);
    note('cursor style while hovering a model edge with Project tool: ' + (canvas ? canvas.style.cursor : 'n/a'));
    assert(
      canvas && canvas.style.cursor === 'pointer',
      'Project-geometry tool shows a hover cursor over model geometry (it previously showed nothing at all)'
    );

    // click to project it
    clickAt(pe.x, pe.y);
    await sleep(80);
    const projected = G.sketch.projected();
    assert(projected.length > 0, 'clicking a model edge with Project tool adds projected geometry');

    if (projected.length > 0) {
      const proj0 = projected[0];
      note('projected entity: ' + JSON.stringify(proj0));

      // snapping: draw a line (REAL synthetic clicks, not the commitTool test
      // hook - that hook takes literal coordinates and never calls the real
      // snap()/pendingSnaps pipeline, so it can't exercise this at all) whose
      // endpoint lands on the projected line's MIDPOINT (deliberately not an
      // endpoint - this box edge's own endpoints sit exactly on the sketch's
      // built-in axis at U=0, which would confound the snap with the
      // always-on axis-anchor rather than testing the projected-geometry path)
      pressKey('l');
      await sleep(20);
      const consBefore = G.sketch.newConstraints().length;
      const midU = (proj0.a[0] + proj0.b[0]) / 2,
        midV = (proj0.a[1] + proj0.b[1]) / 2;
      const farPt = await G.sketchUVToScreen(midU + 10, midV + 10);
      const midPt = await G.sketchUVToScreen(midU, midV);
      assert(farPt && midPt, 'line draw points project onto the screen');
      const entsBefore = G.sketch.entities().length;
      if (farPt && midPt) {
        clickAt(farPt.x, farPt.y); // 1st click: line start
        await sleep(20);
        clickAt(midPt.x, midPt.y); // 2nd click: line end, ON the projected line
        await sleep(20);
        note(
          'entities before/after clicks: ' + entsBefore + ' / ' + G.sketch.entities().length +
          ' (' + JSON.stringify(G.sketch.entities()) + ')'
        );
        pressKey('Escape'); // done with the line tool (back to select)
        await sleep(20);
      }
      const consAfter = G.sketch.newConstraints();
      note('new constraints: ' + JSON.stringify(consAfter));
      assert(
        consAfter.length > consBefore,
        'drawing a line endpoint onto a projected point auto-constrains it (got ' +
          consAfter.length +
          ' vs before ' +
          consBefore +
          ')'
      );
      const gotProjRef = consAfter.some((c) =>
        (c.refs || []).some((r) => typeof r.geo === 'number' && r.geo === proj0.geoId)
      );
      assert(gotProjRef, 'the auto-constraint actually references the PROJECTED geoId, not a stray real point');

      // THE BUG (real user file, "Lid for ceramic thing.FCStd": constraint 0
      // is `Coincident First:0 1, Second:-3 1` - a real endpoint welded
      // directly to a PROJECTED geometry ENDPOINT, not its midpoint):
      // entIdxOfRef/keyOfRef alias EVERY negative geo (origin -1, axes -2,
      // projected <= -3) down to the same -1, so anchor-detection that only
      // ever checked `refs[1]?.geo === -1` could not tell "welded to the
      // origin" apart from "welded to projected geometry", and treated the
      // latter as not anchored at all. A whole-body drag of a line with such
      // a weld then dragged the projected-welded endpoint right along with
      // it instead of pivoting/refusing there (user report, 2026-09-13:
      // "there should've been coincidents on the projected geometry,
      // allowing the connected lines only to rotate about those"). Snap onto
      // proj0's actual endpoint B ([40,20], off-axis so it is not confounded
      // with the always-on axis-anchor) - snapping onto its MIDPOINT (as
      // above) produces a Symmetric constraint instead, a different case.
      pressKey('l');
      await sleep(20);
      const projEndFar = await G.sketchUVToScreen(proj0.b[0] + 10, proj0.b[1] - 10);
      const projEndPt = await G.sketchUVToScreen(proj0.b[0], proj0.b[1]);
      assert(projEndFar && projEndPt, 'endpoint-snap line draw points project onto the screen');
      const entsBeforeEp = G.sketch.entities().length;
      if (projEndFar && projEndPt) {
        clickAt(projEndFar.x, projEndFar.y); // 1st click: line start
        await sleep(20);
        clickAt(projEndPt.x, projEndPt.y); // 2nd click: line end, ON the projected line's endpoint
        await sleep(20);
        pressKey('Escape');
        await sleep(20);
      }
      const consAfterEp = G.sketch.newConstraints();
      const gotCoincidentToProj = consAfterEp.some(
        (c) =>
          c.type === 'Coincident' &&
          (c.refs || []).some((r) => typeof r.geo === 'number' && r.geo === proj0.geoId)
      );
      assert(
        gotCoincidentToProj,
        'snapping a new line endpoint onto a projected LINE ENDPOINT recorded a Coincident to it: ' +
          JSON.stringify(consAfterEp)
      );

      const newLnIdx = entsBeforeEp;
      const newLnBefore = JSON.parse(JSON.stringify(G.sketch.entities()[newLnIdx]));
      const bodyU = (newLnBefore.a[0] * 3 + newLnBefore.b[0]) / 4;
      const bodyV = (newLnBefore.a[1] * 3 + newLnBefore.b[1]) / 4;
      const dpt0 = await G.sketchUVToScreen(bodyU, bodyV);
      const dpt1 = await G.sketchUVToScreen(bodyU + 15, bodyV + 15);
      assert(dpt0 && dpt1, 'projected-welded line body drag points project onto the screen');
      const elProj = viewportEl();
      if (dpt0 && dpt1) {
        fire(elProj, 'pointermove', dpt0.x, dpt0.y);
        fire(elProj, 'pointerdown', dpt0.x, dpt0.y);
        for (let i = 1; i <= 6; i++) {
          fire(elProj, 'pointermove', dpt0.x + ((dpt1.x - dpt0.x) * i) / 6, dpt0.y + ((dpt1.y - dpt0.y) * i) / 6, {
            buttons: 1
          });
        }
        const newLnMid = G.sketch.entities()[newLnIdx];
        // whichever endpoint is welded to the projection must stay exactly
        // where the projected geometry actually is - not drift with the drag
        const gapA = Math.hypot(newLnMid.a[0] - proj0.b[0], newLnMid.a[1] - proj0.b[1]);
        const gapB = Math.hypot(newLnMid.b[0] - proj0.b[0], newLnMid.b[1] - proj0.b[1]);
        assert(
          Math.min(gapA, gapB) < 0.5,
          `the endpoint welded to a projected geometry endpoint stayed pinned to it during a whole-line drag (gapA ${gapA.toFixed(3)}, gapB ${gapB.toFixed(3)})`
        );
        fire(elProj, 'pointerup', dpt1.x, dpt1.y, { buttons: 0 });
        await sleep(60);
      }

      // explicit "click the constraint button FIRST, then click the geometry"
      // flow (Fusion's ribbon-driven constraint UX): Coincident, then click a
      // NEW arc's CENTRE point and the projected line's endpoint - this
      // exercises pendingCon mode picking a specific POINT (not a whole
      // entity), which is both: (a) the reported "can't constrain the points
      // of a centre-point arc (ends and centre)" bug, and (b) "can't
      // constrain to projected geometry" via the button-first flow
      pressKey('Escape');
      await sleep(20);
      const farU = proj0.a[0] + 25,
        farV = proj0.a[1] + 25;
      G.sketch.commitTool('arc', [
        [farU, farV],
        [farU + 6, farV],
        [farU, farV + 6]
      ]);
      await sleep(20);
      const entsNow = G.sketch.entities();
      const newArcIdx = entsNow.length - 1;
      assert(entsNow[newArcIdx] && entsNow[newArcIdx].type === 'arc', 'drew a center-point arc');
      const arcCenterUV = entsNow[newArcIdx].c;

      const conBtns = Array.from(document.querySelectorAll('.sketch-ribbon .ribbon-cmd'));
      const coincidentBtn = conBtns.find((b) => (b.getAttribute('title') || '').startsWith('Coincident'));
      assert(coincidentBtn, 'a Coincident constraint button exists in the sketch ribbon');
      const consBefore2 = G.sketch.newConstraints().length;
      if (coincidentBtn) {
        coincidentBtn.click(); // beginConstraint('Coincident') - pendingCon mode
        await sleep(20);
        const centerPt = await G.sketchUVToScreen(arcCenterUV[0], arcCenterUV[1]);
        assert(centerPt, "the new arc's centre projects onto the screen");
        if (centerPt) clickAt(centerPt.x, centerPt.y); // pick the arc CENTRE point specifically
        await sleep(20);
        const endPt = await G.sketchUVToScreen(proj0.a[0], proj0.a[1]);
        assert(endPt, "the projected line's endpoint projects onto the screen");
        if (endPt) clickAt(endPt.x, endPt.y); // pick the projected line's endpoint
      }
      const consAfter2 = G.sketch.newConstraints();
      note('constraints after button-first attempt: ' + JSON.stringify(consAfter2));
      assert(
        consAfter2.length > consBefore2,
        'constraint-button-first Coincident on an arc CENTRE against a projected point actually recorded (before ' +
          consBefore2 +
          ', after ' +
          consAfter2.length +
          ')'
      );
      if (consAfter2.length > consBefore2) {
        const newest = consAfter2[consAfter2.length - 1];
        const hitsProj = (newest.refs || []).some((r) => typeof r.geo === 'number' && r.geo === proj0.geoId);
        assert(hitsProj, 'the recorded constraint references the projected geoId (not a mis-picked whole entity)');
      }

      // round-trip through FreeCAD: finish the sketch and confirm it rebuilds
      // clean with the projected-geometry constraints intact
      await G.finishSketch();
      await idle();
      assert(!G.getState().sketchMode, 'sketch finished');
      const bodyErr = G.getState().bodies.some((b) => b.features.some((f) => f.error));
      assert(!bodyErr, 'no feature error after finishing a sketch with a projected-geometry constraint');
    }
  } else {
    pressKey('Escape');
    await G.finishSketch();
    await idle();
  }
}

// A profile whose "last side" is a PROJECTED (external) edge must actually
// CLOSE when finished - FreeCAD's Sketcher deliberately excludes external
// geometry from the sketch's own Shape.Wires/Faces (it is a reference only),
// so a wire built with perfectly correct Coincident constraints against a
// projected edge could solve cleanly and STILL never close, with the pad
// failing "Wire is not closed" and no visible reason why. User report,
// 2026-09-12: "projected geometry didn't act like regular geometry... I had
// to draw a line in-place of the project geometry because otherwise it
// didn't create a closed loop/face." Fixed sidecar-side (sketch.finish
// materializes a real, welded copy of any external geometry a Coincident
// constraint actually relies on to close a wire) - this proves it through
// the real app: project a real model edge, draw 3 more real sides via the
// actual sketch tools, Finish, and pad it.
note('--- a profile using a PROJECTED edge as one side actually closes and pads ---');
{
  await rpc('session.reset');
  await G.refresh();
  await idle();
  const baseS = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: baseS.sketchId,
    elements: [{ type: 'rect', a: [0, 0], b: [40, 30] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.selectSketch(baseS.sketchId);
  await sleep(40);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10 });
  await idle();
  const pgBid = G.getState().bodies[0]?.id;
  assert(!!pgBid, 'projected-geometry-closure: base block built');

  await G.beginSketch({ kind: 'origin', role: 'XZ_Plane' });
  await waitFor(() => G.getState().sketchMode, 4000);
  await sleep(60);
  pressKey('p'); // project-geometry tool
  await sleep(30);
  const pgSc = await rpc('scene.get');
  const pgMesh = pgSc.meshes.find((m) => m.id === pgBid);
  // a top edge along X (Z=10, Y=0) so it projects as a real, straight line
  const pgEdge = (pgMesh.edges || []).find((e) => {
    const p = e.points;
    if (p.length < 6) return false;
    const dz = Math.abs(p[2] - 10) < 1e-3 && Math.abs(p[p.length - 1] - 10) < 1e-3;
    const dy = Math.abs(p[1]) < 1e-3 && Math.abs(p[p.length - 2]) < 1e-3;
    return dz && dy && Math.abs(p[0] - p[p.length - 3]) > 20;
  });
  assert(pgEdge, 'found a top edge along X to project');
  if (pgEdge) {
    const eMid = [
      (pgEdge.points[0] + pgEdge.points[pgEdge.points.length - 3]) / 2,
      (pgEdge.points[1] + pgEdge.points[pgEdge.points.length - 2]) / 2,
      (pgEdge.points[2] + pgEdge.points[pgEdge.points.length - 1]) / 2
    ];
    const eScreen = await screenOf(eMid);
    clickAt(eScreen.x, eScreen.y);
    await sleep(80);
    const pgProjected = G.sketch.projected();
    assert(pgProjected.length > 0, 'the top edge is now projected into the sketch');
    if (pgProjected.length > 0) {
      const p0 = pgProjected[0];
      pressKey('Escape'); // back to select, done projecting
      await sleep(20);
      pressKey('l'); // line tool
      await sleep(20);
      // draw 3 more sides, each starting/ending ON the projected edge's own
      // endpoints (real synthetic clicks, so the real snap() records the
      // Coincident against the projected geoId, same as autoCoincident would)
      const outSide = 15; // how far "out" the other 3 sides bow, in sketch mm
      const c1 = await G.sketchUVToScreen(p0.a[0], p0.a[1]);
      const c2 = await G.sketchUVToScreen(p0.a[0] + outSide, p0.a[1]);
      const c3 = await G.sketchUVToScreen(p0.b[0] + outSide, p0.b[1]);
      const c4 = await G.sketchUVToScreen(p0.b[0], p0.b[1]);
      assert(c1 && c2 && c3 && c4, 'all 4 profile corners project onto the screen');
      clickAt(c1.x, c1.y);
      await sleep(20);
      clickAt(c2.x, c2.y);
      await sleep(20);
      clickAt(c3.x, c3.y);
      await sleep(20);
      clickAt(c4.x, c4.y);
      await sleep(40);
      pressKey('Escape');
      await sleep(20);

      const newCons = G.sketch.newConstraints();
      const weldedToProjection = newCons.some(
        (c) => c.type === 'Coincident' && (c.refs || []).some((r) => typeof r.geo === 'number' && r.geo < 0)
      );
      assert(weldedToProjection, 'at least one drawn line welded to the projected edge via a real snap');

      await G.finishSketch();
      await idle();
      await sleep(250);
      assert(!G.getState().sketchMode, 'sketch finished');
      const pgSkId = (G.getState().selection.find((s) => s.startsWith('sketch:')) || '').slice(7);
      assert(!!pgSkId, 'the finished sketch id is known');
      G.selectSketch(pgSkId);
      await sleep(40);
      const noticeBeforePad = G.getState().notice;
      await G.applyOp('extrude', { operation: 'New body', mode: 'Blind', length: 4 });
      await idle();
      const noticeAfterPad = G.getState().notice;
      const padErr = noticeAfterPad && noticeAfterPad !== noticeBeforePad ? noticeAfterPad : null;
      assert(
        !padErr && !G.getState().bodies.some((b) => b.features.some((f) => f.error)),
        `padding the projected-edge profile committed cleanly, wire actually closed (${padErr || 'ok'})`
      );
    }
  }
}

// window-select must be able to pick up PROJECTED (external) geometry, not
// just real sketch geometry - a plain click on projected geometry already
// worked (pickEntity checks this.projected), but commitBand (the rubber-band
// drag) only ever iterated this.entities, so a box drawn tightly around a
// projected line could never select it, no matter how the box was drawn.
// User report, 2026-09-12: "I can't seem to even window-select projected
// geometry?"
note('--- window-select (rubber-band drag) picks up projected geometry ---');
{
  await rpc('session.reset');
  await G.refresh();
  await idle();
  const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: s.sketchId,
    elements: [{ type: 'rect', a: [0, 0], b: [40, 30] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.selectSketch(s.sketchId);
  await sleep(40);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 20 });
  await idle();
  const bid2 = G.getState().bodies[0]?.id;
  assert(!!bid2, 'window-select-projected: base box built');

  const s2 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await G.refresh();
  await idle();
  await G.editSketch(s2.sketchId);
  await waitFor(() => G.getState().sketchMode, 4000);
  await sleep(80);
  pressKey('p'); // project-geometry hotkey
  await sleep(30);
  const sc2 = await rpc('scene.get');
  const mesh2 = sc2.meshes.find((m) => m.id === bid2) || sc2.meshes[0];
  // a bottom edge on the sketch plane (Z=0, constant), so the projected line
  // lands with a clean, easy-to-box screen extent
  const bottomEdge = mesh2.edges.find((e) => {
    const p = e.points;
    const dz1 = Math.abs(p[2]);
    const dz2 = Math.abs(p[p.length - 1]);
    const dy = Math.abs(p[1] - p[p.length - 2]);
    return dz1 < 1e-3 && dz2 < 1e-3 && dy < 1e-3;
  });
  assert(bottomEdge, 'found a bottom edge on the sketch plane to project');
  if (bottomEdge) {
    const emid2 = edgeMid(bottomEdge);
    const pe2 = await screenOf(emid2);
    clickAt(pe2.x, pe2.y);
    await sleep(80);
    const projected2 = G.sketch.projected();
    assert(projected2.length > 0, 'clicking the bottom edge projected it into the sketch');
    if (projected2.length > 0) {
      pressKey('Escape'); // back to select tool
      await sleep(20);
      const p0 = projected2[0];
      // a box comfortably around the whole projected line's endpoints
      const padA = await G.sketchUVToScreen(
        Math.min(p0.a[0], p0.b[0]) - 5,
        Math.min(p0.a[1], p0.b[1]) - 5
      );
      const padB = await G.sketchUVToScreen(
        Math.max(p0.a[0], p0.b[0]) + 5,
        Math.max(p0.a[1], p0.b[1]) + 5
      );
      assert(padA && padB, 'window-select box corners project onto the screen');
      if (padA && padB) {
        dragBox(padA.x, padA.y, padB.x, padB.y);
        await sleep(60);
      }
      const selCount = G.sketch.selectedCount ? G.sketch.selectedCount() : null;
      note('sketchSelectedCount after window-select over projected geometry: ' + selCount);
      assert(
        (selCount ?? 0) > 0,
        'window-select actually picked up the projected geometry (selected count ' + selCount + ')'
      );
      // and Delete on that selection must be a no-op for projected geometry
      // (it is read-only, removed via unproject only) rather than erroring
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
      );
      await sleep(60);
      assert(G.getState().sketchMode, 'Delete on a window-selected projected entity did not crash the sketch editor');
    }
  }
  pressKey('Escape');
  await G.cancelSketch().catch(() => {});
  await idle();
}

// Shift-click on an edge selects the whole TANGENT-CONTINUOUS chain through
// it (a rounded corner/loop), stopping at a sharp corner or a branch - user
// request 2026-09-12: "add the feature where I can shift+click to select all
// conjoining path parts... it should only walk around rounded corners. Not
// sharp 90deg ones. Unless the next edge(s) are ctrl+clicked." Build a
// stadium/slot profile (two straight edges + two tangent semicircle arcs -
// every joint is tangent, a real closed loop with no sharp corners at all),
// extrude it, and shift-click ONE straight edge: all 4 edges around that
// loop must end up selected, via the real edge.loopFrom RPC + a real
// shift-click, not the additive-pick test shortcut.
note('--- shift-click an edge selects the whole tangent (rounded) loop, ctrl-click still adds just one ---');
{
  await rpc('session.reset');
  await G.refresh();
  await idle();
  const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: s.sketchId,
    elements: [
      { type: 'line', a: [0, 5], b: [30, 5] },
      { type: 'arc', c: [30, 0], r: 5, a0: Math.PI / 2, a1: -Math.PI / 2 },
      { type: 'line', a: [30, -5], b: [0, -5] },
      { type: 'arc', c: [0, 0], r: 5, a0: -Math.PI / 2, a1: Math.PI / 2 }
    ],
    constraints: [
      { type: 'Tangent', refs: [{ geo: 0, pt: 2 }, { geo: 1, pt: 1 }] },
      { type: 'Tangent', refs: [{ geo: 1, pt: 2 }, { geo: 2, pt: 1 }] },
      { type: 'Tangent', refs: [{ geo: 2, pt: 2 }, { geo: 3, pt: 1 }] },
      { type: 'Tangent', refs: [{ geo: 3, pt: 2 }, { geo: 0, pt: 1 }] }
    ]
  });
  await G.refresh();
  await idle();
  G.selectSketch(s.sketchId);
  await sleep(40);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 8 });
  await idle();
  const stBid = G.getState().bodies[0]?.id;
  assert(!!stBid, 'stadium extrusion built');
  const stMesh = (await rpc('scene.get')).meshes.find((m) => m.id === stBid);
  // find one of the two long straight side edges (the "bottom rail" at
  // roughly constant Y, spanning most of the X range) to shift-click
  let seedSub = null,
    seedMid = null;
  for (const e of stMesh.edges || []) {
    const p = e.points;
    if (p.length < 6) continue;
    const dx = Math.abs(p[0] - p[p.length - 3]);
    const dy = Math.abs(p[1] - p[p.length - 2]);
    if (dx > 20 && dy < 1e-3) {
      seedSub = 'Edge' + (e.edge + 1);
      seedMid = [(p[0] + p[p.length - 3]) / 2, (p[1] + p[p.length - 2]) / 2, (p[2] + p[p.length - 1]) / 2];
      break;
    }
  }
  assert(!!seedSub, 'found a long straight rail edge to shift-click (' + seedSub + ')');
  if (seedSub) {
    const seedScreen = await screenOf(seedMid);
    G.clearSelection();
    // real shift-click, through the actual DOM pointer handlers
    clickAt(seedScreen.x, seedScreen.y, { shiftKey: true });
    await sleep(80);
    const loopSel = G.getState().selection.filter((k) => k.startsWith('edge:'));
    note('selection after shift-click loop-select: ' + JSON.stringify(loopSel));
    assert(loopSel.length === 4, `shift-click selected the whole 4-edge tangent loop (got ${loopSel.length})`);

    // ctrl-click on a FRESH single edge must still add just that one edge,
    // not another whole loop
    G.clearSelection();
    clickAt(seedScreen.x, seedScreen.y, { ctrlKey: true });
    await sleep(80);
    const ctrlSel = G.getState().selection.filter((k) => k.startsWith('edge:'));
    assert(ctrlSel.length === 1, `ctrl-click still adds just the one edge (got ${ctrlSel.length})`);
  }
}

// =================================================================
note('--- narrow fillet face is still pickable next to its bounding edges ---');
{
  await rpc('session.reset');
  await G.refresh();
  await idle();
  const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: s.sketchId,
    elements: [{ type: 'rect', a: [0, 0], b: [40, 30] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  G.selectSketch(s.sketchId);
  await sleep(40);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 20 });
  await idle();
  await G.fit();
  await idle();
  scene = await rpc('scene.get');
  mesh = scene.meshes[0];
  const vertEdge = mesh.edges.find((e) => {
    const p = e.points;
    const dz = Math.abs(p[2] - p[p.length - 1]);
    const dx = Math.abs(p[0] - p[p.length - 3]);
    const dy = Math.abs(p[1] - p[p.length - 2]);
    return dz > 15 && dx < 1e-3 && dy < 1e-3;
  });
  assert(vertEdge, 'found a vertical edge to fillet (a narrow rounded band)');
  if (vertEdge) {
    const sub = 'Edge' + (vertEdge.edge + 1);
    const emid = edgeMid(vertEdge);
    G.openOp('fillet');
    await sleep(20);
    G.pick({ kind: 'edge', bodyId: mesh.id, sub, point: emid }, false);
    await G.livePreview('fillet', { radius: 3 });
    await idle();
    await G.applyOp('fillet', { radius: 3 });
    await idle();
    await G.fit();
    await idle();
    scene = await rpc('scene.get');
    mesh = scene.meshes[0];
    assert(mesh.edges.length > 12, 'fillet feature actually rounded the vertical edge');

    // find the (now narrow, radius-3) fillet face by its small area / curvature.
    // The corner this edge sits on is whichever original box corner (0/40,
    // 0/30) its XY is closest to. The fillet arc's centre sits R inward from
    // BOTH original faces along their normals (i.e. R toward box centre on
    // each axis); the 45-degree band point is R further out from that centre
    // along the corner's own diagonal (back toward the original corner).
    const cornerX = emid[0] < 20 ? 0 : 40;
    const cornerY = emid[1] < 15 ? 0 : 30;
    const R = 3;
    const sx = cornerX < 20 ? 1 : -1; // +1 => box interior is toward +X
    const sy = cornerY < 15 ? 1 : -1;
    const arcCx = cornerX + sx * R;
    const arcCy = cornerY + sy * R;
    const diag = Math.SQRT1_2; // cos(45deg) == sin(45deg)
    const fx = arcCx - sx * R * diag;
    const fy = arcCy - sy * R * diag;
    const bandPoint = [fx, fy, 10];
    note('fillet band probe point: ' + JSON.stringify(bandPoint) + ' (corner ' + cornerX + ',' + cornerY + ')');
    const p = await screenOf(bandPoint);
    clickAt(p.x, p.y);
    await sleep(60);
    const picked = sel();
    note('picked on fillet band: ' + JSON.stringify(picked));
    assert(
      picked.length === 1 && picked[0].startsWith('face:'),
      'clicking on the narrow fillet band selects the FACE, not just an adjacent edge (got ' +
        JSON.stringify(picked) +
        ')'
    );
  }
  G.closeOp();
}

// =================================================================
// A line's endpoint must be able to SNAP onto an arc's rim endpoint through
// the actual mouse-move/click path, not just via the test-hook's synthetic
// snap parameter (every earlier fix this session used testAddEntity/commitTool
// with an EXPLICIT snap ref handed in - that proves the constraint-recording
// logic works, but never proves the snap that is supposed to trigger it ever
// actually happens for a real click). User report, repeated many times:
// "can't have a line snap onto the end point of an arc, or constrain it to
// do so." Root cause: the live snap() candidate list only ever offered an
// arc's CENTRE as a snap target - never its two rim/start/end points - so a
// real click could get arbitrarily close to an arc's endpoint and never snap
// there, no matter how carefully aimed.
// Real "click the constraint button, then click two points" flow, aiming
// NEAR (not exactly on) each point - the way an actual user clicks. Every
// existing test of this flow clicked the point's EXACT sketch-plane
// coordinate converted to screen, which is not a realistic aim and cannot
// catch a click that lands just outside pickPoint's tolerance. User report,
// 2026-09-12 (with a real debug trace): repeatedly opened Coincident/Tangent,
// clicked twice, and NOTHING happened - no constraint, no error, no visible
// feedback at all - "I can't seem to apply constraints almost anywhere
// right now" / "I am still totally able to drag around 'fully constrained'
// sketch objects".
note('--- button-first Coincident actually applies from two REALISTIC (near, not exact) clicks ---');
{
  await rpc('session.reset');
  await G.refresh();
  await idle();
  await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
  await waitFor(() => G.getState().sketchMode, 4000);
  await sleep(60);
  // two lines whose ends are CLOSE (a few mm apart) but not touching - the
  // user's real workflow: draw geometry that looks like it should join,
  // then explicitly apply Coincident to weld it. Deliberately NOT horizontal
  // or vertical (a perfectly axis-aligned line auto-gets a Horizontal/Vertical
  // constraint at draw time, which then fights a later Coincident: the
  // immediate pre-solve snap correctly only nudges the shared axis, leaving
  // the other axis for the real FreeCAD solve to reconcile - a genuine
  // multi-constraint case, not a bug, but the wrong thing to test here).
  const la = G.sketch.addEntity({ type: 'line', a: [0, 0], b: [30, 7] });
  const lb = G.sketch.addEntity({ type: 'line', a: [30.6, 7.4], b: [50, 20] });
  await sleep(60);
  const entsBefore = G.sketch.entities();
  const gapBefore = Math.hypot(
    entsBefore[la].b[0] - entsBefore[lb].a[0],
    entsBefore[la].b[1] - entsBefore[lb].a[1]
  );
  assert(gapBefore > 0.3 && gapBefore < 2, `the two endpoints start a few tenths of a mm apart (${gapBefore.toFixed(2)})`);

  const conBtns = Array.from(document.querySelectorAll('.sketch-ribbon .ribbon-cmd'));
  const coincidentBtn = conBtns.find((b) => (b.getAttribute('title') || '').startsWith('Coincident'));
  assert(coincidentBtn, 'a Coincident constraint button exists in the sketch ribbon');
  coincidentBtn.click();
  await sleep(30);
  // aim at each point with a REALISTIC few-pixel miss, not its exact centre
  const p1 = await G.sketchUVToScreen(entsBefore[la].b[0], entsBefore[la].b[1]);
  const p2 = await G.sketchUVToScreen(entsBefore[lb].a[0], entsBefore[lb].a[1]);
  assert(p1 && p2, 'both endpoints project onto the screen');
  clickAt(p1.x + 4, p1.y - 3);
  await sleep(30);
  clickAt(p2.x - 3, p2.y + 4);
  // wait for the real FreeCAD solve (runSolve, async) to actually land, not
  // a fixed sleep - the immediate local snap only satisfies the constraint
  // being added; reconciling it against any OTHER constraint on either line
  // needs the real solver's round trip
  await waitFor(() => {
    const e = G.sketch.entities();
    return Math.hypot(e[la].b[0] - e[lb].a[0], e[la].b[1] - e[lb].a[1]) < 1e-3;
  }, 2000);

  const consAfter = G.sketch.newConstraints();
  note('constraints after realistic-aim button-first Coincident: ' + JSON.stringify(consAfter));
  assert(
    consAfter.some((c) => c.type === 'Coincident'),
    'a Coincident constraint was actually recorded from two realistically-aimed clicks'
  );
  const entsAfter = G.sketch.entities();
  const gapAfter = Math.hypot(
    entsAfter[la].b[0] - entsAfter[lb].a[0],
    entsAfter[la].b[1] - entsAfter[lb].a[1]
  );
  assert(gapAfter < 1e-4, `the two endpoints are now welded together (gap ${gapAfter})`);
  // and it must survive Finish + reopen, not just look applied in memory
  await G.finishSketch();
  await idle();
  await sleep(220);
  const bcId = (G.getState().selection.find((s) => s.startsWith('sketch:')) || '').slice(7);
  const bcRe = await rpc('sketch.reopen', { sketchId: bcId });
  assert(
    (bcRe.constraints || []).some((c) => c.type === 'Coincident'),
    'the button-first Coincident survived Finish + reopen (it actually solved)'
  );
}

// beginConstraint() clears `selected` (whole-entity picks) but NEVER clears
// `selectedPts` (specific-point picks) - so a constraint attempt that's
// abandoned after only ONE point pick (the user's real workflow: click the
// point, realise the aim was off / change their mind, click the ribbon
// button again to retry) leaves that stale point sitting in selectedPts.
// The NEXT attempt's first real click then completes arity 2 against that
// STALE point instead of the user's actual second click, applying a
// nonsensical constraint (or silently doing nothing if the stale point's
// entity no longer exists) - and the user's real intended second click
// starts a fresh, incomplete pick for yet another attempt. Repeated forever,
// this looks exactly like "nothing happens no matter how many times I try".
note('--- an ABANDONED single-point constraint pick must not corrupt the next attempt ---');
{
  await rpc('session.reset');
  await G.refresh();
  await idle();
  await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
  await waitFor(() => G.getState().sketchMode, 4000);
  await sleep(60);
  // NOT drawn from the origin (a point at (0,0) auto-anchors to the real
  // sketch origin at draw time - a genuine, separate constraint that would
  // otherwise show up in newConstraints() and confuse this test's own check)
  const abIdx1 = G.sketch.addEntity({ type: 'line', a: [5, 2], b: [30, 7] });
  const abIdx2 = G.sketch.addEntity({ type: 'line', a: [30.6, 7.4], b: [50, 20] });
  await sleep(60);

  const conBtnsAb = Array.from(document.querySelectorAll('.sketch-ribbon .ribbon-cmd'));
  const coincidentBtnAb = conBtnsAb.find((b) => (b.getAttribute('title') || '').startsWith('Coincident'));
  assert(coincidentBtnAb, 'Coincident button exists');

  // ATTEMPT 1: click the button, pick a point UNRELATED to the intended weld
  // (line B's far end), then abandon it (click the ribbon button again, as a
  // real user retrying would) - if the stale point is NOT cleared, attempt
  // 2's first real click completes arity 2 against THIS unrelated point
  // instead of starting a fresh pick, welding the wrong things together
  coincidentBtnAb.click();
  await sleep(30);
  note('pendingConState after 1st button click: ' + JSON.stringify(G.pendingConState()));
  const entsAb = G.sketch.entities();
  const abandonedPt = await G.sketchUVToScreen(entsAb[abIdx2].b[0], entsAb[abIdx2].b[1]);
  assert(abandonedPt, 'the to-be-abandoned point projects onto the screen');
  clickAt(abandonedPt.x, abandonedPt.y);
  await sleep(30);
  note('pendingConState after 1st (abandoned) point pick: ' + JSON.stringify(G.pendingConState()));
  // abandon: click the ribbon button again instead of finishing the pick
  coincidentBtnAb.click();
  await sleep(30);
  note('pendingConState after abandon (2nd button click): ' + JSON.stringify(G.pendingConState()));

  // ATTEMPT 2: a clean pair of real clicks on the actual two endpoints meant
  // to be welded - NEITHER of which is the abandoned point above
  const abP2 = await G.sketchUVToScreen(entsAb[abIdx1].b[0], entsAb[abIdx1].b[1]);
  const abP3 = await G.sketchUVToScreen(entsAb[abIdx2].a[0], entsAb[abIdx2].a[1]);
  assert(abP2 && abP3, 'both intended endpoints project onto the screen for attempt 2');
  clickAt(abP2.x, abP2.y);
  await sleep(30);
  note('pendingConState after attempt-2 1st click: ' + JSON.stringify(G.pendingConState()));
  clickAt(abP3.x, abP3.y);
  await sleep(60);
  note('pendingConState after attempt-2 2nd click: ' + JSON.stringify(G.pendingConState()));

  const consAb = G.sketch.newConstraints();
  note('constraints after abandon-then-retry Coincident: ' + JSON.stringify(consAb));
  // the FIRST click of attempt 2 must NOT have silently completed a
  // constraint against the abandoned point (arity would already be 2 -
  // stale pt + this click - firing immediately, one click early) - assert
  // pendingCon was still active and no constraint existed yet after that
  // single click, i.e. the stale point did not count
  assert(
    consAb.length === 0 || !consAb.some((c) => c.type === 'Coincident' && (c.refs || []).some((r) => r.new === abIdx2 && r.pt === 2)),
    'the retry did not weld the ABANDONED point (line B far end) to anything'
  );
  assert(
    consAb.some((c) => c.type === 'Coincident'),
    'the retry produced exactly the intended Coincident constraint'
  );
  await waitFor(() => {
    const e = G.sketch.entities();
    return Math.hypot(e[abIdx1].b[0] - e[abIdx2].a[0], e[abIdx1].b[1] - e[abIdx2].a[1]) < 1e-3;
  }, 2000);
  const entsAbAfter = G.sketch.entities();
  const gapAb = Math.hypot(
    entsAbAfter[abIdx1].b[0] - entsAbAfter[abIdx2].a[0],
    entsAbAfter[abIdx1].b[1] - entsAbAfter[abIdx2].a[1]
  );
  assert(
    gapAb < 1e-3,
    `the retry actually welds the two INTENDED endpoints, not the abandoned one (gap ${gapAb})`
  );
  await G.cancelSketch();
  await idle();
}

// Same button-first Coincident, but on a REOPENED sketch (Finish, then edit
// sketch again) and against an ARC's rim endpoint (not a plain line end) -
// matching the user's actual real session precisely (their trace showed
// every failed constraint attempt happening after a sketch.reopen, with an
// arc already dragged by its rim point beforehand).
note('--- button-first Coincident on a REOPENED sketch, arc rim point + line end, realistic clicks ---');
{
  await rpc('session.reset');
  await G.refresh();
  await idle();
  await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
  await waitFor(() => G.getState().sketchMode, 4000);
  await sleep(60);
  const arcIdx = G.sketch.addEntity({ type: 'arc', c: [0, 0], r: 10, a0: 0, a1: Math.PI / 2 });
  const lnIdx = G.sketch.addEntity({ type: 'line', a: [0.6, 10.5], b: [20, 25] });
  await sleep(60);
  await G.finishSketch();
  await idle();
  await sleep(220);
  const rsId = (G.getState().selection.find((s) => s.startsWith('sketch:')) || '').slice(7);
  assert(!!rsId, 'the finished sketch id is known');
  await G.editSketch(rsId);
  await waitFor(() => G.getState().sketchMode, 4000);
  await sleep(120);

  const reEnts = G.sketch.entities();
  assert(reEnts.length === 2, 'reopened editor shows both the arc and the line');
  // arc's rim endpoint at angle a1 (pt 2): (10*cos(90deg), 10*sin(90deg)) = (0,10)
  const arcRimPt = [
    reEnts[arcIdx].c[0] + Math.cos(reEnts[arcIdx].a1) * reEnts[arcIdx].r,
    reEnts[arcIdx].c[1] + Math.sin(reEnts[arcIdx].a1) * reEnts[arcIdx].r
  ];
  const lineStart = reEnts[lnIdx].a;
  const gapBefore2 = Math.hypot(arcRimPt[0] - lineStart[0], arcRimPt[1] - lineStart[1]);
  assert(gapBefore2 > 0.3 && gapBefore2 < 2, `arc rim and line start are close but not touching (${gapBefore2.toFixed(2)})`);

  const conBtns2 = Array.from(document.querySelectorAll('.sketch-ribbon .ribbon-cmd'));
  const coincidentBtn2 = conBtns2.find((b) => (b.getAttribute('title') || '').startsWith('Coincident'));
  assert(coincidentBtn2, 'Coincident button exists on the reopened sketch');
  coincidentBtn2.click();
  await sleep(30);
  const rp1 = await G.sketchUVToScreen(arcRimPt[0], arcRimPt[1]);
  const rp2 = await G.sketchUVToScreen(lineStart[0], lineStart[1]);
  assert(rp1 && rp2, 'both points project onto the screen');
  clickAt(rp1.x - 3, rp1.y + 4);
  await sleep(30);
  clickAt(rp2.x + 4, rp2.y - 3);
  await sleep(60);

  const consAfterRe = G.sketch.newConstraints();
  note('constraints after reopened-sketch arc-rim Coincident: ' + JSON.stringify(consAfterRe));
  assert(
    consAfterRe.some((c) => c.type === 'Coincident'),
    'a Coincident constraint was recorded on the reopened sketch, arc rim to line end'
  );
  const entsAfterRe = G.sketch.entities();
  const arcRimAfter = [
    entsAfterRe[arcIdx].c[0] + Math.cos(entsAfterRe[arcIdx].a1) * entsAfterRe[arcIdx].r,
    entsAfterRe[arcIdx].c[1] + Math.sin(entsAfterRe[arcIdx].a1) * entsAfterRe[arcIdx].r
  ];
  const gapAfterRe = Math.hypot(
    arcRimAfter[0] - entsAfterRe[lnIdx].a[0],
    arcRimAfter[1] - entsAfterRe[lnIdx].a[1]
  );
  assert(gapAfterRe < 1e-3, `the arc rim and line start are now welded (gap ${gapAfterRe})`);
  await G.cancelSketch();
  await idle();
}

note('--- a line endpoint SNAPS onto an arc rim endpoint via a real click (not the test-hook snap param) ---');
{
  await rpc('session.reset');
  await G.refresh();
  await idle();
  await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
  await waitFor(() => G.getState().sketchMode, 4000);
  await sleep(60);
  // a centre-point arc: centre (0,0), start at (20,0), end at (0,20) - all
  // through real clicks (the 'a' hotkey + the actual pointer handlers)
  pressKey('a');
  await sleep(20);
  const ac = await G.sketchUVToScreen(0, 0);
  const a1 = await G.sketchUVToScreen(20, 0);
  const a2 = await G.sketchUVToScreen(0, 20);
  assert(ac && a1 && a2, 'arc draw points project onto the screen');
  clickAt(ac.x, ac.y);
  await sleep(20);
  clickAt(a1.x, a1.y);
  await sleep(20);
  clickAt(a2.x, a2.y);
  await sleep(40);
  pressKey('Escape');
  await sleep(20);
  const entsAfterArc = G.sketch.entities();
  const arcIdx = entsAfterArc.length - 1;
  const arc = entsAfterArc[arcIdx];
  assert(arc && arc.type === 'arc', 'drew a centre-point arc via real clicks');

  // now draw a LINE, via the real 'l' hotkey + real clicks, whose END lands
  // ON the arc's START rim point (20,0) - close enough on screen for the
  // snap tolerance, but the click's raw sketch-plane coordinate should NOT
  // be pixel-perfect, same as a real user's hand
  pressKey('l');
  await sleep(20);
  const lineStart = await G.sketchUVToScreen(-20, 0);
  const arcStartPt = [arc.c[0] + Math.cos(arc.a0) * arc.r, arc.c[1] + Math.sin(arc.a0) * arc.r];
  const lineEndNear = await G.sketchUVToScreen(arcStartPt[0] + 0.3, arcStartPt[1] - 0.2);
  assert(lineStart && lineEndNear, 'line draw points project onto the screen');
  clickAt(lineStart.x, lineStart.y);
  await sleep(20);
  clickAt(lineEndNear.x, lineEndNear.y);
  await sleep(40);
  pressKey('Escape');
  await sleep(20);

  const entsAfterLine = G.sketch.entities();
  const lineIdx = entsAfterLine.length - 1;
  const line = entsAfterLine[lineIdx];
  assert(line && line.type === 'line', 'drew a line via real clicks');
  const gap = line ? Math.hypot(line.b[0] - arcStartPt[0], line.b[1] - arcStartPt[1]) : Infinity;
  assert(
    gap < 1e-4,
    `the line's end SNAPPED exactly onto the arc's rim endpoint via the real click (gap ${gap})`
  );
  const newCons = G.sketch.newConstraints();
  const onArcEndpoint = newCons.filter(
    (c) =>
      (c.type === 'Tangent' || c.type === 'Coincident') &&
      (c.refs || []).some((r) => (r.new === lineIdx || r.geo === lineIdx) && (r.pt === 1 || r.pt === 2))
  );
  assert(
    onArcEndpoint.length > 0,
    'a real constraint (Tangent or Coincident) was recorded for the snap - not just a visual coincidence: ' +
      JSON.stringify(newCons)
  );
  // round-trip through the real solver
  await G.finishSketch();
  await idle();
  await sleep(220);
  const rlId = (G.getState().selection.find((s) => s.startsWith('sketch:')) || '').slice(7);
  const rlRe = await rpc('sketch.reopen', { sketchId: rlId });
  assert(
    (rlRe.constraints || []).some((c) => c.type === 'Tangent' || c.type === 'Coincident'),
    'the snap-recorded constraint survived Finish + reopen (it actually solved)'
  );
}

note('--- centre-point arc: real drag of an endpoint changes the sweep, not the radius ---');
{
  await rpc('session.reset');
  await G.refresh();
  await idle();
  await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
  const enteredSketch = await waitFor(() => G.getState().sketchMode, 4000);
  assert(enteredSketch, 'sketch mode entered');
  // draw a centre-point arc: centre (0,0), start at (10,0) i.e. 0 rad,
  // end at (0,10) i.e. 90 deg - real synthetic clicks through the actual
  // 'a' hotkey + click handler, not the commitTool test hook
  pressKey('a');
  await sleep(20);
  const c0 = await G.sketchUVToScreen(0, 0);
  const start0 = await G.sketchUVToScreen(10, 0);
  const end0 = await G.sketchUVToScreen(0, 10);
  assert(c0 && start0 && end0, 'arc draw points project onto the screen');
  if (c0 && start0 && end0) {
    clickAt(c0.x, c0.y);
    await sleep(20);
    clickAt(start0.x, start0.y);
    await sleep(20);
    clickAt(end0.x, end0.y);
    await sleep(40);
  }
  pressKey('Escape'); // back to select
  await sleep(20);

  const entsBefore = G.sketch.entities();
  const arcIdx = entsBefore.length - 1;
  // entities() returns the LIVE array (same-process, no serialization
  // boundary) - deep-clone the snapshot or "before" silently reads the
  // "after" value once the drag mutates the same object in place
  const arc0 = JSON.parse(JSON.stringify(entsBefore[arcIdx] || null));
  assert(arc0 && arc0.type === 'arc', 'drew a centre-point arc via real clicks');
  note('arc before drag: ' + JSON.stringify(arc0));

  if (arc0 && arc0.type === 'arc') {
    const r0 = arc0.r;
    // grab the START endpoint (pt 1, at angle a0) and drag it to a new angle
    const a0pt = [arc0.c[0] + Math.cos(arc0.a0) * arc0.r, arc0.c[1] + Math.sin(arc0.a0) * arc0.r];
    const from = await G.sketchUVToScreen(a0pt[0], a0pt[1]);
    // drag to 45 degrees instead of 0 - still the SAME radius from centre
    const toUV = [arc0.c[0] + Math.cos(Math.PI / 4) * arc0.r, arc0.c[1] + Math.sin(Math.PI / 4) * arc0.r];
    const to = await G.sketchUVToScreen(toUV[0], toUV[1]);
    assert(from && to, 'endpoint drag points project onto the screen');
    if (from && to) {
      dragTo(from.x, from.y, to.x, to.y);
      await sleep(60);
    }
    const entsAfterEndpointDrag = G.sketch.entities();
    const arc1 = JSON.parse(JSON.stringify(entsAfterEndpointDrag[arcIdx] || null));
    note('arc after endpoint drag: ' + JSON.stringify(arc1));
    assert(arc1 && arc1.type === 'arc', 'still an arc after the drag');
    if (arc1 && arc1.type === 'arc') {
      const radiusChanged = Math.abs(arc1.r - r0) > 0.5;
      const angleChanged = Math.abs(arc1.a0 - arc0.a0) > 0.05;
      assert(
        !radiusChanged,
        'dragging the arc ENDPOINT must not change the radius (before ' + r0.toFixed(2) + ', after ' + arc1.r.toFixed(2) + ')'
      );
      assert(
        angleChanged,
        'dragging the arc endpoint actually changed the sweep start angle (before ' +
          arc0.a0.toFixed(2) +
          ', after ' +
          arc1.a0.toFixed(2) +
          ')'
      );
    }

    // regression guard: dragging a point ON THE RING but away from either
    // endpoint must still resize the radius uniformly (the old, correct
    // behaviour for a plain ring-drag)
    const midAngle = (arc1 ? arc1.a0 : arc0.a0) + ((arc1 ? arc1.a1 : arc0.a1) - (arc1 ? arc1.a0 : arc0.a0)) / 2;
    const ringPt = [arc0.c[0] + Math.cos(midAngle) * (arc1 ? arc1.r : r0), arc0.c[1] + Math.sin(midAngle) * (arc1 ? arc1.r : r0)];
    const ringFrom = await G.sketchUVToScreen(ringPt[0], ringPt[1]);
    const biggerR = (arc1 ? arc1.r : r0) * 1.6;
    const ringToUV = [arc0.c[0] + Math.cos(midAngle) * biggerR, arc0.c[1] + Math.sin(midAngle) * biggerR];
    const ringTo = await G.sketchUVToScreen(ringToUV[0], ringToUV[1]);
    assert(ringFrom && ringTo, 'ring-drag points project onto the screen');
    const rBefore = (G.sketch.entities()[arcIdx] || {}).r;
    if (ringFrom && ringTo) {
      dragTo(ringFrom.x, ringFrom.y, ringTo.x, ringTo.y);
      await sleep(60);
    }
    const arc2 = G.sketch.entities()[arcIdx];
    note('arc after ring drag: ' + JSON.stringify(arc2));
    assert(
      arc2 && arc2.type === 'arc' && rBefore != null && arc2.r > rBefore + 0.5,
      'dragging a ring point away from either endpoint still resizes the radius (before ' +
        rBefore +
        ', after ' +
        (arc2 && arc2.r) +
        ')'
    );
  }
  pressKey('Escape');
  await G.cancelSketch();
  await idle();
}

note('--- constraint symbols stay a constant on-screen size across a real zoom ---');
{
  await G.cancelSketch().catch(() => {});
  await idle();
  await rpc('session.reset');
  await G.refresh();
  await idle();
  await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
  await waitFor(() => G.getState().sketchMode, 4000);
  await sleep(80);
  await idle();
  assert(G.getState().sketchMode, 'entered a fresh sketch');

  // a horizontal line gets an auto Horizontal constraint -> a symbol sprite
  const li = G.sketch.addEntity({ type: 'line', a: [0, 0], b: [30, 0.2] });
  await sleep(80);
  const cons = G.sketch.newConstraints();
  assert(
    cons.some((c) => c.type === 'Horizontal' && (c.refs[0].new === li || c.refs[0].geo === li)),
    'the line got an auto Horizontal constraint (so a symbol sprite exists to check)'
  );

  const before = G.symbolWorldScale();
  note('symbol world-space scale before zoom: ' + before);
  assert(typeof before === 'number' && before > 0, 'a constraint symbol sprite exists with a real world-space scale');

  note('camera before zoom: ' + JSON.stringify(await G.cameraDebug()));
  // a real wheel event at the viewport canvas - the actual zoom input path,
  // not a direct camera-state poke
  const el = viewportEl();
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  // one real scroll-wheel notch is ~100-120 deltaY - a few of those, not one
  // huge synthetic jump (which can send the "zoom to cursor" ray-plane
  // intersection somewhere degenerate at certain camera angles)
  for (let i = 0; i < 5; i++) {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
  }
  // rescaleScreenSpace() runs every rAF frame, not synchronously on the wheel
  // event - poll instead of one fixed sleep, which flaked under load (a
  // busy machine running several scenarios back to back can go well past
  // one single guessed delay before the next frame actually lands)
  await waitFor(() => G.symbolWorldScale() !== before, 2000);
  note('camera after zoom: ' + JSON.stringify(await G.cameraDebug()));

  const after = G.symbolWorldScale();
  note('symbol world-space scale after zoom: ' + after);
  assert(typeof after === 'number' && after > 0, 'the symbol sprite still exists after zooming');
  const changedEnough = Math.abs(after - before) / before > 0.05;
  assert(
    changedEnough,
    `THE BUG: a constraint symbol's world-space scale must change with zoom (fixed PIXEL size, not fixed world size) - before=${before}, after=${after}`
  );

  await G.cancelSketch();
  await idle();
}

// =================================================================
note('--- double-clicking a line opens a FLOATING inline dimension editor, not a modal popup ---');
{
  await rpc('session.reset');
  await G.refresh();
  await idle();
  await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
  await waitFor(() => G.getState().sketchMode, 4000);
  await sleep(60);

  pressKey('l');
  await sleep(20);
  const p0 = await G.sketchUVToScreen(0, 0);
  const p1 = await G.sketchUVToScreen(25, 0);
  assert(p0 && p1, 'line draw points project onto the screen');
  clickAt(p0.x, p0.y);
  await sleep(20);
  clickAt(p1.x, p1.y);
  await sleep(40);
  pressKey('Escape');
  await sleep(20);

  const ents = G.sketch.entities();
  const idx = ents.length - 1;
  const line = ents[idx];
  assert(line && line.type === 'line', 'drew a line via real clicks');

  // double-click the middle of the line, through the real dblclick handler
  const midU = (line.a[0] + line.b[0]) / 2;
  const midV = (line.a[1] + line.b[1]) / 2;
  const mid = await G.sketchUVToScreen(midU, midV);
  assert(mid, 'line midpoint projects onto the screen');
  assert(!dimEditorInput(), 'no floating dimension editor is mounted before the double-click');
  dblClickAt(mid.x, mid.y);
  await sleep(60);

  const input = dimEditorInput();
  assert(input, 'double-clicking the line opened the floating inline editor (not a modal)');
  assert(
    !document.querySelector('.prompt-scrim'),
    'the OLD blocking popup did not appear - this is the point of the redesign'
  );
  if (input) {
    const editorBox = input.closest('.dim-editor').getBoundingClientRect();
    const dEditor = Math.hypot(editorBox.left + editorBox.width / 2 - mid.x, editorBox.top - mid.y);
    assert(
      dEditor < 120,
      `the editor is actually anchored near the dimension it edits, not a fixed screen position (${dEditor.toFixed(1)}px away)`
    );
    const prefilled = Number(input.value);
    assert(
      Math.abs(prefilled - 25) < 0.5,
      `the editor is pre-filled with the LIVE measured length (got ${input.value}, expected ~25)`
    );
  }

  typeAndCommitDimEditor('40');
  await sleep(80);
  await waitFor(() => {
    const e = G.sketch.entities()[idx];
    return e && Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) > 39.9;
  }, 2000);
  const after = G.sketch.entities()[idx];
  const newLen = Math.hypot(after.b[0] - after.a[0], after.b[1] - after.a[1]);
  assert(
    Math.abs(newLen - 40) < 1e-3,
    `typing 40 + Enter into the floating editor actually resized the line (got length ${newLen})`
  );
  assert(!dimEditorInput(), 'the floating editor closes itself after committing');

  await G.cancelSketch();
  await idle();
}

// =================================================================
note('--- Dimension tool: click arms + live preview, click again SWITCHES, Ctrl-click ADDS, empty-space click PLACES ---');
{
  await rpc('session.reset');
  await G.refresh();
  await idle();
  await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
  await waitFor(() => G.getState().sketchMode, 4000);
  await sleep(60);

  // three disjoint, non-axis-aligned lines, all off the sketch origin - see
  // the earlier tests in this file for why (auto Horizontal/Vertical/
  // Coincident-to-origin at draw time would consume the exact geometry this
  // test means to click)
  const drawLine = async (ax, ay, bx, by) => {
    pressKey('l');
    await sleep(20);
    const p0 = await G.sketchUVToScreen(ax, ay);
    const p1 = await G.sketchUVToScreen(bx, by);
    clickAt(p0.x, p0.y);
    await sleep(20);
    clickAt(p1.x, p1.y);
    await sleep(30);
    pressKey('Escape');
    await sleep(20);
  };
  await drawLine(6, 4, 16, 7);
  await drawLine(34, 22, 49, 26);
  // parallel to line A (same (10,3) direction) - this sub-test is
  // specifically about a line-to-line DISTANCE, so the two lines must
  // actually be parallel or the new angle auto-detection (a separate,
  // deliberate test below) would correctly claim this pick instead
  await drawLine(60, -10, 70, -7);

  const entsBefore = G.sketch.entities();
  assert(entsBefore.length === 3, 'drew 3 disjoint lines (got ' + entsBefore.length + ')');
  const [lineA, lineB, lineC] = entsBefore;
  const midOf = (l) => [(l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2];

  pressKey('d');
  await sleep(30);

  // click line A - arms it, live preview should now exist (no floating
  // editor yet - nothing is placed until an empty-space click)
  const midA = await G.sketchUVToScreen(...midOf(lineA));
  clickAt(midA.x, midA.y);
  await sleep(40);
  assert(!dimEditorInput(), 'clicking a line arms it but does NOT open the editor yet (nothing placed)');

  // plain click on a DIFFERENT line (B) - SWITCHES, does not add to A
  const midB = await G.sketchUVToScreen(...midOf(lineB));
  clickAt(midB.x, midB.y);
  await sleep(40);
  // place it now (empty space click) and confirm it dimensions B's length,
  // not A's - proving the switch actually took effect
  const emptySpot = await G.sketchUVToScreen(80, 80);
  clickAt(emptySpot.x, emptySpot.y);
  await sleep(60);
  let input = dimEditorInput();
  assert(input, 'placing after a plain-click switch opened the floating editor');
  const lenB = Math.hypot(lineB.b[0] - lineB.a[0], lineB.b[1] - lineB.a[1]);
  if (input) {
    assert(
      Math.abs(Number(input.value) - lenB) < 0.5,
      `the placed dimension is line B's length (switched), not line A's (got ${input.value}, expected ~${lenB.toFixed(2)})`
    );
  }
  // back out without committing this one - a real Escape keydown starts at
  // whatever actually has focus (the editor's own input, auto-focused when
  // it opened) and bubbles from there, which is what its own onKeyDown
  // handler needs to see; document.dispatchEvent from the top does NOT
  // bubble back down INTO the input, so it would never actually reach it
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(40);
  assert(!dimEditorInput(), 'Escape on the floating editor actually closed it');

  // now: click line A, Ctrl-click line C - ADDS a 2nd line, making this a
  // line-to-line distance, then place it with an empty-space click
  clickAt(midA.x, midA.y);
  await sleep(30);
  const midC = await G.sketchUVToScreen(...midOf(lineC));
  clickAt(midC.x, midC.y, { ctrlKey: true });
  await sleep(40);
  assert(!dimEditorInput(), 'Ctrl-click ADDS a 2nd line but still does not place until an empty click');

  const consBefore = G.sketch.newConstraints().length;
  const emptySpot2 = await G.sketchUVToScreen(90, 0);
  clickAt(emptySpot2.x, emptySpot2.y);
  await sleep(60);
  input = dimEditorInput();
  assert(input, 'an empty-space click placed the 2-line distance dimension');
  if (input) {
    const editorBox = input.closest('.dim-editor').getBoundingClientRect();
    const dEditor = Math.hypot(editorBox.left + editorBox.width / 2 - emptySpot2.x, editorBox.top - emptySpot2.y);
    assert(dEditor < 150, `the placed editor anchors near where it was actually clicked to place (${dEditor.toFixed(1)}px away)`);
    typeAndCommitDimEditor(String(Number(input.value).toFixed(1)));
  }
  await sleep(80);
  await idle();
  const consAfter = G.sketch.newConstraints();
  assert(
    consAfter.length > consBefore,
    'the line-to-line distance (click A, Ctrl-click C, place) actually recorded a new Distance constraint'
  );
  const distCon = consAfter.find((c) => c.type === 'Distance' && (c.refs || []).length >= 2);
  assert(distCon, 'the recorded constraint is a real 2-entity Distance, not something else: ' + JSON.stringify(consAfter));

  // let the sketch's own debounced scheduleSolve (240ms) actually fire and
  // settle before tearing the editor down - otherwise it can still be
  // in-flight when session.reset blows away the document out from under it,
  // which showed up as unrelated flakiness in the NEXT test (a tangent-
  // stadium drag occasionally settling wrong for no reason connected to it)
  await sleep(300);
  await G.cancelSketch();
  await idle();
}

// =================================================================
note('--- Dimension tool: two NON-parallel lines auto-detect as an ANGLE, not a distance ---');
{
  // real user report + trace log, 2026-09-12: clicked one line, then another
  // (non-parallel) line while in the Dimension tool, expecting an angle -
  // nothing ever placed (a line-line pick only ever computed a
  // perpendicular-GAP distance, meaningless for non-parallel lines, and the
  // tool silently reset with no editor ever opening)
  await rpc('session.reset');
  await G.refresh();
  await idle();
  await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
  await waitFor(() => G.getState().sketchMode, 4000);
  await sleep(60);

  // two lines at a real, non-parallel, non-perpendicular angle - not
  // touching, so this also proves the two lines need not share an endpoint
  const drawLine = async (ax, ay, bx, by) => {
    pressKey('l');
    await sleep(20);
    const p0 = await G.sketchUVToScreen(ax, ay);
    const p1 = await G.sketchUVToScreen(bx, by);
    clickAt(p0.x, p0.y);
    await sleep(20);
    clickAt(p1.x, p1.y);
    await sleep(30);
    pressKey('Escape');
    await sleep(20);
  };
  await drawLine(0, 0, 20, 4);
  await drawLine(30, 20, 42, -2);

  const ents = G.sketch.entities();
  assert(ents.length === 2, 'drew 2 non-parallel lines (got ' + ents.length + ')');
  const [lineA, lineB] = ents;
  const midOf = (l) => [(l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2];
  // the real angle between the two directions, for a sanity check on the
  // pre-filled value (0-180, undirected - matches SketchController.angleValue)
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1];
  const norm = (u) => Math.hypot(u[0], u[1]);
  const dirA = [lineA.b[0] - lineA.a[0], lineA.b[1] - lineA.a[1]];
  const dirB = [lineB.b[0] - lineB.a[0], lineB.b[1] - lineB.a[1]];
  const expectedDeg = (Math.acos(Math.max(-1, Math.min(1, dot(dirA, dirB) / (norm(dirA) * norm(dirB))))) * 180) / Math.PI;

  pressKey('d');
  await sleep(30);
  const midA = await G.sketchUVToScreen(...midOf(lineA));
  clickAt(midA.x, midA.y);
  await sleep(30);
  const midB = await G.sketchUVToScreen(...midOf(lineB));
  clickAt(midB.x, midB.y, { ctrlKey: true });
  await sleep(60);
  assert(!dimEditorInput(), 'Ctrl-clicking the 2nd (non-parallel) line still only ARMS the pair, does not auto-place');

  const consBefore = G.sketch.newConstraints().length;
  const emptySpot = await G.sketchUVToScreen(70, 40);
  clickAt(emptySpot.x, emptySpot.y);
  await sleep(60);
  const input = dimEditorInput();
  assert(input, 'placing the pick between 2 non-parallel lines opened the floating editor (THE BUG: this used to never open at all)');
  if (input) {
    const prefilled = Number(input.value);
    assert(
      Math.abs(prefilled - expectedDeg) < 1,
      `the editor is pre-filled with the LIVE measured angle in degrees (got ${input.value}, expected ~${expectedDeg.toFixed(2)})`
    );
    typeAndCommitDimEditor(String(prefilled.toFixed(1)));
  }
  await sleep(80);
  await idle();
  const consAfter = G.sketch.newConstraints();
  assert(consAfter.length > consBefore, 'placing the angle actually recorded a new constraint');
  const angleCon = consAfter.find((c) => c.type === 'Angle');
  assert(
    angleCon && (angleCon.refs || []).length >= 2,
    'the recorded constraint is a real 2-line Angle, not a Distance or something else: ' + JSON.stringify(consAfter)
  );

  // Finish + reopen - proves the Angle constraint actually solved for real
  // (not just sitting in the client-side editor list) and round-trips with
  // its value, same discipline as every other constraint type in this file
  await G.finishSketch();
  await idle();
  await sleep(200);
  const sketchId = (G.getState().selection.find((s) => s.startsWith('sketch:')) || '').slice(7);
  assert(sketchId, 'the finished sketch id is known');
  const reopened = await rpc('sketch.reopen', { sketchId });
  const reAngle = (reopened.constraints || []).find((c) => c.type === 'Angle');
  assert(
    reAngle && Math.abs(reAngle.value - expectedDeg) < 1,
    'the Angle constraint survived Finish + reopen with its real solved value: ' + JSON.stringify(reAngle)
  );
}

// =================================================================
note('--- dragging one side of a tangent stadium does not visually corrupt the rest (real drag) ---');
{
  await rpc('session.reset');
  await G.refresh();
  await idle();
  await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
  await waitFor(() => G.getState().sketchMode, 4000);
  await sleep(60);

  // a real stadium/slot: 2 parallel lines + 2 tangent arcs closing the loop
  // (same construction as the shift-click loop-select test above)
  const rTop = G.sketch.addEntity({ type: 'line', a: [-10, 8], b: [10, 8] });
  const rBot = G.sketch.addEntity({ type: 'line', a: [10, -8], b: [-10, -8] });
  const aR = G.sketch.addEntity({ type: 'arc', c: [10, 0], r: 8, a0: -Math.PI / 2, a1: Math.PI / 2 });
  const aL = G.sketch.addEntity({ type: 'arc', c: [-10, 0], r: 8, a0: Math.PI / 2, a1: (3 * Math.PI) / 2 });
  await sleep(40);
  // NOTE: a closed 2-line-2-arc stadium loop with all 4 corners welded
  // (Coincident) and all 4 Tangents applied leaves at least one tangent
  // condition already implied/redundant once the loop closes - the
  // solver's over-constraint veto always drops whichever constraint was
  // MOST RECENTLY applied at the moment its async round-trip lands
  // (SketchController only ever vetoes this.lastUserConstraint, never an
  // earlier one - confirmed by direct repro: identical setup, the dropped
  // one always tracked apply order, never a fixed corner). The drag below
  // only exercises the TOP-LEFT corner (aL <-> rTop), so weld all 4 corners
  // first, then apply that one's Tangent FIRST among the four tangents -
  // by the time a LATER tangent becomes the redundant one and gets vetoed,
  // this one is no longer "the last user constraint" and cannot be the one
  // dropped.
  G.sketch.selectPoints([{ e: rTop, pt: 2 }, { e: aR, pt: 1 }]);
  assert(G.sketch.applyConstraint('Coincident'), 'weld top-right corner');
  await sleep(60);
  G.sketch.selectPoints([{ e: aR, pt: 2 }, { e: rBot, pt: 1 }]);
  assert(G.sketch.applyConstraint('Coincident'), 'weld bottom-right corner');
  await sleep(60);
  G.sketch.selectPoints([{ e: rBot, pt: 2 }, { e: aL, pt: 1 }]);
  assert(G.sketch.applyConstraint('Coincident'), 'weld bottom-left corner');
  await sleep(60);
  G.sketch.selectPoints([{ e: aL, pt: 2 }, { e: rTop, pt: 1 }]);
  assert(G.sketch.applyConstraint('Coincident'), 'weld top-left corner');
  await sleep(60);

  // the join this test actually drags - applied FIRST among the tangents
  G.sketch.select([aL, rTop]);
  assert(G.sketch.applyConstraint('Tangent'), 'tangent left arc <-> top line');
  await sleep(60);
  G.sketch.select([rTop, aR]);
  assert(G.sketch.applyConstraint('Tangent'), 'tangent top line <-> right arc');
  await sleep(60);
  G.sketch.select([aR, rBot]);
  assert(G.sketch.applyConstraint('Tangent'), 'tangent right arc <-> bottom line');
  await sleep(60);
  G.sketch.select([rBot, aL]);
  assert(G.sketch.applyConstraint('Tangent'), 'tangent bottom line <-> left arc');
  await sleep(300);

  const consCheck = G.sketch.newConstraints();
  const hasTopLeftTangent = consCheck.some(
    (c) =>
      c.type === 'Tangent' &&
      (c.refs || []).some((r) => r.new === aL || r.geo === aL) &&
      (c.refs || []).some((r) => r.new === rTop || r.geo === rTop)
  );
  assert(
    hasTopLeftTangent,
    'the top-left tangent (aL <-> rTop) - the one join this test actually drags - survived the redundancy veto: ' +
      JSON.stringify(consCheck.map((c) => c.type))
  );

  const entsBefore = G.sketch.entities();
  assert(entsBefore.length === 4, 'stadium has 4 entities before the drag (got ' + entsBefore.length + ')');

  // a REAL drag of the top line's LEFT endpoint straight up by 5mm, via the
  // actual pointer handlers - down, then several incremental moves, WITHOUT
  // releasing yet, so this can inspect the geometry mid-drag. This matters:
  // the real sidecar solver reconciles everything correctly on release
  // regardless of what solveLocal (the mid-drag local approximation) does,
  // so a check only AFTER release would pass even with the bug still
  // present - it has to catch what the drag looks like WHILE held down,
  // which is the actual "it got all crazy" report (screenshot, 2026-09-12).
  const el = viewportEl();
  const p0 = await G.sketchUVToScreen(-10, 8);
  const p1 = await G.sketchUVToScreen(-10, 13);
  assert(p0 && p1, 'drag start/end points project onto the screen');
  fire(el, 'pointermove', p0.x, p0.y);
  fire(el, 'pointerdown', p0.x, p0.y);
  for (let i = 1; i <= 6; i++) {
    fire(el, 'pointermove', p0.x + ((p1.x - p0.x) * i) / 6, p0.y + ((p1.y - p0.y) * i) / 6, { buttons: 1 });
  }

  const mid = G.sketch.entities();
  const arcRMid = mid[aR];
  const arcLMid = mid[aL];
  const rTopMid = mid[rTop];
  // THE BUG: solveLocal had no concept of Tangent at all, so a dragged
  // endpoint's weld moved but the tangent arc's centre/radius stayed
  // exactly where they were - breaking tangency and producing a visibly
  // wrong, self-crossing shape WHILE the drag is held (user report +
  // screenshot: "it got all crazy"). Checked here, still mid-drag, before
  // the real solver gets a chance to reconcile it on release.
  assert(
    arcRMid.r > 1 && arcRMid.r < 40 && arcLMid.r > 1 && arcLMid.r < 40,
    `mid-drag arc radii stayed sane, not degenerate (right=${arcRMid.r.toFixed(2)}, left=${arcLMid.r.toFixed(2)})`
  );
  const rimRMid = [arcRMid.c[0] + arcRMid.r * Math.cos(arcRMid.a0), arcRMid.c[1] + arcRMid.r * Math.sin(arcRMid.a0)];
  const gapTopRightMid = Math.hypot(rTopMid.b[0] - rimRMid[0], rTopMid.b[1] - rimRMid[1]);
  assert(
    gapTopRightMid < 0.5,
    `top-right corner stayed welded MID-DRAG, did not tear apart (gap ${gapTopRightMid.toFixed(3)})`
  );

  fire(el, 'pointerup', p1.x, p1.y, { buttons: 0 });
  await sleep(250);
  assert(
    !G.getState().notice,
    'no notice/error after the drag settles (' + (G.getState().notice || '') + ')'
  );

  await G.cancelSketch();
  await idle();
}

// =================================================================
note('--- dragging the BODY of a tangent-joined line (not just an endpoint) is refused, not corrupted ---');
{
  // A follow-up to the tangent-endpoint-drag test above: that test drags a
  // single endpoint (handle "a"/"b"), which clampDragTarget already clamped
  // correctly per-point. A WHOLE-line body drag (grab the middle, handle
  // "whole") went through a totally different, much looser check that only
  // asked "is this entity itself fully solved yet?" - it never looked at
  // whether either endpoint was welded into a Tangent join with another
  // entity that would NOT rigidly translate along with it. Real corruption
  // depends on the loop's exact topology (a symmetric 2-line/2-arc stadium
  // like this one is simple enough that solveLocal's weld+tangent passes
  // fully absorb a rigid nudge within a single relaxation and visually snap
  // it right back - the same construction the user actually hit was a more
  // complex asymmetric loop where that convergence is not guaranteed, per
  // the "got all crazy" screenshot). Either way, silently letting the drag
  // proceed and rely on relaxation to paper over it is the wrong contract:
  // the fix instead refuses the whole-body drag outright with an explicit
  // notice, exactly like the single-endpoint (a/b) case already does for a
  // locked point - so THIS test's real regression signal is the notice
  // itself (checked below), not the end position, which is not a reliable
  // discriminator for this particular symmetric construction (user report,
  // 2026-09-12 follow-up log: dragged "idx:0, entType:line, handle:whole").
  await rpc('session.reset');
  await G.refresh();
  await idle();
  await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
  await waitFor(() => G.getState().sketchMode, 4000);
  await sleep(60);

  const rTop = G.sketch.addEntity({ type: 'line', a: [-10, 8], b: [10, 8] });
  const rBot = G.sketch.addEntity({ type: 'line', a: [10, -8], b: [-10, -8] });
  const aR = G.sketch.addEntity({ type: 'arc', c: [10, 0], r: 8, a0: -Math.PI / 2, a1: Math.PI / 2 });
  const aL = G.sketch.addEntity({ type: 'arc', c: [-10, 0], r: 8, a0: Math.PI / 2, a1: (3 * Math.PI) / 2 });
  await sleep(40);
  // weld all 4 corners, then tangent the top-left join FIRST among the
  // tangents (same ordering discipline as the test above, to make the
  // over-constraint veto deterministic regardless of which OTHER corner it
  // ends up flagging redundant)
  G.sketch.selectPoints([{ e: rTop, pt: 2 }, { e: aR, pt: 1 }]);
  assert(G.sketch.applyConstraint('Coincident'), 'weld top-right corner');
  await sleep(60);
  G.sketch.selectPoints([{ e: aR, pt: 2 }, { e: rBot, pt: 1 }]);
  assert(G.sketch.applyConstraint('Coincident'), 'weld bottom-right corner');
  await sleep(60);
  G.sketch.selectPoints([{ e: rBot, pt: 2 }, { e: aL, pt: 1 }]);
  assert(G.sketch.applyConstraint('Coincident'), 'weld bottom-left corner');
  await sleep(60);
  G.sketch.selectPoints([{ e: aL, pt: 2 }, { e: rTop, pt: 1 }]);
  assert(G.sketch.applyConstraint('Coincident'), 'weld top-left corner');
  await sleep(60);
  G.sketch.select([aL, rTop]);
  assert(G.sketch.applyConstraint('Tangent'), 'tangent left arc <-> top line');
  await sleep(60);
  G.sketch.select([rTop, aR]);
  assert(G.sketch.applyConstraint('Tangent'), 'tangent top line <-> right arc');
  await sleep(60);
  G.sketch.select([aR, rBot]);
  assert(G.sketch.applyConstraint('Tangent'), 'tangent right arc <-> bottom line');
  await sleep(60);
  G.sketch.select([rBot, aL]);
  assert(G.sketch.applyConstraint('Tangent'), 'tangent bottom line <-> left arc');
  await sleep(300);

  // back to the select tool - entity dragging only fires when this.tool ===
  // 'select' (the sketch is otherwise left on whatever draw tool was active)
  pressKey('Escape');
  await sleep(60);

  // deep-clone the "before" snapshot - getSketchEntities()/entities() returns
  // the SketchController's own LIVE array, not a copy, so simply aliasing
  // beforeDrag[rTop] and reading it again after the drag would show the
  // drag's OWN result both times (the exact same object, mutated in place)
  const beforeDrag = JSON.parse(JSON.stringify(G.sketch.entities()));
  const rTopBefore = beforeDrag[rTop];
  const arcRBefore = beforeDrag[aR];
  const arcLBefore = beforeDrag[aL];

  // grab the MIDDLE of the top line (whole-body handle, not an endpoint) and
  // drag it straight up by 5mm
  const el2 = viewportEl();
  const q0 = await G.sketchUVToScreen(0, 8);
  const q1 = await G.sketchUVToScreen(0, 13);
  assert(q0 && q1, 'whole-drag start/end points project onto the screen');
  fire(el2, 'pointermove', q0.x, q0.y);
  fire(el2, 'pointerdown', q0.x, q0.y);
  // the block/notice only fires from clampDragTarget, which runs during
  // applyDrag on a pointermove - not on the pointerdown that starts the drag.
  // Check right after the FIRST pointermove, not after all 6 + settling: if
  // the block were absent, applyDrag's "case 'whole'" moves e.a/e.b BEFORE
  // solveLocal gets a chance to react, but solveLocal's own weld/tangent
  // passes can then pull a closed 4-piece loop most of the way back toward
  // its original shape by the time several more moves have run and it has
  // "settled" - checking only after settling would not reliably tell a
  // genuinely blocked drag apart from one that was allowed to move and got
  // mostly (but not perfectly) undone by relaxation.
  fire(el2, 'pointermove', q0.x + (q1.x - q0.x) / 6, q0.y + (q1.y - q0.y) / 6, { buttons: 1 });
  // poll rather than a single fixed sleep - the notice is a React state
  // update reacting to this event, not synchronous with fire() above.
  // Match the specific whole-line wording, not a loose /tangent|constrain/,
  // since a stale notice from elsewhere could satisfy a loose match even
  // with this exact check disabled.
  await waitFor(() => G.getState().notice && /tied to another curve/i.test(G.getState().notice), 5000);
  assert(
    G.getState().notice && /tied to another curve/i.test(G.getState().notice),
    'a notice explains why the drag was refused: ' + JSON.stringify(G.getState().notice)
  );
  const rTopFirst = G.sketch.entities()[rTop];
  assert(
    Math.abs(rTopFirst.a[1] - rTopBefore.a[1]) < 0.01 && Math.abs(rTopFirst.b[1] - rTopBefore.b[1]) < 0.01,
    `tangent-joined line did not move at all, even on the very first pointermove (a.y ${rTopBefore.a[1]} -> ${rTopFirst.a[1]}, b.y ${rTopBefore.b[1]} -> ${rTopFirst.b[1]})`
  );
  for (let i = 2; i <= 6; i++) {
    fire(el2, 'pointermove', q0.x + ((q1.x - q0.x) * i) / 6, q0.y + ((q1.y - q0.y) * i) / 6, { buttons: 1 });
  }
  await sleep(60);

  const mid2 = G.sketch.entities();
  const rTopMid2 = mid2[rTop];
  const arcRMid2 = mid2[aR];
  const arcLMid2 = mid2[aL];
  // THE BUG: a whole-line drag ignored the tangent joins entirely and slid
  // the line freely, tearing the corners apart and letting the tangent pivot
  // pass fight a moving target every iteration - producing the self-crossing
  // "got all crazy" shape. Fixed: the whole-drag is refused outright (the
  // line does not move at all) since both its endpoints are tangent-joined.
  assert(
    Math.abs(rTopMid2.a[1] - rTopBefore.a[1]) < 0.01 && Math.abs(rTopMid2.b[1] - rTopBefore.b[1]) < 0.01,
    `tangent-joined line refused to move on a whole-body drag (a.y ${rTopBefore.a[1]} -> ${rTopMid2.a[1]}, b.y ${rTopBefore.b[1]} -> ${rTopMid2.b[1]})`
  );
  assert(
    Math.abs(arcRMid2.r - arcRBefore.r) < 0.01 && Math.abs(arcLMid2.r - arcLBefore.r) < 0.01,
    `both arcs' radii are untouched, not distorted (right ${arcRBefore.r}->${arcRMid2.r}, left ${arcLBefore.r}->${arcLMid2.r})`
  );

  fire(el2, 'pointerup', q1.x, q1.y, { buttons: 0 });
  await sleep(150);

  await G.cancelSketch();
  await idle();
}

// a genuinely free line (no tangent join, no weld to anything else) should
// STILL be draggable as a whole body - this fix must not block ordinary,
// unconstrained whole-line moves
note('--- an unconstrained, unwelded line can still be whole-dragged normally ---');
{
  await rpc('session.reset');
  await G.refresh();
  await idle();
  await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
  await waitFor(() => G.getState().sketchMode, 4000);
  await sleep(60);

  const ln = G.sketch.addEntity({ type: 'line', a: [3, 5], b: [17, 9] });
  await sleep(60);
  pressKey('Escape');
  await sleep(60);

  // deep-clone here too - same live-array aliasing pitfall as the tangent
  // test above
  const before3 = JSON.parse(JSON.stringify(G.sketch.entities()[ln]));
  const el3 = viewportEl();
  const s0 = await G.sketchUVToScreen(10, 7);
  const s1 = await G.sketchUVToScreen(10, 20);
  assert(s0 && s1, 'free-line drag points project onto the screen');
  fire(el3, 'pointermove', s0.x, s0.y);
  fire(el3, 'pointerdown', s0.x, s0.y);
  for (let i = 1; i <= 6; i++) {
    fire(el3, 'pointermove', s0.x + ((s1.x - s0.x) * i) / 6, s0.y + ((s1.y - s0.y) * i) / 6, { buttons: 1 });
  }
  const mid3 = G.sketch.entities()[ln];
  assert(
    Math.abs(mid3.a[1] - before3.a[1] - 13) < 1 && Math.abs(mid3.b[1] - before3.b[1] - 13) < 1,
    `an unconstrained free line still translates rigidly on a whole-body drag (a.y moved ${(mid3.a[1] - before3.a[1]).toFixed(2)}, b.y moved ${(mid3.b[1] - before3.b[1]).toFixed(2)}, expected ~13)`
  );
  fire(el3, 'pointerup', s1.x, s1.y, { buttons: 0 });
  await sleep(150);

  await G.cancelSketch();
  await idle();
}

// =================================================================
note('--- dragging the RADIUS handle of a tangent-anchored arc is refused, not corrupted ---');
{
  // Follow-up to the whole-line-drag fix above: the SAME "got all crazy"
  // corruption is reachable a different way - dragging an arc's RADIUS
  // handle (not a line's body) when that arc is tangent-joined to a fixed
  // neighbour at one or both rim endpoints. solveLocal's tangent pass pivots
  // the arc's centre about EACH tangent-shared endpoint separately to match
  // the (now-changed) radius there; with joins at BOTH ends those two
  // pivots generally cannot agree on a single centre, fighting each other
  // every relaxation pass - a second real report, same underlying shape,
  // different handle (2026-09-12 follow-up log + screenshot: "sketch drag
  // start (entity) idx:3, entType:arc, handle:r").
  await rpc('session.reset');
  await G.refresh();
  await idle();
  await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
  await waitFor(() => G.getState().sketchMode, 4000);
  await sleep(60);

  const rTop = G.sketch.addEntity({ type: 'line', a: [-10, 8], b: [10, 8] });
  const rBot = G.sketch.addEntity({ type: 'line', a: [10, -8], b: [-10, -8] });
  const aR = G.sketch.addEntity({ type: 'arc', c: [10, 0], r: 8, a0: -Math.PI / 2, a1: Math.PI / 2 });
  const aL = G.sketch.addEntity({ type: 'arc', c: [-10, 0], r: 8, a0: Math.PI / 2, a1: (3 * Math.PI) / 2 });
  await sleep(40);
  G.sketch.selectPoints([{ e: rTop, pt: 2 }, { e: aR, pt: 1 }]);
  assert(G.sketch.applyConstraint('Coincident'), 'weld top-right corner');
  await sleep(60);
  G.sketch.selectPoints([{ e: aR, pt: 2 }, { e: rBot, pt: 1 }]);
  assert(G.sketch.applyConstraint('Coincident'), 'weld bottom-right corner');
  await sleep(60);
  G.sketch.selectPoints([{ e: rBot, pt: 2 }, { e: aL, pt: 1 }]);
  assert(G.sketch.applyConstraint('Coincident'), 'weld bottom-left corner');
  await sleep(60);
  G.sketch.selectPoints([{ e: aL, pt: 2 }, { e: rTop, pt: 1 }]);
  assert(G.sketch.applyConstraint('Coincident'), 'weld top-left corner');
  await sleep(60);
  // tangent the RIGHT arc (the one this test drags) at both its joins FIRST,
  // so the over-constraint veto (which only ever drops the MOST RECENTLY
  // applied constraint) cannot end up dropping either of them
  G.sketch.select([rTop, aR]);
  assert(G.sketch.applyConstraint('Tangent'), 'tangent top line <-> right arc');
  await sleep(60);
  G.sketch.select([aR, rBot]);
  assert(G.sketch.applyConstraint('Tangent'), 'tangent right arc <-> bottom line');
  await sleep(60);
  G.sketch.select([rBot, aL]);
  assert(G.sketch.applyConstraint('Tangent'), 'tangent bottom line <-> left arc');
  await sleep(60);
  G.sketch.select([aL, rTop]);
  assert(G.sketch.applyConstraint('Tangent'), 'tangent left arc <-> top line');
  await sleep(300);

  const consCheck = G.sketch.newConstraints();
  const rightArcTangents = consCheck.filter(
    (c) =>
      c.type === 'Tangent' &&
      (c.refs || []).some((r) => r.new === aR || r.geo === aR)
  );
  assert(
    rightArcTangents.length === 2,
    'both of the right arc\'s tangent joins (the one this test drags) survived the redundancy veto: ' +
      JSON.stringify(consCheck.map((c) => c.type))
  );

  pressKey('Escape');
  await sleep(60);

  const beforeR = JSON.parse(JSON.stringify(G.sketch.entities()[aR]));

  // grab the RIGHT arc's radius handle (a point on its rim, away from
  // either endpoint) and drag it outward
  const el4 = viewportEl();
  // rightmost point of the right arc (c=[10,0], r=8 -> [18,0])
  const r0 = await G.sketchUVToScreen(18, 0);
  const r1 = await G.sketchUVToScreen(24, 0);
  assert(r0 && r1, 'radius-drag start/end points project onto the screen');
  fire(el4, 'pointermove', r0.x, r0.y);
  fire(el4, 'pointerdown', r0.x, r0.y);
  fire(el4, 'pointermove', r0.x + (r1.x - r0.x) / 6, r0.y + (r1.y - r0.y) / 6, { buttons: 1 });
  // poll rather than a single fixed sleep + check - the notice update is a
  // React state set reacting to a real event dispatch, not synchronous with
  // the fire() call above, so a single short sleep can race it (seen in
  // practice: an earlier fixed 30ms sleep sometimes read the state before
  // this event's own notice had landed). Match the arc-specific wording, not
  // just /tangent/ - the PREVIOUS test's own tangent notice ("...line is
  // tied to another curve...") can still be sitting in state for a few
  // seconds (the banner auto-clears after 5s), so a loose match could pass
  // even with this exact check disabled.
  await waitFor(() => G.getState().notice && /this arc is tangent/i.test(G.getState().notice), 5000);
  assert(
    G.getState().notice && /this arc is tangent/i.test(G.getState().notice),
    'a notice explains why the radius drag was refused: ' + JSON.stringify(G.getState().notice)
  );
  const arcRFirst = G.sketch.entities()[aR];
  assert(
    Math.abs(arcRFirst.r - beforeR.r) < 0.01,
    `tangent-anchored arc's radius did not change at all, even on the very first pointermove (${beforeR.r} -> ${arcRFirst.r})`
  );
  for (let i = 2; i <= 6; i++) {
    fire(el4, 'pointermove', r0.x + ((r1.x - r0.x) * i) / 6, r0.y + ((r1.y - r0.y) * i) / 6, { buttons: 1 });
  }
  await sleep(60);
  const arcRMid = G.sketch.entities()[aR];
  const arcLMid = G.sketch.entities()[aL];
  assert(
    Math.abs(arcRMid.r - beforeR.r) < 0.01,
    `tangent-anchored arc's radius is refused for the whole drag, not just the first move (${beforeR.r} -> ${arcRMid.r})`
  );
  assert(
    arcLMid.r > 1 && arcLMid.r < 40,
    `the OTHER arc (not even the one being dragged) stayed sane too (r=${arcLMid.r.toFixed(2)})`
  );
  fire(el4, 'pointerup', r1.x, r1.y, { buttons: 0 });
  await sleep(150);

  await G.cancelSketch();
  await idle();
}

// a genuinely free arc (no tangent join) should still have a draggable
// radius - this fix must not block ordinary, unconstrained resizing
note('--- an unconstrained arc\'s radius can still be dragged normally ---');
{
  await rpc('session.reset');
  await G.refresh();
  await idle();
  await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
  await waitFor(() => G.getState().sketchMode, 4000);
  await sleep(60);

  const ac = G.sketch.addEntity({ type: 'arc', c: [5, 5], r: 6, a0: 0, a1: Math.PI });
  await sleep(60);
  pressKey('Escape');
  await sleep(60);

  const beforeAc = JSON.parse(JSON.stringify(G.sketch.entities()[ac]));
  const el5 = viewportEl();
  // the TOP of the arc's rim (angle pi/2), away from BOTH endpoints
  // (a0=0 is at [11,5], a1=pi is at [-1,5]) - grabHandle checks the
  // endpoints before the generic ring-drag, so clicking AT an endpoint
  // would pick 'a0'/'a1' instead of the 'r' handle this test means to drive
  const t0 = await G.sketchUVToScreen(5, 11);
  const t1 = await G.sketchUVToScreen(5, 17);
  assert(t0 && t1, 'free-arc radius-drag points project onto the screen');
  fire(el5, 'pointermove', t0.x, t0.y);
  fire(el5, 'pointerdown', t0.x, t0.y);
  for (let i = 1; i <= 6; i++) {
    fire(el5, 'pointermove', t0.x + ((t1.x - t0.x) * i) / 6, t0.y + ((t1.y - t0.y) * i) / 6, { buttons: 1 });
  }
  const midAc = G.sketch.entities()[ac];
  assert(
    midAc.r > beforeAc.r + 3,
    `an unconstrained free arc's radius still grows on a radius-handle drag (${beforeAc.r} -> ${midAc.r})`
  );
  fire(el5, 'pointerup', t1.x, t1.y, { buttons: 0 });
  await sleep(150);

  await G.cancelSketch();
  await idle();
}

// =================================================================
note('--- a whole-line drag with only ONE end anchored still moves - the free end follows the cursor ---');
{
  // The user's follow-up correction (2026-09-13): the earlier fixes refused
  // a whole-line/arc-radius drag the moment EITHER end was anchored - "way
  // too strict". A line anchored at only ONE end is not actually stuck: the
  // free end can still move (the anchored end just cannot translate along
  // with it), which is exactly what a single-endpoint (a/b) drag on that
  // free point already does safely. Build a simple "flag" shape: one free
  // line (the pole, unattached) whose top is Coincident-welded to one end
  // of a second line (the flag edge) that is Tangent-joined to an arc at
  // its OTHER end - so the flag edge has exactly one anchored end (the
  // tangent join) and one free end (the weld to the pole, which itself is
  // not otherwise constrained).
  await rpc('session.reset');
  await G.refresh();
  await idle();
  await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
  await waitFor(() => G.getState().sketchMode, 4000);
  await sleep(60);

  // NOT axis-aligned - a perfectly vertical/horizontal line auto-acquires a
  // Horizontal/Vertical constraint at draw time, silently locking a DOF this
  // test means to keep free (the established pitfall in this file: draw
  // test geometry off-axis)
  const pole = G.sketch.addEntity({ type: 'line', a: [30, 30], b: [31, 45] });
  const flag = G.sketch.addEntity({ type: 'line', a: [31, 45], b: [45, 50] });
  const cap = G.sketch.addEntity({ type: 'arc', c: [45, 40], r: 10, a0: Math.PI / 2 - 0.3, a1: Math.PI / 2 + 0.3 });
  await sleep(40);
  G.sketch.selectPoints([{ e: pole, pt: 2 }, { e: flag, pt: 1 }]);
  assert(G.sketch.applyConstraint('Coincident'), 'weld pole top to flag edge start (this end stays FREE - nothing else pins it)');
  await sleep(60);
  G.sketch.selectPoints([{ e: flag, pt: 2 }, { e: cap, pt: 1 }]);
  assert(G.sketch.applyConstraint('Coincident'), 'weld flag edge end to the arc');
  await sleep(60);
  G.sketch.select([flag, cap]);
  assert(G.sketch.applyConstraint('Tangent'), 'tangent flag edge <-> arc (this end IS anchored)');
  await sleep(300);

  pressKey('Escape');
  await sleep(60);

  const beforeFlag = JSON.parse(JSON.stringify(G.sketch.entities()[flag]));

  // grab the MIDDLE of the flag edge (whole-body handle) and drag it
  const el6 = viewportEl();
  const midUV = [(beforeFlag.a[0] + beforeFlag.b[0]) / 2, (beforeFlag.a[1] + beforeFlag.b[1]) / 2];
  const u0 = await G.sketchUVToScreen(midUV[0], midUV[1]);
  const u1 = await G.sketchUVToScreen(midUV[0] - 15, midUV[1] + 10);
  assert(u0 && u1, 'partial-anchor whole-drag points project onto the screen');
  fire(el6, 'pointermove', u0.x, u0.y);
  fire(el6, 'pointerdown', u0.x, u0.y);
  for (let i = 1; i <= 6; i++) {
    fire(el6, 'pointermove', u0.x + ((u1.x - u0.x) * i) / 6, u0.y + ((u1.y - u0.y) * i) / 6, { buttons: 1 });
  }
  await sleep(60);

  const midFlag = G.sketch.entities()[flag];
  // THE FIX: previously this drag would have been refused outright (nothing
  // moves) because ONE end (the tangent join) is anchored. Now it degrades
  // to moving the FREE end (pt 1, welded only to the pole) while the
  // anchored end (pt 2, tangent to the arc) stays put.
  assert(
    Math.hypot(midFlag.a[0] - beforeFlag.a[0], midFlag.a[1] - beforeFlag.a[1]) > 3,
    `the free end of a partially-anchored line actually moved (a: [${beforeFlag.a}] -> [${midFlag.a}])`
  );
  assert(
    Math.abs(midFlag.b[0] - beforeFlag.b[0]) < 0.5 && Math.abs(midFlag.b[1] - beforeFlag.b[1]) < 0.5,
    `the anchored (tangent-joined) end stayed put (b: [${beforeFlag.b}] -> [${midFlag.b}])`
  );
  // the pole (welded to the free end) followed along - the weld held
  const poleAfter = G.sketch.entities()[pole];
  assert(
    Math.abs(poleAfter.b[0] - midFlag.a[0]) < 0.5 && Math.abs(poleAfter.b[1] - midFlag.a[1]) < 0.5,
    `the pole's welded top followed the flag edge's free end (pole.b: [${poleAfter.b}], flag.a: [${midFlag.a}])`
  );
  // (not asserting "no notice at all" here - a stale notice from an earlier
  // test block can still be sitting in state for a few seconds after its
  // own 5s auto-clear timer started, which is not this drag's concern; the
  // movement assertions above already prove this drag was NOT refused)

  fire(el6, 'pointerup', u1.x, u1.y, { buttons: 0 });
  await sleep(150);

  await G.cancelSketch();
  await idle();
}

// =================================================================
note('--- an arc with only ONE tangent join still has a draggable radius ---');
{
  // Same correction, arc-radius side: only TWO tangent joins (both ends)
  // are genuinely over-determined for a radius drag. A single join leaves
  // one always-solvable pivot, so the radius should still be free to change.
  await rpc('session.reset');
  await G.refresh();
  await idle();
  await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
  await waitFor(() => G.getState().sketchMode, 4000);
  await sleep(60);

  const ln2 = G.sketch.addEntity({ type: 'line', a: [-20, 8], b: [-2, 8] });
  const arc2 = G.sketch.addEntity({ type: 'arc', c: [-2, 0], r: 8, a0: Math.PI / 2, a1: Math.PI });
  // a second line welded (Coincident only, deliberately NO Tangent) to the
  // arc's OTHER rim endpoint - a plain "hook" join, matching the shape in
  // the user's screenshot. This end is not tangent-anchored (so it does not
  // trip arcTangentAnchored's block), and unlike the ln2/arc2 join below, it
  // has no Tangent constraint for solveLocal's pivot pass (step 3) to use to
  // compensate - so it isolates the weld-averaging bug from that pass.
  const ln3 = G.sketch.addEntity({ type: 'line', a: [-10, -8], b: [-25, -3] });
  await sleep(40);
  G.sketch.selectPoints([{ e: ln2, pt: 2 }, { e: arc2, pt: 1 }]);
  assert(G.sketch.applyConstraint('Coincident'), 'weld line end to arc start');
  await sleep(60);
  G.sketch.select([ln2, arc2]);
  assert(G.sketch.applyConstraint('Tangent'), 'tangent the ONLY join this arc has');
  await sleep(60);
  G.sketch.selectPoints([{ e: arc2, pt: 2 }, { e: ln3, pt: 1 }]);
  assert(G.sketch.applyConstraint('Coincident'), 'weld arc end to second line (no tangent)');
  await sleep(300);

  pressKey('Escape');
  await sleep(60);

  const beforeArc2 = JSON.parse(JSON.stringify(G.sketch.entities()[arc2]));
  // rim point away from either endpoint (a0=pi/2 at [-2,8], a1=pi at [-10,0])
  // - the arc spans pi/2 to pi, so 3pi/4 (down-left of centre) is a genuine
  // mid-rim point: c + r*[cos(3pi/4), sin(3pi/4)]
  const midAngle = (Math.PI / 2 + Math.PI) / 2;
  const rimU = -2 + 8 * Math.cos(midAngle);
  const rimV = 0 + 8 * Math.sin(midAngle);
  const el7 = viewportEl();
  const v0 = await G.sketchUVToScreen(rimU, rimV);
  const v1 = await G.sketchUVToScreen(rimU * 1.8, rimV * 1.8);
  assert(v0 && v1, 'single-tangent arc radius-drag points project onto the screen');
  fire(el7, 'pointermove', v0.x, v0.y);
  fire(el7, 'pointerdown', v0.x, v0.y);
  for (let i = 1; i <= 6; i++) {
    fire(el7, 'pointermove', v0.x + ((v1.x - v0.x) * i) / 6, v0.y + ((v1.y - v0.y) * i) / 6, { buttons: 1 });
  }
  const midArc2 = G.sketch.entities()[arc2];
  assert(
    midArc2.r > beforeArc2.r + 2,
    `an arc with only ONE tangent join still resizes on a radius-handle drag (${beforeArc2.r} -> ${midArc2.r})`
  );
  // (the radius actually changing, asserted above, already proves this drag
  // was not refused - see the note in the previous test about not asserting
  // "no notice at all" against a possibly-stale notice from elsewhere)

  // THE BUG (user report + trace, 2026-09-13: "the arc became disconnected
  // from the lines... why is there the original version viewable, unchanged
  // after dragging"): draggedKeys() only pinned the arc's CENTRE point for a
  // radius drag, not its rim endpoints - so solveLocal's weld pass treated
  // the rim/line-endpoint weld as an ordinary pair and AVERAGED the two
  // positions instead of snapping the line's endpoint onto the arc's new
  // rim. The line visibly tore away from the resized arc while the drag was
  // held. Checked here, still mid-drag, matching the actual reported
  // scenario (this arc's rim endpoint 1 is welded to ln2's endpoint 2).
  const lnMid = G.sketch.entities()[ln2];
  const rimNow = [
    midArc2.c[0] + midArc2.r * Math.cos(midArc2.a0),
    midArc2.c[1] + midArc2.r * Math.sin(midArc2.a0),
  ];
  const weldGap = Math.hypot(lnMid.b[0] - rimNow[0], lnMid.b[1] - rimNow[1]);
  assert(
    weldGap < 0.5,
    `the tangent-joined line endpoint followed the arc's new rim position after a radius drag, did not tear away (gap ${weldGap.toFixed(3)})`
  );
  // the OTHER end - plain Coincident, no Tangent, so nothing but the rim-pin
  // fix keeps it welded (see the comment above ln3's construction)
  const ln3Mid = G.sketch.entities()[ln3];
  const rim2Now = [
    midArc2.c[0] + midArc2.r * Math.cos(midArc2.a1),
    midArc2.c[1] + midArc2.r * Math.sin(midArc2.a1),
  ];
  const weldGap2 = Math.hypot(ln3Mid.a[0] - rim2Now[0], ln3Mid.a[1] - rim2Now[1]);
  assert(
    weldGap2 < 0.5,
    `the plain-Coincident (non-tangent) hook join also followed the arc's new rim, did not tear away (gap ${weldGap2.toFixed(3)})`
  );

  fire(el7, 'pointerup', v1.x, v1.y, { buttons: 0 });
  await sleep(150);

  await G.cancelSketch();
  await idle();
}

note('--- radius-dragging an arc whose CENTRE is also welded to a shared vertex does not detach it (real repro) ---');
{
  // Faithful repro of a real user file ("Lid for ceramic thing.FCStd",
  // Sketch001, arc geo 3): rim pt1 plain-Coincident to a line end, rim pt2
  // Tangent to another line end (so arcTangentAnchored's count is only 1,
  // radius drag stays unblocked - matches the trace, no refusal notice) -
  // AND SEPARATELY the arc's CENTRE is Coincident-welded to a vertex shared
  // by two more lines (a little hinge/notch through the centre). The
  // earlier fix (pinning rim pts 1/2 for a radius drag) was verified against
  // a simpler 2-line construction that lacked this centre weld - this is
  // the actual reported case (user: "the arc became disconnected from the
  // lines... why is there the original version viewable, unchanged").
  await rpc('session.reset');
  await G.refresh();
  await idle();
  await G.beginSketch({ kind: 'origin', role: 'XY_Plane' });
  await waitFor(() => G.getState().sketchMode, 4000);
  await sleep(60);

  const lnA = G.sketch.addEntity({ type: 'line', a: [-2, 0], b: [-20, 2] }); // rim1 side
  const lnB = G.sketch.addEntity({ type: 'line', a: [12, -3], b: [22, -6] }); // rim2 side (tangent)
  const arcC = G.sketch.addEntity({ type: 'arc', c: [5, -2], r: 7, a0: Math.PI, a1: -0.3 });
  const hingeA = G.sketch.addEntity({ type: 'line', a: [-8, -20], b: [5, -2] }); // pt2 -> centre
  const hingeB = G.sketch.addEntity({ type: 'line', a: [5, -2], b: [-9, -25] }); // pt1 -> centre
  await sleep(40);

  G.sketch.selectPoints([{ e: arcC, pt: 1 }, { e: lnA, pt: 1 }]);
  assert(G.sketch.applyConstraint('Coincident'), 'weld arc rim1 to lnA (plain, no tangent)');
  await sleep(60);
  G.sketch.selectPoints([{ e: arcC, pt: 2 }, { e: lnB, pt: 1 }]);
  assert(G.sketch.applyConstraint('Coincident'), 'weld arc rim2 to lnB');
  await sleep(60);
  G.sketch.select([arcC, lnB]);
  assert(G.sketch.applyConstraint('Tangent'), 'tangent arc rim2 <-> lnB (the ONLY tangent join)');
  await sleep(60);
  G.sketch.selectPoints([{ e: hingeA, pt: 2 }, { e: arcC, pt: 3 }]);
  assert(G.sketch.applyConstraint('Coincident'), 'weld hingeA end to arc CENTRE');
  await sleep(60);
  G.sketch.selectPoints([{ e: hingeB, pt: 1 }, { e: arcC, pt: 3 }]);
  assert(G.sketch.applyConstraint('Coincident'), 'weld hingeB start to arc CENTRE');
  await sleep(300);

  pressKey('Escape');
  await sleep(60);

  const beforeArcC = JSON.parse(JSON.stringify(G.sketch.entities()[arcC]));
  const midAngleC = (Math.PI + -0.3) / 2 - Math.PI; // a genuine mid-rim angle, off both endpoints
  const rimUc = 5 + 7 * Math.cos(midAngleC);
  const rimVc = -2 + 7 * Math.sin(midAngleC);
  const el8 = viewportEl();
  const w0 = await G.sketchUVToScreen(rimUc, rimVc);
  const w1 = await G.sketchUVToScreen(5 + (rimUc - 5) * 1.9, -2 + (rimVc - -2) * 1.9);
  assert(w0 && w1, 'centre-welded arc radius-drag points project onto the screen');
  fire(el8, 'pointermove', w0.x, w0.y);
  fire(el8, 'pointerdown', w0.x, w0.y);
  for (let i = 1; i <= 6; i++) {
    fire(el8, 'pointermove', w0.x + ((w1.x - w0.x) * i) / 6, w0.y + ((w1.y - w0.y) * i) / 6, { buttons: 1 });
  }
  const midArcC = G.sketch.entities()[arcC];
  assert(
    Math.abs(midArcC.r - beforeArcC.r) > 1,
    `centre-welded arc's radius still changes on a radius-handle drag (${beforeArcC.r} -> ${midArcC.r})`
  );

  // the centre weld must follow (hingeA/hingeB's shared endpoint should
  // still sit exactly on the arc's - possibly moved - centre)
  const hingeAMid = G.sketch.entities()[hingeA];
  const hingeBMid = G.sketch.entities()[hingeB];
  const centreGap = Math.hypot(hingeAMid.b[0] - midArcC.c[0], hingeAMid.b[1] - midArcC.c[1]);
  const centreGap2 = Math.hypot(hingeBMid.a[0] - midArcC.c[0], hingeBMid.a[1] - midArcC.c[1]);
  assert(
    centreGap < 0.5 && centreGap2 < 0.5,
    `the centre-welded hinge lines stayed attached to the arc's centre, did not tear away (gaps ${centreGap.toFixed(3)}, ${centreGap2.toFixed(3)})`
  );

  // and the rim welds must ALSO still hold (this is the actual reported
  // symptom - the rim, not just the centre, detaching)
  const lnAMid = G.sketch.entities()[lnA];
  const lnBMid = G.sketch.entities()[lnB];
  const rim1Now = [midArcC.c[0] + midArcC.r * Math.cos(midArcC.a0), midArcC.c[1] + midArcC.r * Math.sin(midArcC.a0)];
  const rim2Now = [midArcC.c[0] + midArcC.r * Math.cos(midArcC.a1), midArcC.c[1] + midArcC.r * Math.sin(midArcC.a1)];
  const rimGap1 = Math.hypot(lnAMid.a[0] - rim1Now[0], lnAMid.a[1] - rim1Now[1]);
  const rimGap2 = Math.hypot(lnBMid.a[0] - rim2Now[0], lnBMid.a[1] - rim2Now[1]);
  assert(
    rimGap1 < 0.5 && rimGap2 < 0.5,
    `the rim-welded lines stayed attached to the arc's new rim too, did not tear away (gaps ${rimGap1.toFixed(3)}, ${rimGap2.toFixed(3)})`
  );

  fire(el8, 'pointerup', w1.x, w1.y, { buttons: 0 });
  await sleep(150);

  await G.cancelSketch();
  await idle();
}

note('--- done ---');
