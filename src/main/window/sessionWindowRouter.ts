import { createHash } from 'node:crypto'
import type { SessionRoutingGap, SessionRoutingGapReason } from '@shared/types/sessionRouting.js'

/**
 * A session's display owner and a backend's execution owner have different
 * lifetimes. This router owns only the former: an exited pane can still need
 * its final observations, and moving that pane does not start a backend.
 *
 * WHY pending traffic is allowed only for an existing claim: without a claim
 * there is no evidence that any window may receive the content. Broadcasting
 * or retaining that content until an arbitrary future claimant appears would
 * turn an ownership failure into disclosure. Unknown traffic keeps bounded
 * metadata instead and asks the eventual explicit owner to resynchronize.
 */
export type SessionWindowLease = Readonly<{
  sessionId: string
  windowId: string
  rendererGeneration: number
  revision: number
}>

export type RoutingWindow = {
  generation: number
  accepting: boolean
}

export type SessionRoutingResult = 'delivered' | 'held' | 'quarantined'
export type RoutingDeliveryResult = 'sent' | 'unavailable' | 'uncertain'

type GapRecord = {
  revision: number
  reason: SessionRoutingGapReason
  missedEvents: number
  expiresAt: number
  notifiedOwnershipRevision: number | null
}

type Pending = {
  lease: SessionWindowLease
  events: Array<{ channel: string; args: unknown[]; bytes: number }>
  bytes: number
  expiresAt: number
}

export type SessionWindowRouterOptions = {
  window: (windowId: string) => RoutingWindow | null
  deliver: (lease: SessionWindowLease, channel: string, args: unknown[]) => RoutingDeliveryResult
  gap: (lease: SessionWindowLease, gap: SessionRoutingGap) => boolean
  incident: (reason: SessionRoutingGapReason, metadata: Record<string, number>) => void
  now?: () => number
  limits?: Partial<typeof DEFAULT_LIMITS>
}

const DEFAULT_LIMITS = {
  pendingSessions: 64,
  eventsPerSession: 128,
  bytesPerSession: 512 * 1024,
  totalEvents: 2048,
  totalBytes: 8 * 1024 * 1024,
  pendingMs: 5000,
  gapRecords: 256,
  gapMs: 60_000,
  incidentMs: 1000,
}

/**
 * An admission estimate, not a claim about exact V8 heap or IPC wire size.
 * Stop before cloning an over-budget payload. JSON.stringify to measure first
 * would allocate the very unbounded intermediate this admission gate avoids.
 * Native observations are data objects; accessors and custom prototypes are
 * refused rather than evaluated while a lifecycle transition owns the queue.
 */
function retainedBytes(value: unknown, budget: number, seen = new Set<object>(), depth = 0): number | null {
  if (depth > 64 || budget < 0) return null
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
    return budget >= 8 ? 8 : null
  }
  if (typeof value === 'string') return value.length * 2 + 16 <= budget ? value.length * 2 + 16 : null
  if (typeof value !== 'object') return null
  if (seen.has(value)) return budget >= 8 ? 8 : null
  seen.add(value)
  if (ArrayBuffer.isView(value)) {
    // Cloning a tiny view clones its entire backing allocation. Counting just
    // byteLength would let a 1-byte view retain megabytes behind this budget.
    // Shared backing memory is not an immutable observation snapshot at all.
    if (!(value.buffer instanceof ArrayBuffer)) return null
    const backing = retainedBytes(value.buffer, budget - 64, seen, depth + 1)
    return backing === null ? null : backing + 64
  }
  if (value instanceof ArrayBuffer) {
    const bytes = value.byteLength + 64
    return bytes <= budget ? bytes : null
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return null
  }
  let total = 64
  if (total > budget || (Array.isArray(value) && value.length * 8 > budget)) return null
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (!property || !('value' in property)) return null
    total += key.length * 2 + 16
    const bytes = retainedBytes(property.value, budget - total, seen, depth + 1)
    if (bytes === null) return null
    total += bytes
  }
  return total <= budget ? total : null
}

export class SessionWindowRouter {
  private readonly owners = new Map<string, SessionWindowLease>()
  private readonly pending = new Map<string, Pending>()
  private readonly gaps = new Map<string, GapRecord>()
  private readonly acknowledged = new WeakSet<SessionWindowLease>()
  private readonly lastIncident = new Map<SessionRoutingGapReason, number>()
  private readonly limits: typeof DEFAULT_LIMITS
  private readonly now: () => number
  private revision = 0
  private pendingBytes = 0
  private pendingEvents = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  // An exact quarantine is bounded, but eviction must not turn a later claim
  // into proof that nothing was missed. This fixed Bloom filter remembers
  // possible evicted ids without retaining their strings. False positives
  // request only a read-only reseed; this evidence NEVER grants ownership or
  // authorizes replay. A single global "something was evicted" flag would
  // unnecessarily warn every unrelated pane created later in the app run.
  private readonly evictedIds = new Uint8Array(32 * 1024)

  constructor(private readonly options: SessionWindowRouterOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits }
    this.now = options.now ?? Date.now
    for (const limit of Object.values(this.limits)) {
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 2_147_483_647) {
        throw new Error('Session routing limits must be positive, timer-safe integers')
      }
    }
  }

  owner(sessionId: string): SessionWindowLease | null {
    return this.owners.get(sessionId) ?? null
  }

  sessionsOwnedBy(windowId: string): string[] {
    return [...this.owners.values()].filter(owner => owner.windowId === windowId).map(owner => owner.sessionId)
  }

  claim(sessionId: string, windowId: string): SessionWindowLease | null {
    this.sweep()
    if (!sessionId || sessionId.length > 512) return null
    const window = this.options.window(windowId)
    if (!window) return null
    const old = this.owners.get(sessionId)
    // A second window presenting stale metadata is not a transfer operation.
    // Only transfer() can move an existing claim between registered windows.
    if (old && old.windowId !== windowId && this.options.window(old.windowId)) return null
    const lease = Object.freeze({ sessionId, windowId, rendererGeneration: window.generation, revision: ++this.revision })
    this.owners.set(sessionId, lease)
    if (old) this.discardPending(sessionId, 'owner_replaced')
    if (this.mayHaveEvicted(sessionId) && !this.gaps.has(sessionId)) this.noteGap(sessionId, 'metadata_evicted', 0)
    this.notifyGap(lease)
    return lease
  }

  /** A delayed operation can release only the exact claim it admitted. */
  release(lease: SessionWindowLease | null): boolean {
    if (!lease || this.owners.get(lease.sessionId) !== lease) return false
    this.owners.delete(lease.sessionId)
    this.discardPending(lease.sessionId, 'owner_replaced')
    return true
  }

  /** An explicit handoff is the only operation allowed to retarget held bytes. */
  transfer(sessionId: string, windowId: string): SessionWindowLease | null {
    this.sweep()
    const previous = this.owners.get(sessionId)
    const destination = this.options.window(windowId)
    if (!previous || !destination) return null
    const lease = Object.freeze({
      sessionId, windowId, rendererGeneration: destination.generation, revision: ++this.revision,
    })
    this.owners.set(sessionId, lease)
    const held = this.pending.get(sessionId)
    if (held) {
      if (held.lease === previous) held.lease = lease
      else this.discardPending(sessionId, 'owner_replaced')
    }
    this.flush(lease)
    return lease
  }

  /** Navigation invalidates publication into the old renderer, not the pane. */
  rendererChanged(windowId: string): void {
    for (const sessionId of this.sessionsOwnedBy(windowId)) {
      this.discardPending(sessionId, 'renderer_replaced')
      this.noteGap(sessionId, 'renderer_replaced', 0)
    }
  }

  windowAvailable(windowId: string): void {
    this.sweep()
    for (const sessionId of this.sessionsOwnedBy(windowId)) {
      const lease = this.owners.get(sessionId)
      if (lease) this.flush(lease)
    }
  }

  send(sessionId: string, channel: string, args: unknown[]): SessionRoutingResult {
    // Unknown observations cannot smuggle unbounded metadata keys into the
    // quarantine. No legitimate claim can ever address an id of this shape.
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) {
      this.reportIncident('unsupported_payload', typeof sessionId === 'string' ? sessionId.length : 0)
      return 'quarantined'
    }
    this.sweep()
    const lease = this.owners.get(sessionId)
    if (!lease) {
      this.noteGap(sessionId, 'unowned', 1)
      return 'quarantined'
    }
    const window = this.options.window(lease.windowId)
    if (window && window.generation !== lease.rendererGeneration) {
      this.discardPending(sessionId, 'renderer_replaced')
      this.noteGap(sessionId, 'renderer_replaced', 1)
      return 'quarantined'
    }
    if (this.available(lease)) {
      this.flush(lease)
      if (!this.pending.has(sessionId) && this.available(lease)) {
        const delivery = this.options.deliver(lease, channel, args)
        if (delivery === 'sent') return 'delivered'
        if (delivery === 'uncertain') {
          // A thrown send is not proof Chromium accepted nothing. Replaying
          // raw terminal bytes could duplicate them; report a gap instead.
          this.noteGap(sessionId, 'delivery_failed', 1)
          return 'quarantined'
        }
      }
    }
    if (this.owners.get(sessionId) !== lease) {
      this.noteGap(sessionId, 'owner_replaced', 1)
      return 'quarantined'
    }
    return this.hold(lease, channel, args)
  }

  gapsForWindow(windowId: string): SessionRoutingGap[] {
    this.sweep()
    // A slow spawn/adoption may publish its pane after detailed metadata has
    // expired. Recover conservative evidence for an ALREADY claimed view too,
    // not only at the next claim. A weak acknowledgement belongs to this exact
    // lease and prevents every subsequent workspace update recreating the same
    // notice from the non-deletable Bloom bits. New loss clears that receipt.
    for (const lease of this.owners.values()) {
      if (lease.windowId === windowId && !this.gaps.has(lease.sessionId) &&
        !this.acknowledged.has(lease) && this.mayHaveEvicted(lease.sessionId)) {
        this.noteGap(lease.sessionId, 'metadata_evicted', 0)
      }
    }
    const result: SessionRoutingGap[] = []
    for (const [sessionId, gap] of this.gaps) {
      const lease = this.owners.get(sessionId)
      if (lease?.windowId === windowId && this.available(lease)) result.push({
        sessionId, ownershipRevision: lease.revision, gapRevision: gap.revision,
        reason: gap.reason, missedEvents: gap.missedEvents,
      })
    }
    return result
  }

  /** Read-only resynchronization uses both the owner claim and the gap version. */
  ownsGap(sessionId: string, ownershipRevision: number, gapRevision: number): SessionWindowLease | null {
    const lease = this.owners.get(sessionId)
    const gap = this.gaps.get(sessionId)
    return lease && this.available(lease) && lease.revision === ownershipRevision && gap?.revision === gapRevision
      ? lease : null
  }

  acknowledgeGap(lease: SessionWindowLease, gapRevision: number): boolean {
    if (!this.ownsGap(lease.sessionId, lease.revision, gapRevision)) return false
    this.gaps.delete(lease.sessionId)
    this.acknowledged.add(lease)
    this.scheduleSweep()
    return true
  }

  diagnostics(): { owners: number; pendingSessions: number; pendingEvents: number; pendingBytes: number; gapRecords: number } {
    this.sweep()
    return {
      owners: this.owners.size, pendingSessions: this.pending.size, pendingEvents: this.pendingEvents,
      pendingBytes: this.pendingBytes, gapRecords: this.gaps.size,
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.owners.clear()
    this.pending.clear()
    this.gaps.clear()
    this.lastIncident.clear()
    this.pendingBytes = 0
    this.pendingEvents = 0
    this.evictedIds.fill(0)
  }

  private available(lease: SessionWindowLease): boolean {
    if (this.owners.get(lease.sessionId) !== lease) return false
    const window = this.options.window(lease.windowId)
    return window?.generation === lease.rendererGeneration && window.accepting
  }

  private hold(lease: SessionWindowLease, channel: string, args: unknown[]): SessionRoutingResult {
    const current = this.pending.get(lease.sessionId)
    const channelBytes = channel.length * 2 + 16
    let payloadBytes: number | null = null
    try {
      payloadBytes = retainedBytes(args, this.limits.bytesPerSession - channelBytes)
    } catch {
      // A malformed provider object (including a Proxy trap) must not throw
      // through the emitter and abort unrelated lifecycle cleanup.
    }
    if (payloadBytes === null) {
      this.discardPending(lease.sessionId, 'unsupported_payload')
      this.noteGap(lease.sessionId, 'unsupported_payload', 1)
      return 'quarantined'
    }
    const bytes = payloadBytes + channelBytes
    if (
      (!current && this.pending.size >= this.limits.pendingSessions) ||
      (current?.events.length ?? 0) + 1 > this.limits.eventsPerSession ||
      (current?.bytes ?? 0) + bytes > this.limits.bytesPerSession ||
      this.pendingEvents + 1 > this.limits.totalEvents ||
      this.pendingBytes + bytes > this.limits.totalBytes
    ) {
      this.discardPending(lease.sessionId, 'queue_limit')
      this.noteGap(lease.sessionId, 'queue_limit', 1)
      return 'quarantined'
    }
    let copied: unknown[]
    try {
      copied = structuredClone(args)
    } catch {
      this.discardPending(lease.sessionId, 'unsupported_payload')
      this.noteGap(lease.sessionId, 'unsupported_payload', 1)
      return 'quarantined'
    }
    const held = current ?? { lease, events: [], bytes: 0, expiresAt: this.now() + this.limits.pendingMs }
    held.events.push({ channel, args: copied, bytes })
    held.bytes += bytes
    this.pending.set(lease.sessionId, held)
    this.pendingBytes += bytes
    this.pendingEvents += 1
    this.scheduleSweep()
    return 'held'
  }

  private flush(lease: SessionWindowLease): void {
    if (!this.available(lease)) return
    this.notifyGap(lease)
    const held = this.pending.get(lease.sessionId)
    if (!held) return
    if (held.lease !== lease) {
      this.discardPending(lease.sessionId, 'owner_replaced')
      this.notifyGap(lease)
      return
    }
    while (held.events.length > 0 && this.available(lease)) {
      const event = held.events.shift()!
      // Consume before calling the sink. An outbound observer can reenter the
      // registry and transfer/release this claim; it must not replay this head
      // or subtract its retained bytes for a second time during that callback.
      held.bytes -= event.bytes
      this.pendingBytes -= event.bytes
      this.pendingEvents -= 1
      const delivery = this.options.deliver(lease, event.channel, event.args)
      if (this.pending.get(lease.sessionId) !== held || held.lease !== lease) return
      if (delivery === 'unavailable') {
        held.events.unshift(event)
        held.bytes += event.bytes
        this.pendingBytes += event.bytes
        this.pendingEvents += 1
        break
      }
      if (delivery === 'uncertain') {
        this.discardPending(lease.sessionId, 'delivery_failed')
        this.noteGap(lease.sessionId, 'delivery_failed', 1)
        return
      }
    }
    if (held.events.length === 0) this.pending.delete(lease.sessionId)
    this.scheduleSweep()
  }

  private discardPending(sessionId: string, reason: SessionRoutingGapReason): void {
    const held = this.pending.get(sessionId)
    if (!held) return
    this.pending.delete(sessionId)
    this.pendingBytes -= held.bytes
    this.pendingEvents -= held.events.length
    this.noteGap(sessionId, reason, held.events.length)
  }

  private noteGap(sessionId: string, reason: SessionRoutingGapReason, missedEvents: number): void {
    const currentOwner = this.owners.get(sessionId)
    if (currentOwner) this.acknowledged.delete(currentOwner)
    const now = this.now()
    const current = this.gaps.get(sessionId)
    // Session ids are app-minted UUIDs. Refuse an oversized malformed id so a
    // bounded record count cannot retain an arbitrarily large key.
    if (sessionId.length <= 512) {
      if (!current && this.gaps.size >= this.limits.gapRecords) {
        const oldest = this.gaps.keys().next().value
        if (oldest !== undefined) {
          this.gaps.delete(oldest)
          this.rememberEvicted(oldest)
        }
      }
      this.gaps.set(sessionId, {
        revision: ++this.revision,
        reason,
        missedEvents: (current?.missedEvents ?? 0) + missedEvents,
        expiresAt: now + this.limits.gapMs,
        // Additional loss advances the gap version and requires a new notice.
        // Otherwise an in-flight old acknowledgement could fail correctly but
        // leave the renderer permanently unable to name the newer gap.
        notifiedOwnershipRevision: null,
      })
    }
    this.reportIncident(reason, sessionId.length)
    this.scheduleSweep()
    const owner = this.owners.get(sessionId)
    if (owner) this.notifyGap(owner)
  }

  private reportIncident(reason: SessionRoutingGapReason, sessionIdLength: number): void {
    const now = this.now()
    const last = this.lastIncident.get(reason)
    if (last === undefined || now - last >= this.limits.incidentMs) {
      this.lastIncident.set(reason, now)
      this.options.incident(reason, {
        sessionIdLength, pendingSessions: this.pending.size,
        pendingBytes: this.pendingBytes, pendingEvents: this.pendingEvents,
      })
    }
  }

  private notifyGap(lease: SessionWindowLease): void {
    if (!this.available(lease)) return
    const gap = this.gaps.get(lease.sessionId)
    if (!gap || gap.notifiedOwnershipRevision === lease.revision) return
    if (this.options.gap(lease, {
      sessionId: lease.sessionId, ownershipRevision: lease.revision, gapRevision: gap.revision,
      reason: gap.reason, missedEvents: gap.missedEvents,
    })) gap.notifiedOwnershipRevision = lease.revision
  }

  private sweep(): void {
    const now = this.now()
    for (const [sessionId, held] of this.pending) {
      if (held.expiresAt <= now) {
        this.discardPending(sessionId, 'queue_expired')
        const lease = this.owners.get(sessionId)
        if (lease) this.notifyGap(lease)
      }
    }
    for (const [sessionId, gap] of this.gaps) {
      if (gap.expiresAt <= now) {
        this.gaps.delete(sessionId)
        this.rememberEvicted(sessionId)
      }
    }
    this.scheduleSweep()
  }

  private scheduleSweep(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    let next = Infinity
    for (const held of this.pending.values()) next = Math.min(next, held.expiresAt)
    for (const gap of this.gaps.values()) next = Math.min(next, gap.expiresAt)
    if (!Number.isFinite(next)) return
    this.timer = setTimeout(() => { this.timer = null; this.sweep() }, Math.max(1, next - this.now()))
    this.timer.unref?.()
  }

  private evictionBits(sessionId: string): number[] {
    const digest = createHash('sha256').update(sessionId).digest()
    const size = this.evictedIds.length * 8
    return [0, 4, 8, 12].map(offset => digest.readUInt32LE(offset) % size)
  }

  private rememberEvicted(sessionId: string): void {
    for (const bit of this.evictionBits(sessionId)) this.evictedIds[bit >>> 3]! |= 1 << (bit & 7)
  }

  private mayHaveEvicted(sessionId: string): boolean {
    return this.evictionBits(sessionId).every(bit => (this.evictedIds[bit >>> 3]! & (1 << (bit & 7))) !== 0)
  }
}
