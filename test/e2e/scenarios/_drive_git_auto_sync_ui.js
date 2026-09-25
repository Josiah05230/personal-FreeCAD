/* Manual driver (--drive): verifies auto-pull-on-open and auto-push-on-save
 * through the REAL App.tsx openDesign/save functions (not just the raw
 * git.ts/lockfile.ts primitives, already covered by
 * _drive_git_sync_lock.js) - against an isolated single-clone scratch repo
 * (never real company data). */

const PART_PATH = '/tmp/sync_ui_test/cloneA/UITEST/UITEST.FCStd';

note('--- dismiss the first-run welcome dialog ---');
for (let i = 0; i < 5; i++) {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    /^Next$|^Start using GWT-CAD$/.test(b.textContent || '')
  );
  if (!btn) break;
  btn.click();
  await sleep(150);
}

note('--- open the test part via the REAL openDesign (auto-pull + lock acquire happen here) ---');
await G.openDesignPath(PART_PATH);
await idle();
await sleep(500);

const afterOpen = await G.gitSyncDebug();
note('sync state after open: ' + JSON.stringify(afterOpen));
assert(afterOpen.docPath === PART_PATH, 'the document actually opened');
assert(afterOpen.offline === false, 'not reported offline for a real reachable local remote');

const lockAfterOpen = await window.cad.lockCurrent(PART_PATH);
note('lock after open: ' + JSON.stringify(lockAfterOpen));
assert(!!lockAfterOpen, 'openDesign acquired the standalone lock on this part');

note('--- edit the part (extrude something) so save() has real geometry to persist ---');
const s0 = await rpc('sketch.on', { ref: { kind: 'origin', role: 'XY_Plane' } });
await rpc('sketch.finish', { sketchId: s0.sketchId, elements: [{ type: 'circle', c: [30, 30], r: 5 }], constraints: [] });
await G.refresh();
await idle();
G.selectSketch(s0.sketchId);
await sleep(40);
await G.applyOp('extrude', { operation: 'Join', mode: 'Blind', length: 3 });
await idle();

note('--- save via the REAL save() (auto-commit + auto-push happen here) ---');
await G.saveDoc();
await idle();
await sleep(800); // save()'s own push is awaited, but give the UI a beat to settle state

const afterSave = await G.gitSyncDebug();
note('sync state after save: ' + JSON.stringify(afterSave));
assert(afterSave.unpushedCount === 0, 'the auto-push after save succeeded (no unpushed changes tracked)');

const statusAfterSave = await window.cad.gitStatus(PART_PATH);
note('git status after save: ' + JSON.stringify(statusAfterSave));
assert(statusAfterSave.dirty === false, 'the working tree is clean after save (real commit was made)');
assert(statusAfterSave.ahead === 0, 'nothing left unpushed at the remote level either');

note('--- confirm a real new commit actually landed and pushed ---');
const log = await window.cad.gitLog(PART_PATH, 3);
note('recent log: ' + JSON.stringify(log));
assert(log.length > 0 && log[0].subject.includes('saved via GWT-CAD'), 'the auto-push commit message is the expected one');

note('--- release the lock (simulating closing the app / opening a different file) ---');
await window.cad.lockRelease(PART_PATH);
const lockAfterRelease = await window.cad.lockCurrent(PART_PATH);
note('lock after manual release: ' + JSON.stringify(lockAfterRelease));
assert(lockAfterRelease === null, 'the lock was released cleanly');

note('--- done ---');
