import { CLAUDE_IDENTITY } from '@providers/claude/renderer/identity'
import { CODEX_IDENTITY } from '@providers/codex/renderer/identity'
import { OPENCODE_IDENTITY } from '@providers/opencode/renderer/identity'

// Provider badge vocabulary for the v2 phone chrome: the SAME identity
// descriptors every desktop surface uses (glyph + shortLabel). The v1 list
// printed the raw wire kind ('opencode') — a registry key wearing a UI
// badge — and the rebuild's contract is that identity comes from the
// provider's own descriptor, never from the kind string.
export type ProviderBadge = {
  glyph: string
  shortLabel: string
}

const FALLBACK: ProviderBadge = { glyph: '❯', shortLabel: 'agent' }

export function providerBadge(kind: string): ProviderBadge {
  switch (kind) {
    case 'claude':
      return CLAUDE_IDENTITY
    case 'codex':
      return CODEX_IDENTITY
    case 'opencode':
      return OPENCODE_IDENTITY
    default:
      return FALLBACK
  }
}
