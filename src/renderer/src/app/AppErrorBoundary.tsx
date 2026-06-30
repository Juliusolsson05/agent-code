import React, { type ReactNode } from 'react'

// App-shell error boundary.
//
// Catches render/lifecycle exceptions that would otherwise blank the window,
// reports them to the main-owned incident journal as a renderer breadcrumb, and
// shows a minimal fallback instead of a white screen. This is enrichment only —
// main's window hooks still own the authoritative "renderer died" signal; this
// catches the softer "a React subtree threw" case main can't otherwise see.

type Props = { children: ReactNode }
type State = { hasError: boolean; message?: string }

export class AppErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Fire-and-forget breadcrumb. window.api is injected by the preload; guard
    // in case the boundary trips before the bridge is ready.
    window.api?.reportIncident?.({
      kind: 'renderer.error',
      message: (error.message || 'react boundary error').slice(0, 200),
      stack: [error.stack, info.componentStack]
        .filter(Boolean)
        .join('\n')
        .split('\n')
        .slice(0, 8)
        .join('\n'),
    })
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 24, font: '13px/1.5 ui-monospace, monospace' }}>
          <strong>Agent Code hit a renderer error.</strong>
          <div style={{ opacity: 0.7, marginTop: 8 }}>{this.state.message}</div>
          <div style={{ opacity: 0.5, marginTop: 8 }}>
            The incident was recorded. Reloading the window may recover.
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
