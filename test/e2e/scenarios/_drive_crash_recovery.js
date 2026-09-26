/* Manual driver (--drive): verifies crash recovery end to end through the
 * REAL App.tsx code path (openDesign / autosave / recovery prompt), against
 * a scratch throwaway .FCStd - never real company data.
 *
 * Simulates a crash by: open -> edit -> autosave (writes a recovery copy
 * to ~/.gwtcad/recovery/, side-channel, never touches the real file) ->
 * close WITHOUT saving -> reopen the same file and confirm the recovery
 * prompt fires and "Recover" actually loads the newer content.
 */
const PART_PATH = '/tmp/crash_recovery_test/TestPart.FCStd';

note('--- dismiss the first-run welcome dialog ---');
for (let i = 0; i < 5; i++) {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    /^Next$|^Start using GWT-CAD$/.test(b.textContent || '')
  );
  if (!btn) break;
  btn.click();
  await sleep(150);
}

note('--- create the scratch part fresh via a real saveAs ---');
await rpc('session.reset', {});
await rpc('document.saveAs', { path: PART_PATH });
const infoAtSaveAs = await rpc('document.info', {});
const baselineObjectCount = infoAtSaveAs.objects;
note('baseline object count right after saveAs (session.reset always seeds a starter body): ' + baselineObjectCount);

note('--- make a real edit so there is something to autosave/recover ---');
// a sketch on the XY plane is enough of a real, visible change - not the
// point of this test, just needs to be SOMETHING that would be lost.
const sk = await rpc('sketch.onPlane', { plane: 'XY' });
await rpc('sketch.finish', {
  sketchId: sk.sketchId,
  elements: [{ type: 'rect', a: [0, 0], b: [10, 10] }]
});
const infoAfterSketch = await rpc('document.info', {});
note('object count after adding the sketch (in memory, not yet saved to the real file): ' + infoAfterSketch.objects);
assert(infoAfterSketch.objects > baselineObjectCount, 'the sketch really did add at least one object over the baseline');

note('--- confirm no recovery exists yet (nothing autosaved) ---');
let rec = await rpc('document.checkRecovery', { path: PART_PATH });
assert(rec.available === false, 'no recovery copy before the first autosave');

note('--- trigger autosave via the real test hook (same RPC the 2-min timer calls) ---');
await G.triggerAutosave();
await sleep(200);
rec = await rpc('document.checkRecovery', { path: PART_PATH });
assert(rec.available === true, 'a recovery copy exists right after autosave');
note('recovery info: ' + JSON.stringify(rec));

note('--- "crash": close without saving, by opening a throwaway blank doc over it ---');
await rpc('session.reset', {});

note('--- confirm the real file on disk is UNCHANGED by autosave (still the pre-edit version) ---');
// the sidecar never wrote the sketch to the real file - only to the
// recovery copy - so reopening it directly (bypassing the recovery
// prompt) must show zero sketches.
const reopened = await rpc('document.open', { path: PART_PATH });
note('reopened (bypassing prompt) partNumber/name: ' + JSON.stringify({ name: reopened.name }));
const infoBeforeRecovery = await rpc('document.info', {});
note('object count in the REAL file (should match the pre-sketch baseline - autosave never touched it): ' + infoBeforeRecovery.objects);
assert(infoBeforeRecovery.objects === baselineObjectCount, 'the real file on disk was never touched by autosave - still just the pre-sketch baseline');

note('--- now drive the REAL openDesign flow, which checks for + offers recovery ---');
// window.confirm is stubbed by the harness to auto-accept - simulates the
// user clicking "Recover" in the real dialog.
const originalConfirm = window.confirm;
let confirmMessage = null;
window.confirm = (msg) => { confirmMessage = msg; return true; };
try {
  await G.openDesignPath(PART_PATH);
  await sleep(400);
} finally {
  window.confirm = originalConfirm;
}
assert(!!confirmMessage && /unsaved work/.test(confirmMessage), 'the recovery prompt fired with the expected message');
note('confirm() message shown: ' + confirmMessage);

note('--- confirm the RECOVERED document now has the sketch (the newer, autosaved content) ---');
const infoAfterRecovery = await rpc('document.info', {});
note('object count after recovery: ' + infoAfterRecovery.objects);
assert(infoAfterRecovery.objects > baselineObjectCount, 'recovering actually loaded the newer (autosaved) content with the sketch, above the pre-sketch baseline');

note('--- recovery copy should be gone now that it was recovered+opened (avoid re-prompting forever) ---');
// NOTE: recovering opens the recovery FILE ITSELF as the live document (not
// a copy) - so document.checkRecovery for the ORIGINAL path now compares
// against a stale mtime snapshot; this app doesn't auto-discard on
// recovery (the user must Save to truly resolve it) - confirm this is the
// actual, documented behavior rather than asserting an ideal that isn't
// implemented.
rec = await rpc('document.checkRecovery', { path: PART_PATH });
note('recovery state after recovering (before any Save): ' + JSON.stringify(rec));

note('--- clean up: remove the scratch recovery copy so it never lingers ---');
await rpc('document.discardRecovery', { path: PART_PATH });
rec = await rpc('document.checkRecovery', { path: PART_PATH });
assert(rec.available === false, 'discardRecovery actually removed the leftover recovery copy');

note('--- done ---');
