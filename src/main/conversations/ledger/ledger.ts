import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { conversationKey } from '@shared/conversations/types.js'
import { isAgentProviderKind } from '@shared/types/providerKind.js'
import type { PersistedWindow } from '@main/storage/workspaceFile.js'
import type { LedgerRow } from './types.js'

// What Agent Code durably remembers about conversations that ran here.
//
// WHY it exists (docs/decomposition/conversations.md, Stage 3): once a pane
// closes, the workspace file forgets its title, spoken name and orchestration
// role, and the only way to tell a review child from a real session becomes
// a prompt sniff. This file is the per-conversation projection of state the
// workspace already holds, keyed by the provider's native id so the catalog
// can join it against any transcript on disk.
//
// WHY a projection from workspace saves, not new IPC: main already receives
// every window's slice through WorkspaceFileStore.commit, and
// collectSessionIds already reads `sessions` out of that opaque blob. The
// renderer learns nothing new; a second write path would be a second opinion
// about identity.
//
// WHY append-only JSONL with a full-row snapshot per write: the reader is
// "last row per key wins", which survives a crash mid-append (a truncated last
// line is skipped) and needs no locking beyond the process's single writer.
// Compaction on open rewrites the file when it holds many more lines than
// rows, so the file stays proportional to the number of conversations.

const COMPACT_LINE_RATIO = 4

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

function sameRow(a: LedgerRow, b: LedgerRow): boolean {
  return a.localSessionId === b.localSessionId && a.cwd === b.cwd && a.title === b.title && a.agentName === b.agentName
    && a.closedAt === b.closedAt && JSON.stringify(a.orchestration) === JSON.stringify(b.orchestration)
}

export async function readAgentNameAssignments(path: string): Promise<Record<string, string>> {
  // Read-only on purpose: AgentNameRegistry.resolve ALLOCATES on a miss, and
  // allocation is monotonic. The ledger must never spend a spoken address.
  try {
    const json: unknown = JSON.parse(await readFile(path, 'utf8'))
    const assignments = isRecord(json) && isRecord(json.assignments) ? json.assignments : {}
    const out: Record<string, string> = {}
    for (const [id, name] of Object.entries(assignments)) if (typeof name === 'string' && name.trim()) out[id] = name
    return out
  } catch {
    return {}
  }
}

export class ConversationLedger {
  private readonly byKey = new Map<string, LedgerRow>()
  private lineCount = 0
  private tail: Promise<void> = Promise.resolve()

  private constructor(private readonly path: string) {}

  static async open(path: string): Promise<ConversationLedger> {
    const ledger = new ConversationLedger(path)
    let text = ''
    try {
      text = await readFile(path, 'utf8')
    } catch {
      text = ''
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line) as LedgerRow
        if (isAgentProviderKind(row.provider) && typeof row.nativeId === 'string') ledger.byKey.set(conversationKey(row.provider, row.nativeId), row)
        ledger.lineCount++
      } catch {
        // A truncated last line from a crash mid-append: skip it; the next
        // projection rewrites the row it belonged to.
      }
    }
    if (ledger.lineCount > COMPACT_LINE_RATIO * Math.max(1, ledger.byKey.size)) await ledger.compact()
    return ledger
  }

  get(provider: LedgerRow['provider'], nativeId: string): LedgerRow | null {
    return this.byKey.get(conversationKey(provider, nativeId)) ?? null
  }

  rows(): ReadonlyMap<string, LedgerRow> {
    return this.byKey
  }

  private async compact(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, [...this.byKey.values()].map(r => JSON.stringify(r)).join('\n') + (this.byKey.size ? '\n' : ''))
    await rename(tmp, this.path)
    this.lineCount = this.byKey.size
  }

  private async append(rows: LedgerRow[]): Promise<void> {
    if (rows.length === 0) return
    await mkdir(dirname(this.path), { recursive: true })
    await appendFile(this.path, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    this.lineCount += rows.length
  }

  /** Upsert every agent session with a native id across all windows; close
   *  rows whose native id no longer appears anywhere. Serialised on a tail so
   *  two quick saves cannot interleave their appends. */
  projectWindows(windows: readonly PersistedWindow[], agentNames: Readonly<Record<string, string>>, now = Date.now()): Promise<void> {
    const run = this.tail.then(async () => {
      const seen = new Set<string>()
      const changed: LedgerRow[] = []
      for (const window of windows) {
        if (!isRecord(window.workspace) || !isRecord(window.workspace.sessions)) continue
        const sessions = window.workspace.sessions
        for (const [localId, metaRaw] of Object.entries(sessions)) {
          if (!isRecord(metaRaw)) continue
          const provider = str(metaRaw.kind) ?? 'claude'
          const nativeId = str(metaRaw.providerSessionId)
          if (!isAgentProviderKind(provider) || !nativeId) continue
          const key = conversationKey(provider, nativeId)
          seen.add(key)
          const parentLocal = str(metaRaw.orchestrationParentId)
          const parentMeta = parentLocal && isRecord(sessions[parentLocal]) ? (sessions[parentLocal] as Record<string, unknown>) : null
          const orchestration = parentLocal || str(metaRaw.orchestrationRole) || str(metaRaw.orchestrationRunId)
            ? { parentNativeId: parentMeta ? str(parentMeta.providerSessionId) : null, role: str(metaRaw.orchestrationRole), runId: str(metaRaw.orchestrationRunId) }
            : null
          const agentNameId = str(metaRaw.agentNameId)
          const previous = this.byKey.get(key)
          const next: LedgerRow = {
            provider, nativeId,
            localSessionId: localId,
            cwd: str(metaRaw.cwd),
            title: str(metaRaw.title),
            agentName: agentNameId ? agentNames[agentNameId] ?? previous?.agentName ?? null : previous?.agentName ?? null,
            orchestration,
            firstSeenAt: previous?.firstSeenAt ?? now,
            lastSeenAt: now,
            closedAt: null,
          }
          if (!previous || !sameRow(previous, next)) {
            this.byKey.set(key, next)
            changed.push(next)
          } else {
            previous.lastSeenAt = now
          }
        }
      }
      for (const [key, row] of this.byKey) {
        if (seen.has(key) || row.closedAt !== null) continue
        const closed = { ...row, closedAt: now }
        this.byKey.set(key, closed)
        changed.push(closed)
      }
      await this.append(changed)
    })
    this.tail = run.catch(() => undefined)
    return run
  }
}
