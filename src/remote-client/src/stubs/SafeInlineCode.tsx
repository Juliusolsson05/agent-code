import type { ReactNode } from 'react'

// Phone substitute for @renderer/features/rendered-content/SafeInlineCode
// (aliased in vite.config.ts). Desktop adds click-to-open-in-editor for
// path-looking tokens; on the phone inline code is just inline code.

export function SafeInlineCode({ children }: { children?: ReactNode }): React.JSX.Element {
  return <code className="font-code">{children}</code>
}
