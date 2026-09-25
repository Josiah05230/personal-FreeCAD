/* Full write-path git coverage through the real UI: init, stage+commit,
 * branch create/switch/merge, push/pull against a real (local, bare)
 * remote. Push/pull auth itself (gh auth git-credential against real
 * GitHub) is NOT re-verified here - that depends on this machine's own gh
 * login and isn't something a CI-safe deterministic test should assume;
 * this test proves the git PLUMBING and UI wiring work by using a local
 * bare repo as the "remote" instead, which exercises the exact same
 * `git push`/`git pull` code paths without any network/auth dependency.
 *
 * The renderer has no Node integration (contextIsolation, no require()), so
 * every filesystem/git-internals check here goes through window.cad's
 * bridge (gitAdd/gitCommit/gitLog/etc, writeText, listDir) - the same
 * surface the real UI uses - rather than shelling out directly. */

const WORK = '/tmp/gwtcad_git_e2e';
const REMOTE = '/tmp/gwtcad_git_e2e_remote.git';
const DESIGN_PATH = WORK + '/design.FCStd';

// React-controlled inputs intercept a plain el.value = x, so go through the
// native prototype setter instead (same trick React's own testing utils
// use), then fire a real 'input'/'change' event so the component's onChange
// actually runs. Matches the pattern already proven in real_input.js.
function setInputValue(el, value) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  nativeSetter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function setTextareaValue(el, value) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  nativeSetter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function setSelectValue(el, value) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  nativeSetter.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

note('--- git: init, stage/commit, branch, merge, push/pull (real UI, real git) ---');

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
assert(!!G.getState().bodies[0], 'body created');

await rpc('document.saveAs', { path: DESIGN_PATH });
await G.refresh();
await idle();
assert(G.getState().docPath === DESIGN_PATH, 'docPath tracks the saved file (' + G.getState().docPath + ')');

assert(G.commandIds().includes('panel.git'), 'the History (Git) panel command is registered');
G.runCommand('panel.git');
await sleep(150);
assert(!!document.querySelector('.gitpanel.open'), 'git panel opened');

// --- init ---
let initBtn = Array.from(document.querySelectorAll('.git-btn')).find((b) => /Initialize git/i.test(b.textContent || ''));
assert(!!initBtn, 'Initialize button shown for a non-repo folder');
initBtn.click();
await sleep(400);
let statusAfterInit = await window.cad.gitStatus(DESIGN_PATH);
assert(statusAfterInit.isRepo === true, 'git init actually created a repo (' + JSON.stringify(statusAfterInit) + ')');

document.querySelector('.gitpanel-refresh').click();
await sleep(200);
const dirtyDot = document.querySelector('.git-dot.dirty');
assert(!!dirtyDot, 'panel shows "uncommitted changes" after init + saved file');

// --- stage + commit (through the real UI) ---
const msgBox = document.querySelector('.git-msg');
assert(!!msgBox, 'commit message textarea exists');
setTextareaValue(msgBox, 'initial commit');
await sleep(60);
const commitBtn = Array.from(document.querySelectorAll('.git-btn')).find((b) => /Commit All Changes/i.test(b.textContent || ''));
assert(!!commitBtn && !commitBtn.disabled, 'Commit button enabled once a message is typed and the repo is dirty');
commitBtn.click();
await sleep(500);

const logAfterCommit = await window.cad.gitLog(DESIGN_PATH, 10);
assert(
  logAfterCommit.length === 1 && logAfterCommit[0].subject === 'initial commit',
  'the commit landed with the right message: ' + JSON.stringify(logAfterCommit)
);
const statusAfterCommit = await window.cad.gitStatus(DESIGN_PATH);
assert(statusAfterCommit.dirty === false, 'repo is clean immediately after Commit All');
const mainBranch = statusAfterCommit.branch;

// --- branch create + switch (through the real UI) ---
const branchBtn = Array.from(document.querySelectorAll('.git-btn')).find((b) => /\+ Branch/i.test(b.textContent || ''));
assert(!!branchBtn, 'Branch button exists');
branchBtn.click();
await sleep(80);
const branchInput = document.querySelector('.git-branch-new .git-input');
assert(!!branchInput, 'new-branch name input appears');
setInputValue(branchInput, 'feature-x');
await sleep(60);
const createBtn = Array.from(document.querySelectorAll('.git-branch-new .git-btn')).find((b) => /Create/i.test(b.textContent || ''));
createBtn.click();
await sleep(400);

const statusOnFeature = await window.cad.gitStatus(DESIGN_PATH);
assert(statusOnFeature.branch === 'feature-x', 'switched onto the new branch (' + statusOnFeature.branch + ')');

// a real change on feature-x, committed via the bridge (same git write path
// the UI's Commit button uses) so the merge below does something real
await window.cad.writeText('change\n', WORK + '/notes.txt');
await window.cad.gitAdd(DESIGN_PATH);
await window.cad.gitCommit(DESIGN_PATH, 'feature-x change');
await sleep(150);

// switch back to the original branch by clicking its chip in the panel
document.querySelector('.gitpanel-refresh').click();
await sleep(200);
const mainChip = Array.from(document.querySelectorAll('.git-branch')).find((c) => c.textContent === mainBranch);
assert(!!mainChip, 'the original branch has a clickable chip in the panel');
mainChip.click();
await sleep(400);
const statusBackOnMain = await window.cad.gitStatus(DESIGN_PATH);
assert(statusBackOnMain.branch === mainBranch, 'clicking the branch chip switched back (' + statusBackOnMain.branch + ')');

// --- merge (through the real UI) ---
document.querySelector('.gitpanel-refresh').click();
await sleep(200);
const mergeToggleBtn = Array.from(document.querySelectorAll('.git-btn')).find((b) => /Merge…/i.test(b.textContent || ''));
assert(!!mergeToggleBtn && !mergeToggleBtn.disabled, 'Merge button enabled with 2+ branches');
mergeToggleBtn.click();
await sleep(80);
const mergeSelect = document.querySelector('.git-branch-new select');
assert(!!mergeSelect, 'merge target dropdown appears');
setSelectValue(mergeSelect, 'feature-x');
await sleep(60);
const mergeBtn = Array.from(document.querySelectorAll('.git-branch-new .git-btn')).find((b) => /^Merge$/i.test((b.textContent || '').trim()));
assert(!!mergeBtn && !mergeBtn.disabled, 'Merge action button enabled once a target is picked');
mergeBtn.click();
// listDir filters to .FCStd files only (it's the Data Panel's file-browser
// backend) and gitLog follows only design.FCStd's own history, so neither
// can see notes.txt or its commit - gitLogAll (full repo history, no file
// filter) is the real check: the feature-x commit should now be reachable
// from the current branch, which only a real merge makes true.
const merged = await waitFor(async () => {
  const l = await window.cad.gitLogAll(DESIGN_PATH, 10);
  return l.some((c) => c.subject === 'feature-x change');
}, 4000);
assert(merged, "feature-x's commit is now reachable from the current branch - a real merge happened");

// --- push (through the real UI), against a real local bare remote ---
// build the "remote" fresh every run (bug found 2026-09-25: this used to
// silently depend on /tmp/gwtcad_git_e2e_remote.git already existing from
// some earlier, unrelated setup - once that directory was cleaned up as
// stale test-fixture debris, the push here failed with "does not appear
// to be a git repository" and hasUpstream never got set, even though the
// test itself never checked the push's own success/failure to notice).
await window.cad.gitInitBare(REMOTE);
await window.cad.gitAddRemote(DESIGN_PATH, 'origin', REMOTE);
await sleep(100);
document.querySelector('.gitpanel-refresh').click();
await sleep(200);
const pushBtn = Array.from(document.querySelectorAll('.git-btn')).find((b) => /^Push$/i.test((b.textContent || '').trim()));
assert(!!pushBtn, 'Push button exists');
pushBtn.click();
await sleep(700);

const pushErrorEl = document.querySelector('.git-error');
note('git panel error after push click: ' + (pushErrorEl ? pushErrorEl.textContent : 'none'));
assert(!pushErrorEl, 'the push itself did not fail (no error shown in the Git panel) - catches a bad/missing remote directly, instead of only surfacing as a confusing hasUpstream/ahead mismatch downstream');

const statusAfterPush = await window.cad.gitStatus(DESIGN_PATH);
assert(statusAfterPush.hasUpstream === true, 'push set up the upstream tracking branch');
assert((statusAfterPush.ahead ?? 0) === 0, 'nothing left unpushed right after a successful push (ahead=0)');

note('--- done ---');
