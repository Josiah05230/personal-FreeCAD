/** Thin git wrapper for the History panel. Read-only for now. */
import { execFile } from 'child_process'
import { dirname } from 'path'
import { promisify } from 'util'

const run = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 })
  return stdout
}

export interface GitStatus {
  isRepo: boolean
  root?: string
  branch?: string
  dirty?: boolean
  tracked?: boolean // is the given file tracked
}

export async function status(filePath: string): Promise<GitStatus> {
  const cwd = dirname(filePath)
  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
    const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    const porcelain = await git(cwd, ['status', '--porcelain'])
    let tracked = true
    try {
      await git(cwd, ['ls-files', '--error-unmatch', filePath])
    } catch {
      tracked = false
    }
    return { isRepo: true, root, branch, dirty: porcelain.trim().length > 0, tracked }
  } catch {
    return { isRepo: false }
  }
}

export interface GitCommit {
  hash: string
  short: string
  subject: string
  author: string
  isoDate: string
  relDate: string
}

export async function log(filePath: string, limit = 50): Promise<GitCommit[]> {
  const cwd = dirname(filePath)
  const SEP = '\x1f'
  const fmt = ['%H', '%h', '%s', '%an', '%aI', '%ar'].join(SEP)
  try {
    const out = await git(cwd, [
      'log',
      `--max-count=${limit}`,
      `--pretty=format:${fmt}`,
      '--follow',
      '--',
      filePath
    ])
    if (!out.trim()) return []
    return out
      .trim()
      .split('\n')
      .map((line) => {
        const [hash, short, subject, author, isoDate, relDate] = line.split(SEP)
        return { hash, short, subject, author, isoDate, relDate }
      })
  } catch {
    return []
  }
}

export interface GitBranch {
  name: string
  current: boolean
}

export async function branches(filePath: string): Promise<GitBranch[]> {
  const cwd = dirname(filePath)
  try {
    const out = await git(cwd, ['branch', '--list', '--no-color'])
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => ({ name: l.replace(/^\*\s+/, ''), current: l.startsWith('* ') }))
  } catch {
    return []
  }
}
