/**
 * Pure rules for the copy-in gate (renderer/copyIn.ts drives the UI): does
 * pulling `src` into the document at `docPath` need the file copied into a
 * company repo first? No I/O here - callers pass already-resolved paths -
 * so it's unit-tested with plain node (test/unit/copyInRules.test.ts).
 */
import { COPY_IN_REQUIRED_KINDS, fileKind, type FileKind } from './fileTypes'

/**
 *   'none'     doc isn't a company doc, or the file is already inside a
 *              company location (repo, ECAD repo, registry) - use as-is
 *   'required' real geometry/ECAD: must become a new part (New Part dialog
 *              + pn.copyIn) before it's used; cancel aborts the insert
 *   'optional' images/pdf/vector art: copying in is offered, not forced
 */
export type CopyInNeed = 'none' | 'required' | 'optional'

function norm(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-zA-Z]:\//.test(s)) s = s.toLowerCase() // Windows paths compare case-insensitively
  return s
}

/** is `p` the folder `root` itself or anything beneath it? (a sibling that
 *  merely shares the prefix, "repo-old", is NOT under "repo") */
export function isUnder(p: string, root: string): boolean {
  const a = norm(p)
  const r = norm(root)
  return !!r && (a === r || a.startsWith(r + '/'))
}

export function copyInNeed(
  docPath: string | null,
  src: string,
  roots: string[]
): { need: CopyInNeed; kind: FileKind | null } {
  const kind = fileKind(src)
  if (!docPath || !roots.some((r) => isUnder(docPath, r))) return { need: 'none', kind }
  if (roots.some((r) => isUnder(src, r))) return { need: 'none', kind }
  return { need: kind && COPY_IN_REQUIRED_KINDS.has(kind) ? 'required' : 'optional', kind }
}

/** the New Part dialog's type preselection for a copied-in file - only
 *  where it's obvious (artwork -> Z Misc, a KiCad board -> F PCB Assembly);
 *  NewPartDialog drops a guess this company's types.yaml doesn't define */
export function guessPartType(kind: FileKind | null): string | undefined {
  if (kind === 'image' || kind === 'vector' || kind === 'document') return 'Z'
  if (kind === 'ecad') return 'F'
  return undefined
}
