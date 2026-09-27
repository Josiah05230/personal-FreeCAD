/* Background autosave to the real file. With a short test interval:
 *  - a clean document is never saved
 *  - a dirty in-work company part is saved in place (and the edit is really
 *    in the file: reopening it shows it), the tab goes clean, the status bar
 *    says "Autosaved"
 *  - drawing edits (made through the drawing sheet, which never told App
 *    before) mark the document dirty and get autosaved too
 *  - an open op dialog, user input and a busy command queue defer it; it
 *    runs once they're gone
 *  - a released (active) part is never written in place - only the crash
 *    recovery copy - and stays dirty
 *  - a file outside the company repos is autosaved in place
 * Scratch registry + CAD repo (local git, no remote) - never real data. */

const ROOT = '/tmp/gwtcad_autosave_e2e_' + Date.now();
const REG = ROOT + '/registry';
const CAD = ROOT + '/cad';
const INTERVAL = 1500;

note('--- scratch company: registry + one project repo ---');
await window.cad.mkdir(REG);
await window.cad.mkdir(CAD + '/CM/C');
await window.cad.writeText(
  'pn,pn_seq,project,type,seq,rev,name,description,reason,mfg,mfg_pn,purchasing_link,status,lifecycle,rev_date,created,repo_relpath\n',
  REG + '/registry.csv'
);
await window.cad.writeText('C: Connector\n', REG + '/types.yaml');
// like the real CAD repo: FreeCAD's per-save backups are not tracked
await window.cad.writeText('*.FCBak\n.gwtcad-thumbs/\n', CAD + '/.gitignore');
for (const dir of [REG, CAD]) {
  await window.cad.gitInit(dir + '/x');
  await window.cad.gitAdd(dir + '/x');
  await window.cad.gitCommit(dir + '/x', 'init', 'Test', 'test@example.com');
}
await rpc('pn.setCompanyConfig', { registryPath: REG, projects: { CM: { repoPath: CAD } } });

const sketchRect = async (w, h) => {
  const s = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
  await rpc('sketch.finish', {
    sketchId: s.sketchId,
    elements: [{ type: 'rect', a: [0, 0], b: [w, h] }],
    constraints: []
  });
  await G.refresh();
  await idle();
  return s.sketchId;
};
const extrude = async (sketchId, length) => {
  G.selectSketch(sketchId);
  await sleep(40);
  await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length });
  await idle();
};
const featureCount = () => (G.getState().bodies[0]?.features ?? []).length;
const state = () => G.autosaveState();
const commitAll = async () => {
  await window.cad.gitAdd(CAD + '/x');
  await window.cad.gitCommit(CAD + '/x', 'baseline', 'Test', 'test@example.com').catch(() => undefined);
};
// has the part file itself changed since the last commit
const repoDirty = async () =>
  (await window.cad.gitChangedFiles(CAD + '/x')).some((c) => /CMC0010\.FCStd$/.test(c.path));

note('--- an in-work company part, saved and committed ---');
await rpc('session.reset');
await G.refresh();
await idle();
await extrude(await sketchRect(20, 15), 5);
const reserved = await rpc('pn.reserve', {
  project: 'CM', type: 'C', seq: 1, name: 'bracket', description: 'autosave test'
});
const PART = CAD + '/' + reserved.repoRelpath;
await rpc('pn.tagDocument', { pn: reserved.pn, name: reserved.name, description: reserved.description });
await rpc('document.saveAs', { path: PART });
await G.openDesignPath(PART);
await idle();
await waitFor(() => G.getState().currentPn === 'CMC0010', 5000);
assertEq(G.getState().currentPn, 'CMC0010', 'the part opens knowing its PN');
await commitAll();
assert(!(await repoDirty()), 'baseline committed - the repo is clean');

// The harness itself is slow enough (an extrude + scene refresh) that a
// 1.5s timer can fire before a check runs, so each phase HOLDs the timer
// (long interval) while it sets up, then RELEASEs it (short interval).
const HOLD = () => G.autosaveConfig({ intervalMs: 600000 });
const RELEASE = () => G.autosaveConfig({ intervalMs: INTERVAL });
G.autosaveConfig({ enabled: true, intervalMs: INTERVAL, quietMs: 200 });

note('--- clean document: nothing is saved ---');
await sleep(INTERVAL + 1500);
assertEq(state().saves, 0, 'no autosave while the document is clean');
assert(!(await repoDirty()), 'the file on disk was not touched');

note('--- dirty in-work part: saved in place ---');
HOLD();
const before = featureCount();
await extrude(await sketchRect(8, 8), 9);
const edited = featureCount();
assert(edited > before, `the edit added features (${before} -> ${edited})`);
assert(state().dirty, 'the edit made the tab dirty');
assert(!(await repoDirty()), 'nothing written before the interval');
RELEASE();
assert(await waitFor(() => state().saves === 1, 8000), 'autosaved after the interval');
await sleep(100);
assert(!state().dirty, 'the tab is clean after the autosave');
assert(await repoDirty(), 'the part file on disk changed');
assert(/^Autosaved /.test(state().indicator || ''), `the status bar says so ("${state().indicator}")`);
await G.openDesignPath(PART);
await idle();
assertEq(featureCount(), edited, 'reopening the file from disk shows the autosaved edit');
await commitAll();

note('--- drawing edits mark the document dirty and are autosaved ---');
HOLD();
G.runCommand('draw.fromDesign');
assert(await waitFor(() => document.querySelector('.drawing') != null, 5000), 'entered a drawing');
await idle();
assert(await waitFor(() => state().dirty, 3000), 'creating the drawing page marked the document dirty');
RELEASE();
assert(await waitFor(() => state().saves === 2, 8000), 'the new drawing page was autosaved');
HOLD();
G.runCommand('draw.front');
await idle();
assert(await waitFor(() => state().dirty, 3000), 'placing a view on the sheet marked the document dirty');
RELEASE();
assert(await waitFor(() => state().saves === 3, 8000), 'the placed view was autosaved');
await G.openDesignPath(PART);
await idle();
const pages = (await rpc('drawing.pageList')).pages;
assertEq(pages.length, 1, 'reopening the file shows the drawing page');
const contents = await rpc('drawing.pageContents', { pageId: pages[0].id });
assert((contents.views || []).length >= 1, `and its view (${(contents.views || []).length})`);
await commitAll();

note('--- an open op dialog defers the save ---');
HOLD();
await extrude(await sketchRect(4, 4), 12);
assert(state().dirty, 'dirty going in');
G.openOp('fillet');
await sleep(80);
const s1 = state().saves;
RELEASE();
await sleep(INTERVAL + 1500);
assertEq(state().saves, s1, 'no autosave while the dialog is open');
assertEq(state().lastDefer, 'operation dialog open', 'deferred because of the dialog');
G.closeOp();
assert(await waitFor(() => state().saves === s1 + 1, 8000), 'saved once the dialog closed');

note('--- user input defers the save ---');
HOLD();
G.autosaveConfig({ quietMs: 1000 });
await extrude(await sketchRect(3, 3), 15);
assert(state().dirty, 'dirty going in');
const s2 = state().saves;
RELEASE();
const typeUntil = Date.now() + INTERVAL + 1500;
while (Date.now() < typeUntil) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
  await sleep(150);
}
assertEq(state().saves, s2, 'no autosave while the user keeps typing');
assertEq(state().lastDefer, 'user active', 'deferred because of the input');
assert(await waitFor(() => state().saves === s2 + 1, 8000), 'saved once the input stopped');
G.autosaveConfig({ quietMs: 200 });

note('--- a busy command queue defers the save ---');
// attempts made by hand here, the timer held off throughout
HOLD();
await extrude(await sketchRect(2, 2), 18);
assert(state().dirty, 'dirty going in');
const s3 = state().saves;
const sk = await sketchRect(1, 1);
G.selectSketch(sk);
await sleep(40);
const running = G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 24 });
await sleep(0);
const r = await G.autosaveNow();
assertEq(r, 'deferred', 'an autosave attempted mid-operation is deferred');
assert(
  ['command queue busy', 'engine call in flight'].includes(state().lastDefer),
  `because the engine is busy ("${state().lastDefer}")`
);
assertEq(state().saves, s3, 'nothing saved mid-operation');
await running;
await idle();
await sleep(300);
assertEq(await G.autosaveNow(), 'saved', 'the same attempt saves once the operation finished');
RELEASE();
await commitAll();

note('--- ECAD: what KiCad saved is committed, KiCad junk is not ---');
// hold the timer so only the explicit attempts below run (let one already
// scheduled check go by first)
HOLD();
await sleep(INTERVAL + 300);
const KDIR = CAD + '/CM/C/CMC001-kicad';
await window.cad.mkdir(KDIR);
await window.cad.writeText('(kicad_pcb (version 1))\n', KDIR + '/board.kicad_pcb');
await window.cad.writeText('{}\n', KDIR + '/board.kicad_pro');
await commitAll();
G.setLinkedKicadProject(KDIR + '/board.kicad_pro');
await sleep(100);
assertEq(await G.autosaveKicadNow(), 'nothing changed', 'no KiCad changes, nothing to commit');
await window.cad.writeText('(kicad_pcb (version 2))\n', KDIR + '/board.kicad_pcb');
await window.cad.writeText('lock\n', KDIR + '/~board.kicad_pcb.lck');
await window.cad.writeText('(kicad_sch)\n', KDIR + '/_autosave-board.kicad_sch');
await window.cad.mkdir(KDIR + '/board-backups');
await window.cad.writeText('zip\n', KDIR + '/board-backups/board-2026.zip');
assertEq(await G.autosaveKicadNow(), 'committed 1', 'the board KiCad saved was committed');
const klog = await window.cad.gitLog(KDIR + '/board.kicad_pcb', 1);
assert(/KiCad changes/.test(klog[0]?.subject || ''), `as a KiCad autosave commit ("${klog[0]?.subject}")`);
const left = (await window.cad.gitChangedFiles(KDIR + '/board.kicad_pro')).map((c) => c.path).sort();
assert(
  left.length > 0 && left.every((p) => /~board|_autosave-|-backups/.test(p)),
  `lock / autosave / backup files were left alone (${JSON.stringify(left)})`
);

note('--- released part: never written in place ---');
await rpc('pn.setLifecycle', { pnSeq: 'CMC001', lifecycle: 'active' });
RELEASE();
await extrude(await sketchRect(5, 5), 27);
const saves3 = state().saves;
await sleep(INTERVAL + 2000);
assertEq(state().saves, saves3, 'no in-place autosave of a released revision');
assert(/released/.test(state().lastSkip), `skipped as released ("${state().lastSkip}")`);
assert(state().dirty, 'the tab stays dirty (a real Save makes the next revision)');
assert(!(await repoDirty()), 'the released file on disk is untouched');
const rec = await G.triggerAutosave();
assert(rec && rec.saved === true, 'the crash-recovery copy still works for it');
assertEq((await rpc('pn.history', { pnSeq: 'CMC001' })).revisions.length, 1, 'no revision was made');
await window.cad.writeText('(kicad_pcb (version 3))\n', KDIR + '/board.kicad_pcb');
assertEq(await G.autosaveKicadNow(), 'released (active)', 'a released part\'s KiCad changes are not committed');
G.setLinkedKicadProject(null);

note('--- a file outside the company repos is autosaved in place ---');
HOLD();
await rpc('session.reset');
await G.refresh();
await idle();
await extrude(await sketchRect(10, 10), 3);
const SCRATCH = ROOT + '/scratch/loose.FCStd';
await window.cad.mkdir(ROOT + '/scratch');
await rpc('document.saveAs', { path: SCRATCH });
await G.openDesignPath(SCRATCH);
await idle();
assertEq(G.getState().currentPn, null, 'not a company part');
const saves4 = state().saves;
RELEASE();
await extrude(await sketchRect(4, 4), 6);
const scratchEdited = featureCount();
assert(await waitFor(() => state().saves === saves4 + 1, 8000), 'autosaved the scratch file');
await G.openDesignPath(SCRATCH);
await idle();
assertEq(featureCount(), scratchEdited, 'reopening the scratch file shows the edit');

G.autosaveConfig({ enabled: null, intervalMs: null, quietMs: 4000 });
