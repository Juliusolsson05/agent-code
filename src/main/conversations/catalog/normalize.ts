import type { Conversation } from '@shared/conversations/types.js'
import type { RepositoryFamily } from '../family.js'
import type { LedgerRow } from '../ledger/types.js'
import type { SourceConversation } from '../sources/types.js'
import { classifyConversation } from './classify.js'
import { resolveLabel } from './label.js'
import { activityOf } from './order.js'
import { firstUnwrappedPrompt } from './unwrap.js'

function basename(path: string | null): string | null {
  if (!path) return null
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? null
}

/** The worktree a cwd belongs to, for the row's second line. Null for the
 *  main checkout itself. Under the main root, `.worktrees/<name>` shows
 *  `<name>` and any other subdirectory shows its first segment; a sibling
 *  worktree (outside the root) shows its own directory name. */
function worktreeOf(cwd: string, family: RepositoryFamily): string | null {
  if (!family.root) return null
  const c = cwd.toLowerCase()
  if (c === family.root) return null
  if (c.startsWith(family.root + '/')) {
    const segments = cwd.slice(family.root.length + 1).split('/').filter(Boolean)
    return segments[0] === '.worktrees' ? segments[1] ?? null : segments[0] ?? null
  }
  for (const root of family.roots) {
    if (c === root || c.startsWith(root + '/')) return basename(cwd.slice(0, root.length))
  }
  return basename(cwd)
}

export function normalizeConversation(
  source: SourceConversation,
  ledger: LedgerRow | null,
  family: RepositoryFamily,
): Conversation {
  const first = firstUnwrappedPrompt(source.userTexts)
  const kind = classifyConversation(source, ledger, first)
  const cwd = source.cwd ?? ledger?.cwd ?? ''
  const { label, labelSource } = resolveLabel(source, ledger, first, basename(cwd))
  const activity = activityOf(source)
  return {
    provider: source.provider,
    nativeId: source.nativeId,
    cwd,
    repoRoot: family.root,
    worktree: cwd ? worktreeOf(cwd, family) : null,
    gitBranch: source.gitBranch,
    kind,
    parentNativeId: source.parentNativeId ?? ledger?.orchestration?.parentNativeId ?? null,
    label,
    labelSource,
    firstPrompt: first?.text ?? null,
    agentName: ledger?.agentName ?? null,
    agentCodeTitle: ledger?.title ?? null,
    createdAt: source.createdAt,
    lastUserActivityAt: activity.at,
    activitySource: activity.source,
    promptCount: source.promptCount,
    available: source.available,
    origin: source.origin,
    match: null,
  }
}
