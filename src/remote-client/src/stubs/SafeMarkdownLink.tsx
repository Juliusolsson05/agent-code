import type { AnchorHTMLAttributes, ReactNode } from 'react'

// Phone substitute for @renderer/features/rendered-content/SafeMarkdownLink
// (aliased in vite.config.ts). The desktop version routes http(s) links
// through main's external-open IPC and file-ish links into the Global
// Editor; neither exists on a phone. A plain new-tab anchor with the same
// safety posture (noopener/noreferrer, http(s)-only) is the honest mobile
// equivalent — file links render as inert text rather than pretending to
// open an editor that isn't there.

export function SafeMarkdownLink({
  href,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { children?: ReactNode }): React.JSX.Element {
  const isHttp = typeof href === 'string' && /^https?:\/\//i.test(href)
  if (!isHttp) return <span className="underline decoration-dotted">{children}</span>
  return (
    <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}
