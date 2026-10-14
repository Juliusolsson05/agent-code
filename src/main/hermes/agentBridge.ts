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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { HermesHeadless, HermesPromptError, type CommittedRow, type HermesRequest, type HermesTarget, type TranscriptMessage } from 'hermes-headless'

import type { HermesConnectionService } from '@main/hermes/service.js'
import type { HermesConnectionInfo } from '@shared/hermes/types.js'

/** What the bridge needs from the connection service (tests pass a fake). */
export type HermesBridgeConnections = Pick<HermesConnectionService, 'list' | 'dialFor' | 'restFor' | 'defaultLaneKey'>

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
  | { status: 'accepted'; conversationId: string }
  | { status: 'still_running'; conversationId: string }
  | { status: 'awaiting_approval'; conversationId: string; request: { kind: string; description: string } }
  | { status: 'held'; conversationId: string }

/** A failure the agent can act on; `message` is curated (never server text, never a token). */
export class HermesBridgeError extends Error {
  constructor(readonly code: 'not-signed-in' | 'unknown-connection' | 'ambiguous-connection' | 'unknown-conversation' | 'no-telegram-thread' | 'unreachable' | 'refused' | 'uncertain', message: string) {
    super(message)
    this.name = 'HermesBridgeError'
  }
}

const DEFAULT_WAIT_SECONDS = 300
const MAX_WAIT_SECONDS = 900
const READ_LIMIT_DEFAULT = 20
const READ_LIMIT_MAX = 100
const MAP_FILE = 'agent-conversations.json'

export class HermesAgentBridge {
  private readonly now: () => number
  /** connectionId → callerSessionId → stored conversation id. */
  private map: Record<string, Record<string, string>> | null = null
  /** One send at a time per conversation: two queued submits racing a fresh
   *  `session.create` would make two "own" conversations for one agent. */
  private readonly lanes = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: HermesAgentBridgeDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Connections, the Telegram thread, the caller's own conversation, and recent conversations. */
  async conversations(callerSessionId: string, options: { connection?: string } = {}): Promise<{
    connection: { id: string; name: string }
    telegram: { storedSessionId: string | null } | null
    own: string | null
    recent: Array<{ id: string; title: string | null; source: string | null; lastActiveAt: number | null }>
  }> {
    const connection = this.pick(options.connection)
    const rest = this.deps.connections.restFor(connection.id)
    const [list, laneKey] = await Promise.all([
      rest.listSessions({ order: 'recent', limit: 20 }).catch(() => {
        throw new HermesBridgeError('unreachable', `Could not reach Hermes on "${connection.name}".`)
      }),
      this.deps.connections.defaultLaneKey(connection.id),
    ])
    const own = (await this.loadMap())[connection.id]?.[callerSessionId] ?? null
    return {
      connection: { id: connection.id, name: connection.name },
      telegram: laneKey ? { storedSessionId: null } : null,
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

  /** The last `limit` messages of a conversation, as text. */
  async read(callerSessionId: string, options: { connection?: string; conversation?: HermesConversationRef; limit?: number } = {}): Promise<{ conversationId: string; messages: HermesMessage[] }> {
    const connection = this.pick(options.connection)
    const target = await this.target(connection, callerSessionId, options.conversation ?? 'own', null)
    if (!target) throw new HermesBridgeError('unknown-conversation', 'This agent has no Hermes conversation yet. Send a message with hermes_send first, or name one from hermes_conversations.')
    const limit = Math.max(1, Math.min(READ_LIMIT_MAX, Math.floor(options.limit ?? READ_LIMIT_DEFAULT)))
    return this.withHeadless(connection, target, async (headless, rows) => {
      await rows.caughtUp()
      return { conversationId: headless.storedSessionId, messages: messagesOf(rows.all()).slice(-limit) }
    })
  }

  /** Send `text`; by default wait for Hermes' reply (bounded). */
  async send(callerSessionId: string, callerTitle: string, options: { text: string; connection?: string; conversation?: HermesConversationRef; wait?: boolean; timeoutSeconds?: number }): Promise<HermesSendResult> {
    const connection = this.pick(options.connection)
    const ref = options.conversation ?? 'own'
    const key = `${connection.id}:${ref === 'own' ? `own:${callerSessionId}` : ref}`
    const previous = this.lanes.get(key) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(() => this.sendNow(connection, callerSessionId, callerTitle, ref, options))
    this.lanes.set(key, run)
    try {
      return await run
    } finally {
      if (this.lanes.get(key) === run) this.lanes.delete(key)
    }
  }

  private async sendNow(
    connection: HermesConnectionInfo,
    callerSessionId: string,
    callerTitle: string,
    ref: HermesConversationRef,
    options: { text: string; wait?: boolean; timeoutSeconds?: number },
  ): Promise<HermesSendResult> {
    const target = (await this.target(connection, callerSessionId, ref, callerTitle))!
    const waitMs = Math.max(1, Math.min(MAX_WAIT_SECONDS, options.timeoutSeconds ?? DEFAULT_WAIT_SECONDS)) * 1000
    return this.withHeadless(connection, target, async (headless, rows) => {
      // A conversation this call created is the caller's own from now on,
      // recorded BEFORE the prompt: if the send fails half-way, the next
      // call resumes this conversation instead of making another.
      if (target.mode === 'create' || (ref === 'own' && rows.replaced)) await this.remember(connection.id, callerSessionId, headless.storedSessionId)
      await rows.caughtUp()
      const before = rows.all().length
      let outcome
      try {
        outcome = await headless.prompt(options.text)
      } catch (error) {
        if (error instanceof HermesPromptError && error.kind === 'unknown') {
          throw new HermesBridgeError('uncertain', 'The message may or may not have reached Hermes. Read the conversation before sending it again.')
        }
        if (error instanceof HermesPromptError && error.kind === 'refused') throw new HermesBridgeError('refused', 'Hermes refused the message.')
        throw error
      }
      const conversationId = headless.storedSessionId
      // Telegram-lane hold (lane/laneBusy): the phone's turn is running on
      // the thread. The hold lives in THIS client, which disconnects when the
      // call returns, so the message is NOT sent. Saying so is the only
      // honest answer; forcing it would land inside the owner's phone turn.
      if (outcome.status === 'held') return { status: 'held', conversationId }
      if (options.wait === false) return { status: 'accepted', conversationId }
      return rows.reply({ afterRowId: outcome.userRowId, afterIndex: before, timeoutMs: waitMs, conversationId })
    }, { adoptReplacement: ref === 'own' })
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

  private async target(connection: HermesConnectionInfo, callerSessionId: string, ref: HermesConversationRef, createTitle: string | null): Promise<HermesTarget | null> {
    if (ref === 'telegram') {
      const sessionKey = await this.deps.connections.defaultLaneKey(connection.id)
      if (!sessionKey) throw new HermesBridgeError('no-telegram-thread', 'This Hermes server has no Telegram thread (or it could not be looked up).')
      return { mode: 'lane', sessionKey }
    }
    if (ref !== 'own') return { mode: 'resume', storedSessionId: ref }
    const own = (await this.loadMap())[connection.id]?.[callerSessionId]
    if (own) return { mode: 'resume', storedSessionId: own }
    // UNCONFIRMED (plan Decision 2): an agent's messages go to a conversation
    // of its own, never to the owner's Telegram thread by default. Agent
    // traffic in that thread would interleave with the phone chat, and Hermes
    // would act on it as if the owner had typed it there.
    return createTitle === null ? null : { mode: 'create', source: 'agent-code', title: `Agent Code · ${createTitle}`.slice(0, 80) }
  }

  private async withHeadless<T>(connection: HermesConnectionInfo, target: HermesTarget, work: (headless: HermesHeadless, rows: RowLog) => Promise<T>, options: { adoptReplacement?: boolean } = {}): Promise<T> {
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
        // 4007 on resume (a conversation id that does not exist) arrives as
        // a replaced session, not an error; anything that fails start() is
        // the network or the sign-in, said plainly. The real error goes to
        // main's log, never to the model (it can carry server detail).
        console.warn('[hermes-mcp] start failed:', error)
        throw new HermesBridgeError('unreachable', `Could not open the Hermes conversation on "${connection.name}".`)
      }
      // Resuming an id Hermes does not have (4007) makes HermesHeadless open
      // a NEW conversation and say so. For an id the agent named, that is
      // an error (it asked for a specific conversation). For the agent's OWN
      // conversation (deleted on the server), the new one simply becomes its
      // own: the caller adopts it.
      if (target.mode === 'resume' && rows.replaced && !options.adoptReplacement) throw new HermesBridgeError('unknown-conversation', `Hermes has no conversation "${target.storedSessionId}".`)
      return await work(headless, rows)
    } finally {
      rows.dispose()
      await headless.stop().catch(() => undefined)
    }
  }

  private async loadMap(): Promise<Record<string, Record<string, string>>> {
    if (this.map) return this.map
    try {
      const parsed = JSON.parse(await readFile(this.mapPath(), 'utf8')) as unknown
      this.map = parsed && typeof parsed === 'object' ? (parsed as Record<string, Record<string, string>>) : {}
    } catch {
      // Missing or corrupt: start empty. The worst case is one new
      // conversation for an agent; nothing on the server is lost.
      this.map = {}
    }
    return this.map
  }

  private async remember(connectionId: string, callerSessionId: string, storedSessionId: string): Promise<void> {
    const map = await this.loadMap()
    map[connectionId] = { ...(map[connectionId] ?? {}), [callerSessionId]: storedSessionId }
    const path = this.mapPath()
    await mkdir(dirname(path), { recursive: true })
    // Write-then-rename: a crash mid-write leaves the old map, never half a file.
    await writeFile(`${path}.tmp`, JSON.stringify(map, null, 2), { mode: 0o600 })
    await rename(`${path}.tmp`, path)
  }

  private mapPath(): string {
    return join(this.deps.stateDir, 'hermes', MAP_FILE)
  }
}

/**
 * The committed rows one call has seen, plus the signals to wait on.
 *
 * WHY committed rows and not the live semantic stream for the reply: the
 * committed row is what Hermes stored, i.e. what the owner sees later in the
 * pane and on the phone. HermesHeadless re-fetches history when a turn
 * settles and publishes a `caught-up` boundary after applying it, so "a
 * caught-up boundary that contains an assistant answer after OUR user row,
 * while the session is idle" is the turn's end as Hermes recorded it.
 */
class RowLog {
  private readonly rows = new Map<string, TranscriptMessage>()
  private readonly order: string[] = []
  private generation = 0
  private caughtUpGeneration = -1
  private active = false
  private request: HermesRequest | null = null
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
      }
      this.wake()
    })
    on(headless.screen, 'activity', (event: { active: boolean }) => {
      this.active = event.active
      this.wake()
    })
    on(headless, 'request', (request: HermesRequest) => {
      if (!request.replayed) this.request = request
      this.wake()
    })
    on(headless, 'session-replaced', () => {
      this.replaced = true
    })
  }

  all(): TranscriptMessage[] {
    return this.order.map((key) => this.rows.get(key)!).filter(Boolean)
  }

  /** The snapshot's history has been applied (or 10 s passed: read what there is). */
  caughtUp(): Promise<void> {
    return this.until(() => this.caughtUpGeneration >= this.generation, 10_000).then(() => undefined)
  }

  async reply(options: { afterRowId: number | null; afterIndex: number; timeoutMs: number; conversationId: string }): Promise<HermesSendResult> {
    // Everything committed AFTER our own user row, by position. Not by
    // `row_id > ours`: tool rows carry no row_id (they are keyed by their
    // call id, recorded S4), so an id filter silently dropped every tool.
    const ours = () => {
      const all = this.all()
      const mine = options.afterRowId === null ? -1 : all.findIndex((row) => row.role === 'user' && row.row_id === options.afterRowId)
      return all.slice(mine >= 0 ? mine + 1 : options.afterIndex)
    }
    const answered = () => {
      if (this.active) return false
      const after = ours()
      const last = after[after.length - 1]
      return Boolean(last && last.role === 'assistant' && textOf(last).trim())
    }
    const settled = await this.until(() => this.request !== null || answered(), options.timeoutMs)
    if (this.request) {
      // UNCONFIRMED (plan Decision 4): never answered or declined from MCP.
      // The request stays pending on the server for the owner to answer.
      return { status: 'awaiting_approval', conversationId: options.conversationId, request: describeRequest(this.request) }
    }
    if (!settled) return { status: 'still_running', conversationId: options.conversationId }
    const after = ours()
    const reply = after.filter((row) => row.role === 'assistant').map(textOf).filter((text) => text.trim()).join('\n\n')
    return { status: 'replied', conversationId: options.conversationId, reply, tools: after.filter((row) => row.role === 'tool').map(toolLine) }
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

/** One line per tool call: what ran, never its (possibly huge) output. */
function toolLine(row: TranscriptMessage): string {
  const name = row.name ?? 'tool'
  const args = row.args ?? {}
  const detail = row.context ?? Object.values(args).find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? ''
  const line = `${name}${detail ? ` ${detail}` : ''}`.replace(/\s+/g, ' ').trim()
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
  // The request's own words, bounded; a secret request names WHAT it wants,
  // never a value (Hermes never sends one to the client).
  return { kind: request.method, description: description.slice(0, 400) || `Hermes is waiting for a ${request.method} answer.` }
}
