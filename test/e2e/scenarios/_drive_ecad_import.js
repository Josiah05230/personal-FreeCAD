/* Manual driver (--drive): File > New Part from File... end to end with a
 * zip holding a real KiCad board, that board's own footprint STEP model,
 * and an unrelated enclosure STEP. Expects: the footprint model classified
 * "part of the board", the enclosure "separate mechanical part", then two
 * New Part dialogs back to back (mechanical first, then F preselected),
 * the enclosure imported into the mechanical PN's FCStd, and the KiCad
 * project + footprint model placed in the F PN's ECAD folder with the
 * board's real geometry in its FCStd.
 * Run test/e2e/scenarios/_setup_ecad_import_test.sh first. */
const ROOT = '/tmp/ecad_import_test';

function setSelect(el, value) {
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function setInput(el, value) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await sleep(100);
  }
  return null;
}
async function fillNewPart(project, type, description) {
  const selects = Array.from(document.querySelectorAll('select'));
  setSelect(selects[0], project);
  await sleep(150);
  if (type) setSelect(selects[1], type);
  const seqBtn = await waitFor(() =>
    Array.from(document.querySelectorAll('button')).find((b) => /^\d{3}$/.test((b.textContent || '').trim()))
  );
  seqBtn.click();
  await sleep(100);
  const desc = Array.from(document.querySelectorAll('input')).find((i) => /^Description/.test(i.placeholder || ''));
  setInput(desc, description);
  await sleep(100);
  Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Create Part').click();
}

note('--- dismiss the first-run welcome dialog ---');
for (let i = 0; i < 5; i++) {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    /^Next$|^Start using GWT-CAD$/.test(b.textContent || '')
  );
  if (!btn) break;
  btn.click();
  await sleep(150);
}

const cfgBefore = await rpc('pn.getCompanyConfig', {});
await rpc('pn.setCompanyConfig', {
  registryPath: ROOT + '/registry',
  ecadRepoPath: ROOT + '/ecad-cad-files',
  projects: { CM: { name: 'Test Co', repoPath: ROOT + '/pn-cad-files' } }
});

note('--- the File menu has the new entry ---');
document.querySelector('.appbar-file').click();
await sleep(150);
assert(
  Array.from(document.querySelectorAll('.filemenu-item')).some((el) => /New Part from File/.test(el.textContent || '')),
  'File menu shows "New Part from File..."'
);
document.querySelector('.filemenu-scrim')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
await sleep(100);

note('--- pick the zip (test hook: the real menu opens a native file dialog) ---');
await G.importFromFilePath(ROOT + '/upload.zip');
const dlg = await waitFor(() => document.querySelector('.import-dialog'));
assert(!!dlg, 'the classification dialog opened');
const rows = Array.from(dlg.querySelectorAll('.import-files tr'));
const roleOf = (name) => {
  const r = rows.find((tr) => (tr.cells[0].textContent || '').endsWith(name));
  if (!r) return null;
  const sel = r.querySelector('select');
  return sel ? sel.value : r.cells[1].textContent;
};
note('rows: ' + rows.map((r) => r.textContent).join(' | '));
assert(roleOf('L_0603_1608Metric.step') === 'footprint', 'the footprint\'s own STEP model is "part of the board"');
assert(roleOf('enclosure.step') === 'mechanical', 'the unrelated enclosure STEP is a separate mechanical part');
assert(/KiCad project/.test(roleOf('board.kicad_pcb') || ''), 'the board file is part of the KiCad project');
assert(/1 mechanical part/.test(dlg.textContent) && /1 PCB assembly/.test(dlg.textContent), 'summary says two parts will be created');

note('--- override check: flipping the footprint model to mechanical updates the summary, then flip back ---');
const fpSelect = rows.find((tr) => (tr.cells[0].textContent || '').endsWith('L_0603_1608Metric.step')).querySelector('select');
setSelect(fpSelect, 'mechanical');
await sleep(100);
assert(/2 models/.test(dlg.textContent), 'summary now counts 2 mechanical models');
setSelect(fpSelect, 'footprint');
await sleep(100);

Array.from(dlg.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Continue').click();
await sleep(400);

note('--- first New Part dialog: the mechanical (enclosure) PN ---');
assert(!!(await waitFor(() => document.querySelectorAll('select').length === 2)), 'New Part dialog opened for the mechanical part');
await fillNewPart('CM', 'C', 'test enclosure');

note('--- second New Part dialog opens automatically with type F preselected ---');
const second = await waitFor(() => {
  const s = document.querySelectorAll('select');
  return s.length === 2 && s[1].value === 'F' ? s : null;
}, 30000);
assert(!!second, 'the PCB-assembly New Part dialog opened with type F preselected');
await fillNewPart('CM', null, 'test board');
await waitFor(() => false, 6000); // placeEcad + kicad-cli STEP export + push

note('--- verify the results on disk / in the registry ---');
const mech = await rpc('pn.resolve', { pnSeqOrFull: 'CMC001' });
note('mechanical part: ' + mech.path);
assert(mech.path.startsWith(ROOT + '/pn-cad-files/CM/C/'), 'mechanical PN\'s FCStd is in the mechanical repo');
const board = await rpc('pn.resolve', { pnSeqOrFull: 'CMF001' });
note('board part: ' + board.path);
assert(board.path.startsWith(ROOT + '/ecad-cad-files/CM/F/'), 'F PN\'s FCStd is in the ECAD repo');
const dir = board.path.slice(0, board.path.lastIndexOf('/'));
const found = await window.cad.findKicadProject(dir);
note('ECAD folder: ' + JSON.stringify(found));
assert(!!found.pcbPath && !!found.proPath, 'the KiCad project landed next to the F part\'s FCStd');
const mechDir = mech.path.slice(0, mech.path.lastIndexOf('/'));
const mechFound = await window.cad.findKicadProject(mechDir);
assert(!mechFound.pcbPath, 'no KiCad files leaked into the mechanical part\'s folder');

const info = await rpc('document.info', {});
note('open doc: ' + JSON.stringify(info));
assert(info.path === board.path, 'the F part is the open document at the end');
assert(info.objects > 12, 'the F part\'s FCStd holds the board\'s imported geometry, not an empty doc');

note('--- the imported KiCad files were committed AND pushed (auto-push, same as Save) ---');
let st = null;
for (let i = 0; i < 50; i++) {
  st = await window.cad.gitStatus(found.pcbPath);
  if (st.tracked && !st.dirty && st.ahead === 0) break;
  await sleep(200);
}
note('ECAD repo status for the board: ' + JSON.stringify(st));
assert(st.tracked === true, 'the .kicad_pcb is tracked in the ECAD repo');
assert(st.dirty === false && st.ahead === 0, 'nothing left uncommitted or unpushed');
const mechSt = await window.cad.gitStatus(mech.path);
assert(mechSt.tracked === true && mechSt.ahead === 0, 'the mechanical part was committed and pushed too');

note('--- "Open in KiCad" available for the freshly imported board ---');
document.querySelector('.appbar-file').click();
await sleep(150);
assert(
  Array.from(document.querySelectorAll('.filemenu-item')).some((el) => /Open in KiCad/.test(el.textContent || '')),
  '"Open in KiCad" is in the File menu'
);
document.querySelector('.filemenu-scrim')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

note('--- Re-sync KiCad PCB: commit a local KiCad save, pull a teammate\'s push, push ---');
const teammate = ROOT + '/teammate';
await window.cad.gitClone(ROOT + '/remotes/ecad-cad-files.git', teammate);
await window.cad.writeText('from a teammate\n', teammate + '/CM/F/CMF0010/teammate-notes.txt');
await window.cad.gitCommitAll(teammate + '/CM/F/CMF0010/teammate-notes.txt', 'teammate change', 'Mate', 'mate@example.com');
await window.cad.gitPush(teammate + '/CM/F/CMF0010/teammate-notes.txt');
// stands in for saving in KiCad: a changed/new file in the board folder
await window.cad.writeText('edited in KiCad\n', dir + '/my-kicad-edit.txt');

G.runCommand('ins.kicadSync');
let synced = null;
for (let i = 0; i < 60; i++) {
  synced = await window.cad.gitStatus(dir + '/my-kicad-edit.txt');
  const mate = await window.cad.gitStatus(dir + '/teammate-notes.txt');
  if (synced.tracked && !synced.dirty && synced.ahead === 0 && synced.behind === 0 && mate.tracked) break;
  await sleep(250);
}
note('after re-sync: ' + JSON.stringify(synced));
assert(synced.tracked === true, 'the local KiCad save got committed');
assert(synced.ahead === 0 && synced.behind === 0, 'and pushed, with the teammate\'s change pulled in (in sync with origin)');
assert((await window.cad.gitStatus(dir + '/teammate-notes.txt')).tracked === true, 'the teammate\'s file is now present locally');
const after = await rpc('document.info', {});
assert(after.objects > 12, 'the board was re-imported (geometry still present)');

await rpc('pn.setCompanyConfig', cfgBefore);
note('--- done ---');
