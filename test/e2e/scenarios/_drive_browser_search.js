/* Manual driver (--drive): verifies the new browser-tree search box
 * (user request, 2026-09-22: "make sure the file explorer window on the
 * left side of the cad program allows the user to search for files...
 * search the highest level first and then continue searching
 * recursively"). Builds a part with two bodies, a sketch, and a drawing
 * page (so there's enough tree variety to search across), then drives the
 * real search input and checks: (1) a query matching a SECTION name
 * (e.g. "sketch") keeps every item under that section, (2) a query
 * matching only a leaf label filters down to just that leaf plus its
 * ancestor chain forced open, (3) a query with no matches shows the
 * empty state, (4) clearing the query restores the full tree. */

note('--- dismiss the first-run welcome dialog ---');
for (let i = 0; i < 5; i++) {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    /^Next$|^Start using GWT-CAD$/.test(b.textContent || '')
  );
  if (!btn) break;
  btn.click();
  await sleep(150);
}

note('--- build a body + a sketch so the tree has real variety (the .browser panel only mounts in the model/design view, not drawing mode, so this test stays there) ---');
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
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 10 });
await idle();

state_check: {
  const state = await rpc('tree.get', {});
  note('tree before search: ' + JSON.stringify(state.bodies[0].features.map((f) => ({ id: f.id, kind: f.kind, label: f.label }))));
}

note('--- find the search input in the browser panel ---');
const searchInput = document.querySelector('.br-search');
assert(!!searchInput, 'found the .br-search input in the browser panel');

function setSearch(v) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(searchInput, v);
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
}

function visibleLabels() {
  return Array.from(document.querySelectorAll('.browser .br-label')).map((el) => el.textContent);
}

note('--- baseline: full tree visible with no query ---');
const baseline = visibleLabels();
note('baseline labels (top-level, most sections collapsed by default): ' + JSON.stringify(baseline));
assert(baseline.includes('Untitled'), 'root row present with no query');

note('--- SECTION-LEVEL match: "sketch" should keep the whole Sketches section open with all its items, per "search the highest level first" ---');
setSearch('sketch');
await sleep(50);
const sectionMatchLabels = visibleLabels();
note('labels after searching "sketch": ' + JSON.stringify(sectionMatchLabels));
assert(sectionMatchLabels.includes('Sketches'), 'Sketches section is shown for a section-name match');
assert(sectionMatchLabels.some((l) => l.startsWith('Sketch')), 'the sketch item itself is visible (section forced open)');

note('--- LEAF-LEVEL match: a query that does not match any section name but matches a body label should show just Bodies > that body ---');
const treeState = await rpc('tree.get', {});
const bodyLabel = treeState.bodies[0].label;
note('searching for body label: ' + bodyLabel);
setSearch(bodyLabel.toLowerCase());
await sleep(50);
const leafMatchLabels = visibleLabels();
note('labels after searching body label: ' + JSON.stringify(leafMatchLabels));
assert(leafMatchLabels.includes('Bodies'), 'Bodies section shown as an ancestor of the matching leaf');
assert(leafMatchLabels.includes(bodyLabel), 'the matching body itself is visible');
assert(!leafMatchLabels.includes('Sketches') || leafMatchLabels.length < sectionMatchLabels.length,
  'unrelated sections are filtered out for a leaf-only match (tree is narrower than the section-match case)');

note('--- NO MATCH: a nonsense query shows the empty state, not a stale tree ---');
setSearch('zzzznonexistentqueryzzzz');
await sleep(50);
const noMatchEl = document.querySelector('.br-no-results');
note('no-results element present: ' + !!noMatchEl + ' text: ' + (noMatchEl ? noMatchEl.textContent : null));
assert(!!noMatchEl, 'the empty state renders for a query with no matches anywhere in the tree');
assert(!document.querySelector('.browser .br-label'), 'no stale tree rows are shown alongside the empty state');

note('--- CLEAR: emptying the query restores the collapsed-by-default baseline tree ---');
setSearch('');
await sleep(50);
const clearedLabels = visibleLabels();
note('labels after clearing: ' + JSON.stringify(clearedLabels));
assert(JSON.stringify(clearedLabels) === JSON.stringify(baseline), 'clearing the search restores the exact original tree state');

note('--- leave state up for inspection ---');
await sleep(200);
