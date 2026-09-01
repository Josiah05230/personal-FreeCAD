import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Last-resort guard: a render/lifecycle throw anywhere in the tree shows a
 * recoverable panel instead of a blank white window. "Reload" re-mounts the
 * whole app (renderer only - the engine keeps running).
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { err: Error | null }
> {
  state: { err: Error | null } = { err: null }

  static getDerivedStateFromError(err: Error): { err: Error } {
    return { err }
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    // forwarded to the run log via main's console-message hook
    console.error('uncaught render error:', err.message, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.err) return this.props.children
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'grid',
          placeItems: 'center',
          background: '#1e1e22',
          color: '#e6e6e6',
          font: '13px/1.5 system-ui, sans-serif',
          zIndex: 99999
        }}
      >
        <div style={{ maxWidth: 460, padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
            The interface hit an error
          </div>
          <div style={{ color: '#a8a8ad', marginBottom: 16, whiteSpace: 'pre-wrap' }}>
            {this.state.err.message}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '7px 18px',
              borderRadius: 5,
              border: '1px solid #3a3a40',
              background: '#2a7fff',
              color: '#fff',
              cursor: 'pointer'
            }}
          >
            Reload the interface
          </button>
          <div style={{ color: '#77777c', marginTop: 10, fontSize: 11 }}>
            Your model is held in the engine and will reload with the window.
          </div>
        </div>
      </div>
    )
  }
}
