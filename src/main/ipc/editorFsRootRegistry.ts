import type { WebContents } from 'electron'
import { realpath } from 'fs/promises'
import { resolve } from 'path'

import type { SessionManager } from '@main/sessionManager.js'

// Main-owned editor root grants. The renderer may name a cwd, but that string
// is not authority: a compromised renderer could otherwise pass "/" and turn
// root-relative containment into arbitrary filesystem access. A root is first
// admitted only when it matches a live main-owned session cwd, then remains a
// capability for this document so open tabs keep working after that session
// exits. Reload/navigation clears every grant.
export class EditorFsRootRegistry {
  private readonly rootsByOwner = new Map<number, Set<string>>()
  private readonly trackedOwners = new WeakSet<WebContents>()
  /** Candidate path → renderer that first claimed it. `null` means a session
   * ended before any editor request, so the first trusted app document may
   * still claim it. Binding keeps one renderer from inheriting another
   * document's ended-session capability by guessing the path. */
  private readonly mainKnownRootCandidates = new Map<string, number | null>()

  constructor(
    private readonly manager: SessionManager,
    private readonly listAdditionalRoots: () => Promise<string[]> = async () => [],
  ) {
    // Session exit must not revoke the first editor access to its cwd. Remember
    // roots from main-owned lifecycle events, not only from the current live
    // list sampled by authorize(). A renderer still has to name the exact
    // canonical path; this does not turn arbitrary paths into capabilities.
    for (const sessionId of this.manager.list()) {
      const cwd = this.manager.getSpawnCwd(sessionId)
      if (cwd) this.mainKnownRootCandidates.set(resolve(cwd), null)
    }
    this.manager.on?.('started', (payload: { sessionId: string }) => {
      // `started.projectDir` is provider-internal transcript storage for
      // Claude, not its spawn cwd. Resolve through SessionManager's canonical
      // spawn metadata or we would accidentally authorize ~/.claude/projects
      // as an editor root while failing to remember the actual workspace.
      const cwd = this.manager.getSpawnCwd(payload.sessionId)
      if (cwd && !this.mainKnownRootCandidates.has(resolve(cwd))) {
        this.mainKnownRootCandidates.set(resolve(cwd), null)
      }
    })
  }

  async authorize(sender: WebContents, requestedRoot: string): Promise<string> {
    if (typeof requestedRoot !== 'string' || requestedRoot.length === 0) {
      throw new Error('project root is required')
    }
    const canonical = await realpath(resolve(requestedRoot))
    const existing = this.rootsByOwner.get(sender.id)
    if (existing?.has(canonical)) return canonical

    let known = false
    for (const [candidate, claimedBy] of this.mainKnownRootCandidates) {
      if (claimedBy !== null && claimedBy !== sender.id) continue
      const remembered = await realpath(candidate).catch(() => null)
      if (remembered === canonical) {
        known = true
        this.mainKnownRootCandidates.set(candidate, sender.id)
        break
      }
    }
    for (const sessionId of this.manager.list()) {
      const cwd = this.manager.getSpawnCwd(sessionId)
      if (!cwd) continue
      const sessionRoot = await realpath(resolve(cwd)).catch(() => null)
      if (sessionRoot === canonical) {
        known = true
        break
      }
    }
    if (!known) {
      for (const root of await this.listAdditionalRoots()) {
        const additionalRoot = await realpath(resolve(root)).catch(() => null)
        if (additionalRoot === canonical) {
          known = true
          break
        }
      }
    }
    if (!known) throw new Error('project root is not authorized')

    const roots = existing ?? new Set<string>()
    roots.add(canonical)
    this.rootsByOwner.set(sender.id, roots)
    this.track(sender)
    return canonical
  }

  clear(senderId: number): void {
    this.rootsByOwner.delete(senderId)
    // A navigation is a new renderer document and must not inherit ended
    // session capabilities from the old one. Live sessions remain discoverable
    // through manager.list() and can mint a fresh grant normally.
    for (const [candidate, claimedBy] of this.mainKnownRootCandidates) {
      if (claimedBy === senderId) this.mainKnownRootCandidates.delete(candidate)
    }
  }

  private track(sender: WebContents): void {
    if (this.trackedOwners.has(sender)) return
    this.trackedOwners.add(sender)
    const clear = (): void => this.clear(sender.id)
    sender.once('destroyed', clear)
    sender.on('did-start-navigation', details => {
      if (details.isMainFrame && !details.isSameDocument) clear()
    })
    sender.on('render-process-gone', clear)
  }
}
