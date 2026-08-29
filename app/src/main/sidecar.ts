/**
 * Sidecar supervisor: spawns headless FreeCAD (`freecadcmd sidecar/server.py`),
 * discovers the loopback port it prints, and proxies JSON-RPC calls to it.
 *
 * Milestone 0: single instance, no auto-restart. Supervision/restart lands with
 * the modelling milestone.
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

export function loadConfig(repoRoot: string): SidecarConfig {
  const candidates = [
    resolve(repoRoot, 'config.local.json'),
    resolve(repoRoot, 'config.example.json')
  ]
  const file = candidates.find(existsSync)
  const raw = file ? JSON.parse(readFileSync(file, 'utf-8')) : {}
  return {
    freecadcmd: expandHome(raw.freecadcmd ?? 'freecadcmd'),
    sidecarHost: raw.sidecarHost ?? '127.0.0.1',
    sidecarStartupTimeoutMs: raw.sidecarStartupTimeoutMs ?? 20000
  }
}

export class Sidecar {
  private proc: ChildProcess | null = null
  private endpoint: Endpoint | null = null
  private nextId = 1

  constructor(
    private readonly repoRoot: string,
    private readonly cfg: SidecarConfig
  ) {}

  async start(): Promise<Endpoint> {
    if (this.endpoint) return this.endpoint
    const serverPy = resolve(this.repoRoot, 'sidecar/server.py')
    if (!existsSync(serverPy)) throw new Error(`sidecar not found: ${serverPy}`)
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

    const endpoint = await new Promise<Endpoint>((res, rej) => {
      const timer = setTimeout(
        () => rej(new Error('sidecar did not report ready in time')),
        this.cfg.sidecarStartupTimeoutMs
      )
      let buf = ''
      this.proc!.stdout!.on('data', (d: Buffer) => {
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
      this.proc!.stderr!.on('data', (d: Buffer) =>
        process.stderr.write(`[sidecar] ${d.toString()}`)
      )
      this.proc!.on('exit', (code, signal) => {
        clearTimeout(timer)
        this.endpoint = null
        rej(new Error(`sidecar exited early (code=${code} signal=${signal})`))
      })
    })

    this.endpoint = endpoint
    return endpoint
  }

  async rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.endpoint) throw new Error('sidecar not started')
    const { host, port } = this.endpoint
    const resp = await fetch(`http://${host}:${port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params })
    })
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
