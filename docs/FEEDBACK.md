# Feedback tracker

Live-test feedback. `[x]` = done and **deleted** from this file (keep it short);
`[~]` = partial; `[ ]` = open. Newest batch at the bottom. When a task is fully
done, remove its line entirely rather than leaving a checked box.

## Open / partial

- [~] Sheet metal: only Base Flange (SheetMetal addon or pad fallback). Richer
      flange / unfold / bend features deferred (low priority).

## Batch 13 - feature wiring audit (remaining)

Done this pass: Extrude up-to-face, Draft neutral-plane pick, Rectangular
Pattern direction pick (no X/Y/Z dropdown), Sweep path from a body edge,
Construction Axis / Point from selection, Suppress vs Delete. Still open:

- [~] Construction Point only lands at the body origin - needs vertex / edge
      point selection to place it
- [ ] Rib / Web feature (open profile + thickness + direction)
- [ ] Thicken / Offset surface (face pick)
- [ ] Move / Copy body (body + transform, or copy to a new body)
- [ ] Combine "keep tool bodies" option
- [ ] Hole counterbore / countersink options

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
