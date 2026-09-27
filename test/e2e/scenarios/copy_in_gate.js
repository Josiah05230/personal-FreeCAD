/* Copy-in gate (renderer/copyIn.ts + App's bringIntoDoc + sidecar pn.copyIn)
 * and the Data Panel's file filter, end to end through the real app.
 *
 * Builds its own throwaway company (registry + CAD repo, real git, no
 * remote) under /tmp and points company.json at it - --e2e runs use their
 * own GWTCAD_CONFIG_DIR, so the real ~/.gwtcad is never touched; the
 * previous (e2e) config is restored at the end.
 *
 *  1. outside STEP -> company doc: the New Part dialog is REQUIRED; closing
 *     it aborts the import (nothing imported)
 *  2. same again, filled in: STEP + a PN-tagged FCStd land in the repo,
 *     committed, and the geometry is imported from the in-repo copy
 *  3. outside FCStd as an assembly component: copied in, the link points
 *     at the in-repo copy
 *  4. an in-repo FCStd: inserts with no prompt
 *  5. optional kinds: "just use it" on a drawing image copies it next to
 *     the doc; "copy" on a canvas image runs New Part with type Z guessed;
 *     "cancel" aborts
 *  6. Data Panel listing: usable types only, FCBak hidden, a code-only
 *     folder reported irrelevant
 */
const ROOT = '/tmp/gwtcad_copyin_e2e_' + Date.now();
const REG = ROOT + '/registry';
const CAD = ROOT + '/pn-cad-files';
const OUT = ROOT + '/outside';
const DOC = CAD + '/CM/A/CMA0010.FCStd';

function setSelect(el, value) {
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function setInput(el, value) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
/** the gate's New Part dialog (title set by App for copy-in) */
function gateDialog() {
  return Array.from(document.querySelectorAll('.mcmaster-panel')).find((p) =>
    /COPY IN AS A NEW PART|NEW PART FROM FILE/.test(p.querySelector('.mcmaster-head')?.textContent || '')
  );
}
async function fillGateDialog(type, description) {
  const dlg = await waitFor(() => gateDialog(), 15000);
  if (!dlg) return false;
  const selects = dlg.querySelectorAll('select');
  await waitFor(() => selects[0].value === 'CM' && selects[1].options.length > 1, 8000);
  if (type) setSelect(selects[1], type);
  const seqBtn = await waitFor(() =>
    Array.from(dlg.querySelectorAll('button')).find((b) => /^\d{3}$/.test((b.textContent || '').trim()))
  , 8000);
  if (!seqBtn) return false;
  seqBtn.click();
  await sleep(100);
  const desc = Array.from(dlg.querySelectorAll('input')).find((i) => /^Description/.test(i.placeholder || ''));
  setInput(desc, description);
  await sleep(100);
  Array.from(dlg.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Create Part').click();
  return true;
}
const exists = async (p) => !!(await window.cad.realpath(p));
const asmTree = () => rpc('assembly.tree');

note('--- throwaway company: registry + CAD repo (real git, no remote) ---');
await window.cad.mkdir(REG);
await window.cad.mkdir(CAD + '/CM/A');
await window.cad.mkdir(OUT + '/code');
await window.cad.writeText(
  'pn,pn_seq,project,type,seq,rev,name,description,reason,mfg,mfg_pn,purchasing_link,status,lifecycle,rev_date,created,repo_relpath\n',
  REG + '/registry.csv'
);
await window.cad.writeText('A: Assembly\nC: Component\nF: PCB Assembly\nZ: Misc\n', REG + '/types.yaml');
await window.cad.writeText('', CAD + '/.gitkeep');
for (const repo of [REG, CAD]) {
  await window.cad.gitInit(repo + '/x');
  await window.cad.gitCommitAll(repo + '/x', 'init', 'Test', 'test@example.com');
}
const cfgBefore = await rpc('pn.getCompanyConfig', {});
await rpc('pn.setCompanyConfig', {
  registryPath: REG,
  ecadRepoPath: ROOT + '/ecad-cad-files',
  projects: { CM: { name: 'Test Co', repoPath: CAD } }
});

try {
  note('--- outside files: a part FCStd, its STEP, an svg label, junk ---');
  await rpc('session.reset');
  await rpc('primitive.box', { length: 10, width: 10, height: 10 });
  await rpc('document.saveAs', { path: OUT + '/bolt.FCStd' });
  await rpc('io.export', { path: OUT + '/widget.step' });
  await window.cad.writeText(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#c33"/></svg>',
    OUT + '/label.svg'
  );
  await window.cad.writeText('print(1)', OUT + '/code/tool.py');
  await window.cad.writeText('x', OUT + '/code/lib.dll');
  assert(await exists(OUT + '/widget.step'), 'outside STEP exported');

  note('--- the company document ---');
  await rpc('session.reset');
  await rpc('primitive.box', { length: 30, width: 20, height: 5 });
  await rpc('document.saveAs', { path: DOC });
  await window.cad.gitCommitAll(DOC, 'add assembly', 'Test', 'test@example.com');
  await G.openDesignPath(DOC);
  await idle();
  assertEq(G.getState().docPath, DOC, 'company doc is open');
  const bodies0 = G.getState().bodies.length + G.getState().meshes.length;

  note('--- 1. outside STEP: required, closing the dialog aborts ---');
  const p1 = G.importModelPath(OUT + '/widget.step');
  const d1 = await waitFor(() => gateDialog(), 15000);
  assert(!!d1, 'New Part dialog opened for the outside STEP');
  assert(/COPY IN AS A NEW PART/.test(d1?.textContent || ''), 'dialog says it is a required copy-in');
  const pend = G.copyInPending();
  assert(pend && pend.required && pend.src === OUT + '/widget.step', 'gate is waiting on a REQUIRED copy-in');
  Array.from(d1.querySelectorAll('button')).find((b) => b.title === 'Close').click();
  await p1;
  await idle();
  assertEq(G.getState().bodies.length + G.getState().meshes.length, bodies0, 'cancelled: nothing imported');
  assert(/Not inserted/.test(G.getState().notice || ''), 'cancel explains why nothing was inserted');

  note('--- 2. outside STEP, New Part filled in ---');
  const p2 = G.importModelPath(OUT + '/widget.step');
  assert(await fillGateDialog('C', 'copied-in widget'), 'filled the New Part dialog');
  await p2;
  await idle();
  const widget = await rpc('pn.resolve', { pnSeqOrFull: 'CMC001' });
  note('widget part file: ' + widget.path);
  assert(widget.path.startsWith(CAD + '/'), 'the new PN resolves to a file inside the company repo');
  const wdir = widget.path.slice(0, widget.path.lastIndexOf('/'));
  assert(await exists(wdir + '/CMC0010.step'), 'the STEP itself was copied next to the part file');
  assert(G.getState().bodies.length + G.getState().meshes.length > bodies0, 'geometry imported into the doc');
  const log = await window.cad.gitLog(widget.path, 5);
  assert(log.some((c) => /Add CMC0010/.test(c.message || c.subject || '')), 'copy-in was committed to the CAD repo');
  const wprops = await rpc('pn.resolve', { pnSeqOrFull: 'CMC0010' });
  assertEq(wprops.row.description, 'copied-in widget', 'registry row has the entered description');

  note('--- 3. outside FCStd as an assembly component ---');
  const p3 = G.insertComponentPath(OUT + '/bolt.FCStd');
  assert(await fillGateDialog('C', 'copied-in bolt'), 'filled the New Part dialog for the component');
  await p3;
  await idle();
  const bolt = await rpc('pn.resolve', { pnSeqOrFull: 'CMC002' });
  let tree = await asmTree();
  const linked = (tree.components || []).map((c) => c.linkedPath);
  note('linked: ' + JSON.stringify(linked));
  assert(linked.includes(bolt.path), 'the component links the in-repo copy');
  assert(!linked.some((p) => p && p.startsWith(OUT)), 'nothing links the outside file');

  note('--- 4. an in-repo FCStd inserts with no prompt ---');
  const n4 = (tree.components || []).length;
  await G.insertComponentPath(widget.path);
  await idle();
  assert(!G.copyInPending() && !gateDialog(), 'no dialog for an in-repo source');
  tree = await asmTree();
  assertEq((tree.components || []).length, n4 + 1, 'component added directly');

  note('--- 5. optional kinds ---');
  G.setCopyInChoice('use');
  const placed = await G.resolveDrawingImage(OUT + '/label.svg');
  note('drawing image placed at: ' + placed);
  assertEq(placed, CAD + '/CM/A/CMA0010_label.svg', '"just use it" copies the image next to the document');
  assert(await exists(placed), 'the copy exists');

  G.setCopyInChoice('copy');
  const p5 = G.insertCanvasPath(OUT + '/label.svg');
  const d5 = await waitFor(() => gateDialog(), 15000);
  assert(/NEW PART FROM FILE/.test(d5?.textContent || ''), 'optional copy-in opens the New Part dialog');
  await waitFor(() => d5.querySelectorAll('select')[1].value === 'Z', 5000);
  assertEq(d5.querySelectorAll('select')[1].value, 'Z', 'type Z (Misc) preselected for an image');
  assert(await fillGateDialog(null, 'warning label'), 'filled the label part');
  await p5;
  await idle();
  const lbl = await rpc('pn.resolve', { pnSeqOrFull: 'CMZ001' });
  const ldir = lbl.path.slice(0, lbl.path.lastIndexOf('/'));
  assert(await exists(ldir + '/CMZ0010.svg'), 'label artwork copied in as its own part');

  G.setCopyInChoice('cancel');
  await G.insertCanvasPath(OUT + '/label.svg');
  assert(!gateDialog(), 'cancelling the optional prompt does nothing');

  note('--- 6. Data Panel listing + folder relevance ---');
  await window.cad.writeText('x', wdir + '/CMC0010.FCBak');
  await window.cad.writeText('{}', wdir + '/CMC0010.FCStd.gwtcad.json');
  const listing = await window.cad.listDir(wdir);
  const names = listing.items.map((i) => i.name);
  note('listing: ' + names.join(', '));
  assert(names.includes('CMC0010.FCStd') && names.includes('CMC0010.step'), 'part file + STEP listed');
  assert(!names.some((n) => /FCBak|gwtcad\.json/.test(n)), 'backup + companion files hidden');
  const rel = await window.cad.dirRelevance([OUT + '/code', OUT, CAD]);
  assertEq(rel[OUT + '/code'], false, 'a folder of only .py/.dll is irrelevant (hidden)');
  assertEq(rel[OUT], true, 'a folder with a STEP beneath it is relevant');
  const hits = await window.cad.searchDir(OUT, 'label');
  assert(hits.results.some((h) => h.name === 'label.svg'), 'search finds the svg');
} finally {
  await rpc('pn.setCompanyConfig', cfgBefore).catch(() => {});
  await rpc('session.reset').catch(() => {});
}
