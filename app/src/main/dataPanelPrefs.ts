/**
 * Data Panel preferences the user sets from its right-click menu: folders
 * hidden from the panel (and from its search), and the folder it starts in.
 * Kept in the GWT-CAD config dir (~/.gwtcad, or GWTCAD_CONFIG_DIR) so they
 * survive app updates and match the sidecar's own config location.
 */
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { homedir } from 'os'

export interface DataPanelPrefs {
  /** absolute folder paths hidden from the panel */
  hidden: string[]
  /** where the panel opens on startup (null = home) */
  defaultDir: string | null
}

function prefsPath(): string {
  return join(process.env.GWTCAD_CONFIG_DIR || join(homedir(), '.gwtcad'), 'datapanel.json')
}

let cache: DataPanelPrefs | null = null

export async function loadPrefs(): Promise<DataPanelPrefs> {
  if (cache) return cache
  try {
    const j = JSON.parse(await readFile(prefsPath(), 'utf8'))
    cache = {
      hidden: Array.isArray(j.hidden) ? j.hidden.filter((x: unknown) => typeof x === 'string') : [],
      defaultDir: typeof j.defaultDir === 'string' ? j.defaultDir : null
    }
  } catch {
    cache = { hidden: [], defaultDir: null }
  }
  return cache
}

async function save(p: DataPanelPrefs): Promise<DataPanelPrefs> {
  cache = p
  await mkdir(dirname(prefsPath()), { recursive: true })
  await writeFile(prefsPath(), JSON.stringify(p, null, 2) + '\n')
  return p
}

export async function setHidden(dir: string, hidden: boolean): Promise<DataPanelPrefs> {
  const p = await loadPrefs()
  const rest = p.hidden.filter((d) => d !== dir)
  return save({ ...p, hidden: hidden ? [...rest, dir] : rest })
}

export async function setDefaultDir(dir: string | null): Promise<DataPanelPrefs> {
  return save({ ...(await loadPrefs()), defaultDir: dir })
}

/** The folder the panel opens in: the default folder if it still exists, else home. */
export async function startDir(): Promise<string> {
  const d = (await loadPrefs()).defaultDir
  if (d) {
    try {
      if ((await stat(d)).isDirectory()) return d
    } catch {
      // moved or deleted - fall back to home
    }
  }
  return homedir()
}
