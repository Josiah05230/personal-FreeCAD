/**
 * Watches the files a window has open (its document and, for an assembly,
 * every part it links) and reports when one changes ON DISK by someone
 * else's hand - another GWT-CAD window, or a script building parts.
 *
 * Polled (stat every POLL_MS) rather than fs.watch: a save replaces the file
 * (new inode), which fs.watch on the file loses, and a change is only
 * reported once its size + mtime have held still for a poll - a file caught
 * half-written is not a file to open. The window's own saves are told to
 * `rebase()` (see index.ts's cad:rpc), so they never report.
 */
import { stat } from 'fs/promises'

const POLL_MS = 700

type Sig = string | null

async function sigOf(path: string): Promise<Sig> {
  try {
    const s = await stat(path)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return null
  }
}

export class FileWatch {
  private files = new Map<string, { base: Sig; pending: Sig | undefined }>()
  private timer: NodeJS.Timeout | null = null
  private ticking = false

  constructor(private onChange: (path: string) => void) {}

  /** Replace the watched set. Files already watched keep their baseline. */
  async set(paths: string[]): Promise<void> {
    const want = new Set(paths.filter(Boolean))
    for (const p of [...this.files.keys()]) if (!want.has(p)) this.files.delete(p)
    for (const p of want) if (!this.files.has(p)) this.files.set(p, { base: await sigOf(p), pending: undefined })
    if (this.files.size && !this.timer) this.timer = setInterval(() => void this.tick(), POLL_MS)
    if (!this.files.size && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** What is on disk now is what this window knows (it just wrote or read it). */
  async rebase(): Promise<void> {
    for (const [p, f] of this.files) {
      f.base = await sigOf(p)
      f.pending = undefined
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const [p, f] of [...this.files]) {
        const now = await sigOf(p)
        if (!this.files.has(p)) continue
        if (now === f.base) {
          f.pending = undefined
        } else if (now !== null && now === f.pending) {
          f.base = now // settled
          f.pending = undefined
          this.onChange(p)
        } else {
          f.pending = now ?? undefined // changed (or mid-replace): look again next poll
        }
      }
    } finally {
      this.ticking = false
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.files.clear()
  }
}
