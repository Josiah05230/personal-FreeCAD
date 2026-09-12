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

note('--- done ---');
