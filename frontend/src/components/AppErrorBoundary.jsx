import React from 'react'
import { useLocation } from 'react-router-dom'
import { AlertTriangle, RefreshCw, LayoutDashboard } from 'lucide-react'

/**
 * Catches any render error so one broken page can never turn the whole app into a blank (black) screen.
 * It resets itself when the user navigates to another page, so the sidebar keeps working.
 */
class Boundary extends React.Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error, info) { console.error('UI crashed:', error, info?.componentStack) }
  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="min-h-[60vh] flex items-center justify-center p-6">
        <div className="max-w-lg w-full rounded-2xl border border-red-500/30 bg-slate-900 p-6 shadow-2xl">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-red-500/15 flex items-center justify-center">
              <AlertTriangle className="w-5 h-5 text-red-400" />
            </div>
            <div>
              <h2 className="text-white font-semibold">This page hit an error</h2>
              <p className="text-xs text-slate-400">The rest of the app is fine — nothing was lost.</p>
            </div>
          </div>
          <pre className="text-[11px] text-red-300 bg-slate-950 rounded-lg p-3 overflow-auto max-h-32 whitespace-pre-wrap">
            {String(this.state.error?.message || this.state.error)}
          </pre>
          <div className="flex gap-2 mt-4">
            <button onClick={() => window.location.reload()} className="btn-primary flex items-center gap-2 text-sm">
              <RefreshCw className="w-4 h-4" /> Reload page
            </button>
            <button onClick={() => { window.location.href = '/dashboard' }} className="btn-secondary flex items-center gap-2 text-sm">
              <LayoutDashboard className="w-4 h-4" /> Go to dashboard
            </button>
          </div>
        </div>
      </div>
    )
  }
}

export default function AppErrorBoundary({ children }) {
  const { pathname } = useLocation()
  return <Boundary resetKey={pathname}>{children}</Boundary>
}
