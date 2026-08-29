/// <reference types="vite/client" />

interface CadBridge {
  rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  sidecarStatus(): Promise<{ started: boolean }>
}

interface Window {
  cad: CadBridge
}
