// Startup recovery compares saved references with the registry's managed live
// names. The prefix proves a session is managed by Agent Code, not that it is
// abandoned. Only a COMPLETE inventory can supply that second fact. A partial
// workspace can still recover its known terminals without authorizing deletion
// of terminals whose references may have been discarded by decoding (#898).

import { randomUUID } from 'node:crypto'

import { parseWorkspaceFile } from '@main/storage/workspaceFile.js'
import type { ParsedWorkspaceFile } from '@main/storage/workspaceFile.js'
import type { TmuxRegistry } from '@main/tmux/TmuxRegistry.js'
import { isSessionKind } from '@shared/types/providerKind.js'

export type PersistedTerminalRef = {
  sessionId: string
  tmuxName: string
}

type InventoryIssue =
  | 'workspace_missing'
  | 'workspace_read_failed'
  | 'workspace_unreadable'
  | 'invalid_windows_container'
  | 'discarded_windows'
  | 'invalid_sessions_container'
  | 'invalid_session_metadata'
  | 'invalid_terminal_reference'
  | 'conflicting_terminal_reference'

// Fixed categories and counts keep diagnostics bounded and avoid serializing
// workspace content, paths, or per-row parse errors into the startup journal.
type InventoryIssues = Partial<Record<InventoryIssue, number>>

type TerminalInventory = {
  kind: 'complete' | 'incomplete' | 'unknown'
  references: PersistedTerminalRef[]
  issues: InventoryIssues
}

export type RecoveryReport = {
  inventory: TerminalInventory['kind']
  inventoryIssues: InventoryIssues
  /** Known live references, including ones retained by a partial decoder. */
  recoverable: PersistedTerminalRef[]
  /** Known references absent from the registry's live-session listing. */
  lost: string[]
  /** Unmatched managed names cleaned only after a complete inventory. */
  orphans: string[]
  /** Unmatched names left alive because absence of ownership is unproven. */
  preserved: string[]
}

type RecoveryRegistry = Pick<TmuxRegistry, 'isAvailable' | 'listManagedSessions' | 'killSession'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function terminalInventory(parsed: ParsedWorkspaceFile): TerminalInventory {
  if (parsed.kind === 'unreadable') {
    return { kind: 'unknown', references: [], issues: { workspace_unreadable: 1 } }
  }

  const issues: InventoryIssues = {}
  const note = (issue: InventoryIssue, count = 1) => { issues[issue] = (issues[issue] ?? 0) + count }
  if (parsed.completeness.kind === 'partial') {
    if (parsed.completeness.invalidWindowsContainer) note('invalid_windows_container')
    if (parsed.completeness.discardedWindows > 0) note('discarded_windows', parsed.completeness.discardedWindows)
  }

  const references: PersistedTerminalRef[] = []
  const bySession = new Map<string, Set<string>>()
  const byName = new Map<string, string>()
  for (const window of parsed.file.windows) {
    // This is a resource projection, not another renderer ownership walker.
    // The saved sessions map includes visible, detached, and buried metadata.
    // Even a stale-looking row must protect its named process: layout repair
    // does not establish that the process is safe to kill.
    if (!isRecord(window.workspace) || !isRecord(window.workspace.sessions)) {
      note('invalid_sessions_container')
      continue
    }
    for (const [sessionId, meta] of Object.entries(window.workspace.sessions)) {
      if (!sessionId || !isRecord(meta) || (meta.kind !== undefined && !isSessionKind(meta.kind))) {
        note('invalid_session_metadata')
        continue
      }
      // Missing kind is the documented legacy Claude shape. Missing tmuxName
      // is valid for direct-PTY terminals; neither means a broken reference.
      // A name on an unexpected kind, however, must not be silently discarded
      // and then used as evidence that its live process has no owner.
      if (meta.tmuxName === undefined) continue
      if (meta.kind !== 'terminal' || typeof meta.tmuxName !== 'string' || meta.tmuxName.trim().length === 0) {
        note('invalid_terminal_reference')
        continue
      }
      const names = bySession.get(sessionId) ?? new Set<string>()
      if (names.has(meta.tmuxName)) continue // Same saved ref can appear in two window slices.
      if (names.size > 0 || (byName.has(meta.tmuxName) && byName.get(meta.tmuxName) !== sessionId)) {
        note('conflicting_terminal_reference')
      }
      names.add(meta.tmuxName)
      bySession.set(sessionId, names)
      byName.set(meta.tmuxName, sessionId)
      references.push({ sessionId, tmuxName: meta.tmuxName })
    }
  }
  return { kind: Object.keys(issues).length === 0 ? 'complete' : 'incomplete', references, issues }
}

/**
 * The startup boundary owns reading and decoding together so restoration and
 * cleanup cannot acquire independent interpretations of workspace.json again.
 * Only read failures are translated here: a registry/termination failure must
 * still reach the caller as a recovery failure, never as successful cleanup.
 */
export async function reconcileWorkspace(
  registry: RecoveryRegistry,
  readWorkspace: () => Promise<string>,
): Promise<RecoveryReport> {
  let text: string
  try {
    text = await readWorkspace()
  } catch (error) {
    // ENOENT is normal on first install, but is not proof of orphanhood if a
    // prior run's managed sessions survive a deleted/moved workspace file.
    const issue = isRecord(error) && error.code === 'ENOENT' ? 'workspace_missing' : 'workspace_read_failed'
    return reconcile(registry, { kind: 'unknown', references: [], issues: { [issue]: 1 } })
  }
  return reconcile(registry, terminalInventory(parseWorkspaceFile(text, randomUUID)))
}

async function reconcile(registry: RecoveryRegistry, inventory: TerminalInventory): Promise<RecoveryReport> {
  const persisted = inventory.references
  const evidence = { inventory: inventory.kind, inventoryIssues: inventory.issues }
  if (!registry.isAvailable()) {
    return { ...evidence, recoverable: [], lost: persisted.map(p => p.sessionId), orphans: [], preserved: [] }
  }

  const aliveSessions = await registry.listManagedSessions()
  const aliveNames = new Set(aliveSessions.map(s => s.name))
  const persistedNames = new Set(persisted.map(p => p.tmuxName))
  const recoverable = persisted.filter(p => aliveNames.has(p.tmuxName))
  const lost = persisted.filter(p => !aliveNames.has(p.tmuxName)).map(p => p.sessionId)
  const unmatched = [...aliveNames].filter(name => !persistedNames.has(name))

  // Partial UI restoration is not a cleanup capability. Keep unmatched names
  // explicitly preserved; calling them "orphans" would invite a downstream
  // caller to delete them later. Only an explicit complete result, including
  // a genuinely empty one, retains the existing orphan-cleanup policy.
  // This is authority from this startup's file snapshot, not a durable repair
  // journal. Preserving references through later workspace rewrites requires
  // a separate persistence contract; an in-memory flag here cannot promise it.
  const orphans = inventory.kind === 'complete' ? unmatched : []
  const preserved = inventory.kind === 'complete' ? [] : unmatched
  await Promise.all(orphans.map(name => registry.killSession(name)))

  return { ...evidence, recoverable, lost, orphans, preserved }
}
