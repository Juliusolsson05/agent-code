# Prompt Suggestion Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Claude Code's prompt-suggestion fork calls from leaking into the conversation feed as phantom turns, and instead surface the suggestion as an ephemeral, clickable chip near the composer (issue #174).

**Architecture:** Detect the suggestion call on the wire by a body fingerprint (its last/seed user message is Claude Code's fixed `SUGGESTION_PROMPT`, which begins `[SUGGESTION MODE:`). The mitm addon already buffers and parses every `/v1/messages` request body into `request_shape`; we add one boolean (`prompt_suggestion`) there. The `ClaudeProxyAdapter` consumes it at `message_start`: instead of calling `channel.startTurn` (which is what ghosts the suggestion into the transcript), it routes the flow to a new typed `prompt_suggestion` semantic event carrying the suggestion text. The renderer stores that text on the per-session runtime and renders a chip in the composer; clicking it prefills the draft; it clears on the next turn.

**Tech Stack:** Python (mitmproxy addon), TypeScript (claude-code-headless package + Electron main/renderer), React 18 + Zustand (renderer), Vitest (unit + renderer projects).

---

## Background: why the existing sidecar filter cannot catch this

`ClaudeProxyAdapter.isSidecarFlow` (ClaudeProxyAdapter.ts:1662) demotes auxiliary `/v1/messages` calls (title-gen, compaction, hook agents) using two signals: (1) the response model is Haiku while the session model is not, and (2) the request body has a tiny `max_tokens` + tiny `messageCount`, or a known system-prompt prefix.

The prompt-suggestion fork (`vendor/claude-code-src/full/services/PromptSuggestion/promptSuggestion.ts:294` `generateSuggestion` → `runForkedAgent`) defeats **all** of these. The fork deliberately reuses the parent turn's `cacheSafeParams` — **identical model, identical `tools` array, identical `system`, identical `max_tokens`** — because overriding any of them busts the prompt cache (the source comment at promptSuggestion.ts:308-318 cites PR #18143, a 45× cache-write spike). The ONLY thing that differs from a real turn is one appended user message containing the fixed `SUGGESTION_PROMPT` (promptSuggestion.ts:258-287), and Claude Code marks the fork `skipTranscript: true` (promptSuggestion.ts:328) so it is never written to the rollout JSONL — which is exactly why Agent Code's committed-transcript channel never supersedes it and it lives forever as a phantom.

The fix therefore must key on the one stable wire signal: a user message whose text starts with `[SUGGESTION MODE:`. This mirrors the existing compaction detector (`_detect_compaction_synthesis` in mitmAddon.py:177, which probes the last user message for `Your task is to create a detailed summary`).

**Detection nuance (why we scan ALL user messages, not just the last):** the fork is a full agent loop. If the model attempts a tool, `canUseTool` denies it (promptSuggestion.ts:302) and the loop issues another `/v1/messages` request whose *last* message is now a `tool_result`, not the SUGGESTION_PROMPT. But the SUGGESTION_PROMPT user message is the loop's seed and **remains in the `messages` array** on every request of the fork. So scanning every user message for the `[SUGGESTION MODE:` prefix catches all requests in the fork; a last-message-only check (like compaction) would miss tool-loop continuations and let their text leak. The bracketed sentinel is not something a real user would type, so scanning all user messages carries negligible false-positive risk.

**Out of scope — speculation (documented, deliberate):** `speculation.ts:457` pre-executes the suggested prompt via another fork, but it sends the suggestion **text itself** as the user message (`createUserMessage({ content: suggestionText })`, speculation.ts:458) with `querySource: 'speculation'` — a client-side label that never reaches the wire. A speculation request is therefore byte-indistinguishable from a real user turn in the request body; there is no safe fingerprint. Speculation is gated behind a separate `isSpeculationEnabled()` flag and only runs after a suggestion is generated. We explicitly do not attempt to suppress it here; Task 13 documents the residual risk and a follow-up.

**Codex:** the Codex CLI has no equivalent suggestion API call (confirmed by grepping `vendor/codex-src` — only test fixtures and compaction). #174's "both providers" is Claude-only on the wire today. This plan is Claude-only.

---

## File Structure

**Phase 1 — wire detection + leak suppression (independently shippable):**
- `packages/claude-code-headless/src/proxy/mitmAddon.py` — add `prompt_suggestion` to `request_shape` (Python; detection mirrors compaction).
- `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts` — thread the flag through `ProxyTransportEvent` → `ParsedRequestShape` → `FlowState`; at `message_start`, demote suggestion flows so no `turn_started` is emitted.
- `testing/unit/proxy/promptSuggestionDetection.test.ts` — new unit test (Vitest, node project) covering parse + adapter routing.

**Phase 2 — typed event + renderer store:**
- `packages/claude-code-headless/src/channels/types.ts` — add `SemanticPromptSuggestionEvent` + union member.
- `packages/claude-code-headless/src/channels/SemanticChannel.ts` — add `publishPromptSuggestion`.
- `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts` — capture suggestion text; emit the event at `message_stop`.
- `packages/claude-code-headless/src/proxy/suggestionFilter.ts` — new: pure `shouldFilterSuggestion` port (the source's quality filters).
- `src/renderer/src/workspace/workspaceState.ts` — add `promptSuggestion` field to `SessionRuntime` + `emptyRuntime`.
- `src/renderer/src/workspace/semantic/foldEvent.ts` — handle the `prompt_suggestion` case (it returns the suggestion text up to the caller; see Task 9 for where it lands on the runtime).
- `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts` — write the suggestion text onto the runtime.

**Phase 3 — chip UI:**
- `src/renderer/src/workspace/tile-tree/TileLeaf/PromptSuggestionChip.tsx` — new presentational chip.
- `src/renderer/src/workspace/tile-tree/TileLeaf/ComposerInput.tsx` — mount the chip.
- `src/renderer/src/workspace/tile-tree/TileLeaf.tsx` — pass suggestion + clear-on-submit wiring.

---

## Testing note (read before starting)

The repo established a Vitest stack on 2026-05-22 (commit ceefe67, #263) with three projects: `unit` (node, globs `testing/unit/**/*.test.ts`, `src/**/*.test.ts`, `packages/**/*.test.ts`), `integration`, and `renderer` (happy-dom, globs `src/**/*.renderer.test.ts(x)`, `testing/renderer/**`). This plan is written TDD-first against that stack. The mitm addon is Python and is **not** covered by Vitest; we verify the addon's one-line change by unit-testing the TypeScript fallback (`parseRequestBody`), which mirrors the addon's detection byte-for-byte, plus a manual decode step (Task 2 Step 6). Do not introduce a pytest harness for one boolean.

Run commands used throughout:
- Unit: `npm run test:unit -- <path>`
- Renderer: `npm run test:renderer -- <path>`
- Typecheck: `npm run -s build:app` is heavy; prefer `npx tsc -p tsconfig.node.json --noEmit` for the package and `npx tsc -p tsconfig.web.json --noEmit` for the renderer.

---

## Phase 1 — Wire detection + leak suppression

### Task 1: Addon — detect the suggestion fingerprint in `request_shape`

**Files:**
- Modify: `packages/claude-code-headless/src/proxy/mitmAddon.py` (add constant + helper near `_detect_compaction_synthesis` ~line 177; add field in `_extract_request_shape` return ~line 367)

- [ ] **Step 1: Add the sentinel constant and detector**

After `_COMPACT_MESSAGE_PROBE_CHARS` (mitmAddon.py:132), add:

```python
# Signature for Claude Code's prompt-suggestion fork.
#
# When prompt suggestions are enabled (vendor services/PromptSuggestion/
# promptSuggestion.ts), Claude Code issues an internal /v1/messages call
# whose conversation is the FULL parent turn (cache-safe — identical
# model/tools/system/max_tokens) PLUS one appended user message carrying
# the fixed SUGGESTION_PROMPT. That prompt opens with this exact bracketed
# sentinel (promptSuggestion.ts:258). Because the fork reuses the parent's
# cache params, NONE of the title-gen/compaction discriminators
# (max_tokens, tools_count, system prefix) differ from a real turn — this
# seed user message is the only wire signal.
#
# Unlike compaction (last-message-only), we scan EVERY user message: the
# fork is an agent loop, and on a tool-denied retry the last message is a
# tool_result while the SUGGESTION_PROMPT remains earlier in the array as
# the loop seed. Scanning all user messages catches every request in the
# fork. The sentinel is not something a real user types, so a full scan is
# false-positive-safe.
_SUGGESTION_PROMPT_SENTINEL = "[SUGGESTION MODE:"


def _detect_prompt_suggestion(messages):
    """True iff any user-role message's text starts with the suggestion
    sentinel. Tolerant: returns False on any non-list / non-string shape."""
    if not isinstance(messages, list):
        return False
    for msg in messages:
        if not isinstance(msg, dict) or msg.get("role") != "user":
            continue
        content = msg.get("content")
        text = None
        if isinstance(content, str):
            text = content
        elif isinstance(content, list) and content:
            first = content[0]
            if isinstance(first, dict) and isinstance(first.get("text"), str):
                text = first["text"]
        if isinstance(text, str) and text.lstrip().startswith(
            _SUGGESTION_PROMPT_SENTINEL
        ):
            return True
    return False
```

- [ ] **Step 2: Call the detector and add the field to `_extract_request_shape`**

In `_extract_request_shape`, after the `compaction_synthesis = _detect_compaction_synthesis(messages)` line (mitmAddon.py:365), add:

```python
    prompt_suggestion = _detect_prompt_suggestion(messages)
```

Then add the field to the returned dict (mitmAddon.py:367-377), after `"compaction_synthesis": compaction_synthesis,`:

```python
        "prompt_suggestion": prompt_suggestion,
```

- [ ] **Step 3: Manually verify against a real captured body**

There is no Python test harness; verify by decoding a real suggestion body if one exists, else confirm the detector logic against the sentinel. Run:

```bash
python3 - <<'PY'
import sys; sys.path.insert(0, 'packages/claude-code-headless/src/proxy')
import mitmAddon as m
# Real turn: no sentinel
assert m._detect_prompt_suggestion([{"role":"user","content":"fix the bug"}]) is False
# Suggestion seed message (string content)
assert m._detect_prompt_suggestion([{"role":"user","content":"[SUGGESTION MODE: Suggest..."}]) is True
# Suggestion in tool-loop continuation (sentinel earlier, tool_result last)
assert m._detect_prompt_suggestion([
    {"role":"user","content":"[SUGGESTION MODE: ..."},
    {"role":"assistant","content":[{"type":"tool_use"}]},
    {"role":"user","content":[{"type":"tool_result","text":"denied"}]},
]) is True
# Block-array content form
assert m._detect_prompt_suggestion([{"role":"user","content":[{"type":"text","text":"[SUGGESTION MODE: x"}]}]) is True
# Tolerant of junk
assert m._detect_prompt_suggestion("nope") is False
print("addon detector OK")
PY
```

Expected: prints `addon detector OK` with no assertion error.

- [ ] **Step 4: Commit**

```bash
git add packages/claude-code-headless/src/proxy/mitmAddon.py
git commit -m "feat(proxy): detect prompt-suggestion fork in request_shape"
```

---

### Task 2: Adapter — thread `prompt_suggestion` through the type layer

**Files:**
- Modify: `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts` (transport type ~line 127; `ParsedRequestShape` ~line 328; `normalizeRequestShape` ~line 1545; `parseRequestBody` ~line 1627)
- Test: `testing/unit/proxy/promptSuggestionDetection.test.ts` (new)

- [ ] **Step 1: Write the failing test (parse layer)**

Create `testing/unit/proxy/promptSuggestionDetection.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { ClaudeProxyAdapter } from '@claude-code-headless/proxy/ClaudeProxyAdapter'

// parseRequestBody is private; we exercise it through the public request
// path by feeding a base64 body and reading the resulting routing decision
// in later tasks. For this task we assert the pre-extracted request_shape
// path sets isPromptSuggestion via a tiny exported helper-free probe:
// construct a body and confirm a suggestion-shaped request is NOT promoted
// to a turn (full assertion lands in Task 3). Here we lock the shape
// parsing by round-tripping a known body through the adapter's normalize
// path using a request event with request_shape.

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
}

describe('prompt-suggestion request shape', () => {
  it('flags a body whose seed user message is the SUGGESTION_PROMPT', () => {
    // Asserted end-to-end in Task 3 (no turn_started). This test pins the
    // base64 fallback path: a suggestion body must parse without throwing
    // and carry the messages array intact.
    const body = b64({
      model: 'claude-opus-4-8',
      max_tokens: 64000,
      tools: new Array(10).fill({ name: 'Bash' }),
      system: [{ type: 'text', text: 'You are Claude Code' }],
      messages: [
        { role: 'user', content: 'fix the bug' },
        { role: 'assistant', content: 'done' },
        { role: 'user', content: '[SUGGESTION MODE: Suggest what the user...' },
      ],
    })
    expect(typeof body).toBe('string')
    expect(body.length).toBeGreaterThan(0)
  })
})
```

> Note: the import alias `@claude-code-headless/*` must resolve in Vitest. Verify with `grep -n "claude-code-headless" vitest.config.ts tsconfig*.json`; if no alias exists, import via the relative path `../../../packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts` instead. Adjust the import line accordingly before running.

- [ ] **Step 2: Run it to confirm the harness resolves**

Run: `npm run test:unit -- testing/unit/proxy/promptSuggestionDetection.test.ts`
Expected: PASS (this step only verifies imports/harness; the real assertions arrive in Task 3). If the import path fails to resolve, fix the import per the note above and re-run.

- [ ] **Step 3: Add `prompt_suggestion` to the transport type**

In `ProxyTransportEvent.request_shape` (ClaudeProxyAdapter.ts:127), after the `compaction_synthesis?: boolean | null` field, add:

```ts
    /** Renderer-relevant: true when ANY user message in the body starts
     *  with Claude Code's `[SUGGESTION MODE:` sentinel — i.e. this flow is
     *  the prompt-suggestion fork (see `_detect_prompt_suggestion` in
     *  mitmAddon.py). Unlike the sidecar signals this is model-/tools-
     *  independent because the fork reuses the parent's cache params; the
     *  seed user message is the only wire tell. Threaded to
     *  `ParsedRequestShape.isPromptSuggestion` and consumed at
     *  message_start to route the flow OUT of the visible turn stream. */
    prompt_suggestion?: boolean | null
```

- [ ] **Step 4: Add `isPromptSuggestion` to `ParsedRequestShape`**

In `ParsedRequestShape` (ClaudeProxyAdapter.ts:328), after `isCompactionSynthesis: boolean`, add:

```ts
  /** True when the request body is Claude Code's prompt-suggestion fork.
   *  Forwarded from the addon's `request_shape.prompt_suggestion`, with the
   *  legacy `parseRequestBody` path computing the same bit inline. Read by
   *  the message_start handler to route the flow to a `prompt_suggestion`
   *  semantic event instead of `startTurn`. Distinct from the sidecar
   *  predicate: a suggestion fork runs on the user's PRIMARY model with the
   *  full tools array, so isSidecarFlow can never catch it. */
  isPromptSuggestion: boolean
```

- [ ] **Step 5: Compute it in both parse paths**

In `normalizeRequestShape` (ClaudeProxyAdapter.ts:1544-1547), change the return to compute and include the flag:

```ts
    const rawCompaction = obj.compaction_synthesis
    const isCompactionSynthesis = rawCompaction === true
    const isPromptSuggestion = obj.prompt_suggestion === true

    return { maxTokens, messageCount, systemPrefixes, isCompactionSynthesis, isPromptSuggestion }
```

In `parseRequestBody` (ClaudeProxyAdapter.ts:1610-1627), after the compaction block and before the return, add the inline scan, then include it in the return:

```ts
    // Prompt-suggestion sniff for the legacy body_b64 path. Mirrors
    // `_detect_prompt_suggestion` in mitmAddon.py. We scan EVERY user
    // message (not just the last like compaction) because the fork's
    // tool-denied retries push a tool_result to the last slot while the
    // SUGGESTION_PROMPT seed stays earlier in the array.
    let isPromptSuggestion = false
    if (messages) {
      for (const m of messages) {
        const rec = asRecord(m)
        if (rec?.role !== 'user') continue
        let text: string | null = null
        if (typeof rec.content === 'string') {
          text = rec.content
        } else if (Array.isArray(rec.content) && rec.content.length > 0) {
          text = textFromUnknownBlock(rec.content[0])
        }
        if (text && text.trimStart().startsWith('[SUGGESTION MODE:')) {
          isPromptSuggestion = true
          break
        }
      }
    }

    return { maxTokens, messageCount, systemPrefixes, isCompactionSynthesis, isPromptSuggestion }
```

- [ ] **Step 6: Typecheck and run**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors (the two `ParsedRequestShape` constructions both now include `isPromptSuggestion`; if tsc reports a missing property anywhere else that builds a `ParsedRequestShape`, add `isPromptSuggestion: false` there).

Run: `npm run test:unit -- testing/unit/proxy/promptSuggestionDetection.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts testing/unit/proxy/promptSuggestionDetection.test.ts
git commit -m "feat(proxy): thread prompt_suggestion flag through ParsedRequestShape"
```

---

### Task 3: Adapter — suppress the leak at `message_start`

**Files:**
- Modify: `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts` (`FlowState` ~line 357; `onRequest` init ~line 655; `message_start` branch ~line 993)
- Test: `testing/unit/proxy/promptSuggestionDetection.test.ts`

- [ ] **Step 1: Write the failing test (no turn for a suggestion flow)**

Append to `testing/unit/proxy/promptSuggestionDetection.test.ts`. This drives the adapter with a synthetic SSE stream for a suggestion-shaped request and asserts NO `turn_started` reaches the channel. Use the existing test helpers if the repo has them; otherwise a minimal fake channel:

```ts
import { ClaudeProxyAdapter } from '@claude-code-headless/proxy/ClaudeProxyAdapter'
import type { SemanticEvent } from '@claude-code-headless/channels/types'

function makeAdapter(events: SemanticEvent[]) {
  // Minimal channel double: capture every published event.
  const channel = {
    startTurn: (p: any) => events.push({ type: 'turn_started', ...p } as any),
    applyDelta: () => {},
    finishTurn: () => {},
    publishBlockStarted: () => {},
    publishTextDelta: () => {},
    publishThinkingDelta: () => {},
    publishSignature: () => {},
    publishConnectorTextDelta: () => {},
    publishCitationsDelta: () => {},
    publishToolInputDelta: () => {},
    publishToolInputFinalized: () => {},
    publishBlockCompleted: () => {},
    publishToolResult: () => {},
    publishTurnStopped: () => {},
    publishUsageUpdated: () => {},
    publishStreamError: () => {},
    publishApiError: () => {},
    publishFlowSelected: () => {},
    publishFlowIgnored: (p: any) => events.push({ type: 'flow_ignored', ...p } as any),
    publishStreamPhase: () => {},
  } as any
  return new ClaudeProxyAdapter({ channel, getSessionModel: () => 'claude-opus-4-8' })
}

// SSE frame helper. message_start carries the model; one text block;
// message_stop closes it.
function sse(model: string, text: string): string {
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_sugg', model, usage: {} } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ].join('')
}

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
}

it('does NOT emit turn_started for a prompt-suggestion flow', () => {
  const events: SemanticEvent[] = []
  const adapter = makeAdapter(events)
  const flow_id = 111
  const suggestionBody = b64({
    model: 'claude-opus-4-8',
    max_tokens: 64000,
    tools: new Array(10).fill({ name: 'Bash' }),
    system: [{ type: 'text', text: 'You are Claude Code' }],
    messages: [
      { role: 'user', content: 'fix the bug' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: '[SUGGESTION MODE: Suggest what the user might type' },
    ],
  })
  adapter.handleTransportEvent({ kind: 'request', flow_id, path: '/v1/messages', body_b64: suggestionBody } as any)
  const stream = sse('claude-opus-4-8', 'run the tests')
  adapter.handleTransportEvent({ kind: 'response-chunk', flow_id, path: '/v1/messages', chunk_b64: Buffer.from(stream).toString('base64') } as any)
  adapter.handleTransportEvent({ kind: 'response-end', flow_id, path: '/v1/messages' } as any)

  expect(events.find(e => e.type === 'turn_started')).toBeUndefined()
})

it('DOES emit turn_started for a normal turn (regression guard)', () => {
  const events: SemanticEvent[] = []
  const adapter = makeAdapter(events)
  const flow_id = 222
  const normalBody = b64({
    model: 'claude-opus-4-8',
    max_tokens: 64000,
    tools: new Array(10).fill({ name: 'Bash' }),
    system: [{ type: 'text', text: 'You are Claude Code' }],
    messages: [{ role: 'user', content: 'fix the bug' }],
  })
  adapter.handleTransportEvent({ kind: 'request', flow_id, path: '/v1/messages', body_b64: normalBody } as any)
  const stream = sse('claude-opus-4-8', 'Working on it')
  adapter.handleTransportEvent({ kind: 'response-chunk', flow_id, path: '/v1/messages', chunk_b64: Buffer.from(stream).toString('base64') } as any)
  adapter.handleTransportEvent({ kind: 'response-end', flow_id, path: '/v1/messages' } as any)

  expect(events.find(e => e.type === 'turn_started')).toBeDefined()
})
```

> If the repo already has an adapter test with a richer channel mock or SSE helper (search `testing/` and `packages/claude-code-headless` for existing `ClaudeProxyAdapter` tests), reuse it instead of the inline doubles above to stay DRY.

- [ ] **Step 2: Run to verify the suppression test FAILS**

Run: `npm run test:unit -- testing/unit/proxy/promptSuggestionDetection.test.ts`
Expected: the "does NOT emit turn_started" test FAILS (today a suggestion flow IS promoted to a turn). The regression guard passes.

- [ ] **Step 3: Add the FlowState fields**

In `FlowState` (ClaudeProxyAdapter.ts:357, near `requestShape`), add:

```ts
  /** True once message_start confirmed this flow is the prompt-suggestion
   *  fork (requestShape.isPromptSuggestion). When set, the flow is kept OUT
   *  of the visible turn stream — no startTurn, no text deltas to the feed.
   *  Phase 2 uses this flag to accumulate the suggestion text and emit a
   *  `prompt_suggestion` event at message_stop. */
  isPromptSuggestionFlow: boolean
  /** Accumulated assistant text for a suggestion flow (Phase 2). Empty for
   *  every normal flow. */
  promptSuggestionText: string
```

- [ ] **Step 4: Initialize them in `onRequest`**

In the `FlowState` object literal inside `onRequest` (ClaudeProxyAdapter.ts:655-665, where `requestShape: null` is set), add:

```ts
      isPromptSuggestionFlow: false,
      promptSuggestionText: '',
```

- [ ] **Step 5: Route suggestion flows in the `message_start` branch**

In `applyAnthropicEvent`'s `message_start` case, insert this block **immediately before** the `if (isActive && this.isSidecarFlow(state, ev.model)) {` check (ClaudeProxyAdapter.ts:993). Placing it before isSidecarFlow matters: the suggestion fork would NOT match isSidecarFlow anyway, but routing it explicitly keeps the demotion reason accurate.

```ts
        // Prompt-suggestion routing. The fork reuses the parent's cache
        // params (same model/tools/system/max_tokens), so isSidecarFlow
        // can't see it — the only tell is requestShape.isPromptSuggestion,
        // sniffed from the seed user message at request time. We keep the
        // flow OUT of the visible turn stream: clear the spinner we emitted
        // on first-chunk, flip to 'secondary' so every later text_delta /
        // message_stop falls through the isActive gates, and record the
        // flag. Phase 2 will additionally capture the streamed text and
        // emit a `prompt_suggestion` event here. We do NOT call startTurn —
        // that call is what ghosts the suggestion into the transcript
        // (#174), and Claude Code marks the fork skipTranscript so the
        // committed channel never supersedes it.
        if (isActive && state.requestShape?.isPromptSuggestion === true) {
          state.isPromptSuggestionFlow = true
          this.publishPhase(state, 'idle')
          state.attribution = 'secondary'
          this.channel.publishFlowIgnored({
            flowId: state.flowId,
            reason: 'prompt_suggestion',
            source,
            confidence,
          })
          this.onDiagnostic(
            `flow ${state.flowId} routed as prompt_suggestion (model=${ev.model})`,
          )
          return
        }
```

- [ ] **Step 6: Run to verify both tests pass**

Run: `npm run test:unit -- testing/unit/proxy/promptSuggestionDetection.test.ts`
Expected: PASS — no `turn_started` for the suggestion flow; the normal-turn regression guard still emits one.

- [ ] **Step 7: Typecheck**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts testing/unit/proxy/promptSuggestionDetection.test.ts
git commit -m "fix(proxy): keep prompt-suggestion forks out of the feed (#174)"
```

**Phase 1 is now independently shippable: prompt suggestions no longer pollute the transcript or semantic history.**

---

## Phase 2 — Typed event + renderer store

### Task 4: Port the source's suggestion quality filter

The fork's output can be meta-noise ("silence", "nothing to suggest"), evaluative ("looks good"), Claude-voice ("Let me…"), too long, etc. The vendored source filters these in `shouldFilterSuggestion` (promptSuggestion.ts:354). We port a compact, faithful subset as a pure function so the adapter only emits real suggestions.

**Files:**
- Create: `packages/claude-code-headless/src/proxy/suggestionFilter.ts`
- Test: `packages/claude-code-headless/src/proxy/suggestionFilter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/claude-code-headless/src/proxy/suggestionFilter.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { shouldFilterSuggestion } from './suggestionFilter'

describe('shouldFilterSuggestion', () => {
  it('keeps a real short suggestion', () => {
    expect(shouldFilterSuggestion('run the tests')).toBe(false)
    expect(shouldFilterSuggestion('commit this')).toBe(false)
    expect(shouldFilterSuggestion('yes')).toBe(false) // allowed single word
    expect(shouldFilterSuggestion('/compact')).toBe(false) // slash command
  })
  it('drops empty / meta / silence', () => {
    expect(shouldFilterSuggestion('')).toBe(true)
    expect(shouldFilterSuggestion('   ')).toBe(true)
    expect(shouldFilterSuggestion('silence')).toBe(true)
    expect(shouldFilterSuggestion('(silence — nothing obvious)')).toBe(true)
    expect(shouldFilterSuggestion('no suggestion')).toBe(true)
  })
  it('drops evaluative / claude-voice / formatted / over-long', () => {
    expect(shouldFilterSuggestion('looks good')).toBe(true)
    expect(shouldFilterSuggestion("Let me run the tests")).toBe(true)
    expect(shouldFilterSuggestion('do this.\nThen that')).toBe(true)
    expect(shouldFilterSuggestion('a '.repeat(60))).toBe(true) // too many words
    expect(shouldFilterSuggestion('x'.repeat(120))).toBe(true) // too long
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit -- packages/claude-code-headless/src/proxy/suggestionFilter.test.ts`
Expected: FAIL with "Cannot find module './suggestionFilter'".

- [ ] **Step 3: Implement the filter**

Create `packages/claude-code-headless/src/proxy/suggestionFilter.ts`:

```ts
// Faithful, compact port of `shouldFilterSuggestion` from Claude Code's
// vendored source (vendor/claude-code-src/full/services/PromptSuggestion/
// promptSuggestion.ts:354). The fork's raw text output is frequently
// meta-noise the user never wants to see as a chip ("silence", "nothing to
// suggest"), evaluative ("looks good"), Claude-voice ("Let me…"), formatted,
// or too long. We reproduce the source's filters so our chip shows exactly
// what Claude Code itself would have shown. Kept as a pure function with no
// adapter/channel deps so it unit-tests trivially and the adapter stays thin.
//
// Returns TRUE when the suggestion should be DROPPED (not shown).

const ALLOWED_SINGLE_WORDS = new Set([
  'yes', 'yeah', 'yep', 'yea', 'yup', 'sure', 'ok', 'okay',
  'push', 'commit', 'deploy', 'stop', 'continue', 'check', 'exit', 'quit',
  'no',
])

export function shouldFilterSuggestion(raw: string | null | undefined): boolean {
  if (!raw) return true
  const suggestion = raw.trim()
  if (!suggestion) return true

  const lower = suggestion.toLowerCase()
  const wordCount = suggestion.split(/\s+/).length

  if (lower === 'done') return true
  if (
    lower === 'nothing found' ||
    lower === 'nothing found.' ||
    lower.startsWith('nothing to suggest') ||
    lower.startsWith('no suggestion') ||
    /\bsilence is\b|\bstay(s|ing)? silent\b/.test(lower) ||
    /^\W*silence\W*$/.test(lower)
  ) return true
  // Meta wrapped in parens/brackets.
  if (/^\(.*\)$|^\[.*\]$/.test(suggestion)) return true
  if (
    lower.startsWith('api error:') ||
    lower.startsWith('prompt is too long') ||
    lower.startsWith('request timed out') ||
    lower.startsWith('invalid api key') ||
    lower.startsWith('image was too large')
  ) return true
  // "Label: value" preface.
  if (/^\w+:\s/.test(suggestion)) return true
  // Too few words (allow slash commands + known single-word actions).
  if (wordCount < 2 && !suggestion.startsWith('/') && !ALLOWED_SINGLE_WORDS.has(lower)) {
    return true
  }
  if (wordCount > 12) return true
  if (suggestion.length >= 100) return true
  if (/[.!?]\s+[A-Z]/.test(suggestion)) return true // multiple sentences
  if (/[\n*]|\*\*/.test(suggestion)) return true // formatting
  if (/thanks|thank you|looks good|sounds good|that works|that worked|that's all|nice|great|perfect|makes sense|awesome|excellent/.test(lower)) {
    return true
  }
  if (/^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly)/i.test(suggestion)) {
    return true
  }
  return false
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit -- packages/claude-code-headless/src/proxy/suggestionFilter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code-headless/src/proxy/suggestionFilter.ts packages/claude-code-headless/src/proxy/suggestionFilter.test.ts
git commit -m "feat(proxy): port Claude Code's suggestion quality filter"
```

---

### Task 5: Add the `SemanticPromptSuggestionEvent` type

**Files:**
- Modify: `packages/claude-code-headless/src/channels/types.ts` (new leaf type near `SemanticFlowIgnoredEvent` ~line 582; union ~line 709)

- [ ] **Step 1: Add the leaf type**

After `SemanticFlowIgnoredEvent` (types.ts:591), add:

```ts
/** A prompt-suggestion the model offered for the user's NEXT input. This is
 *  NOT a conversation turn — it is an ephemeral, clickable hint surfaced by
 *  the renderer near the composer and discarded when the next real turn
 *  starts. Emitted by ClaudeProxyAdapter when it detects Claude Code's
 *  prompt-suggestion fork (see ParsedRequestShape.isPromptSuggestion) and
 *  the streamed text survives `shouldFilterSuggestion`. It must never be
 *  folded into the turn/feed history. */
export type SemanticPromptSuggestionEvent = {
  type: 'prompt_suggestion'
  /** The flow that produced it (diagnostics / dedupe). */
  flowId: string
  /** Anthropic message id of the suggestion flow (diagnostics only). */
  turnId: string | null
  /** The suggestion text, trimmed and already passed through
   *  shouldFilterSuggestion. Non-empty by construction. */
  text: string
  source: SemanticSource
  confidence: SemanticConfidence
  ts: number
}
```

- [ ] **Step 2: Add it to the union**

In the `SemanticEvent` union (types.ts:709), add the member after `SemanticFlowIgnoredEvent`:

```ts
  | SemanticPromptSuggestionEvent
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/claude-code-headless/src/channels/types.ts
git commit -m "feat(channels): add SemanticPromptSuggestionEvent type"
```

---

### Task 6: Add `publishPromptSuggestion` to SemanticChannel

**Files:**
- Modify: `packages/claude-code-headless/src/channels/SemanticChannel.ts` (import ~line 3; new method near `publishFlowIgnored` ~line 752)

- [ ] **Step 1: Write the failing test**

Create `packages/claude-code-headless/src/channels/SemanticChannel.promptSuggestion.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SemanticChannel } from './SemanticChannel'
import type { SemanticEvent } from './types'

describe('publishPromptSuggestion', () => {
  it('emits a prompt_suggestion event on both named and catch-all channels', () => {
    const channel = new SemanticChannel()
    const named: SemanticEvent[] = []
    const all: SemanticEvent[] = []
    channel.on('prompt_suggestion', e => named.push(e))
    channel.on('event', e => all.push(e))

    channel.publishPromptSuggestion({
      flowId: 'flow-1',
      turnId: 'msg_1',
      text: 'run the tests',
      source: 'proxy',
    })

    expect(named).toHaveLength(1)
    expect(all).toHaveLength(1)
    expect(named[0]).toMatchObject({ type: 'prompt_suggestion', text: 'run the tests', flowId: 'flow-1' })
    expect(typeof (named[0] as any).ts).toBe('number')
  })
})
```

> Verify the constructor signature: open SemanticChannel.ts and confirm `new SemanticChannel()` takes no required args (the existing tests/usages in the package will show the real signature — match them). Adjust the construction line if needed.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit -- packages/claude-code-headless/src/channels/SemanticChannel.promptSuggestion.test.ts`
Expected: FAIL with "publishPromptSuggestion is not a function".

- [ ] **Step 3: Import the type**

In SemanticChannel.ts, add `SemanticPromptSuggestionEvent` to the existing import from `./types.js` (match the file's import style — it imports the other `Semantic*Event` types there).

- [ ] **Step 4: Add the method**

After `publishFlowIgnored` (SemanticChannel.ts:752-768), mirroring its exact shape:

```ts
  /** Publish an ephemeral prompt suggestion. See
   *  SemanticPromptSuggestionEvent — this is deliberately NOT a turn and
   *  must never be folded into history. Emitted to both the named channel
   *  and the catch-all `event` emitter so the IPC forwarder picks it up. */
  publishPromptSuggestion(params: {
    flowId: string
    turnId: string | null
    text: string
    source: SemanticSource
    confidence?: SemanticConfidence
  }): void {
    const ev: SemanticPromptSuggestionEvent = {
      type: 'prompt_suggestion',
      flowId: params.flowId,
      turnId: params.turnId,
      text: params.text,
      source: params.source,
      confidence: params.confidence ?? this.defaultConfidence(params.source),
      ts: Date.now(),
    }
    this.emit('prompt_suggestion', ev)
    this.emit('event', ev)
  }
```

> `this.defaultConfidence(params.source)` is the same helper `publishTextDelta`/`publishFlowIgnored` use (SemanticChannel.ts). Confirm its name by grepping the file; if it differs, match it.

- [ ] **Step 5: Run to verify it passes**

Run: `npm run test:unit -- packages/claude-code-headless/src/channels/SemanticChannel.promptSuggestion.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/claude-code-headless/src/channels/SemanticChannel.ts packages/claude-code-headless/src/channels/SemanticChannel.promptSuggestion.test.ts
git commit -m "feat(channels): add publishPromptSuggestion"
```

---

### Task 7: Adapter — capture text and emit the event

**Files:**
- Modify: `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts` (text accumulation in the text-delta path; emit in the `message_stop` case)
- Test: `testing/unit/proxy/promptSuggestionDetection.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `testing/unit/proxy/promptSuggestionDetection.test.ts`. Extend the fake channel in `makeAdapter` to capture `publishPromptSuggestion`:

```ts
// In makeAdapter's channel double, replace the no-op with a capture:
//   publishPromptSuggestion: (p: any) => events.push({ type: 'prompt_suggestion', ...p } as any),

it('emits a prompt_suggestion event with the streamed text', () => {
  const events: SemanticEvent[] = []
  const adapter = makeAdapter(events) // ensure the double captures publishPromptSuggestion
  const flow_id = 333
  const suggestionBody = b64({
    model: 'claude-opus-4-8', max_tokens: 64000,
    tools: new Array(10).fill({ name: 'Bash' }),
    system: [{ type: 'text', text: 'You are Claude Code' }],
    messages: [
      { role: 'user', content: 'fix the bug' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: '[SUGGESTION MODE: Suggest...' },
    ],
  })
  adapter.handleTransportEvent({ kind: 'request', flow_id, path: '/v1/messages', body_b64: suggestionBody } as any)
  const stream = sse('claude-opus-4-8', 'run the tests')
  adapter.handleTransportEvent({ kind: 'response-chunk', flow_id, path: '/v1/messages', chunk_b64: Buffer.from(stream).toString('base64') } as any)
  adapter.handleTransportEvent({ kind: 'response-end', flow_id, path: '/v1/messages' } as any)

  const ev = events.find(e => e.type === 'prompt_suggestion') as any
  expect(ev).toBeDefined()
  expect(ev.text).toBe('run the tests')
  expect(events.find(e => e.type === 'turn_started')).toBeUndefined()
})

it('does NOT emit a prompt_suggestion when the text is filtered noise', () => {
  const events: SemanticEvent[] = []
  const adapter = makeAdapter(events)
  const flow_id = 444
  const suggestionBody = b64({
    model: 'claude-opus-4-8', max_tokens: 64000,
    tools: new Array(10).fill({ name: 'Bash' }),
    system: [{ type: 'text', text: 'You are Claude Code' }],
    messages: [{ role: 'user', content: '[SUGGESTION MODE: ...' }],
  })
  adapter.handleTransportEvent({ kind: 'request', flow_id, path: '/v1/messages', body_b64: suggestionBody } as any)
  const stream = sse('claude-opus-4-8', 'silence')
  adapter.handleTransportEvent({ kind: 'response-chunk', flow_id, path: '/v1/messages', chunk_b64: Buffer.from(stream).toString('base64') } as any)
  adapter.handleTransportEvent({ kind: 'response-end', flow_id, path: '/v1/messages' } as any)

  expect(events.find(e => e.type === 'prompt_suggestion')).toBeUndefined()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit -- testing/unit/proxy/promptSuggestionDetection.test.ts`
Expected: the two new tests FAIL (no `prompt_suggestion` event emitted yet).

- [ ] **Step 3: Accumulate suggestion text**

Find where assistant text deltas update `state.fullText` in `applyAnthropicEvent` (search the file for `state.fullText +=` or the `text_delta` handling inside the `content_block_delta` case). Immediately where `fullText` is appended, add an unconditional accumulation for suggestion flows **before** the `isActive` gate that would otherwise drop it:

```ts
        // Suggestion flows are 'secondary' (so they never publish to the
        // feed), but we still need their text. Accumulate it here,
        // independent of the isActive gate that suppresses feed events.
        if (state.isPromptSuggestionFlow) {
          state.promptSuggestionText += textDelta // use the same delta var the surrounding code uses
        }
```

> Use the exact local variable that the surrounding code already extracted for the text delta (likely `textDelta` or `ev.delta.text` / `delta.text`). Match it; do not introduce a new decode.

- [ ] **Step 4: Emit at message_stop**

Add a `prompt_suggestion`-flow branch to the `message_stop` case of `applyAnthropicEvent`. Find the `case 'message_stop':` block; at its top, before the normal `isActive`-gated finish logic, add:

```ts
        if (state.isPromptSuggestionFlow) {
          // Emit the captured suggestion if it survives the same quality
          // filter Claude Code itself applies (shouldFilterSuggestion). We
          // intentionally do this at message_stop, not on each delta, so the
          // chip only appears once the suggestion is complete. No startTurn
          // ran, so there is nothing to finish here.
          const text = state.promptSuggestionText.trim()
          if (!shouldFilterSuggestion(text)) {
            this.channel.publishPromptSuggestion({
              flowId: state.flowId,
              turnId: state.turnId,
              text,
              source,
            })
          }
          return
        }
```

Add the import at the top of ClaudeProxyAdapter.ts:

```ts
import { shouldFilterSuggestion } from './suggestionFilter.js'
```

- [ ] **Step 5: Run to verify all adapter tests pass**

Run: `npm run test:unit -- testing/unit/proxy/promptSuggestionDetection.test.ts`
Expected: PASS — real suggestion emits the event with text `run the tests`; noise (`silence`) emits nothing; normal turn still emits `turn_started`; suggestion never emits `turn_started`.

- [ ] **Step 6: Typecheck + full package unit run**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Run: `npm run test:unit -- packages/claude-code-headless`
Expected: no type errors; all package unit tests pass (regression guard for the existing sidecar/compaction tests).

- [ ] **Step 7: Commit**

```bash
git add packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts testing/unit/proxy/promptSuggestionDetection.test.ts
git commit -m "feat(proxy): emit prompt_suggestion semantic event from the fork stream"
```

---

### Task 8: Renderer — add `promptSuggestion` to SessionRuntime

**Files:**
- Modify: `src/renderer/src/workspace/workspaceState.ts` (`SessionRuntime` type ~line 320 near `draftInput`; `emptyRuntime()` ~line 567)

- [ ] **Step 1: Add the field to the type**

In the `SessionRuntime` type, next to `draftInput: string` (workspaceState.ts:320), add:

```ts
  /** Ephemeral next-prompt suggestion offered by the model (issue #174).
   *  Lives on the per-session runtime (not a global uiShell slice) because
   *  each pane has its own suggestion and it must survive tab switches.
   *  Set from the `prompt_suggestion` semantic event; cleared when the next
   *  turn starts or the user submits. Never persisted, never part of the
   *  feed/history. */
  promptSuggestion: { text: string; receivedAt: number } | null
```

- [ ] **Step 2: Initialize it in `emptyRuntime`**

In `emptyRuntime()` (workspaceState.ts:567, next to `draftInput: ''`), add:

```ts
    promptSuggestion: null,
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: no errors (no consumers yet — this is purely additive).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/workspace/workspaceState.ts
git commit -m "feat(workspace): add ephemeral promptSuggestion to SessionRuntime"
```

---

### Task 9: Renderer — write the suggestion onto the runtime + clear on next turn

The `prompt_suggestion` event must NOT enter `foldSemanticEvent`'s turn/history state (that is exactly the leak we're avoiding). Instead we handle it in the IPC subscription where the event lands, writing it to the per-session runtime, and we clear it when a new `turn_started` arrives.

**Files:**
- Modify: `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts` (semantic-event handler ~line 670)
- Modify: `src/renderer/src/workspace/semantic/foldEvent.ts` (add an explicit no-op `case 'prompt_suggestion'` so the reducer never logs it as unknown)
- Test: `src/renderer/src/workspace/hook/ipc/promptSuggestion.renderer.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/workspace/hook/ipc/promptSuggestion.renderer.test.ts`. Test the small pure reducer we will extract (`applyPromptSuggestionToRuntime`) so we don't need to boot the whole IPC layer:

```ts
import { describe, it, expect } from 'vitest'
import { applyPromptSuggestionToRuntime } from './applyPromptSuggestionToRuntime'
import { emptyRuntime } from '@renderer/workspace/workspaceState'

describe('applyPromptSuggestionToRuntime', () => {
  it('stores suggestion text on the runtime', () => {
    const rt = emptyRuntime()
    const next = applyPromptSuggestionToRuntime(rt, { type: 'prompt_suggestion', text: 'run the tests', ts: 5 } as any)
    expect(next.promptSuggestion).toEqual({ text: 'run the tests', receivedAt: 5 })
  })
  it('clears suggestion when a turn starts', () => {
    const rt = { ...emptyRuntime(), promptSuggestion: { text: 'x', receivedAt: 1 } }
    const next = clearPromptSuggestionOnTurnStart(rt)
    expect(next.promptSuggestion).toBeNull()
  })
})

// import at top:
import { clearPromptSuggestionOnTurnStart } from './applyPromptSuggestionToRuntime'
```

> Confirm the `@renderer` path alias resolves in the renderer Vitest project (`grep -n "@renderer" vitest.config.ts tsconfig.web.json`). If not, use a relative import to `workspaceState`.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:renderer -- src/renderer/src/workspace/hook/ipc/promptSuggestion.renderer.test.ts`
Expected: FAIL with "Cannot find module './applyPromptSuggestionToRuntime'".

- [ ] **Step 3: Implement the pure helpers**

Create `src/renderer/src/workspace/hook/ipc/applyPromptSuggestionToRuntime.ts`:

```ts
import type { SessionRuntime } from '@renderer/workspace/workspaceState'

// The prompt_suggestion event is deliberately kept OUT of foldSemanticEvent
// (it is not a turn and must never enter history). These two pure helpers
// own the only state it touches: a single ephemeral field on the per-session
// runtime. Splitting them out keeps useIpcSubscriptions thin and makes the
// behaviour unit-testable without booting IPC.

export function applyPromptSuggestionToRuntime(
  runtime: SessionRuntime,
  ev: { text?: unknown; ts?: unknown },
): SessionRuntime {
  const text = typeof ev.text === 'string' ? ev.text.trim() : ''
  if (!text) return runtime
  const receivedAt = typeof ev.ts === 'number' ? ev.ts : 0
  return { ...runtime, promptSuggestion: { text, receivedAt } }
}

// Clear the ephemeral suggestion the moment a new turn begins — a suggestion
// is an offer about the NEXT input, so once the conversation moves on it is
// stale. Called from the turn_started path in the IPC handler.
export function clearPromptSuggestionOnTurnStart(runtime: SessionRuntime): SessionRuntime {
  if (!runtime.promptSuggestion) return runtime
  return { ...runtime, promptSuggestion: null }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:renderer -- src/renderer/src/workspace/hook/ipc/promptSuggestion.renderer.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the helpers into the IPC handler**

In `useIpcSubscriptions.ts`, in the `setRuntimes` updater for `semantic-event` (around line 670-681), branch on the event type BEFORE the generic `foldSemanticEvent` call:

```ts
    const eventType = typeof semanticEvent.type === 'string' ? semanticEvent.type : ''
    if (eventType === 'prompt_suggestion') {
      // Not a turn — never folded into semantic history. Write only the
      // ephemeral runtime field.
      const updated = applyPromptSuggestionToRuntime(current, semanticEvent as any)
      return { ...prev, [sessionId]: updated }
    }
    const nextSemantic = foldSemanticEvent(current.semantic, semanticEvent, sessionKind)
    // ...existing logic...
    // In the same updater, when eventType === 'turn_started', also clear any
    // stale suggestion:
    const cleared = eventType === 'turn_started'
      ? clearPromptSuggestionOnTurnStart(current)
      : current
    // ...merge `cleared.promptSuggestion` into the returned runtime...
```

> The exact merge depends on how `useIpcSubscriptions` currently composes the returned runtime object (it already spreads `current` and overwrites `semantic`). Add `promptSuggestion: cleared.promptSuggestion` to the returned runtime object in the non-suggestion path so the clear-on-turn-start takes effect. Add the import:

```ts
import { applyPromptSuggestionToRuntime, clearPromptSuggestionOnTurnStart } from '@renderer/workspace/hook/ipc/applyPromptSuggestionToRuntime'
```

- [ ] **Step 6: Add a no-op case in foldEvent (defensive)**

In `foldEvent.ts` (the `switch (t)` around line 184), add — so a `prompt_suggestion` event that ever reaches the reducer is explicitly ignored rather than landing in the debug "unknown event" log:

```ts
      case 'prompt_suggestion':
        // Handled out-of-band in useIpcSubscriptions (writes the ephemeral
        // runtime field). Never a turn — do not touch semantic state.
        return state
```

- [ ] **Step 7: Typecheck + run renderer tests**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Run: `npm run test:renderer -- src/renderer/src/workspace`
Expected: no type errors; tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/workspace/hook/ipc/applyPromptSuggestionToRuntime.ts src/renderer/src/workspace/hook/ipc/promptSuggestion.renderer.test.ts src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts src/renderer/src/workspace/semantic/foldEvent.ts
git commit -m "feat(workspace): route prompt_suggestion to ephemeral runtime state"
```

---

## Phase 3 — Chip UI

### Task 10: The chip component

**Files:**
- Create: `src/renderer/src/workspace/tile-tree/TileLeaf/PromptSuggestionChip.tsx`
- Test: `src/renderer/src/workspace/tile-tree/TileLeaf/PromptSuggestionChip.renderer.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/workspace/tile-tree/TileLeaf/PromptSuggestionChip.renderer.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PromptSuggestionChip } from './PromptSuggestionChip'

describe('PromptSuggestionChip', () => {
  it('renders nothing when text is empty', () => {
    const { container } = render(<PromptSuggestionChip text="" onApply={() => {}} onDismiss={() => {}} />)
    expect(container.firstChild).toBeNull()
  })
  it('shows the suggestion and calls onApply on click', () => {
    const onApply = vi.fn()
    render(<PromptSuggestionChip text="run the tests" onApply={onApply} onDismiss={() => {}} />)
    fireEvent.click(screen.getByText('run the tests'))
    expect(onApply).toHaveBeenCalledWith('run the tests')
  })
  it('calls onDismiss on the dismiss control', () => {
    const onDismiss = vi.fn()
    render(<PromptSuggestionChip text="commit this" onApply={() => {}} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByLabelText('Dismiss suggestion'))
    expect(onDismiss).toHaveBeenCalled()
  })
})
```

> Confirm `@testing-library/react` is available (`grep -n "@testing-library/react" package.json`). The renderer setup file is `testing/setup/renderer.ts` (per vitest.config.ts:117) — if testing-library is not yet a dep, the renderer project will need it; check first and, if absent, raise it before proceeding rather than adding a dep silently.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:renderer -- src/renderer/src/workspace/tile-tree/TileLeaf/PromptSuggestionChip.renderer.test.tsx`
Expected: FAIL with "Cannot find module './PromptSuggestionChip'".

- [ ] **Step 3: Implement the chip**

Create `src/renderer/src/workspace/tile-tree/TileLeaf/PromptSuggestionChip.tsx`. Match the existing styling vocabulary used in `ComposerInput.tsx`/`DebugBundleNotePrompt.tsx` (tokens like `text-ink`, `text-muted`, `border-border`, `bg-surface`, `font-code`):

```tsx
type Props = {
  text: string
  /** Apply the suggestion — prefill the composer draft with this text. */
  onApply: (text: string) => void
  /** Dismiss without applying. */
  onDismiss: () => void
}

// Ephemeral next-prompt suggestion chip (issue #174). Deliberately visually
// distinct from a chat row — it is an OFFER about what to type next, not a
// message. Clicking the body prefills the composer; the ✕ dismisses it. The
// parent (ComposerInput) owns when it renders and clears it on submit / next
// turn, so this component is pure-presentational and renders nothing for an
// empty suggestion.
export function PromptSuggestionChip({ text, onApply, onDismiss }: Props) {
  if (!text) return null
  return (
    <div className="flex items-center gap-1 px-2 pb-1">
      <button
        type="button"
        onClick={() => onApply(text)}
        className="
          flex items-center gap-1.5 max-w-full truncate
          px-2 py-1 text-[11px] font-code text-ink-dim
          border border-border bg-surface
          hover:text-ink hover:border-border-hi
        "
        title="Use this suggestion"
      >
        <span className="text-muted">↵</span>
        <span className="truncate">{text}</span>
      </button>
      <button
        type="button"
        aria-label="Dismiss suggestion"
        onClick={onDismiss}
        className="px-1 text-[11px] text-muted hover:text-ink"
      >
        ✕
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:renderer -- src/renderer/src/workspace/tile-tree/TileLeaf/PromptSuggestionChip.renderer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/workspace/tile-tree/TileLeaf/PromptSuggestionChip.tsx src/renderer/src/workspace/tile-tree/TileLeaf/PromptSuggestionChip.renderer.test.tsx
git commit -m "feat(workspace): add PromptSuggestionChip component"
```

---

### Task 11: Mount the chip in the composer

**Files:**
- Modify: `src/renderer/src/workspace/tile-tree/TileLeaf/ComposerInput.tsx` (add props + render the chip above the textarea, ~line 113-192)
- Modify: `src/renderer/src/workspace/tile-tree/TileLeaf.tsx` (pass `promptSuggestion`, `onApplySuggestion`, `onDismissSuggestion` to ComposerInput ~line 498-517; clear on submit ~line 177-198)

- [ ] **Step 1: Add props to ComposerInput**

In `ComposerInput.tsx`, extend the props type with:

```ts
  /** Ephemeral suggestion text for this pane (issue #174), or null. */
  promptSuggestion: string | null
  /** Prefill the draft with the suggestion and clear it. */
  onApplySuggestion: (text: string) => void
  /** Clear the suggestion without applying. */
  onDismissSuggestion: () => void
```

- [ ] **Step 2: Render the chip**

Import at the top: `import { PromptSuggestionChip } from './PromptSuggestionChip'`. Inside the `.relative` wrapper that holds the textarea (ComposerInput.tsx:113), render the chip immediately ABOVE the textarea:

```tsx
        {promptSuggestion ? (
          <PromptSuggestionChip
            text={promptSuggestion}
            onApply={onApplySuggestion}
            onDismiss={onDismissSuggestion}
          />
        ) : null}
```

- [ ] **Step 3: Wire from TileLeaf**

In `TileLeaf.tsx`, where `ComposerInput` is rendered (~line 498-517), pass:

```tsx
          promptSuggestion={runtime.promptSuggestion?.text ?? null}
          onApplySuggestion={text => {
            // Prefill the draft and clear the suggestion. We do NOT auto-send
            // — the user reviews/edits before submitting, matching the issue's
            // "clickable suggestion chips" (prefill) acceptance criterion.
            setDraftInput(sessionId, text)
            workspace.updateRuntime(sessionId, { promptSuggestion: null })
          }}
          onDismissSuggestion={() => workspace.updateRuntime(sessionId, { promptSuggestion: null })}
```

> Confirm the per-session runtime mutator name. The Explore map shows `workspace.updateRuntime(sessionId, partial)` and `setDraftInput(sessionId, next)` (TileLeaf.tsx:111-113). Verify both exist on the `workspace` object (grep `useWorkspace`/`workspace.updateRuntime` in `src/renderer/src/workspace/hook/`); if the mutator is named differently (e.g. `setRuntimePartial`), match it.

- [ ] **Step 4: Clear on submit**

In TileLeaf's `send()` path (TileLeaf.tsx:177-198), after the prompt is dispatched, clear the suggestion so a stale chip never lingers post-send:

```ts
    workspace.updateRuntime(sessionId, { promptSuggestion: null })
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Manual smoke (renderer)**

There is no DOM test for TileLeaf wiring (it pulls the whole workspace hook). Verify by reading the diff: chip renders when `runtime.promptSuggestion` is set, clicking prefills `draftInput`, dismiss/submit/next-turn all clear it. Confirm no TypeScript or lint errors:

Run: `npx eslint src/renderer/src/workspace/tile-tree/TileLeaf/ComposerInput.tsx src/renderer/src/workspace/tile-tree/TileLeaf.tsx`
Expected: clean (or only pre-existing warnings).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/workspace/tile-tree/TileLeaf/ComposerInput.tsx src/renderer/src/workspace/tile-tree/TileLeaf.tsx
git commit -m "feat(workspace): show prompt suggestion chip in the composer (#174)"
```

---

### Task 12: End-to-end verification in the real app

**Files:** none (verification only)

- [ ] **Step 1: Enable suggestions and run the app**

Prompt suggestions are gated in Claude Code by the growthbook flag `tengu_chomp_inflection` + interactive mode + `assistantTurnCount >= 2` + warm parent cache (promptSuggestion.ts:37-94, 141-156). Force-enable with the env override and launch:

```bash
CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1 npm run dev
```

- [ ] **Step 2: Reproduce and confirm**

In a Claude pane: send a first prompt, let it complete, send a second prompt, let it complete (the feature needs ≥2 assistant turns). Then idle. Confirm:
- A suggestion chip appears near the composer (not a feed row).
- The suggestion text does NOT appear as a phantom assistant message in the feed.
- Clicking the chip prefills the composer draft.
- Starting another turn (or submitting) clears the chip.

- [ ] **Step 3: Confirm the leak is gone via a fresh debug bundle**

Run the "Save Debug Logs" command on the pane, then check the bundle's `render-diagnostics.json` and `proxy-semantic.json` contain no suggestion text as a committed/semantic turn, and `proxy-events.jsonl` shows the suggestion request flagged. Quick check:

```bash
python3 -c "
import json,glob,os
b=sorted(glob.glob(os.path.expanduser('~/.config/agent-code/debug-bundles/manual/*')))[-1]
print('bundle:', b)
ev=open(b+'/proxy-events.jsonl').read()
print('has prompt_suggestion in request_shape:', '\"prompt_suggestion\": true' in ev)
print('suggestion leaked into render-diagnostics:', 'SUGGESTION MODE' in open(b+'/render-diagnostics.json').read())
"
```

Expected: `has prompt_suggestion in request_shape: True`, `suggestion leaked ...: False`.

- [ ] **Step 4: Run the full unit + renderer suites**

Run: `npm run test:unit && npm run test:renderer`
Expected: all pass.

---

### Task 13: Document the speculation residual risk

**Files:**
- Modify: `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts` (extend the comment block above the new `message_start` suggestion branch)

- [ ] **Step 1: Add the residual-risk note**

Append to the comment block introduced in Task 3 Step 5:

```ts
        // KNOWN GAP — speculation. Claude Code can pre-execute the suggested
        // prompt (vendor .../PromptSuggestion/speculation.ts) via another
        // skipTranscript fork. That fork sends the suggestion TEXT itself as
        // the user message (speculation.ts:458) with a client-side
        // querySource:'speculation' that never reaches the wire — so its
        // request body is byte-indistinguishable from a real user turn and
        // we cannot detect it here. It is gated behind a separate
        // isSpeculationEnabled() flag. If a speculation fork streams while no
        // real turn holds the active lock, its output can still leak as a
        // phantom turn. Catching it would require a response-side or
        // lock-timing heuristic; tracked as follow-up, out of scope for #174.
```

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors.

```bash
git add packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts
git commit -m "docs(proxy): note speculation-fork residual leak risk"
```

---

## Self-Review

**Spec coverage (#174 acceptance criteria):**
- "Parsed into a dedicated, typed channel — not the feed/turn stream" → Tasks 1-3 (detection + suppression), Task 5-7 (`prompt_suggestion` event). ✓
- "Render as a distinct, clearly-not-a-message suggestion affordance (chips) the user can click" → Tasks 10-11 (chip, prefill on click). ✓
- "Ephemeral: never committed to transcript/semantic history, clear when next turn starts" → Task 3 (no startTurn), Task 9 (out-of-band runtime field + clear on turn_started), Task 11 (clear on submit). ✓
- "Works for both providers" → Investigation proved Codex has no equivalent wire call; documented as Claude-only (Background section). Partial-by-reality, explicitly scoped. ✓ (flagged)

**Placeholder scan:** No TBD/TODO/"handle edge cases" — every code step has concrete code. Two steps deliberately say "match the existing variable/mutator name" (Task 7 Step 3 text-delta var; Task 11 Step 3 mutator) because those are local symbols the executor must read off the current file; each names exactly what to look for and the fallback. These are verification instructions, not placeholders.

**Type consistency:** `ParsedRequestShape.isPromptSuggestion` (Task 2) is read in Task 3 Step 5 and never renamed. `FlowState.isPromptSuggestionFlow` / `promptSuggestionText` (Task 3) are consumed in Task 7. `SemanticPromptSuggestionEvent` fields (`flowId`, `turnId`, `text`, `source`, `confidence`, `ts`, Task 5) match `publishPromptSuggestion` params (Task 6) and the adapter call site (Task 7 Step 4). Runtime field `promptSuggestion: { text; receivedAt }` (Task 8) matches the helper writes (Task 9) and the chip read `runtime.promptSuggestion?.text` (Task 11). `shouldFilterSuggestion` signature (Task 4) matches both call sites (Task 7 Step 4 adapter, internal). ✓

**Open verification points the executor must confirm against live code (each has a fallback in-step):** Vitest path aliases (`@claude-code-headless`, `@renderer`); `SemanticChannel` constructor signature + `defaultConfidence` helper name; the text-delta local variable in `applyAnthropicEvent`; `workspace.updateRuntime` / `setDraftInput` names; `@testing-library/react` availability.
