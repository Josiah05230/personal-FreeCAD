/* Pull, verified against a real (local, bare) remote with a genuine second
 * contributor: this app's own gitClone makes a second real clone of the
 * same remote, commits+pushes a change from there, then Pull is clicked in
 * the real UI and the change must land. No shell/Node access needed
 * (renderer has no Node integration) - every step goes through the same
 * window.cad git bridge the real panel uses. */

const WORK = '/tmp/gwtcad_git_pull_e2e';
const REMOTE = '/tmp/gwtcad_git_pull_e2e_remote.git';
const CO_CLONE = '/tmp/gwtcad_git_pull_e2e_coclone';
const DESIGN_PATH = WORK + '/design.FCStd';

note('--- git: Pull brings in a real change pushed by someone else ---');

await rpc('session.reset');
await G.refresh();
await idle();

const s0 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', {
  sketchId: s0.sketchId,
  elements: [{ type: 'rect', a: [0, 0], b: [10, 10] }],
  constraints: []
});
await G.refresh();
await idle();
G.selectSketch(s0.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 5 });
await idle();

await rpc('document.saveAs', { path: DESIGN_PATH });
await G.refresh();
await idle();

await window.cad.gitInit(DESIGN_PATH);
await window.cad.gitAdd(DESIGN_PATH);
await window.cad.gitCommit(DESIGN_PATH, 'initial commit');
await window.cad.gitAddRemote(DESIGN_PATH, 'origin', REMOTE);
await window.cad.gitPush(DESIGN_PATH);
const st = await window.cad.gitStatus(DESIGN_PATH);
assert(st.hasUpstream === true, 'setup: push succeeded, upstream tracking set up');

// a genuine SECOND clone of the same remote - real ancestry, so its push
// below is a real fast-forward on the remote, not a synthetic/unrelated one
const cloned = await window.cad.gitClone(REMOTE, CO_CLONE);
assert(!!cloned.root, 'gitClone produced a real second working copy: ' + JSON.stringify(cloned));
// every git.ts function keys off dirname(filePath) to find the repo, so it
// always wants a FILE inside the repo, never the repo root itself
const coNotesPath = CO_CLONE + '/co_notes.txt';
await window.cad.writeText('hello from a co-contributor\n', coNotesPath);
await window.cad.gitAdd(coNotesPath);
await window.cad.gitCommit(coNotesPath, 'co-contributor change');
await window.cad.gitPush(coNotesPath);
const coLog = await window.cad.gitLogAll(coNotesPath, 5);
assert(
  coLog.some((c) => c.subject === 'co-contributor change'),
  'setup: the co-contributor commit exists in the second clone'
);

// back in the ORIGINAL working copy - it does not know about that commit yet
const beforePull = await window.cad.gitLogAll(DESIGN_PATH, 20);
assert(
  !beforePull.some((c) => c.subject === 'co-contributor change'),
  "sanity: the incoming commit isn't visible in the original copy before Pull"
);

assert(G.commandIds().includes('panel.git'), 'the History (Git) panel command is registered');
G.runCommand('panel.git');
await sleep(150);
document.querySelector('.gitpanel-refresh').click();
await sleep(200);

const pullBtn = Array.from(document.querySelectorAll('.git-btn')).find((b) => /^Pull$/i.test((b.textContent || '').trim()));
assert(!!pullBtn, 'Pull button exists');
pullBtn.click();

const pulled = await waitFor(async () => {
  const l = await window.cad.gitLogAll(DESIGN_PATH, 20);
  return l.some((c) => c.subject === 'co-contributor change');
}, 4000);
assert(pulled, 'Pull (real UI button) brought in a commit pushed by a real second clone of the same remote');

note('--- done ---');
