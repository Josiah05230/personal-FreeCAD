/* Manual driver (--drive): builds a box, places one dimension of each of
 * the four dimGeom render shapes (Distance, Radius, Angle, DistanceX
 * ordinate) directly via drawing.addDimension refs (no synthetic clicking
 * needed - the geometry math itself was already verified live earlier;
 * this run only exercises the tolerance-text RENDERING path), gives each a
 * tolerance (mixing symmetric/deviation and one free-text prefix on the
 * longest value), then leaves the sheet up for a screenshot to visually
 * check the just-fixed bug: tolerance text should sit flush against its
 * dimension value ("same text box"), not floating with a gap or
 * overlapping it. */

note('--- dismiss the first-run welcome dialog (not suppressed under --drive) ---');
for (let i = 0; i < 5; i++) {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    /^Next$|^Start using GWT-CAD$/.test(b.textContent || '')
  );
  if (!btn) break;
  btn.click();
  await sleep(150);
}

note('--- build a box and enter a drawing ---');
await rpc('session.reset');
await G.refresh();
await idle();
const s0 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: s0.sketchId,
  elements: [{ type: 'rect', a: [0, 0], b: [40, 30] }],
  constraints: []
});
await G.refresh();
await idle();
G.selectSketch(s0.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 12 });
await idle();

note('--- fillet one vertical edge so there is a real curved edge to dimension as Radius/Diameter (textAnchor start/end case) ---');
const sc = await rpc('scene.get', {});
const box = sc.meshes[0];
const vEdge = box.edges.find((e) => Math.abs(e.points[2] - e.points[5]) > 1 && e.points[0] === 0 && e.points[1] === 0);
note('vertical edge found: ' + JSON.stringify(vEdge));
if (vEdge) {
  const mid = [
    (vEdge.points[0] + vEdge.points[3]) / 2,
    (vEdge.points[1] + vEdge.points[4]) / 2,
    (vEdge.points[2] + vEdge.points[5]) / 2
  ];
  await rpc('feature.fillet', { edges: ['Edge' + (vEdge.edge + 1)], radius: 5, points: [mid] });
  await idle();
}

G.runCommand('draw.fromDesign');
await sleep(300);
G.runCommand('draw.front');
await sleep(250);

const pl = await rpc('drawing.pageList', {});
const pageId = pl.pages[pl.pages.length - 1].id;
let contents = await rpc('drawing.pageContents', { pageId });
const viewId = contents.views[0].id;
note('view id: ' + viewId);

note('--- Distance dimension, deviation tolerance + "2X " prefix (long-value case, textAnchor=middle) ---');
const dist = await rpc('drawing.addDimension', {
  pageId, viewId, kind: 'Distance', refs: [{ sub: 'Vertex1' }, { sub: 'Vertex3' }]
});
note('distance: ' + JSON.stringify(dist));
await rpc('drawing.moveDimension', { dimId: dist.id, labelUV: [0, 5] });
await rpc('drawing.setDimensionFormat', {
  dimId: dist.id,
  fmt: { toleranceMode: 'deviation', tolerancePlus: 0.1, toleranceMinus: -0.05, textPrefix: '2X ', precision: 2 }
});

note('--- Diameter dimension on the real filleted curved edge (textAnchor start/end case), symmetric tolerance ---');
const snap = await rpc('drawing.snapTargets', { viewId });
// the fillet leaves 20 edges total (12 original minus the one it replaced,
// plus its own new curved ones) - pick the one whose two projected
// endpoints are closest together without being coincident, the signature
// of a small curved edge seen near end-on rather than a long straight run.
const withLen = snap.targets
  .filter((t) => t.kind === 'edge' && t.p1 && t.p2)
  .map((t) => ({ t, len: Math.hypot(t.p1[0] - t.p2[0], t.p1[1] - t.p2[1]) }))
  .filter((x) => x.len > 0.01)
  .sort((a, b) => a.len - b.len);
note('shortest edges by projected length: ' + JSON.stringify(withLen.slice(0, 4)));
const curved = withLen[0] && withLen[0].t;
const rad = await rpc('drawing.addDimension', {
  pageId, viewId, kind: 'Diameter', refs: [{ sub: (curved || snap.targets[0]).sub }]
});
note('diameter: ' + JSON.stringify(rad));
await rpc('drawing.setDimensionFormat', {
  dimId: rad.id,
  fmt: { toleranceMode: 'symmetric', tolerancePlus: 0.05, precision: 2 }
});

note('--- Angle dimension between two edges, deviation tolerance ---');
const ang = await rpc('drawing.addDimension', {
  pageId, viewId, kind: 'Angle', refs: [{ sub: 'Edge1' }, { sub: 'Edge2' }]
});
note('angle: ' + JSON.stringify(ang));
await rpc('drawing.setDimensionFormat', {
  dimId: ang.id,
  fmt: { toleranceMode: 'deviation', tolerancePlus: 0.5, toleranceMinus: -0.5, precision: 1 }
});

note('--- Ordinate (DistanceX) dimension, symmetric tolerance ---');
const ord = await rpc('drawing.addDimension', {
  pageId, viewId, kind: 'DistanceX', refs: [{ sub: 'Vertex1' }, { sub: 'Vertex4' }]
});
note('ordinate: ' + JSON.stringify(ord));
await rpc('drawing.moveDimension', { dimId: ord.id, labelUV: [10, -3] });
await rpc('drawing.setDimensionFormat', {
  dimId: ord.id,
  fmt: { toleranceMode: 'symmetric', tolerancePlus: 0.02, precision: 2 }
});

await G.refresh();
await idle();
await sleep(300);

contents = await rpc('drawing.pageContents', { pageId });
assert(contents.dimensions.length === 4, 'all four dimensions were created (got ' + contents.dimensions.length + ')');

note('--- dimensions/formats were set via raw RPC while the sheet was already ' +
     'mounted, which does NOT go through React state (see this session\'s own ' +
     'notes on document.open) - back out to the model view and reopen the same ' +
     'page through the real Browser tree UI so DrawingSheet remounts and its ' +
     'mount-effect refetches drawing.pageContents + drawing.getDimensionFormats ---');
const backBtn = document.querySelector('.drawing-back');
assert(!!backBtn, 'found the "← Model" back button');
backBtn.click();
await sleep(300);

const drawingsRow = Array.from(document.querySelectorAll('.br-label')).find(
  (el) => el.textContent === 'Drawings'
);
assert(!!drawingsRow, 'found the Drawings row in the browser tree');
const twisty = drawingsRow.parentElement.querySelector('.br-tw');
twisty.click();
await sleep(150);

const pageRow = Array.from(document.querySelectorAll('.br-label')).find(
  (el) => el.textContent === 'Drawing'
);
assert(!!pageRow, 'found the drawing page row');
pageRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
await sleep(500);
await idle();
await sleep(300);

note('--- leave the sheet up for the screenshot ---');
await sleep(200);
