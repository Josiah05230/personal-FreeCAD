/**
 * Sidecar supervisor: spawns headless FreeCAD (`freecadcmd sidecar/server.py`),
 * discovers the loopback port it prints, and proxies JSON-RPC calls to it.
 *
 * Headless FreeCAD / OCCT can hard-abort on certain malformed geometry, so the
 * supervisor auto-respawns a sidecar that exits without us asking. An in-flight
 * RPC also lazily revives a dead sidecar before giving up. The document is
 * in-memory only, so a respawn starts empty - the renderer re-fetches the scene
 * and the user re-opens or redoes; better than a bricked session.
 */
import { spawn, ChildProcess } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'

type Endpoint = { host: string; port: number }

const READY_PREFIX = 'GWTCAD_SIDECAR_READY '

function expandHome(p: string): string {
  return p.startsWith('~') ? resolve(homedir(), p.slice(1).replace(/^[/\\]/, '')) : p
}

export type SidecarConfig = {
  freecadcmd: string
  sidecarHost: string
  sidecarStartupTimeoutMs: number
}

/**
 * Resolve `freecadcmd`. A packaged build ships FreeCAD under
 * `<resources>/freecad/`; a dev checkout reads config.local.json.
 */
function resolveFreecadCmd(repoRoot: string, configured?: string): string {
  const res = process.resourcesPath
  const bundled =
    process.platform === 'win32'
      ? resolve(res, 'freecad', 'bin', 'FreeCADCmd.exe')
      : resolve(res, 'freecad', 'usr', 'bin', 'freecadcmd')
  if (existsSync(bundled)) return bundled
  if (configured) return expandHome(configured)
  return 'freecadcmd'
}

export function loadConfig(repoRoot: string): SidecarConfig {
  const candidates = [
    resolve(repoRoot, 'config.local.json'),
    resolve(repoRoot, 'config.example.json')
  ]
  const file = candidates.find(existsSync)
  const raw = file ? JSON.parse(readFileSync(file, 'utf-8')) : {}
  return {
    freecadcmd: resolveFreecadCmd(repoRoot, raw.freecadcmd),
    sidecarHost: raw.sidecarHost ?? '127.0.0.1',
    sidecarStartupTimeoutMs: raw.sidecarStartupTimeoutMs ?? 20000
  }
}

export class Sidecar {
  private proc: ChildProcess | null = null
  private endpoint: Endpoint | null = null
  private nextId = 1
  private stopping = false
  private starting: Promise<Endpoint> | null = null
  /** notified when a respawn finishes so the renderer can re-fetch the scene */
  onRespawn: (() => void) | null = null

  constructor(
    private readonly repoRoot: string,
    private readonly cfg: SidecarConfig
  ) {}

  async start(): Promise<Endpoint> {
    if (this.endpoint) return this.endpoint
    // fold concurrent callers (e.g. a burst of RPCs after a crash) into one spawn
    if (this.starting) return this.starting
    this.starting = this._spawn().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async _spawn(): Promise<Endpoint> {
    const candidates = [
      resolve(this.repoRoot, 'sidecar/server.py'),
      resolve(process.resourcesPath, 'sidecar/server.py')
    ]
    const serverPy = candidates.find(existsSync)
    if (!serverPy) throw new Error(`sidecar not found (looked in ${candidates.join(', ')})`)
    if (!existsSync(this.cfg.freecadcmd)) {
      throw new Error(
        `freecadcmd not found: ${this.cfg.freecadcmd} - set it in config.local.json`
      )
    }

    this.proc = spawn(this.cfg.freecadcmd, [serverPy], {
      cwd: this.repoRoot,
      env: {
        ...process.env,
        GWTCAD_HOST: this.cfg.sidecarHost,
        GWTCAD_PORT: '0'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const proc = this.proc!
    const endpoint = await new Promise<Endpoint>((res, rej) => {
      const timer = setTimeout(
        () => rej(new Error('sidecar did not report ready in time')),
        this.cfg.sidecarStartupTimeoutMs
      )
      let buf = ''
      proc.stdout!.on('data', (d: Buffer) => {
        buf += d.toString()
        const line = buf.split('\n').find((l) => l.startsWith(READY_PREFIX))
        if (line) {
          clearTimeout(timer)
          try {
            res(JSON.parse(line.slice(READY_PREFIX.length)) as Endpoint)
          } catch (e) {
            rej(e as Error)
          }
        }
      })
      proc.stderr!.on('data', (d: Buffer) =>
        process.stderr.write(`[sidecar] ${d.toString()}`)
      )
      proc.on('exit', (code, signal) => {
        clearTimeout(timer)
        if (this.proc === proc) {
          this.proc = null
          this.endpoint = null
        }
        rej(new Error(`sidecar exited early (code=${code} signal=${signal})`))
        // a crash we did not ask for: bring a fresh one up so the app keeps working
        if (!this.stopping && this.proc === null) {
          process.stderr.write(
            `[GUI-ERR] [main] sidecar exited (code=${code} signal=${signal}) - respawning\n`
          )
          this.start()
            .then(() => {
              process.stdout.write('[main] sidecar respawned\n')
              this.onRespawn?.()
            })
            .catch((e) =>
              process.stderr.write(`[GUI-ERR] [main] sidecar respawn failed: ${(e as Error).message}\n`)
            )
        }
      })
    })

    this.endpoint = endpoint
    return endpoint
  }

  async rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    // heal a crashed sidecar before giving up on the call
    if (!this.endpoint) {
      if (this.stopping) throw new Error('sidecar not started')
      await this.start()
    }
    const ep = this.endpoint
    if (!ep) throw new Error('sidecar not started')
    let resp: Response
    try {
      resp = await fetch(`http://${ep.host}:${ep.port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params })
      })
    } catch (netErr) {
      // connection dropped mid-flight (sidecar died): revive once and retry
      this.endpoint = null
      if (this.stopping) throw netErr
      await this.start()
      const ep2 = this.endpoint as Endpoint | null
      if (!ep2) throw netErr
      resp = await fetch(`http://${ep2.host}:${ep2.port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params })
      })
    }
    const body = (await resp.json()) as {
      result?: T
      error?: { code: number; message: string; data?: unknown }
    }
    if (body.error) {
      const err = new Error(`RPC ${method}: ${body.error.message}`) as Error & {
        code?: number
        data?: unknown
      }
      err.code = body.error.code
      err.data = body.error.data
      throw err
    }
    return body.result as T
  }

  stop(): void {
    this.stopping = true
    const p = this.proc
    if (p && !p.killed) {
      p.kill('SIGTERM')
      // escalate if it does not go quietly
      setTimeout(() => {
        if (!p.killed) p.kill('SIGKILL')
      }, 2000).unref()
    }
    this.proc = null
    this.endpoint = null
  }
}
