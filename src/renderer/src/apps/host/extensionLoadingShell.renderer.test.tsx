import { describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

import { ExtensionLoadingShell } from './extensionLoadingShell'

// The shell is deliberately tiny; what must not regress is its CONTRACT: a
// sized, animated, accessible placeholder — because an extension that loses
// this regresses to the old text-sliver-then-jump modal that users read as
// "broken", and nothing else in the tree would fail.
describe('ExtensionLoadingShell', () => {
  it('renders a status region naming the extension with the animated ring', () => {
    const host = document.createElement('div')
    document.body.append(host)
    try {
      act(() => { createRoot(host).render(<ExtensionLoadingShell displayName="Agent Code Poker" />) })
      const status = host.querySelector('[role="status"]')
      expect(status?.getAttribute('aria-label')).toBe('Loading Agent Code Poker')
      expect(status?.querySelector('.extension-loading-ring')).not.toBeNull()
      expect(status?.textContent).toContain('Agent Code Poker')
    } finally {
      host.remove()
    }
  })
})
