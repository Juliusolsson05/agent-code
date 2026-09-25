// Claude's rendering asymmetries for the ownership ledger (#1177). These
// were literals in the shared decide layer (rendering/model/ownership.ts,
// observations/committed.ts); see LedgerProviderPolicy there for what each
// bit means in general. The WHYs below are about Claude.

import type { LedgerProviderPolicy } from '@renderer/rendering/model/ownership'

export const CLAUDE_LEDGER_POLICY: LedgerProviderPolicy = {
  suppression: {
    // Claude's durable assistant row carries message.id == the semantic
    // turnId, so a committed row provably owns its whole live turn.
    wholeTurnByMessageId: true,
    // Claude tool results always pair into the block (semantic reducer) or
    // land as committed rows, so an unresolved history tool with neither,
    // after committed truth moved past its turn, truly died.
    hideUnresolvedHistoryTools: true,
    // The legacy collapsed_activity churn set (classifySemanticToolActivity):
    // Read/Glob/Grep/Bash fold into a collapsed run that null-paints while
    // running. The first, broader version of the hide rule also hid Task,
    // Edit, AskUserQuestion and MCP chips, and the corpus caught it at once:
    // 6 claude fixtures went missing-in-next on legitimate running chips.
    collapsibleChurnToolNames: new Set(['Read', 'FileRead', 'Glob', 'Grep', 'Bash']),
  },
  rendersGhostFallback: true,
  // #338: Claude writes local-command scaffolding as NON-meta user rows —
  // `<command-name>`, `<local-command-stdout>`, `<environment_context>` —
  // which rendered as if the user typed them.
  angleBracketUserRowsAreScaffolding: true,
}
