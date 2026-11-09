import { Component, type ContextType, type ErrorInfo, type ReactNode } from 'react'
import { HostCtx } from '../host/context'

/**
 * Catches render errors. Inside MnemoNexus an uncaught error ends the run and
 * loses the session, so a broken view is replaced by a way back instead.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; onEnd?: () => void }, { failed: boolean }> {
  static contextType = HostCtx
  declare context: ContextType<typeof HostCtx>
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('The lab view failed:', error, info.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="ui-page w-full h-full flex items-center justify-center p-6">
        <div className="ui-panel-solid max-w-sm p-5 text-center" role="alert">
          <div className="text-[14px] font-semibold text-[var(--ink)]">This view stopped working</div>
          <p className="mt-1.5 text-[12px] text-[var(--muted)] leading-relaxed">
            The rest of the laboratory is fine. Go back to the lab home, or end the session.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <button className="ui-btn-solid" data-testid="recover" onClick={() => this.setState({ failed: false })}>
              Back to the lab
            </button>
            <button className="ui-btn" data-testid="recover-leave" onClick={() => (this.props.onEnd ? this.props.onEnd() : this.context?.leave())}>
              End session
            </button>
          </div>
        </div>
      </div>
    )
  }
}
