// Folds ACP `session/update` notifications into two outputs:
//
//   committed rows  one per conversation segment (a user prompt, a stretch of
//                   assistant text, a stretch of thinking, one tool call with
//                   its result) — what the feed, history and MCP read_agent
//                   show, and what a renderer reload gets back;
//   live events     the feed's semantic vocabulary (turn_started, text_delta,
//                   thinking_delta, tool blocks, turn_completed), emitted only
//                   for a live turn, never for a replay.
//
// WHY segments and ordinal ids: agy streams text as chunks with no message
// ids, and `session/load` replays a conversation as the same kinds of chunks
// (user_message_chunk, agent_thought_chunk, tool_call, agent_message_chunk —
// recorded against agy 1.5.15). A new segment starts exactly when the update
// kind changes or a new tool call appears, so a live turn and a later replay
// of it cut the same segments in the same order. The row id is the segment's
// ordinal in the conversation (`ag:<session>:<n>`): stable across a renderer
// reload (the live rows are served back as-is) and across a resume (which
// starts with a history reset, so ids never have to match across processes).
//
// WHY a row is committed when its segment CLOSES, not per chunk: the feed's
// ledger treats committed rows as immutable by id; a row emitted on its first
// chunk would freeze half a sentence. The live text_delta stream shows the
// text while it grows; the committed row lands once it is whole.
//
// Tool calls are committed when they reach a terminal status (completed,
// failed, cancelled) or when the turn ends, carrying their call AND result in
// one row, because ACP sends a tool's input first and its output on a later
// tool_call_update under the same toolCallId.

export type AntigravityRowRole = 'user' | 'assistant' | 'thought' | 'tool'

export type AntigravityToolSnapshot = {
  toolCallId: string
  name: string
  /** ACP tool kind: read, edit, delete, move, search, execute, think, fetch, other. */
  kind: string | null
  title: string | null
  input: unknown
  status: string
  /** Text of the result, when the agent reported one. */
  output: string | null
  isError: boolean
}

export type AntigravityRow = {
  type: 'antigravity-row'
  sessionId: string
  /** Stable row id, `ag:<sessionId>:<ordinal>`; also the history paging marker. */
  key: string
  ordinal: number
  role: AntigravityRowRole
  text?: string
  tool?: AntigravityToolSnapshot
  timestamp: number
}

export type AntigravitySemanticEvent = Record<string, unknown> & { type: string; source: 'antigravity-acp'; ts: number }

type OpenSegment = { includesImage?: boolean; kind: 'user' | 'assistant' | 'thought'; ordinal: number; text: string; blockId: string; blockIndex: number; openedAt: number }
type OpenTool = AntigravityToolSnapshot & { ordinal: number; blockIndex: number; committed: boolean; openedAt: number }

const TERMINAL_TOOL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'canceled', 'error'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function contentText(content: unknown): string {
  if (!isRecord(content)) return ''
  if (content.type === 'text' && typeof content.text === 'string') return content.text
  // Embedded resources and links: show what they name rather than nothing.
  if (content.type === 'resource_link' && typeof content.uri === 'string') return content.uri
  if (content.type === 'resource' && isRecord(content.resource) && typeof content.resource.text === 'string') return content.resource.text
  return ''
}

/**
 * The text of a tool's result. agy reports it in `rawOutput` (an object with
 * `output`, recorded for run_command) and/or in ACP `content` blocks
 * ({type:'content', content:{type:'text'}} or {type:'diff', path, oldText,
 * newText}). Replays carry neither for most tools; then there is no output.
 */
function toolOutput(update: Record<string, unknown>): string | null {
  const texts: string[] = []
  if (Array.isArray(update.content)) {
    for (const item of update.content) {
      if (!isRecord(item)) continue
      if (item.type === 'content') {
        const text = contentText(item.content)
        if (text) texts.push(text)
      } else if (item.type === 'diff' && typeof item.path === 'string') {
        texts.push(`Edited ${item.path}`)
      } else if (item.type === 'terminal' && typeof item.terminalId === 'string') {
        texts.push(`[terminal ${item.terminalId}]`)
      }
    }
  }
  if (texts.length > 0) return texts.join('\n')
  const raw = update.rawOutput
  if (typeof raw === 'string' && raw.length > 0) return raw
  if (isRecord(raw)) {
    if (typeof raw.output === 'string') return raw.output
    if (typeof raw.error === 'string') return raw.error
    return JSON.stringify(raw)
  }
  return null
}

export type AssemblerSink = {
  row(row: AntigravityRow): void
  semantic(event: AntigravitySemanticEvent): void
}

export class TurnAssembler {
  private ordinal = 0
  private segment: OpenSegment | null = null
  private readonly tools = new Map<string, OpenTool>()
  private turnId: string | null = null
  private turnCounter = 0
  private blockCounter = 0
  private turnText = ''
  private live = false
  /**
   * Timestamp base for REPLAYED rows. WHY not the time they are replayed: the
   * feed orders committed rows by timestamp (rendering/model/order.ts), and a
   * resume replays the whole conversation in one burst — every row would
   * carry the resume moment and sort after live content that preceded it.
   * Replayed rows instead get a base well in the past plus their ordinal, so
   * they keep conversation order and sort before anything live.
   */
  private replayBase = 0

  constructor(private sessionId: string, private readonly sink: AssemblerSink, private readonly now: () => number = Date.now) {}

  /** Start over for another conversation (after a history reset). */
  reset(sessionId: string): void {
    this.sessionId = sessionId
    this.ordinal = 0
    this.segment = null
    this.tools.clear()
    this.turnId = null
    this.turnText = ''
    this.live = false
  }

  /** Replays (session/load) build rows only; live turns also stream events. */
  setLive(live: boolean): void {
    this.live = live
    if (!live) this.replayBase = this.now() - 24 * 60 * 60 * 1000
  }

  /**
   * When a row's content STARTED. WHY the open time and not the commit time:
   * a tool commits when it finishes, possibly after text that started later
   * (parallel tools, a tool closed at turn end), and the feed sorts by
   * timestamp; stamping at commit would paint it below the text that followed.
   */
  private stamp(ordinal: number): number {
    return this.live ? this.now() : this.replayBase + ordinal
  }

  /**
   * The user's prompt, sent by us. ACP does not echo it during a live turn
   * (only replays carry user_message_chunk), so the user row is cut here —
   * which is what keeps live and replay ordinals aligned.
   */
  beginTurn(promptText: string): string {
    this.closeSegment()
    this.commitOpenTools()
    this.turnId = `ag-turn-${++this.turnCounter}`
    this.blockCounter = 0
    this.turnText = ''
    if (promptText.trim().length > 0) {
      const ordinal = this.ordinal++
      this.segment = { kind: 'user', ordinal, text: promptText, blockId: '', blockIndex: -1, openedAt: this.stamp(ordinal) }
      this.closeSegment()
    }
    if (this.live) {
      this.emit({ type: 'turn_started', turnId: this.turnId, role: 'assistant', confidence: 'high' })
      this.emit({ type: 'stream_phase', turnId: this.turnId, phase: 'thinking' })
    }
    return this.turnId
  }

  /** The prompt request returned: the turn is over. */
  endTurn(stopReason: string | null): void {
    this.closeSegment()
    // A tool still open at the end of a turn will never finish: agy stopped
    // it (cancel) or moved on. Committed as running it would spin forever,
    // and its later updates are ignored once committed.
    this.commitOpenTools(stopReason === 'cancelled' ? 'cancelled' : 'failed')
    const turnId = this.turnId
    if (this.live && turnId) {
      // turn_stopped before turn_completed, as Hermes does: the fold closes
      // the live turn on it, so the next turn can take the slot
      // (allowReplaceOfLiveTurn is false for this provider).
      this.emit({ type: 'turn_stopped', turnId, stopReason: stopReason ?? 'end_turn' })
      if (stopReason === 'cancelled') {
        this.emit({ type: 'api_error', turnId, message: 'Turn cancelled.', errorType: 'cancelled' })
      } else if (stopReason === 'refusal') {
        this.emit({ type: 'api_error', turnId, message: 'The model refused to continue this turn.', errorType: 'refusal' })
      } else if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
        this.emit({ type: 'api_error', turnId, message: `The turn stopped early (${stopReason}).`, errorType: stopReason })
      }
      this.emit({ type: 'turn_completed', turnId, fullText: this.turnText, confidence: 'high' })
      this.emit({ type: 'stream_phase', turnId, phase: 'idle' })
    }
    this.turnId = null
  }

  /** The prompt request failed outright (auth, quota, transport). */
  failTurn(message: string): void {
    this.closeSegment()
    this.commitOpenTools('failed')
    const turnId = this.turnId
    if (this.live && turnId) {
      this.emit({ type: 'api_error', turnId, message, errorType: 'request-failed' })
      // Without these the live turn stays open in the fold, and with
      // allowReplaceOfLiveTurn false every later turn's events would be
      // dropped: the pane would never stream again (review finding).
      this.emit({ type: 'turn_stopped', turnId, stopReason: 'error' })
      this.emit({ type: 'turn_completed', turnId, fullText: this.turnText, confidence: 'high' })
      this.emit({ type: 'stream_phase', turnId, phase: 'idle' })
    }
    this.turnId = null
  }

  /** Close what is open, e.g. at the end of a replay. */
  flush(): void {
    this.closeSegment()
    this.commitOpenTools()
  }

  apply(update: Record<string, unknown>): void {
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        return this.appendText('user', contentText(update.content), isRecord(update.content) && update.content.type === 'image')
      case 'agent_message_chunk':
        return this.appendText('assistant', contentText(update.content))
      case 'agent_thought_chunk':
        return this.appendText('thought', contentText(update.content))
      case 'tool_call':
      case 'tool_call_update':
        return this.applyTool(update)
      default:
        // plan, available_commands_update, session_info_update,
        // usage_update, current_mode_update: not conversation rows; the
        // session handles the ones it uses.
        return
    }
  }

  private appendText(kind: OpenSegment['kind'], text: string, isImage = false): void {
    if (text.length === 0 && !isImage) return
    if (this.segment?.kind !== kind) {
      this.closeSegment()
      const blockIndex = this.blockCounter++
      const ordinal = this.ordinal++
      this.segment = { kind, ordinal, text: '', blockId: `ag-block-${this.turnCounter}-${blockIndex}`, blockIndex, openedAt: this.stamp(ordinal) }
      if (this.live && this.turnId && kind !== 'user') {
        this.emit({ type: 'block_started', turnId: this.turnId, blockId: this.segment.blockId, blockIndex, kind: kind === 'thought' ? 'reasoning' : 'text' })
        this.emit({ type: 'stream_phase', turnId: this.turnId, phase: kind === 'thought' ? 'thinking' : 'responding' })
      }
    }
    const segment = this.segment!
    if (isImage) segment.includesImage = true
    segment.text += text
    if (!this.live || !this.turnId || kind === 'user') return
    if (kind === 'assistant') {
      this.turnText += text
      this.emit({ type: 'text_delta', turnId: this.turnId, blockId: segment.blockId, blockIndex: segment.blockIndex, textDelta: text, fullText: segment.text, textSoFar: segment.text })
    } else {
      this.emit({ type: 'thinking_delta', turnId: this.turnId, blockId: segment.blockId, blockIndex: segment.blockIndex, textDelta: text, fullText: segment.text, thinkingDelta: text, thinkingSoFar: segment.text })
    }
  }

  private closeSegment(): void {
    const segment = this.segment
    if (!segment) return
    this.segment = null
    if (this.live && this.turnId && segment.kind !== 'user') {
      this.emit({ type: 'block_completed', turnId: this.turnId, blockId: segment.blockId, blockIndex: segment.blockIndex, kind: segment.kind === 'thought' ? 'reasoning' : 'text' })
    }
    // Images may be the entire user prompt. Preserve its turn and ordinal on reload
    // without copying base64 into the UI journal or altering mixed prompts' typed text.
    if (segment.includesImage && !segment.text.trim()) segment.text = '[Image attached]'
    if (segment.text.trim().length === 0) return
    this.sink.row({
      type: 'antigravity-row',
      sessionId: this.sessionId,
      key: `ag:${this.sessionId}:${segment.ordinal}`,
      ordinal: segment.ordinal,
      role: segment.kind,
      text: segment.text,
      timestamp: segment.openedAt,
    })
  }

  private applyTool(update: Record<string, unknown>): void {
    const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : null
    if (!toolCallId) return
    let tool = this.tools.get(toolCallId)
    if (!tool) {
      // A tool call ends the text segment before it, like a new kind does.
      this.closeSegment()
      const blockIndex = this.blockCounter++
      const ordinal = this.ordinal++
      tool = {
        toolCallId,
        name: typeof update.name === 'string' ? update.name : typeof update.title === 'string' ? update.title : 'tool',
        kind: typeof update.kind === 'string' ? update.kind : null,
        title: typeof update.title === 'string' ? update.title : null,
        input: update.rawInput ?? update.args ?? {},
        status: typeof update.status === 'string' ? update.status : 'pending',
        output: null,
        isError: false,
        ordinal,
        blockIndex,
        committed: false,
        openedAt: this.stamp(ordinal),
      }
      this.tools.set(toolCallId, tool)
      if (this.live && this.turnId) {
        const base = { turnId: this.turnId, blockId: toolCallId, blockIndex, toolUseId: toolCallId, toolName: tool.name, name: tool.name }
        this.emit({ type: 'block_started', ...base, kind: 'tool_use' })
        const inputJson = JSON.stringify(tool.input ?? null)
        this.emit({ type: 'tool_input_finalized', ...base, input: tool.input, inputJson, parsed: isRecord(tool.input) ? tool.input : undefined })
        this.emit({ type: 'stream_phase', turnId: this.turnId, phase: 'tool-use' })
      }
    } else {
      if (typeof update.status === 'string') tool.status = update.status
      if (typeof update.title === 'string') tool.title = update.title
      if (update.rawInput !== undefined) tool.input = update.rawInput
    }
    const output = toolOutput(update)
    if (output !== null) tool.output = output
    if (tool.status === 'failed' || tool.status === 'error') tool.isError = true
    if (TERMINAL_TOOL_STATUSES.has(tool.status)) this.commitTool(tool)
  }

  /** Commit every unfinished tool; at a turn's end they are given a final status. */
  private commitOpenTools(finalStatus?: 'cancelled' | 'failed'): void {
    for (const tool of this.tools.values()) {
      if (tool.committed) continue
      if (finalStatus && !TERMINAL_TOOL_STATUSES.has(tool.status)) {
        tool.status = finalStatus
        tool.isError = finalStatus === 'failed'
      }
      this.commitTool(tool)
    }
  }

  private commitTool(tool: OpenTool): void {
    if (tool.committed) return
    tool.committed = true
    if (this.live && this.turnId) {
      if (TERMINAL_TOOL_STATUSES.has(tool.status)) {
        this.emit({ type: 'tool_result', turnId: this.turnId, toolUseId: tool.toolCallId, name: tool.name, content: tool.output ?? '', isError: tool.isError })
      }
      this.emit({ type: 'block_completed', turnId: this.turnId, blockId: tool.toolCallId, blockIndex: tool.blockIndex, kind: 'tool_use', toolName: tool.name, toolUseId: tool.toolCallId })
    }
    const { ordinal, blockIndex: _blockIndex, committed: _committed, openedAt, ...snapshot } = tool
    this.sink.row({
      type: 'antigravity-row',
      sessionId: this.sessionId,
      key: `ag:${this.sessionId}:${ordinal}`,
      ordinal,
      role: 'tool',
      tool: snapshot,
      timestamp: openedAt,
    })
  }

  private emit(event: Record<string, unknown> & { type: string }): void {
    this.sink.semantic({ ...event, source: 'antigravity-acp', ts: this.now() })
  }
}
