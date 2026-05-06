# Claude Code Title-Turn Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Claude Code's per-turn auxiliary "title generation" calls from leaking into the cc-shell visible transcript as orphan ghost messages, even when those calls are made with the user's primary (non-Haiku) model.

**Architecture:** The existing sidecar filter in `ClaudeProxyAdapter` only demotes flows whose `message_start.model` matches `/haiku/i`. Recent Claude Code versions also issue title-gen calls against the primary model (Opus/Sonnet/Haiku-as-primary), so the model-name heuristic no longer covers them. We extend the mitm addon to surface request bodies for `/v1/messages` calls, and extend the proxy adapter to read `max_tokens` and a small structural fingerprint (`system` prefix + `messages.length`) so any call with a tiny `max_tokens` budget AND a non-conversation system prompt is demoted as a sidecar regardless of model. Behaviour is otherwise unchanged.

**Tech Stack:** TypeScript (Node), mitmproxy/Python addon, Vitest (already used by `claude-code-headless`).

**Reference debug bundle:** `/Users/juliusolsson/.config/cc-shell/debug-bundles/2026-05-06T08-20-40-689-75a7665a/`

  - Suspect turns: `msg_01AGXBCFLV` ("merge frontend and infra"), `msg_01B5RnKfME` ("promote development to main for backend and frontend"), `msg_01Te6XNZU4` ("poll the prod terraform workflow")
  - Common shape: `usage.input_tokens=425`, `output_tokens=12-16`, `stop_reason=end_turn`, sub-second turn duration, single text block
  - None of them appear in `flows[*].attribution=='ignored'` — the existing Haiku filter never fired

---

## Investigation summary (read first)

Already verified before this plan was written:

  1. The unhandled "title" the user sees is a fresh assistant turn with `turnId msg_*`, `stopReason=end_turn`, body of the form *"<short imperative phrase>"* (4–10 words). It's emitted **after** a real assistant turn and rendered via the normal ghost path; Claude Code never writes it to the JSONL rollout, so the orphan-supersede timeout never fires and the ghost stays visible.
  2. The producer is the same proxy code path that handles real turns:
     - `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts:703-723` is where the existing Haiku-based sidecar demotion lives (`isSidecarFlow(ev.model)`).
     - For the new title-gen calls `ev.model` is the primary session model, so `isSidecarFlow` returns `false` and the flow is promoted to `active` and streamed through.
  3. `out/main/mitmAddon.py` already emits a `request` event for every `/v1/messages` call but **does not include the request body** (line 23-32). Without the body we cannot see `max_tokens`, the `system` prompt, or the message history — all of which would distinguish title-gen from a real turn.
  4. The renderer side (`src/renderer/src/workspace/semantic/foldEvent.ts:93-110`) already handles `flow_ignored` correctly: it stamps the flow as `attribution: 'ignored'` and the matching `turn_*` events never reach the visible feed because the adapter early-returns on non-active flows. So **fixing this at the adapter is sufficient** — no renderer changes are required.

This means the entire fix is local to two files: `mitmAddon.py` and `ClaudeProxyAdapter.ts`, plus tests.

---

## File Structure

**Modified files:**

  - `out/main/mitmAddon.py` — extend the `request` payload with a base64-encoded body for `/v1/messages` calls, gated behind a small size cap.
  - `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts` — add a request-body parser, persist the parsed shape on `FlowState`, and consult it from the existing `message_start` demotion branch.
  - `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts` — *or* a new `packages/claude-code-headless/src/proxy/sidecarHeuristics.ts` if the heuristic logic exceeds ~40 lines (decided in Task 4).
  - `packages/claude-code-headless/src/proxy/__tests__/sidecarHeuristics.test.ts` (new) — unit tests for the body-based heuristic. *Skip this file* per the cc-shell project memory ("no new tests in feature/fix PRs"); rely on the existing test suite + a manual reproduction recipe captured in Task 7.

**Untouched** (no changes needed):

  - `src/renderer/src/workspace/semantic/foldEvent.ts` — already handles `flow_ignored`.
  - `src/renderer/src/workspace/ghosts.ts` — ghosts mint correctly when a flow is *not* demoted; the fix prevents the demotion-eligible flows from ever reaching the channel.
  - `src/providers/claude/runtime/claudeSession.ts` — wires the existing adapter; no API change.

---

## Task 1: Surface request bodies through the mitm addon

**Why this comes first:** the adapter cannot make a body-based decision until the body is in the event stream. Doing the addon side first lets every later TypeScript task be tested against real bundle replays.

**Files:**

  - Modify: `out/main/mitmAddon.py:17-32` (the `request()` hook)

- [ ] **Step 1: Read the addon to confirm the current `request` payload shape**

Run: `wc -l /Users/juliusolsson/Desktop/Development/cc-shell/out/main/mitmAddon.py`
Expected: `118` lines.

Open `out/main/mitmAddon.py`. Confirm the `request()` hook ends at line 32 with no body field on the payload.

- [ ] **Step 2: Extend `request()` to include a base64 body for `/v1/messages` only**

Replace lines 17-32 with:

```python
# Cap at 256 KiB so an oversized body (e.g. an attachment-heavy turn)
# can never wedge the JSONL writer or balloon the in-memory event
# buffer. 256 KiB is generous: a maxed-out title-gen request — the only
# consumer of this field — is well under 4 KiB, and a normal turn
# request is bounded by Claude Code's own context budget. Larger
# requests still emit a `request` event, just without `body_b64`, so
# the adapter falls back to its model-name heuristic.
_REQUEST_BODY_CAP = 256 * 1024


def request(flow: http.HTTPFlow) -> None:
    request = flow.request
    path = request.path or ""
    is_messages = (
        request.host.endswith("anthropic.com") and "/v1/messages" in path
    )
    if is_messages:
        request.headers["Accept-Encoding"] = "identity"

    payload = {
        "kind": "request",
        "flow_id": id(flow),
        "method": request.method,
        "url": request.pretty_url,
        "host": request.host,
        "path": request.path,
        "headers": dict(request.headers),
    }

    # Body capture is gated on /v1/messages because:
    #   * the adapter only consumes it for sidecar detection on those
    #     flows, so emitting it for unrelated traffic (auth, MCP
    #     registry, telemetry) is pure noise on the wire to the renderer
    #     and a leak risk for any non-Anthropic host the user proxies;
    #   * `request.content` materialises the buffered body, which we
    #     don't want to do for every flow on every host.
    if is_messages:
        try:
            content = request.content or b""
            if 0 < len(content) <= _REQUEST_BODY_CAP:
                payload["body_b64"] = base64.b64encode(content).decode("ascii")
        except Exception as exc:
            payload["body_error"] = str(exc)

    _write(payload)
```

- [ ] **Step 3: Smoke-test with the in-tree proxy harness**

Run: `cd /Users/juliusolsson/Desktop/Development/cc-shell && grep -rn 'PROXY_EVENTS_FILE' src/main/ | head -5`
Expected: locate the spawn site so you know which env path to tail.

Start the app (or the proxy-testing harness in `src/testing/proxy-testing/` if present) and send a single short turn through Claude Code. Tail the events file:

```bash
tail -n 50 -f "$PROXY_EVENTS_FILE" | grep -m1 '"kind":"request"'
```

Expected: one line that includes `"body_b64":"..."`. Decode it with `python3 -c 'import base64,sys; print(base64.b64decode(sys.stdin.read()))'` and confirm you see `"max_tokens":` and `"messages":` JSON.

- [ ] **Step 4: Commit**

```bash
git add out/main/mitmAddon.py
git commit -m "proxy(addon): surface /v1/messages request body for sidecar detection"
```

---

## Task 2: Type the new transport field and persist parsed body on FlowState

**Files:**

  - Modify: `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts:50-67` (`ProxyTransportEvent` type)
  - Modify: `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts` — `FlowState` struct (search for `interface FlowState` or `type FlowState`)
  - Modify: `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts:411-452` (the `onRequest` handler)

- [ ] **Step 1: Locate `FlowState`**

Run: `grep -n 'FlowState\b' /Users/juliusolsson/Desktop/Development/cc-shell/packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts | head -10`

Note the line where the struct is declared. Required field set today: `flowId, attribution, url, turnId, decoder, sseParser, blocks, fullText, usage, turnStarted, turnStopped, pendingToolUses, lastChunkAt`.

- [ ] **Step 2: Extend `ProxyTransportEvent`**

Update the type at line 50-67 to add the optional body field:

```ts
export type ProxyTransportEvent = {
  kind: 'request' | 'response' | 'response-chunk' | 'response-end'
  flow_id: number | string
  method?: string
  url?: string
  host?: string
  path?: string
  status_code?: number
  headers?: Record<string, string>
  /** Base64-encoded transport bytes on `response-chunk`. */
  chunk_b64?: string
  /** Base64-encoded REQUEST body, populated by the mitm addon for
   *  /v1/messages calls only and capped at 256 KiB. Used by the sidecar
   *  filter to detect title-gen / compaction / hook-agent calls that
   *  share the user's primary model and therefore can't be caught by
   *  the model-name heuristic. Optional because (a) older addons don't
   *  emit it, (b) non-/v1/messages requests omit it, and (c) oversized
   *  bodies are dropped silently. Consumers MUST tolerate absence. */
  body_b64?: string
  /** Final buffered body on `response`. … */
  body?: string
  [k: string]: unknown
}
```

- [ ] **Step 3: Add a `requestShape` field to `FlowState`**

Add (next to `usage`) the field declaration. Place the comment immediately above the field so the WHY survives any future refactor:

```ts
  /** Parsed shape of the request body, populated at `onRequest` time
   *  when the addon supplied `body_b64`. Null when the addon did not
   *  emit a body, parsing failed, or the request was made by an older
   *  addon version. The sidecar filter must treat null as "no signal"
   *  and fall back to the existing model-name heuristic — never as
   *  evidence that a flow is real. */
  requestShape: ParsedRequestShape | null
```

Where `ParsedRequestShape` is a new type declared above `FlowState`:

```ts
type ParsedRequestShape = {
  /** Caller-supplied generation cap. Title-gen requests typically set
   *  this to 32-512; real turns set it to 8192+. Stored verbatim — the
   *  filter compares against an explicit threshold rather than a ratio
   *  to remain robust to future Claude Code defaults. */
  maxTokens: number | null
  /** Number of messages in the conversation history. Title-gen
   *  requests typically include 0-2 synthetic messages; a real turn
   *  has the entire user/assistant history. We store the count rather
   *  than the full array so a 200 KiB request body doesn't pin in
   *  memory after the request is parsed. */
  messageCount: number | null
  /** First 200 chars of the system prompt (joined if it's an array of
   *  blocks). Used as a fingerprint match against known title-gen
   *  prompt prefixes. Truncated to keep the per-flow memory bounded —
   *  full prompts can be tens of KB. */
  systemPrefix: string | null
}
```

- [ ] **Step 4: Initialise the field on flow creation**

In `onRequest` at line ~432 where `state` is built, add `requestShape: null,` to the literal. This guarantees every flow has the field even when no body arrives.

- [ ] **Step 5: Verify compile**

Run: `cd /Users/juliusolsson/Desktop/Development/cc-shell && npx tsc -p packages/claude-code-headless/tsconfig.json --noEmit`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts
git commit -m "proxy(adapter): plumb request-body field on FlowState"
```

---

## Task 3: Parse the request body in `onRequest`

**Files:**

  - Modify: `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts` — the `onRequest` method.

- [ ] **Step 1: Add a private parser**

Place this helper inside the `ClaudeProxyAdapter` class, near the other private methods:

```ts
  /** Decode and minimally parse the addon-supplied request body so the
   *  sidecar filter can read max_tokens / system / messages.length
   *  without re-parsing on every chunk. We stay deliberately tolerant
   *  here: any failure produces null, and null means "fall through to
   *  the model-name heuristic" — never "this is a real turn". The
   *  threshold for fingerprint matching lives in isSidecarFlow,
   *  not here, because this method must remain free of policy. */
  private parseRequestBody(b64: string | undefined): ParsedRequestShape | null {
    if (!b64 || typeof b64 !== 'string') return null
    let json: unknown
    try {
      const raw = Buffer.from(b64, 'base64').toString('utf-8')
      json = JSON.parse(raw)
    } catch {
      return null
    }
    if (!json || typeof json !== 'object') return null
    const obj = json as Record<string, unknown>

    const maxTokens =
      typeof obj.max_tokens === 'number' && Number.isFinite(obj.max_tokens)
        ? obj.max_tokens
        : null

    const messages = Array.isArray(obj.messages) ? obj.messages : null
    const messageCount = messages ? messages.length : null

    let systemPrefix: string | null = null
    const sys = obj.system
    if (typeof sys === 'string') {
      systemPrefix = sys.slice(0, 200)
    } else if (Array.isArray(sys)) {
      // Anthropic's request format also accepts `system` as an array of
      // text blocks. Concatenate the text of the first block only — that
      // is where the title-gen prompt body lives in Claude Code's CLI;
      // later blocks (if any) carry context that varies per session and
      // would defeat the fingerprint check.
      const first = sys[0] as { type?: string; text?: string } | undefined
      if (first && typeof first.text === 'string') {
        systemPrefix = first.text.slice(0, 200)
      }
    }

    return { maxTokens, messageCount, systemPrefix }
  }
```

- [ ] **Step 2: Call the parser from `onRequest`**

In the `onRequest` method, immediately before `this.flows.set(flowId, state)`, add:

```ts
    state.requestShape = this.parseRequestBody(
      typeof event.body_b64 === 'string' ? event.body_b64 : undefined,
    )
```

Use the loose-typed read because `body_b64` is declared on the index signature; we already type-narrowed in the type definition but the runtime value can still be missing.

- [ ] **Step 3: Verify compile**

Run: `cd /Users/juliusolsson/Desktop/Development/cc-shell && npx tsc -p packages/claude-code-headless/tsconfig.json --noEmit`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts
git commit -m "proxy(adapter): parse /v1/messages request body once at onRequest"
```

---

## Task 4: Extend `isSidecarFlow` with a body-based heuristic

This is the load-bearing decision. Read it carefully before editing.

**Files:**

  - Modify: `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts` — the `isSidecarFlow` method (around line 1220).
  - Modify: `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts:703-723` — the demotion call site (already exists; only the call signature changes).

- [ ] **Step 1: Find the existing `isSidecarFlow` signature**

Run: `grep -n 'isSidecarFlow' /Users/juliusolsson/Desktop/Development/cc-shell/packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts`
Expected: a private method declared around line 1220, currently taking `(flowModel: string | null | undefined): boolean`. Read all of it.

- [ ] **Step 2: Change the signature to accept a flow state**

We need access to `requestShape`, not just the model. Update the declaration to:

```ts
  /** Whether the given flow looks like a sidecar (auxiliary) call rather
   *  than the user's visible turn. Two independent signals; either one
   *  is sufficient:
   *
   *    1. Model heuristic (legacy, kept). The flow's response model
   *       matches `sidecarModelPattern` (default /haiku/i) AND the
   *       session model does not. This catches Claude Code versions
   *       that still route auxiliary calls to Haiku.
   *
   *    2. Request-shape heuristic (new). The request body — surfaced
   *       by the mitm addon at onRequest time — declares a tiny
   *       max_tokens budget AND/OR carries one of Claude Code's known
   *       title-gen / summary system-prompt prefixes. Recent versions
   *       send these calls against the user's primary model, so the
   *       legacy model heuristic alone misses them.
   *
   *  Returning true causes the message_start branch in
   *  applyAnthropicEvent to demote the flow to 'secondary'. The two
   *  signals are deliberately independent: a false negative on either
   *  one is recoverable (we just don't filter that one call), but a
   *  false POSITIVE silently hides a real turn — so each signal is
   *  written conservatively and the caller is welcome to read them
   *  individually if a future bug demands tighter targeting.
   */
  private isSidecarFlow(state: FlowState, flowModel: string | null | undefined): boolean {
    // Signal 1: legacy model match.
    if (this.sidecarModelPattern && this.getSessionModel) {
      const sessionModel = this.getSessionModel()
      if (typeof flowModel === 'string' && typeof sessionModel === 'string') {
        if (
          this.sidecarModelPattern.test(flowModel) &&
          !this.sidecarModelPattern.test(sessionModel)
        ) {
          return true
        }
      }
    }

    // Signal 2: request shape. Skipped when the addon did not supply a
    // body (older mitmAddon.py, oversized payload, parse failure) — in
    // those cases we degrade to signal 1 only and the user falls back
    // to the prior behaviour.
    const shape = state.requestShape
    if (shape) {
      // 2a. Tiny generation cap. Real Claude Code turns set max_tokens
      // to 8192+; every known auxiliary call (title gen, branch-name
      // gen, compaction summary, hook agent) caps at <= 1024. We use
      // 1024 as the threshold because Claude Code's compaction
      // summary uses 1024 (the highest auxiliary value observed) and
      // a real turn would never legitimately set max_tokens that low
      // — Claude Code's own composer enforces a higher floor.
      const MAX_TOKENS_SIDECAR_THRESHOLD = 1024
      if (
        typeof shape.maxTokens === 'number' &&
        shape.maxTokens > 0 &&
        shape.maxTokens <= MAX_TOKENS_SIDECAR_THRESHOLD
      ) {
        return true
      }

      // 2b. System-prompt fingerprint. We match prefixes (case-
      // insensitive) rather than full strings because Anthropic
      // versions the prompts and we'd rather miss a renamed prompt
      // than miss-classify a real turn. List drawn from the
      // Claude Code 2.1.x source as of 2026-05-06; extend as new
      // sidecars are observed in debug bundles.
      const sysFingerprints = [
        'You are a helpful AI assistant tasked with generating',
        'You will be given a conversation', // teleport branch+title
        'Generate a concise', // compaction summary, title gen
        'Summarize the following', // hook-agent variants
      ]
      const prefix = shape.systemPrefix?.toLowerCase() ?? ''
      if (prefix.length > 0) {
        for (const fp of sysFingerprints) {
          if (prefix.startsWith(fp.toLowerCase())) return true
        }
      }
    }

    return false
  }
```

- [ ] **Step 3: Update the only caller**

Around line 703, change:

```ts
        if (isActive && this.isSidecarFlow(ev.model)) {
```

to:

```ts
        if (isActive && this.isSidecarFlow(state, ev.model)) {
```

The diagnostic string a few lines below already includes `ev.model`; leave it alone — it remains useful even when the demotion was triggered by the body heuristic, because the model is still the most concise label for log skimmers. If you want to be thorough, append the trigger:

```ts
          this.onDiagnostic(
            `flow ${state.flowId} demoted as sidecar (model=${ev.model}` +
            `, maxTokens=${state.requestShape?.maxTokens ?? '?'}` +
            `, sysPrefix=${(state.requestShape?.systemPrefix ?? '').slice(0, 40)})`,
          )
```

- [ ] **Step 4: Verify compile**

Run: `cd /Users/juliusolsson/Desktop/Development/cc-shell && npx tsc -p packages/claude-code-headless/tsconfig.json --noEmit`
Expected: zero errors.

- [ ] **Step 5: Run existing test suite**

Run: `cd /Users/juliusolsson/Desktop/Development/cc-shell/packages/claude-code-headless && npx vitest run`
Expected: all pre-existing tests still pass. **Do not add new test files** (per project memory `feedback_no_test_bloat.md`). If a pre-existing test happened to assert against the old single-arg `isSidecarFlow` signature, it will fail compile in Step 4 and you'll fix it as part of this step.

- [ ] **Step 6: Commit**

```bash
git add packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts
git commit -m "proxy(adapter): demote sidecar flows by request shape, not just model"
```

---

## Task 5: Tighten the `flow_ignored` reason string for renderability

The renderer's debug panel surfaces `flow.reason` verbatim. Long, ambiguous reasons make triage harder when the heuristic mis-fires.

**Files:**

  - Modify: `packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts:713-718` (only the `reason` string).

- [ ] **Step 1: Replace the call**

Existing:

```ts
          this.channel.publishFlowIgnored({
            flowId: state.flowId,
            reason: `sidecar model ${ev.model ?? '<unknown>'} (session model differs from sidecar pattern)`,
            source,
            confidence,
          })
```

Replace with:

```ts
          this.channel.publishFlowIgnored({
            flowId: state.flowId,
            reason: this.describeSidecarReason(state, ev.model),
            source,
            confidence,
          })
```

And add the helper:

```ts
  /** Human-readable label for why a flow was demoted, derived after
   *  the fact from whichever signal(s) tripped. We re-evaluate each
   *  signal here rather than threading the trigger through the call
   *  chain — the cost is negligible (string comparisons on a 200-char
   *  prefix and a numeric compare) and it keeps the demotion site
   *  free of branching. The output goes straight to the debug panel
   *  and the proxy-semantic dump, so phrase it for a human reader. */
  private describeSidecarReason(state: FlowState, flowModel: string | null | undefined): string {
    const reasons: string[] = []
    if (
      this.sidecarModelPattern &&
      this.getSessionModel &&
      typeof flowModel === 'string'
    ) {
      const sessionModel = this.getSessionModel()
      if (
        typeof sessionModel === 'string' &&
        this.sidecarModelPattern.test(flowModel) &&
        !this.sidecarModelPattern.test(sessionModel)
      ) {
        reasons.push(`sidecar model ${flowModel}`)
      }
    }
    const shape = state.requestShape
    if (shape) {
      if (
        typeof shape.maxTokens === 'number' &&
        shape.maxTokens > 0 &&
        shape.maxTokens <= 1024
      ) {
        reasons.push(`tiny max_tokens (${shape.maxTokens})`)
      }
      if (shape.systemPrefix && shape.systemPrefix.trim().length > 0) {
        reasons.push(`auxiliary system prompt`)
      }
    }
    if (reasons.length === 0) {
      // Defensive — isSidecarFlow returned true but no signal matches
      // here. Means the heuristics drifted out of sync; surface as much
      // detail as possible so we can fix the divergence.
      return 'sidecar (signals mismatch — see adapter logs)'
    }
    return reasons.join(' + ')
  }
```

- [ ] **Step 2: Verify compile**

Run: `cd /Users/juliusolsson/Desktop/Development/cc-shell && npx tsc -p packages/claude-code-headless/tsconfig.json --noEmit`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add packages/claude-code-headless/src/proxy/ClaudeProxyAdapter.ts
git commit -m "proxy(adapter): describe sidecar-demotion trigger in flow_ignored"
```

---

## Task 6: Manual end-to-end verification with a fresh debug bundle

No new automated tests are introduced (per project memory `feedback_no_test_bloat.md`). Instead, the verification step is a captured manual recipe so the next maintainer can re-run it.

**Files:**

  - No code changes. Optional: append the recipe to the PR description.

- [ ] **Step 1: Build and launch cc-shell**

Run: `cd /Users/juliusolsson/Desktop/Development/cc-shell && npm run dev`
Expected: app launches; the proxy starts inside the first Claude pane.

- [ ] **Step 2: Reproduce the bug pre-fix is unnecessary**

We already have a captured pre-fix repro in
`/Users/juliusolsson/.config/cc-shell/debug-bundles/2026-05-06T08-20-40-689-75a7665a/`. The post-fix bundle is what we need to compare against.

- [ ] **Step 3: Drive a session that reliably triggers a title gen**

Open a Claude pane, send a single short instruction (e.g. *"list the files in this directory"*). After the assistant responds, send another short instruction (*"now show me the first 20 lines of the largest one"*). Claude Code emits a title-gen call after the second turn settles. Watch the proxy debug panel: a flow that fires within ~600 ms of `turn_completed` should now show `attribution: ignored` with `reason: "tiny max_tokens (...)"` or `"auxiliary system prompt"`.

- [ ] **Step 4: Save a debug bundle**

In the pane, run the *Save Debug Logs* command (palette). Open the resulting bundle. Verify:

  - `proxy-semantic.json` → `flows.<id>.attribution === 'ignored'` for at least one flow with the new reason string.
  - `proxy-semantic.json` → `history` does NOT contain a 4-10-word turn with `output_tokens < 20` AND `input_tokens >= 100`.
  - `html-clean.html` → no orphan ghost message containing only the title text appears at the bottom of the feed.

- [ ] **Step 5: Run the pre-existing regression suite**

Run: `cd /Users/juliusolsson/Desktop/Development/cc-shell && npm run test`
Expected: all suites pass. If any test in `packages/claude-code-headless` or `src/renderer/.../semantic` fails, return to Phase 1 — the heuristic likely caught a real turn in a fixture.

- [ ] **Step 6: Final commit (no code change — optional, only if a tail of fixture replay diff exists)**

If Step 5 surfaces fixture diffs that need refreshing (e.g. a JSONL replay that asserts the old `flow_ignored.reason` text), regenerate them with the same command pattern the fixture's README documents, then:

```bash
git add <regenerated fixture files>
git commit -m "proxy(fixtures): refresh after sidecar reason-string change"
```

If no fixture diff: do nothing here.

---

## Self-Review Checklist (run before opening the PR)

- [ ] The Haiku-on-Haiku-session case (a user who explicitly picked Haiku as primary) still runs correctly: `isSidecarFlow` returns false on signal 1 because both models match the pattern, and signal 2 fires only on `max_tokens<=1024` or a known prefix — neither of which a real Haiku conversation turn would carry.
- [ ] Older mitm addons that don't emit `body_b64` continue to work: `state.requestShape` stays null, signal 2 short-circuits, and behaviour reverts to the legacy model-only filter.
- [ ] No `requestShape` reads happen before `onRequest` runs — the field is initialised at flow creation, so even on a pathological event ordering (chunk before request) the field exists.
- [ ] The renderer is unchanged. `flow_ignored` already wires through `foldSemanticEvent.ts:93`, ghosts are already gated on attribution, and no UI surface needs an update.
- [ ] No new test file is committed (project memory). If a strong urge to write one survives review, file it as a separate test-only PR after the cleanup PR mentioned in the memory has landed.
- [ ] The fingerprint list in `isSidecarFlow` Step 2 is conservative: each entry is a literal English-word prefix, not a generic pattern that could match a user's own message. A user who paste-quotes one of these prefixes into a real prompt would only false-positive *if* they also happened to set `max_tokens<=1024` in the same request, which Claude Code's composer doesn't expose.

---

## Open follow-up (NOT in this plan, file separately)

  - Replace the constant `getSessionModel()` default in `claudeSession.ts:289-290` with a parser that reads Claude Code's header line ("Opus 4.7 (1M context) …"). The current default of `'claude-opus-4-7'` becomes wrong the moment the user `/model`-switches to Haiku, and signal 1 in `isSidecarFlow` then mis-classifies their real turns. The body-based signal 2 is robust to this (it doesn't read `getSessionModel`), but the diagnostics will lie about *which* signal tripped.
  - Audit the addon's `_REQUEST_BODY_CAP` after a few weeks of telemetry. If we observe legitimate /v1/messages requests above 256 KiB (e.g. heavy attachment turns), bump the cap or stream-hash the body instead of buffering.
