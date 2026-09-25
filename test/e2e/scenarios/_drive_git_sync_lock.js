/* Manual driver (--drive): verifies the git auto-sync + standalone lock +
 * upstream-change watch pipeline (user request, 2026-09-25) against an
 * isolated two-clone scratch environment (never real company data) built
 * by the harness invocation itself (see the shell setup before this runs).
 * Exercises window.cad's lock/gitWatch/git bridge methods directly, since
 * this is main-process IPC logic, not sidecar RPC. */

const CLONE_A = '/tmp/sync_test/cloneA/TESTPART/TESTPART.FCStd';
const CLONE_B = '/tmp/sync_test/cloneB/TESTPART/TESTPART.FCStd';

note('--- gitStatus sees both clones as real repos with an upstream ---');
const stA = await window.cad.gitStatus(CLONE_A);
const stB = await window.cad.gitStatus(CLONE_B);
note('cloneA status: ' + JSON.stringify(stA));
note('cloneB status: ' + JSON.stringify(stB));
assert(stA.isRepo && stA.hasUpstream, 'clone A is a real repo with an upstream');
assert(stB.isRepo && stB.hasUpstream, 'clone B is a real repo with an upstream');

note('--- isReachable is true for a real local bare remote ---');
const reachableA = await window.cad.gitIsReachable(CLONE_A);
note('reachable: ' + reachableA);
assert(reachableA === true, 'a real reachable remote reports reachable');

note('--- lock: clone A acquires the lock, commits + pushes it ---');
const acqA = await window.cad.lockAcquire(CLONE_A);
note('acquire A: ' + JSON.stringify(acqA));
assert(acqA.status === 'acquired', 'clone A successfully acquired the lock (' + acqA.status + ')');

note('--- clone B pulls and sees the lock file ---');
await window.cad.gitPull(CLONE_B);
const lockFromB = await window.cad.lockCurrent(CLONE_B);
note('lock as seen from clone B: ' + JSON.stringify(lockFromB));
assert(!!lockFromB, 'clone B can see the lock A wrote, after pulling');

note('--- clone B tries to acquire the SAME lock - should report held, not acquired ---');
const acqB = await window.cad.lockAcquire(CLONE_B);
note('acquire B (should be held): ' + JSON.stringify(acqB));
assert(acqB.status === 'held', 'clone B correctly sees the lock as held by someone else (' + acqB.status + ')');
assert(acqB.status === 'held' && acqB.lock.machine === lockFromB.machine, 'the reported holder matches what clone B pulled');

note('--- release from clone A, clone B pulls, lock is gone ---');
await window.cad.lockRelease(CLONE_A);
await window.cad.gitPull(CLONE_B);
const lockAfterRelease = await window.cad.lockCurrent(CLONE_B);
note('lock after release, from clone B: ' + JSON.stringify(lockAfterRelease));
assert(lockAfterRelease === null, 'the lock is gone from clone B after A released and B pulled');

note('--- NOW clone B can acquire it cleanly ---');
const acqB2 = await window.cad.lockAcquire(CLONE_B);
note('acquire B (should be acquired now): ' + JSON.stringify(acqB2));
assert(acqB2.status === 'acquired', 'clone B acquires cleanly once A released (' + acqB2.status + ')');
await window.cad.lockRelease(CLONE_B); // clean up for the next test section

note('--- upstream-change watch: clone A commits+pushes a real change, clone B\'s watch detects it ---');
// the lock dance above already left clone B's local HEAD in sync with
// origin (its own lock-release pull absorbed everything up to that point)
// - explicitly confirm that starting state so this section's own
// before/after comparison is meaningful, rather than assuming it.
await window.cad.gitPull(CLONE_A);
const beforeChange = await window.cad.gitWatchCheckOne(CLONE_B);
note('watch check BEFORE any new change (should be null - B is caught up): ' + JSON.stringify(beforeChange));
assert(beforeChange === null, 'nothing to report before A makes a new change (confirms clean starting state)');

// simulate clone A editing the part - must touch the EXACT file being
// watched (TESTPART.FCStd itself), since changedUpstream's git log is
// scoped to that path - a change to some other file in the same repo
// correctly reports nothing for this path, which is by design (this is
// testing the WATCH mechanism itself, not FreeCAD geometry diffing, so a
// plain byte-append to the real file stands in for a genuine re-save).
await window.cad.writeText('changed by A\n', CLONE_A);
await window.cad.gitAdd(CLONE_A);
await window.cad.gitCommitAll(CLONE_A, 'A: real upstream change');
await window.cad.gitPush(CLONE_A);

const check = await window.cad.gitWatchCheckOne(CLONE_B);
note('watch check from clone B: ' + JSON.stringify(check));
assert(!!check, 'clone B\'s watch detects the change A pushed');
assert(check.commits.length > 0 && check.commits[0].subject.includes('real upstream change'), 'the detected commit is the real one A made');

note('--- fetchUpstreamVersion resolves the pushed file without touching clone B\'s working tree ---');
const beforeStatus = await window.cad.gitStatus(CLONE_B);
const resolved = await window.cad.gitWatchFetchUpstreamVersion(CLONE_B);
note('resolved: ' + JSON.stringify(resolved));
assert(!!resolved.path, 'fetchUpstreamVersion returned a real cache path');
const afterStatus = await window.cad.gitStatus(CLONE_B);
assert(JSON.stringify(beforeStatus) === JSON.stringify(afterStatus), 'clone B\'s own git status is UNCHANGED by the review fetch (read-only, no working-tree mutation)');

note('--- Sync (a real pull) brings clone B up to date, watch clears ---');
await window.cad.gitPull(CLONE_B);
const checkAfterSync = await window.cad.gitWatchCheckOne(CLONE_B);
note('watch check after sync: ' + JSON.stringify(checkAfterSync));
assert(checkAfterSync === null, 'nothing left to report after clone B pulled the real change');

note('--- offline: an unreachable remote is correctly detected, not hung ---');
const t0 = Date.now();
const reachableBad = await window.cad.gitIsReachable('/tmp/sync_test/cloneA/TESTPART/TESTPART.FCStd', 'nonexistent-remote-xyz');
const elapsed = Date.now() - t0;
note('unreachable check: ' + reachableBad + ' in ' + elapsed + 'ms');
assert(reachableBad === false, 'a nonexistent remote correctly reports unreachable');
assert(elapsed < 10000, 'the unreachable check returned promptly (timeout worked), not hung: ' + elapsed + 'ms');

note('--- done ---');
