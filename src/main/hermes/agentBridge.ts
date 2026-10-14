// Coding agents → the owner's Hermes agent, for the `hermes` MCP domain
// (#1512, plan docs/plans/2026-10-14-hermes-mcp-domain.md).
//
// WHY a main-side bridge and not "give the agent the Hermes URL": the
// connection's tokens live in main (HermesTokenBroker over safeStorage) and
// must never reach a model. Every call here dials with the stored sign-in
// through HermesConnectionService, does one thing, and disconnects; the agent
// only ever sees text.
//
// WHY one short-lived HermesHeadless per call, not a long-lived client per
// agent: an MCP call is a request/response, and a resident socket per agent
// would be N extra Hermes sessions the owner never opened, each holding a
// heartbeat and a lease on the conversation. HermesHeadless is the same
// client the panes use, so queued submits (never redirecting a running
// turn), lane holds (never landing inside a phone turn) and history
// reconciliation behave exactly as in a pane.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { HermesHeadless, HermesPromptError, type CommittedRow, type HermesConnectionState, type HermesRequest, type HermesTarget, type SemanticEvent, type TranscriptMessage } from 'hermes-headless'

import type { HermesConnectionService } from '@main/hermes/service.js'
import type { HermesConnectionInfo } from '@shared/hermes/types.js'

/** What the bridge needs from the connection service (tests pass a fake). */
export type HermesBridgeConnections = Pick<HermesConnectionService, 'list' | 'dialFor' | 'restFor' | 'lookupLaneKey'>

export type HermesAgentBridgeDeps = {
  connections: HermesBridgeConnections
  /** Agent Code's state dir; the agent → conversation map lives under it. */
  stateDir: string
  /** HermesHeadless options the bridge does not decide (tests shorten timers). */
  headlessOptions?: { requestTimeoutMs?: number; heartbeatIntervalMs?: number }
  now?: () => number
}

/** A conversation as an agent names it: its own (default), the Telegram thread, or a stored id. */
export type HermesConversationRef = 'own' | 'telegram' | string

export type HermesMessage = { role: 'user' | 'hermes' | 'tool'; text: string }

export type HermesSendResult =
  | { status: 'replied'; conversationId: string; reply: string; tools: string[] }
  /** The turn ended without an answer: interrupted, or Hermes/the model errored (recorded S7, S15). */
  | { status: 'ended'; conversationId: string; reason: string; tools: string[] }
  | { status: 'accepted'; conversationId: string }
  | { status: 'still_running'; conversationId: string }
  | { status: 'awaiting_approval'; conversationId: string; request: { kind: string; description: string } }
  | { status: 'held'; conversationId: string }

/** A failure the agent can act on; `message` is curated (never server text, never a token). */
export class HermesBridgeError extends Error {
  constructor(readonly code: 'not-signed-in' | 'unknown-connection' | 'ambiguous-connection' | 'unknown-conversation' | 'no-telegram-thread' | 'unreachable' | 'refused' | 'uncertain' | 'busy', message: string) {
    super(message)
    this.name = 'HermesBridgeError'
  }
}

// WHY 25 s by default and never more than 50 (review B F2): MCP clients
// time a tool call out on their own clock — 60 s in the SDK default that
// OpenCode, Grok and Pi use, 300 s in Codex — and a client that gave up sees
// a transport error, not "still running", and may RESEND, making Hermes do
// the work twice. The house number for waiting tools is 30 s
// (orchestration_wait_agents). The rest of the budget is the dial, the
// history read and the submit. A longer turn returns `still_running`, and
// the agent reads the answer with hermes_read.
const DEFAULT_WAIT_SECONDS = 25
const MAX_WAIT_SECONDS = 50
/** A second send to one conversation waits this long for the first, then says busy (review B F2). */
const LANE_WAIT_MS = 10_000
const READ_LIMIT_DEFAULT = 20
const READ_LIMIT_MAX = 100
const MAP_FILE = 'agent-conversations.json'

export class HermesAgentBridge {
  private readonly now: () => number
  /** connectionId → caller identity → stored conversation id. */
  private mapLoad: Promise<Record<string, Record<string, string>>> | null = null
  /** Every map write, in order (review A F1: two first-sends raced on one tmp file). */
  private writing: Promise<void> = Promise.resolve()
  /** One send at a time per conversation: two queued submits racing a fresh
   *  `session.create` would make two "own" conversations for one agent. */
  private readonly lanes = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: HermesAgentBridgeDeps) {
    this.now = deps.now ?? Date.now
  }

  /**
   * Connections, whether a Telegram thread exists, the caller's own
   * conversation, and recent conversations.
   *
   * `callerId` everywhere is the scope's tldrIdentity (falling back to the
   * session id): the identity that survives an agent's reload and provider
   * switch (review A F2). It always comes from the authenticated MCP scope,
   * never from tool input, so no agent can address another's "own" mapping.
   */
  async conversations(callerId: string, options: { connection?: string } = {}): Promise<{
    connection: { id: string; name: string }
    telegram: boolean
    own: string | null
    recent: Array<{ id: string; title: string | null; source: string | null; lastActiveAt: number | null }>
  }> {
    const connection = this.pick(options.connection)
    const rest = this.deps.connections.restFor(connection.id)
    const [list, laneKey] = await Promise.all([
      rest.listSessions({ order: 'recent', limit: 20 }).catch(() => {
        throw new HermesBridgeError('unreachable', `Could not reach Hermes on "${connection.name}".`)
      }),
      this.deps.connections.lookupLaneKey(connection.id),
    ])
    const own = (await this.loadMap())[connection.id]?.[callerId] ?? null
    return {
      connection: { id: connection.id, name: connection.name },
      telegram: laneKey !== null,
      own,
      recent: list.sessions.map((session) => {
        const record = session as unknown as Record<string, unknown>
        const lastActive = record.last_active ?? record.updated_at ?? record.started_at
        return {
          id: String(record.id ?? ''),
          title: typeof record.title === 'string' && record.title ? record.title : null,
          source: typeof record.source === 'string' ? record.source : null,
          lastActiveAt: typeof lastActive === 'number' ? lastActive : null,
        }
      }).filter((row) => row.id),
    }
  }

  /** The last `limit` messages of a conversation, as text. Never creates one (review A F7 / B F4). */
  async read(callerId: string, options: { connection?: string; conversation?: HermesConversationRef; limit?: number } = {}): Promise<{ conversationId: string; messages: HermesMessage[] }> {
    const connection = this.pick(options.connection)
    const target = await this.target(connection, callerId, options.conversation ?? 'own', null)
    if (!target) throw new HermesBridgeError('unknown-conversation', 'This agent has no Hermes conversation yet. Send a message with hermes_send first, or name one from hermes_conversations.')
    const limit = Math.max(1, Math.min(READ_LIMIT_MAX, Math.floor(options.limit ?? READ_LIMIT_DEFAULT)))
    return this.withHeadless(connection, target, async (headless, rows) => {
      await rows.caughtUp()
      return { conversationId: headless.storedSessionId, messages: messagesOf(rows.all()).slice(-limit) }
    })
  }

  /** Send `text`; by default wait (briefly, see DEFAULT_WAIT_SECONDS) for Hermes' reply. */
  async send(callerId: string, callerTitle: string, options: { text: string; connection?: string; conversation?: HermesConversationRef; wait?: boolean; timeoutSeconds?: number }): Promise<HermesSendResult> {
    const connection = this.pick(options.connection)
    const ref = options.conversation ?? 'own'
    const key = `${connection.id}:${ref === 'own' ? `own:${callerId}` : ref}`
    const previous = this.lanes.get(key)
    if (previous) {
      // Never let a queued call submit after its client may have given up
      // (review B F2): a short wait for the one ahead, then "busy".
      const done = await Promise.race([previous.then(() => true, () => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), LANE_WAIT_MS))])
      if (!done) throw new HermesBridgeError('busy', 'Another message to this Hermes conversation is still being sent. Try again in a moment.')
    }
    const run = this.sendNow(connection, callerId, callerTitle, ref, options)
    this.lanes.set(key, run)
    try {
      return await run
    } finally {
      if (this.lanes.get(key) === run) this.lanes.delete(key)
    }
  }

  private async sendNow(
    connection: HermesConnectionInfo,
    callerId: string,
    callerTitle: string,
    ref: HermesConversationRef,
    options: { text: string; wait?: boolean; timeoutSeconds?: number },
  ): Promise<HermesSendResult> {
    const target = (await this.target(connection, callerId, ref, callerTitle))!
    const waitMs = Math.max(1, Math.min(MAX_WAIT_SECONDS, options.timeoutSeconds ?? DEFAULT_WAIT_SECONDS)) * 1000
    // UNCONFIRMED (review A F4): every message an agent sends says so. Hermes
    // and the owner (reading the conversation later, or on the phone) can
    // tell an agent's words from their own, which also blunts a prompt
    // injection that talks an agent into writing to the Telegram thread.
    const text = `[Sent by an Agent Code agent: ${callerTitle}]\n\n${options.text}`
    return this.withHeadless(connection, target, async (headless, rows) => {
      // A conversation this call created is the caller's own from now on,
      // recorded BEFORE the prompt: if the send fails half-way, the next
      // call resumes this conversation instead of making another.
      if (target.mode === 'create') await this.remember(connection.id, callerId, headless.storedSessionId)
      await rows.caughtUp()
      const mark = rows.mark()
      let outcome
      try {
        outcome = await headless.prompt(text)
      } catch (error) {
        if (error instanceof HermesPromptError && error.kind === 'unknown') {
          throw new HermesBridgeError('uncertain', 'The message may or may not have reached Hermes. Read the conversation with hermes_read before sending it again.')
        }
        if (error instanceof HermesPromptError && error.kind === 'refused') throw new HermesBridgeError('refused', 'Hermes refused the message.')
        throw error
      }
      const conversationId = headless.storedSessionId
      if (outcome.status === 'held') {
        // Telegram-lane hold (lane/laneBusy): the thread is busy, or could
        // not be checked. The hold lives in THIS client, which disconnects
        // when the call returns: take it back first, so a lane change in the
        // gap before stop() cannot send it after we told the agent it was
        // not sent (review B F5.4).
        if (outcome.holdId) headless.cancelHeld(outcome.holdId)
        return { status: 'held', conversationId }
      }
      if (options.wait === false) return { status: 'accepted', conversationId }
      return rows.reply({ mark, userRowId: outcome.userRowId, text, timeoutMs: waitMs, conversationId })
    })
  }

  // -------------------------------------------------------------------------

  private pick(nameOrId?: string): HermesConnectionInfo {
    const all = this.deps.connections.list()
    if (nameOrId) {
      const match = all.find((entry) => entry.id === nameOrId) ?? all.find((entry) => entry.name.toLowerCase() === nameOrId.toLowerCase())
      if (!match) throw new HermesBridgeError('unknown-connection', `No Hermes connection named "${nameOrId}".`)
      if (match.state === 'signed-out' || match.state === 'signing-in') throw new HermesBridgeError('not-signed-in', `Hermes connection "${match.name}" is not signed in. Sign in under Settings → Providers → Hermes.`)
      return match
    }
    const usable = all.filter((entry) => entry.state === 'ready' || entry.state === 'unreachable')
    if (usable.length === 0) throw new HermesBridgeError('not-signed-in', 'No signed-in Hermes connection. Sign in under Settings → Providers → Hermes.')
    // Never guess between two of the owner's servers: a message to the wrong
    // Hermes is a message to the wrong agent.
    if (usable.length > 1) throw new HermesBridgeError('ambiguous-connection', `Several Hermes connections are signed in (${usable.map((entry) => `"${entry.name}"`).join(', ')}); pass \`connection\`.`)
    return usable[0]!
  }

  private async target(connection: HermesConnectionInfo, callerId: string, ref: HermesConversationRef, createTitle: string | null): Promise<HermesTarget | null> {
    if (ref === 'telegram') {
      const sessionKey = await this.deps.connections.lookupLaneKey(connection.id)
      if (!sessionKey) throw new HermesBridgeError('no-telegram-thread', 'This Hermes server has no Telegram thread (or it could not be looked up).')
      return { mode: 'lane', sessionKey }
    }
    const own = ref === 'own' ? (await this.loadMap())[connection.id]?.[callerId] : undefined
    const id = ref === 'own' ? own : ref
    if (id) {
      // Ask BEFORE resuming (reviews A F7, B F4): HermesHeadless answers an
      // unknown id (4007) by CREATING a conversation, so every typo'd or
      // deleted id left a junk conversation on the owner's server. The same
      // lookup follows compression to the conversation's current tip.
      const tip = await this.latest(connection, id)
      if (tip) return { mode: 'resume', storedSessionId: tip }
      if (ref !== 'own') throw new HermesBridgeError('unknown-conversation', `Hermes has no conversation "${ref}".`)
      // The agent's own conversation was deleted on the server: forget it
      // and, for a send, start a new one below.
      await this.forget(connection.id, callerId)
    }
    // UNCONFIRMED (plan Decision 2): an agent's messages go to a conversation
    // of its own, never to the owner's Telegram thread by default. Agent
    // traffic in that thread would interleave with the phone chat, and Hermes
    // would act on it as if the owner had typed it there.
    return createTitle === null ? null : { mode: 'create', source: 'agent-code', title: `Agent Code · ${createTitle}`.slice(0, 80) }
  }

  /** The conversation's current tip, null when Hermes has no such id (404). */
  private async latest(connection: HermesConnectionInfo, id: string): Promise<string | null> {
    try {
      const found = await this.deps.connections.restFor(connection.id).latestDescendant(id)
      return typeof found.session_id === 'string' && found.session_id ? found.session_id : id
    } catch (error) {
      if ((error as { status?: unknown } | null)?.status === 404) return null
      console.warn('[hermes-mcp] conversation lookup failed:', error)
      throw new HermesBridgeError('unreachable', `Could not reach Hermes on "${connection.name}".`)
    }
  }

  private async withHeadless<T>(connection: HermesConnectionInfo, target: HermesTarget, work: (headless: HermesHeadless, rows: RowLog) => Promise<T>): Promise<T> {
    const headless = new HermesHeadless({
      dial: this.deps.connections.dialFor(connection.id),
      target,
      ...(target.mode === 'lane' ? { rest: this.deps.connections.restFor(connection.id) } : {}),
      // Nothing here lives long enough to need the lane backstop poll.
      laneBackstopMs: 600_000,
      ...this.deps.headlessOptions,
    })
    const rows = new RowLog(headless, this.now)
    try {
      try {
        await headless.start()
      } catch (error) {
        if (error instanceof HermesBridgeError) throw error
        // The real error goes to main's log, never to the model (it can
        // carry server detail).
        console.warn('[hermes-mcp] start failed:', error)
        throw new HermesBridgeError('unreachable', `Could not open the Hermes conversation on "${connection.name}".`)
      }
      // The id was checked just before (latest), so a 4007 here is a delete
      // racing this call; say so rather than talk to the conversation
      // HermesHeadless created in its place.
      if (target.mode === 'resume' && rows.replaced) throw new HermesBridgeError('unknown-conversation', `Hermes has no conversation "${target.storedSessionId}".`)
      return await work(headless, rows)
    } finally {
      rows.dispose()
      await headless.stop().catch(() => undefined)
    }
  }

  /** Loaded once (review A F6: two first calls each loading could drop a fresh mapping). */
  private loadMap(): Promise<Record<string, Record<string, string>>> {
    this.mapLoad ??= (async () => {
      let raw: string
      try {
        raw = await readFile(this.mapPath(), 'utf8')
      } catch {
        return {}
      }
      try {
        return validMap(JSON.parse(raw))
      } catch {
        // Corrupt: keep a copy before the next write replaces it (review A
        // F5). The worst case is one new conversation per agent.
        await rename(this.mapPath(), `${this.mapPath()}.corrupt-${this.now()}`).catch(() => undefined)
        return {}
      }
    })()
    return this.mapLoad
  }

  private async remember(connectionId: string, callerId: string, storedSessionId: string): Promise<void> {
    const map = await this.loadMap()
    map[connectionId] = { ...(map[connectionId] ?? {}), [callerId]: storedSessionId }
    await this.save(map)
  }

  private async forget(connectionId: string, callerId: string): Promise<void> {
    const map = await this.loadMap()
    if (!map[connectionId]?.[callerId]) return
    delete map[connectionId]![callerId]
    await this.save(map)
  }

  /**
   * One write at a time, each with its own temp file, then an atomic rename
   * (review A F1, reproduced: two concurrent writes to one `.tmp` lost a
   * send to ENOENT and left invalid JSON 10 times in 200). The snapshot is
   * serialized INSIDE the queue, so the last write carries every mapping.
   */
  private save(map: Record<string, Record<string, string>>): Promise<void> {
    const write = async () => {
      const path = this.mapPath()
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(tmp, JSON.stringify(map, null, 2), { mode: 0o600 })
      await rename(tmp, path)
    }
    const next = this.writing.then(write, write)
    this.writing = next.catch(() => undefined)
    return next
  }

  private mapPath(): string {
    return join(this.deps.stateDir, 'hermes', MAP_FILE)
  }
}

/** Only `{ connectionId: { callerId: storedId } }` with string ids survives a load. */
function validMap(parsed: unknown): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
  for (const [connectionId, entries] of Object.entries(parsed as Record<string, unknown>)) {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue
    for (const [callerId, stored] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof stored === 'string' && stored) (out[connectionId] ??= {})[callerId] = stored
    }
  }
  return out
}

/**
 * Which committed rows answer OUR message (review B F1).
 *
 * Our user row is found by its id when Hermes returned one, else (a queued
 * submit returns no `user_row_id`, recorded S20 "Turn 4": `{"status":
 * "queued"}`) as the first user row after the mark whose text is exactly
 * what we sent. The answer is everything from there to the NEXT user row:
 * a later message (the owner's, another agent's) and its answer are not
 * ours. Null when our row is not committed yet.
 */
export function rowsForOurMessage(rows: TranscriptMessage[], options: { mark: number; userRowId: number | null; text: string }): { found: boolean; after: TranscriptMessage[]; closed: boolean } {
  const index = options.userRowId !== null
    ? rows.findIndex((row) => row.role === 'user' && row.row_id === options.userRowId)
    : rows.findIndex((row, at) => at >= options.mark && row.role === 'user' && textOf(row) === options.text)
  if (index < 0) return { found: false, after: [], closed: false }
  const next = rows.findIndex((row, at) => at > index && row.role === 'user')
  return { found: true, after: rows.slice(index + 1, next < 0 ? undefined : next), closed: next >= 0 }
}

/**
 * The committed rows one call has seen, plus the signals to wait on.
 *
 * WHY committed rows for the answer: they are what Hermes stored, i.e. what
 * the owner sees later in the pane and on the phone. HermesHeadless
 * re-fetches history when a turn settles and publishes a `caught-up`
 * boundary after applying it.
 */
class RowLog {
  private readonly rows = new Map<string, TranscriptMessage>()
  private readonly order: string[] = []
  private generation = 0
  private caughtUpGeneration = -1
  private caughtUpCount = 0
  private active = false
  /** Every turn_stopped seen (semantic channel), with the caught-up count at that moment. */
  private readonly stops: Array<{ reason: string; caughtUpBefore: number }> = []
  private request: HermesRequest | null = null
  private disconnected = false
  private readonly waiters = new Set<() => void>()
  replaced = false
  private readonly offs: Array<() => void> = []

  constructor(private readonly headless: HermesHeadless, private readonly now: () => number) {
    const on = <A extends unknown[]>(emitter: { on: (event: string, listener: (...args: A) => void) => unknown; off: (event: string, listener: (...args: A) => void) => unknown }, event: string, listener: (...args: A) => void) => {
      emitter.on(event, listener)
      this.offs.push(() => emitter.off(event, listener))
    }
    on(headless.committed, 'entry', (row: CommittedRow) => {
      if (!this.rows.has(row.key)) this.order.push(row.key)
      this.rows.set(row.key, row.row)
    })
    on(headless.committed, 'boundary', (boundary: { type: string; generation: number }) => {
      if (boundary.type === 'reset') {
        this.rows.clear()
        this.order.length = 0
        this.generation = boundary.generation
      } else {
        this.caughtUpGeneration = boundary.generation
        this.caughtUpCount += 1
      }
      this.wake()
    })
    on(headless.screen, 'activity', (event: { active: boolean }) => {
      this.active = event.active
      this.wake()
    })
    on(headless.semantic, 'event', (event: SemanticEvent) => {
      if (event.type !== 'turn_stopped') return
      this.stops.push({ reason: String(event.stopReason ?? ''), caughtUpBefore: this.caughtUpCount })
      this.wake()
    })
    // A request open BEFORE our message (a replayed one) blocks it just the
    // same: Hermes runs our turn only after it is answered (review B F5.1).
    on(headless, 'request', (request: HermesRequest) => {
      this.request = request
      this.wake()
    })
    on(headless, 'request-closed', ({ id }: { id: string }) => {
      if (this.request?.id === id) this.request = null
      this.wake()
    })
    on(headless, 'connection', (state: HermesConnectionState) => {
      if (state.kind === 'disconnected') this.disconnected = true
      this.wake()
    })
    on(headless, 'session-replaced', () => {
      this.replaced = true
    })
  }

  all(): TranscriptMessage[] {
    return this.order.map((key) => this.rows.get(key)!).filter(Boolean)
  }

  /** Where "rows before our message" ends; pass to reply(). */
  mark(): number {
    return this.order.length
  }

  /** The snapshot's history has been applied (or 10 s passed: read what there is). */
  caughtUp(): Promise<void> {
    return this.until(() => this.caughtUpGeneration >= this.generation, 10_000).then(() => undefined)
  }

  async reply(options: { mark: number; userRowId: number | null; text: string; timeoutMs: number; conversationId: string }): Promise<HermesSendResult> {
    const stopsAtSubmit = this.stops.length
    const ours = () => rowsForOurMessage(this.all(), options)
    // Our turn is over when our row is committed and EITHER the rows after
    // it already end at the next user row (a later message started), OR the
    // session is idle, OUR turn has stopped, and the history read that
    // follows that stop has landed.
    //
    // Which stop is ours: a submit Hermes accepted at once (it returned our
    // user row id) runs next, so the first stop after the submit. A QUEUED
    // submit (no user row id, recorded S20) waits behind at least one turn,
    // so the second. "The last row is an assistant text", the first rule,
    // fired on the PREVIOUS turn's answer for a queued submit (review B F1)
    // and never fired for a turn that ended without text (review B F3,
    // recorded S7 interrupted). If more than one turn was queued ahead of
    // ours, the `closed` check catches the next user row; otherwise the
    // answer is read as far as it goes and the agent can hermes_read again.
    const stopsNeeded = options.userRowId !== null ? 1 : 2
    const ended = () => {
      const mine = ours()
      if (!mine.found) return false
      if (mine.closed) return true
      if (this.active) return false
      const since = this.stops.slice(stopsAtSubmit)
      const ourStop = since[stopsNeeded - 1]
      return Boolean(ourStop && this.caughtUpCount > ourStop.caughtUpBefore)
    }
    const settled = await this.until(() => this.request !== null || this.disconnected || ended(), options.timeoutMs)
    if (this.request) {
      // UNCONFIRMED (plan Decision 4): never answered or declined from MCP.
      // The request stays pending on the server for the owner to answer.
      return { status: 'awaiting_approval', conversationId: options.conversationId, request: describeRequest(this.request) }
    }
    if (this.disconnected && !ended()) {
      throw new HermesBridgeError('uncertain', 'The connection to Hermes dropped after the message was sent. It was delivered; read the answer later with hermes_read instead of sending it again.')
    }
    if (!settled) return { status: 'still_running', conversationId: options.conversationId }
    const { after } = ours()
    const reply = after.filter((row) => row.role === 'assistant').map(textOf).filter((text) => text.trim()).join('\n\n')
    const tools = after.filter((row) => row.role === 'tool').map(toolLine)
    if (!reply) {
      const reason = this.stops.at(-1)?.reason ?? 'ended'
      return { status: 'ended', conversationId: options.conversationId, reason: reason === 'end_turn' ? 'ended without a reply' : reason, tools }
    }
    return { status: 'replied', conversationId: options.conversationId, reply, tools }
  }

  dispose(): void {
    for (const off of this.offs) off()
    for (const wake of this.waiters) wake()
  }

  private wake(): void {
    for (const wake of [...this.waiters]) wake()
  }

  /** Resolve true once `done()` holds, false after `timeoutMs`. */
  private until(done: () => boolean, timeoutMs: number): Promise<boolean> {
    if (done()) return Promise.resolve(true)
    const deadline = this.now() + timeoutMs
    return new Promise((resolve) => {
      const check = () => {
        if (done()) finish(true)
      }
      const timer = setTimeout(() => finish(done()), Math.max(0, deadline - this.now()))
      const finish = (value: boolean) => {
        clearTimeout(timer)
        this.waiters.delete(check)
        resolve(value)
      }
      this.waiters.add(check)
    })
  }
}

function textOf(row: TranscriptMessage): string {
  if (typeof row.text === 'string' && row.text) return row.text
  const content = row.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('')
  }
  return ''
}

/**
 * Credentials Hermes may have TYPED on the owner's server (a curl with a
 * bearer, an API key in an env assignment), scrubbed from the one-line
 * summaries this bridge builds (review A F3). A coding agent reading its
 * owner's conversation is the feature; a third-party model provider
 * receiving the owner's server secrets through a summary line is not.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password|passwd|pwd)[A-Za-z0-9_]*)\s*([=:])\s*("[^"]*"|'[^']*'|\S+)/gi, '$1$2[redacted]')
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, '[redacted]')
}

/** One line per tool call: what ran, never its (possibly huge) output, secrets scrubbed. */
function toolLine(row: TranscriptMessage): string {
  const name = row.name ?? 'tool'
  const args = row.args ?? {}
  const detail = row.context ?? Object.values(args).find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? ''
  const line = redactSecrets(`${name}${detail ? ` ${detail}` : ''}`.replace(/\s+/g, ' ').trim())
  return line.length > 160 ? `${line.slice(0, 159)}…` : line
}

function messagesOf(rows: TranscriptMessage[]): HermesMessage[] {
  const out: HermesMessage[] = []
  for (const row of rows) {
    if (row.role === 'user') {
      const text = textOf(row).trim()
      if (text) out.push({ role: 'user', text })
    } else if (row.role === 'assistant') {
      const text = textOf(row).trim()
      if (text) out.push({ role: 'hermes', text })
    } else if (row.role === 'tool') {
      out.push({ role: 'tool', text: toolLine(row) })
    }
  }
  return out
}

function describeRequest(request: HermesRequest): { kind: string; description: string } {
  const params = request.params
  const pick = (...keys: string[]) => keys.map((key) => params[key]).find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const description = request.method === 'approval'
    ? [pick('description'), pick('command')].filter(Boolean).join(': ')
    : pick('question', 'prompt', 'description', 'message') ?? ''
  // The request's own words, bounded and scrubbed; a secret request names
  // WHAT it wants, never a value (Hermes never sends one to the client).
  return { kind: request.method, description: redactSecrets(description).slice(0, 400) || `Hermes is waiting for a ${request.method} answer.` }
}
