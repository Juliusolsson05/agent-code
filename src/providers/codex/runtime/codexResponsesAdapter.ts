import { StringDecoder } from 'string_decoder'
import type { CodexHeadless } from 'codex-headless'
import type { ResponsesProxy } from './responsesProxy.js'

// CodexResponsesAdapter — consumes the raw SSE chunks that
// `ResponsesProxy` emits on its 'event' channel, parses OpenAI
// Responses API events, and publishes them to the CodexHeadless
// SemanticChannel as `source: 'proxy'` turns/deltas.
//
// WHY this lives in cc-shell and not inside codex-headless:
//   codex-headless already has a rollout→semantic translator; the
//   proxy wire is a *separate* semantic source that only exists
//   when cc-shell spins up ResponsesProxy. Keeping the transport
//   adapter next to the proxy (both are cc-shell-owned transport
//   concerns) means the submodule doesn't need to grow a parallel
//   ingestion path for an observer the submodule doesn't own.
//   It also parallels how ClaudeProxyAdapter lives inside the
//   claude-code-headless package only because the Claude adapter
//   needs deep access to that package's internals (mitmproxy
//   framing, flow attribution); the Codex case is much simpler —
//   we just consume the adapter's public semantic channel.
//
// WHY proxy source is preferred when available:
//   The rollout file is high-fidelity but *latent* — Codex writes
//   it after the fact, so the first byte arrives seconds after
//   Codex started producing output. The proxy sees response bytes
//   as they come back from the server, so the semantic live-turn
//   fills in instantly. When both fire, the rollout reducer in
//   CodexHeadless will emit `source_changed` on convergence and
//   defer to whichever source reached the turn first.
//
// Format reference:
//   OpenAI Responses API SSE events, as of 2026-04. Sampled live
//   in scripts/proxy-harness.mts against chatgpt.com/backend-api/codex
//   and api.openai.com/v1/responses. Known event types:
//     response.created
//     response.in_progress
//     response.output_item.added / .done
//     response.content_part.added / .done
//     response.output_text.delta / .done
//     response.reasoning_summary_part.added / .done
//     response.reasoning_summary_text.delta
//     response.reasoning_text.delta
//     response.completed
//     response.failed
//     response.incomplete
//   See codex-src/codex-rs/codex-api/src/sse/responses.rs for the
//   authoritative upstream parser.

type ChunkEvent = {
  kind: 'response-chunk'
  requestId: string
  path: string
  size: number
  chunk: Buffer
}

type StartEvent = {
  kind: 'request'
  requestId: string
  method: string
  path: string
  upstream: string
}

type EndEvent = {
  kind: 'response-end'
  requestId: string
  path: string
  bytes: number
}

// Per-turn state tracked by the adapter. Keyed by the proxy's
// requestId (emitted on every request/response/chunk/end/error event
// for that specific HTTP call). Path-based keying was the old
// approach; it silently merged overlapping retries' bytes into
// whichever flow happened to be most-recent on that path.
type FlowState = {
  flowId: string
  // requestId from the proxy. Responses are routed to this flow by
  // requestId equality, not by path — path is kept only for
  // observability/logging.
  requestId: string
  path: string
  // `response.id` from the upstream, used as our semantic turnId.
  // Falls back to the flow id until response.created arrives.
  responseId: string | null
  // Rolling SSE frame buffer — bytes are chunked arbitrarily.
  buffer: string
  // Incremental UTF-8 decoder. HTTP chunks can split a multi-byte
  // codepoint at any byte boundary (emoji, CJK, box-drawing all come
  // back as ≥2 bytes). An eager `Buffer.toString('utf-8')` per chunk
  // substitutes the split tail with U+FFFD, permanently corrupting
  // the assistant text. `StringDecoder` holds the trailing partial
  // bytes until the next chunk arrives and emits only complete
  // codepoints, so the assistant stream is byte-accurate.
  decoder: StringDecoder
  // Accumulated assistant text across all output_text.delta events.
  fullText: string
  // Block index for the current assistant message output item, if
  // any. Multiple items can exist in one response (message, tool
  // call, reasoning, etc.) but we only surface the message text as
  // the turn's `fullText`.
  messageBlockIndex: number | null
  blocks: Map<string, { index: number; kind: 'text' | 'thinking' | 'tool' }>
  // Whether we've emitted startTurn for this flow yet. Used to
  // avoid publishing deltas before the turn exists.
  turnOpened: boolean
  // Last observed `obfuscation` nonce — noisy, only for debug logs.
  lastObfuscation: string | null
}

export class CodexResponsesAdapter {
  private readonly proxy: ResponsesProxy
  private readonly headless: CodexHeadless
  private readonly flows = new Map<string, FlowState>()
  // Monotonically increasing flow id — not path-derived because
  // the same path fires on every retry and we need stable keys.
  private nextFlowSeq = 1
  private attachedHandler: ((ev: Record<string, unknown>) => void) | null = null

  constructor(proxy: ResponsesProxy, headless: CodexHeadless) {
    this.proxy = proxy
    this.headless = headless
  }

  attach(): void {
    if (this.attachedHandler) return
    this.attachedHandler = ev => {
      try {
        this.onProxyEvent(ev)
      } catch (err) {
        // Adapter failures must NOT crash the proxy pipeline.
        // Log to console and move on; the next chunk usually
        // re-syncs the stream state. If it doesn't, we lose
        // semantic fidelity for this turn but the user still
        // sees raw output via the rollout path.
        console.warn('[CodexResponsesAdapter] parse error:', err)
      }
    }
    this.proxy.on('event', this.attachedHandler)
  }

  detach(): void {
    if (!this.attachedHandler) return
    this.proxy.off('event', this.attachedHandler)
    this.attachedHandler = null
  }

  // Push a raw event onto the semantic channel without going through
  // a typed publisher. Used for synthetic events (flow_selected,
  // chunk-byte tracking) that don't have a dedicated method on the
  // codex-headless SemanticChannel surface — cc-shell's reducer
  // accepts them on the same `event` channel as everything else.
  private publishRawEvent(ev: Record<string, unknown>): void {
    const semantic = this.headless.semantic as unknown as {
      emit: (name: 'event', payload: Record<string, unknown>) => boolean
    }
    semantic.emit('event', ev)
  }

  private onProxyEvent(ev: Record<string, unknown>): void {
    const kind = ev.kind
    // Only /responses POSTs produce semantic events. Skip /models
    // and any other observability events.
    const path = typeof ev.path === 'string' ? ev.path : ''
    if (!path.includes('/responses')) return

    if (kind === 'request') {
      const req = ev as unknown as StartEvent
      if (req.method !== 'POST') return
      // Mint a flow. Don't open a semantic turn yet — we want the
      // real response.id from response.created, not a synthetic id
      // that'd conflict with rollout's later task_started.
      const flowId = `proxy-${this.nextFlowSeq++}`
      this.flows.set(flowId, {
        flowId,
        requestId: req.requestId,
        path: req.path,
        responseId: null,
        buffer: '',
        decoder: new StringDecoder('utf8'),
        fullText: '',
        messageBlockIndex: null,
        blocks: new Map(),
        turnOpened: false,
        lastObfuscation: null,
      })
      // WHY publish a synthetic `flow_selected` to the semantic
      // channel: cc-shell's ProxyDebugPanel reads `runtime.semantic.flows`
      // to render the "flows seen" section. Claude's adapter does
      // this via SemanticChannel.publishFlowSelected; codex-headless's
      // channel doesn't expose flow methods because the rollout path
      // doesn't have flow attribution. Emitting the raw event here
      // bypasses the lack of a typed publisher and lets the same
      // workspaceStore reducer fold it into runtime.semantic.flows
      // identically to Claude. Reason text mirrors the format the
      // panel already knows how to read.
      this.publishRawEvent({
        type: 'flow_selected',
        flowId,
        turnId: null,
        reason: `${req.method} ${req.path}`,
        source: 'proxy',
        confidence: 'high',
        ts: Date.now(),
      })
      return
    }

    if (kind === 'response-chunk') {
      const chunkEv = ev as unknown as ChunkEvent
      const flow = this.findFlowByRequestId(chunkEv.requestId)
      if (!flow) return
      // decoder.write holds any trailing partial multi-byte sequence
      // until the next chunk arrives — see the FlowState.decoder
      // comment for why a plain toString('utf-8') corrupts non-ASCII.
      //
      // Normalize line endings at the boundary: the SSE spec allows
      // \r\n or \n line terminators, and some corporate proxies /
      // TLS-terminating CDNs rewrite the stream with \r\n. The frame
      // splitter below only looks for \n\n, so we canonicalize here
      // (dropping bare \r is safe because SSE field payloads never
      // contain them). Without this, a CRLF upstream emits zero
      // semantic events for an entire turn because `\n\n` never
      // appears in the buffer.
      flow.buffer += flow.decoder.write(chunkEv.chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      this.drainFrames(flow)
      return
    }

    if (kind === 'response-end') {
      const endEv = ev as unknown as EndEvent
      const flow = this.findFlowByRequestId(endEv.requestId)
      if (!flow) return
      // Flush any bytes the decoder was holding back (i.e. a trailing
      // partial sequence that never got its continuation). In healthy
      // streams this is empty; on truncated streams we'd rather see
      // a stray U+FFFD than silently swallow the tail.
      flow.buffer += flow.decoder.end()
      // Best-effort flush — upstream may not send a terminator.
      this.drainFrames(flow)
      // If we got this far without seeing response.completed,
      // close the turn to avoid a dangling in-progress indicator.
      // The rollout source will correct the final text.
      if (flow.turnOpened && flow.responseId) {
        this.headless.semantic.finishTurn({
          turnId: flow.responseId,
          fullText: flow.fullText || undefined,
          source: 'proxy',
          confidence: 'medium',
        })
      }
      this.flows.delete(flow.flowId)
      return
    }

    if (kind === 'response-error' || kind === 'upstream-error') {
      // Treat like an end: seal any open turn so the renderer
      // isn't stuck in "streaming" state, then drop the flow.
      const errReqId = typeof ev.requestId === 'string' ? ev.requestId : ''
      const flow = this.findFlowByRequestId(errReqId)
      if (!flow) return
      if (flow.turnOpened && flow.responseId) {
        this.headless.semantic.finishTurn({
          turnId: flow.responseId,
          fullText: flow.fullText || undefined,
          source: 'proxy',
          confidence: 'fallback',
        })
      }
      this.flows.delete(flow.flowId)
    }
  }

  // Route chunks by requestId. The proxy mints a monotonic requestId
  // per HTTP call and stamps every request/response/chunk/end/error
  // event with it, so overlapping retries to the same path never
  // collide — each retry gets its own requestId and its own flow.
  private findFlowByRequestId(requestId: string): FlowState | null {
    if (!requestId) return null
    for (const flow of this.flows.values()) {
      if (flow.requestId === requestId) return flow
    }
    return null
  }

  // SSE framing: events are separated by blank lines ("\n\n"). A
  // single frame is a sequence of "field: value\n" lines. We only
  // care about the `data:` field(s); `event:` is informational but
  // every OpenAI Responses frame sets `data.type` redundantly, so
  // relying on the JSON payload keeps the parser simpler.
  private drainFrames(flow: FlowState): void {
    let idx = flow.buffer.indexOf('\n\n')
    while (idx >= 0) {
      const frame = flow.buffer.slice(0, idx)
      flow.buffer = flow.buffer.slice(idx + 2)
      this.handleFrame(flow, frame)
      idx = flow.buffer.indexOf('\n\n')
    }
  }

  private handleFrame(flow: FlowState, rawFrame: string): void {
    // Collect all `data:` lines (a frame can have multiple, joined
    // by newlines per the SSE spec). Drop `event:`, `id:`, `retry:`
    // — we don't need them.
    //
    // WHY silently drop data-less frames instead of logging/upgrading
    // them: the OpenAI Responses SSE wire always pairs `event: ...`
    // with a `data: {...}` payload; a frame with only `event:` or
    // only a comment (`: keepalive`) carries no state we can fold
    // into the semantic channel. If upstream ever introduces a
    // data-less signal (e.g. a heartbeat that hints at quota
    // throttling) we'd want to surface it, but until that exists
    // dropping them is the right call — anything else just generates
    // noise in the event log.
    const dataLines: string[] = []
    for (const line of rawFrame.split('\n')) {
      if (line.startsWith('data: ')) dataLines.push(line.slice(6))
      else if (line.startsWith('data:')) dataLines.push(line.slice(5))
    }
    if (dataLines.length === 0) return
    const payload = dataLines.join('\n')
    // The keepalive frame `data: [DONE]` isn't used by Responses
    // SSE (it's a Chat Completions convention) but be defensive.
    if (payload.trim() === '[DONE]') return

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>
    } catch {
      return
    }

    const t = typeof parsed.type === 'string' ? parsed.type : ''
    switch (t) {
      case 'response.created':
      case 'response.in_progress': {
        const response = parsed.response as Record<string, unknown> | undefined
        const id = typeof response?.id === 'string' ? response.id : null
        if (!id) return
        flow.responseId = id
        if (!flow.turnOpened) {
          this.headless.semantic.startTurn({
            turnId: id,
            role: 'assistant',
            source: 'proxy',
            confidence: 'high',
          })
          flow.turnOpened = true
        }
        return
      }

      case 'response.output_item.added': {
        // Track block boundaries so a later adapter (or UI surface)
        // can correlate tool-use / reasoning blocks with their
        // tool_use id. We don't emit block_started here because
        // cc-shell's renderer only reads `task.todos` / tool
        // lookups from the rollout-sourced semantic reducer today.
        const item = parsed.item as Record<string, unknown> | undefined
        const itemId = typeof item?.id === 'string' ? item.id : null
        const itemType = typeof item?.type === 'string' ? item.type : ''
        const outputIndex = typeof parsed.output_index === 'number' ? parsed.output_index : 0
        if (!itemId) return
        if (itemType === 'message') {
          flow.blocks.set(itemId, { index: outputIndex, kind: 'text' })
          if (flow.messageBlockIndex === null) flow.messageBlockIndex = outputIndex
        } else if (itemType === 'reasoning') {
          flow.blocks.set(itemId, { index: outputIndex, kind: 'thinking' })
        } else {
          // tool_use variants: surface as 'tool' for bookkeeping
          flow.blocks.set(itemId, { index: outputIndex, kind: 'tool' })
        }
        return
      }

      case 'response.output_text.delta': {
        if (!flow.turnOpened || !flow.responseId) return
        const delta = typeof parsed.delta === 'string' ? parsed.delta : ''
        if (!delta) return
        flow.fullText += delta
        flow.lastObfuscation =
          typeof parsed.obfuscation === 'string' ? parsed.obfuscation : flow.lastObfuscation
        this.headless.semantic.applyDelta({
          turnId: flow.responseId,
          textDelta: delta,
          fullText: flow.fullText,
          source: 'proxy',
          confidence: 'high',
        })
        return
      }

      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta': {
        // Reasoning deltas aren't merged into `fullText` — they're
        // a separate cognitive track. Not published to the
        // semantic channel as deltas today because the renderer
        // surfaces reasoning only via rollout-sourced tool state.
        // Left here as a hook; adding a `thinking_delta` publish
        // would double-count if rollout also emits it.
        return
      }

      case 'response.completed': {
        if (!flow.responseId) return
        // Final usage is available on response.usage (mirrors
        // claude-code-headless's approach).
        const response = parsed.response as Record<string, unknown> | undefined
        const usage = response?.usage as Record<string, unknown> | undefined
        if (usage) {
          this.headless.semantic.usageUpdated({
            usage: flattenUsage(usage),
            source: 'proxy',
          })
        }
        this.headless.semantic.finishTurn({
          turnId: flow.responseId,
          fullText: flow.fullText || undefined,
          source: 'proxy',
          confidence: 'high',
        })
        flow.turnOpened = false
        return
      }

      case 'response.failed':
      case 'response.incomplete': {
        if (!flow.responseId) return
        this.headless.semantic.finishTurn({
          turnId: flow.responseId,
          fullText: flow.fullText || undefined,
          source: 'proxy',
          confidence: 'fallback',
        })
        flow.turnOpened = false
        return
      }

      default:
        // Unknown event: ignore. Upstream adds new kinds
        // occasionally; we don't want to crash when that happens.
        return
    }
  }
}

function flattenUsage(u: Record<string, unknown>): Record<string, number | string | undefined> {
  const out: Record<string, number | string | undefined> = {}
  for (const [k, v] of Object.entries(u)) {
    if (typeof v === 'number' || typeof v === 'string') out[k] = v
    else if (v && typeof v === 'object') {
      for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) {
        if (typeof cv === 'number' || typeof cv === 'string') out[`${k}.${ck}`] = cv
      }
    }
  }
  return out
}
