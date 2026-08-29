# Feedback tracker

Live-test feedback. `[x]` = done and **deleted** from this file (keep it short);
`[~]` = partial; `[ ]` = open. Newest batch at the bottom. When a task is fully
done, remove its line entirely rather than leaving a checked box.

## Open / partial

- [~] Sheet metal: only Base Flange (SheetMetal addon or pad fallback). Richer
      flange / unfold / bend features deferred (low priority).

## Batch 13 - full feature wiring audit

Wire every modelling feature end to end, all selection-driven the same way
(pick geometry in the viewport or a node in the model tree - no dropdowns for
geometry references). Track per feature:

- [ ] Sketch - plane / face pick (done); confirm construction planes + faces
- [ ] Extrude - profile sketch; up-to-face / to-object option via a face pick
- [ ] Revolve - profile + axis pick (done); confirm sketch-line axis
- [ ] Loft - 2+ profile sketches in order
- [ ] Sweep - profile + path (path from a sketch or a body edge)
- [ ] Hole - face + point (done); confirm counterbore / countersink
- [ ] Fillet / Chamfer - edge or face pick (done); confirm face-chain
- [ ] Shell - face pick for removed faces (done)
- [ ] Draft - faces + neutral plane pick
- [ ] Rib / Web - open profile + direction (new)
- [ ] Mirror - feature/body + plane pick (done)
- [ ] Rectangular / Circular pattern - feature/body + direction/axis pick
- [ ] Combine - two bodies (done); confirm keep-tool option
- [ ] Split Body - body + cutting plane/face/surface (done)
- [ ] Thicken / Offset surface - face pick (new)
- [ ] Datum plane / axis / point - from selection (plane done)
- [ ] Move / Copy body - body + transform
- [ ] Delete / suppress feature (done - confirm suppress vs delete)

## Deferred / not done

- Assembly joint SOLVING (joints recorded + round-trip; MbD solver is GUI-coupled
  headless) - needs a headless-solver path or an embedded GUI session.
- Canvas: multi-page PDF underlays.
- Git panel write ops (commit / checkout / diff from the UI).
- File-embedded colours on STEP / 3MF import (GUI-only in FreeCAD).
- Live packaged build with the real ~1GB bundled FreeCAD (pipeline verified with
  `--dir`; run `scripts/package.sh linux`).

## User added

Drop new feedback here between sessions; it gets folded into a batch and this
space cleared. As tasks complete, delete them from the batch above so this file
stays short.

(none pending)
