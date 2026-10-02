/* Saving a released part never changes it in place: Save on an active (or
 * discontinued) revision makes the next revision from the edits, in work
 * unless the user picks Active; an in-work revision saves in place; a
 * superseded revision opens as the newest one and is only viewed, read
 * only, from there. New parts land flat at
 * <project>/<type>/<pn>.FCStd. Uses a scratch registry + CAD repo (local
 * git, no remote) - never real company data. */

const ROOT = '/tmp/gwtcad_rev_e2e_' + Date.now();
const REG = ROOT + '/registry';
const CAD = ROOT + '/cad';

note('--- scratch company: registry + one project repo ---');
await window.cad.mkdir(REG);
await window.cad.mkdir(CAD + '/CM/C');
await window.cad.writeText(
  'pn,pn_seq,project,type,seq,rev,name,description,reason,mfg,mfg_pn,purchasing_link,status,lifecycle,rev_date,created,repo_relpath\n',
  REG + '/registry.csv'
);
await window.cad.writeText('C: Connector\n', REG + '/types.yaml');
await window.cad.writeText('', CAD + '/.gitkeep');
for (const dir of [REG, CAD]) {
  await window.cad.gitInit(dir + '/x');
  await window.cad.gitAdd(dir + '/x');
  await window.cad.gitCommit(dir + '/x', 'init', 'Test', 'test@example.com');
}
await rpc('pn.setCompanyConfig', { registryPath: REG, projects: { CM: { repoPath: CAD } } });

note('--- a designed part with a drawing, reserved and saved ---');
await rpc('session.reset');
await G.refresh();
await idle();
const s0 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: s0.sketchId,
  elements: [{ type: 'rect', a: [0, 0], b: [20, 15] }],
  constraints: []
});
await G.refresh();
await idle();
G.selectSketch(s0.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 5 });
await idle();

const reserved = await rpc('pn.reserve', {
  project: 'CM', type: 'C', seq: 1, name: 'bracket', description: 'test bracket'
});
assertEq(reserved.repoRelpath, 'CM/C/CMC0010.FCStd', 'a new part lands flat at <project>/<type>/<pn>.FCStd');
const REV0 = CAD + '/' + reserved.repoRelpath;
await rpc('pn.tagDocument', { pn: reserved.pn, name: reserved.name, description: reserved.description });
const page = await rpc('drawing.pageCreate', { label: 'Drawing' });
await rpc('drawing.addView', { pageId: page.id, direction: 'front', scale: 1 });
await rpc('drawing.makeTable', {
  pageId: page.id,
  rows: [{ label: 'PART NUMBER', value: '=PN' }],
  columns: [
    { key: 'label', header: 'FIELD', source: 'label' },
    { key: 'value', header: 'VALUE', source: 'value' }
  ]
});
await rpc('document.saveAs', { path: REV0 });
await G.openDesignPath(REV0);
await idle();
await waitFor(() => G.getState().currentPn === 'CMC0010', 5000);
assertEq(G.getState().currentPn, 'CMC0010', 'the part opens knowing its PN');

const history = async () => (await rpc('pn.history', { pnSeq: 'CMC001' })).revisions;

note('--- in work: Save writes in place ---');
await G.saveDoc();
await idle();
assertEq(G.getState().docPath, REV0, 'an in-work revision saves to its own file');
assertEq((await history()).length, 1, 'no revision made for an in-work save');

note('--- released: Save asks for a revision; Cancel saves nothing ---');
await rpc('pn.setLifecycle', { pnSeq: 'CMC001', lifecycle: 'active' });
G.answerNextPrompt(null);
await G.saveDoc();
await idle();
assertEq(G.getState().docPath, REV0, 'cancelling leaves the released file open');
assertEq((await history()).length, 1, 'cancelling makes no revision');

note('--- released: Save with a reason makes CMC0011, in work ---');
G.answerNextPrompt({ reason: 'moved the mounting holes', status: 'In work (draft)' });
await G.saveDoc();
await idle();
await waitFor(() => G.getState().currentPn === 'CMC0011', 10000);
const REV1 = CAD + '/CM/C/CMC0011.FCStd';
assertEq(G.getState().currentPn, 'CMC0011', 'the open document is now the new revision');
assertEq(G.getState().docPath, REV1, 'the new revision sits flat beside the old one');
assertEq(G.getState().currentLifecycle, 'in_work', 'the new revision starts in work');
let revs = await history();
assertEq(revs.length, 2, 'the registry recorded the revision');
assertEq(revs[1].reason, 'moved the mounting holes', 'with the reason given');
assertEq(revs[0].status, 'obsolete', 'and the released revision is superseded');

note('--- in work again: a second save stays on CMC0011 ---');
await G.saveDoc();
await idle();
assertEq(G.getState().currentPn, 'CMC0011', 'saving in-work CMC0011 does not bump again');
assertEq((await history()).length, 2, 'still two revisions');

note('--- released, saved as Active: CMC0012 goes straight to active ---');
await rpc('pn.setLifecycle', { pnSeq: 'CMC001', lifecycle: 'active' });
G.answerNextPrompt({ reason: 'thicker flange', status: 'Active' });
await G.saveDoc();
await idle();
await waitFor(() => G.getState().currentPn === 'CMC0012', 10000);
await waitFor(() => G.getState().currentLifecycle === 'active', 15000);
assertEq(G.getState().currentLifecycle, 'active', 'CMC0012 was made active');
revs = await history();
assertEq(revs.length, 3, 'three revisions');
assertEq(revs[2].lifecycle, 'active', 'the registry has CMC0012 active');
const pages = (await rpc('drawing.pageList')).pages;
assertEq(pages.length, 1, 'the drawing came along to the new revision');

const REV2 = CAD + '/CM/C/CMC0012.FCStd';

note('--- opening a superseded revision opens the newest one instead ---');
await G.openDesignPath(REV1);
await idle();
assertEq(G.getState().docPath, REV2, 'CMC0011 opened as CMC0012');
assertEq(G.getState().currentPn, 'CMC0012', 'the newest revision is the open one');

note('--- History lists every revision with its file ---');
const files = (await rpc('pn.revisionFiles', { pnSeqOrFull: 'CMC0012' })).revisions;
assertEq(files.map((r) => [r.pn, r.current, r.path]), [
  ['CMC0010', false, REV0], ['CMC0011', false, REV1], ['CMC0012', true, REV2]
], 'oldest first, newest current');

note('--- an old revision is viewed read only from the newest ---');
await G.viewRevision(REV0, 'CMC0010');
await idle();
assertEq(G.getState().viewingRev, 'CMC0010', 'viewing CMC0010');
assertEq((await rpc('document.info')).path, REV0, 'the engine has CMC0010 open');
assert(G.getState().bodies.length > 0, 'its model shows');
let refused = null;
try {
  await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
} catch (e) {
  refused = String(e.message || e);
}
assert(refused && /old revision - read only/.test(refused), `an edit is refused (${refused})`);
await G.saveDoc();
await idle();
assertEq((await history()).length, 3, 'saving while viewing makes nothing');
await G.endReview();
await idle();
assertEq(G.getState().viewingRev, null, 'done viewing');
assertEq((await rpc('document.info')).path, REV2, 'back on CMC0012');
const s1 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
assert(!!s1.sketchId, 'CMC0012 is editable again');
