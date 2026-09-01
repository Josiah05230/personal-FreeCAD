import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './ui/ErrorBoundary'
import './styles.css'

// surface every uncaught renderer error to the console so the Electron main
// process forwards it to the run log (prefixed [GUI-ERR]) - lets a watcher or
// the dev see failures without opening devtools
window.addEventListener('error', (e) => {
  console.error(`uncaught error: ${e.message} @ ${e.filename}:${e.lineno}`, e.error?.stack ?? '')
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason
  console.error(`unhandledrejection: ${r?.message ?? r}`, r?.stack ?? '')
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
