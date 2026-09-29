/**
 * Undoable delete for the Data Panel: instead of the system trash (which
 * Electron can't restore from), a deleted file or folder moves into
 * ~/.gwtcad/deleted/<stamp>/<name> and moves back on undo. Entries older
 * than KEEP_DAYS are purged at startup.
 */
import { cp, mkdir, readdir, rename, rm, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { homedir } from 'os'

const KEEP_DAYS = 30

function holdRoot(): string {
  return join(process.env.GWTCAD_CONFIG_DIR || join(homedir(), '.gwtcad'), 'deleted')
}

/** rename, or copy + remove when source and destination are on different disks */
async function moveAny(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  try {
    await rename(src, dest)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    await cp(src, dest, { recursive: true, preserveTimestamps: true })
    await rm(src, { recursive: true, force: true })
  }
}

/** Move `path` into the holding area; returns where it went. */
export async function softDelete(path: string): Promise<{ held: string }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const held = join(holdRoot(), stamp, basename(path))
  await moveAny(path, held)
  return { held }
}

/** Put a held item back where it was (refuses to overwrite something new there). */
export async function restore(held: string, path: string): Promise<{ restored: string }> {
  const taken = await stat(path).then(() => true).catch(() => false)
  if (taken) throw new Error(`Can't restore: "${basename(path)}" already exists there again.`)
  await moveAny(held, path)
  await rm(dirname(held), { recursive: true, force: true }).catch(() => undefined)
  return { restored: path }
}

/** Drop holding-area entries older than KEEP_DAYS. */
export async function purgeOld(): Promise<void> {
  const root = holdRoot()
  const cutoff = Date.now() - KEEP_DAYS * 86400_000
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const t = Number(name.split('-')[0])
    if (t && t < cutoff) await rm(join(root, name), { recursive: true, force: true }).catch(() => undefined)
  }
}
