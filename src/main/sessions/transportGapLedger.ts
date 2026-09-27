import { TRANSPORT_GAPS_PER_CONVERSATION, type TransportGapRecord } from '@shared/types/session.js'

/**
 * Where main keeps the proxy-transport gaps a session's feed must show (#1381).
 *
 * WHY main holds them at all: the owner-approved call (B6 proxy, 2026-09-27,
 * option B) is a feed-HISTORY row — "data loss is never hidden" — bounded to
 * the main-process lifetime (q119/q120; restart durability is #1445). The
 * renderer's semantic state is rebuilt on every window reload, and the gap is
 * not in the transcript (the JSONL is Claude's own file and never saw our
 * transport), so the only process that outlives a renderer reload and saw the
 * gap is main. It hands them out with the conversation's initial history chunk
 * (`session:load-initial-history`), which every feed rebuild goes through.
 *
 * WHY in memory and not on disk: the approved lifetime is this app run.
 * Surviving a restart needs a dedicated store, which is an owner decision
 * (#1445, related to the #1235 ghost-log removal). The always-on
 * `claude.proxy_transport_gap` incident is a DIAGNOSTIC copy only — B6 (q120)
 * ruled it must not be used to reseed rows (forensic, lossy, no conversation
 * id).
 *
 * WHY keyed by the provider CONVERSATION id (Claude's session id), not the
 * pane: a gap is a fact about what we saw of that conversation. Keyed so, the
 * row comes back wherever the conversation's feed is rebuilt — a window
 * reload, an agent reload or crash respawn (same conversation), a resume in
 * another pane — and it does NOT follow a pane into a new conversation (a
 * Claude /clear), where its time position would sit among unrelated rows.
 * Never cleared by the session's process for the same reason; a finished
 * conversation's handful of records lingers until quit, and the bounds below
 * keep that finite.
 *
 * Bounds: the newest PER_CONVERSATION_CAP gaps per conversation (a gap needs
 * >= 1 GiB of proxy traffic through a stalled poller, so even the cap is far
 * beyond a real conversation), and CONVERSATION_CAP conversations, evicting the one
 * that recorded least recently.
 */
// Shared with the renderer's merge so a live and a rebuilt feed paint the same rows.
export const PER_CONVERSATION_CAP = TRANSPORT_GAPS_PER_CONVERSATION
export const CONVERSATION_CAP = 500

export class TransportGapLedger {
  // Map iteration order is insertion order; a conversation is re-inserted on
  // every record, so the first key is always the least recently recorded.
  private readonly byConversation = new Map<string, TransportGapRecord[]>()
  // One sequence for the whole ledger, so ids are unique across conversations:
  // the renderer de-duplicates a history rebuild's records against the live
  // ones it already holds by id.
  private sequence = 0

  record(conversationId: string, gap: Omit<TransportGapRecord, 'id'>): TransportGapRecord {
    this.sequence += 1
    const entry: TransportGapRecord = { id: `gap-${this.sequence}`, ...gap }
    const list = this.byConversation.get(conversationId) ?? []
    this.byConversation.delete(conversationId)
    const next = [...list, entry].slice(-PER_CONVERSATION_CAP)
    this.byConversation.set(conversationId, next)
    if (this.byConversation.size > CONVERSATION_CAP) {
      const oldest = this.byConversation.keys().next().value
      if (oldest !== undefined) this.byConversation.delete(oldest)
    }
    return entry
  }

  list(conversationId: string): readonly TransportGapRecord[] {
    return this.byConversation.get(conversationId) ?? []
  }
}
