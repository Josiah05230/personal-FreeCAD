/**
 * The copy-in gate: a company document (one saved inside a company repo)
 * must never end up referencing a file that lives OUTSIDE every company
 * repo - a teammate pulling the repo wouldn't have it. Every path that
 * pulls a file into the open document (insert component, import model,
 * import KiCad, canvas, drawing image, Data Panel double-click) goes
 * through App.tsx's bringIntoDoc(), which uses checkCopyIn() here (rules in
 * shared/copyInRules.ts), then either inserts as-is, runs the normal New
 * Part dialog + pn.copyIn (required for geometry/ECAD), or offers the
 * choice below (images, pdf, vector art).
 */
import { api } from './rpc'
import { promptForm } from './ui/PromptDialog'
import { fileKind, type FileKind } from '../shared/fileTypes'
import { copyInNeed, type CopyInNeed } from '../shared/copyInRules'

export { guessPartType, type CopyInNeed } from '../shared/copyInRules'

/** every configured company location - project repos, the ECAD repo, the
 *  registry - plus each one's symlink-resolved form, so a repo reached
 *  through a link still counts as inside */
export async function companyRoots(): Promise<string[]> {
  const cfg = await api.pnGetCompanyConfig()
  const raw = [
    ...Object.values(cfg.projects || {}).map((p) => p?.repoPath),
    cfg.ecadRepoPath,
    cfg.registryPath
  ].filter(Boolean) as string[]
  const out = new Set<string>()
  for (const r of raw) {
    out.add(r)
    const real = await window.cad.realpath(r).catch(() => null)
    if (real) out.add(real)
  }
  return [...out]
}

export async function checkCopyIn(
  docPath: string | null,
  src: string
): Promise<{ need: CopyInNeed; kind: FileKind | null }> {
  if (!docPath) return { need: 'none', kind: fileKind(src) }
  const roots = await companyRoots()
  const doc = (await window.cad.realpath(docPath).catch(() => null)) ?? docPath
  const real = (await window.cad.realpath(src).catch(() => null)) ?? src
  return copyInNeed(doc, real, roots)
}

/** E2E hook (no one answers a real prompt under --e2e): the next optional
 *  prompt's answer. Consumed by the one prompt it answers. */
export const copyInTestHooks: { choice: 'copy' | 'use' | 'cancel' | null } = { choice: null }

const USE_IT = 'Just use it (kept with this document)'
const COPY_IT = 'Copy in as a new part (e.g. a label)'

/** "copy" / "use" / null (cancelled) for an optional copy-in */
export async function askOptionalCopyIn(name: string): Promise<'copy' | 'use' | null> {
  const forced = copyInTestHooks.choice
  if (forced) {
    copyInTestHooks.choice = null
    return forced === 'cancel' ? null : forced
  }
  const r = await promptForm(
    `${name} is outside the company repos`,
    [{ key: 'how', label: 'Bring it in how?', options: [USE_IT, COPY_IT] }],
    'Continue'
  )
  if (!r) return null
  return r.how === COPY_IT ? 'copy' : 'use'
}
