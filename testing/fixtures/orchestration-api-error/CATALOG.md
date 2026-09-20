# Provider API errors as the renderer runtime sees them (#1018)

This catalog comes from recordings made on the dev machine between 2026-09-14 and
2026-09-19, following the staged-decomposition "instrumentation first" rule.
It answers one question: **when has an orchestration child's turn failed for
good, and when is the provider still retrying or recovering?** It also covers
what the renderer runtime can report about the failure.

Each fact below is labelled with where it came from:

- **REC**: seen in a recording (feed-debug, OpenCode DB, proxy dump, Codex rollout or Claude transcript).
- **SRC**: read from source or from the installed binary. Not seen in a recording.
- **DERIVED**: produced by running our own code over recorded input by hand. Not recorded directly.

Fixture files and their provenance are listed in `README.md`.

---

## 0. The bug, as recorded (REC)

The run was `release-pr-review`, with parent `44cc62fa…`. Six OpenCode children
used the structured runtime with `zai-coding-plan/glm-5.3`. Each of them:

1. got its prompt at 04:53:43–04:54:49Z on 2026-09-19;
2. retried 5 times inside OpenCode (`session.status` = `retry`, about 80–96 s in total);
3. emitted `session.error`. The runtime logged `api_error`, then `process idle` (4–9 ms later), then `turn_completed` (7–19 ms later);
4. did nothing after that.

`orchestration_wait_agents` returned at 04:56:34.874Z with `done:false`. By then
all six children had failed, 22–90 s earlier. Every child still showed
`lifecycleState:"prompt_sent"`, `statusSummary:"waiting"`, `messageCount:1`,
and no `errorSummary`. The fixture is `opencode-structured-usage-limit-terminal.json`.

How the current code produces that result (SRC):

- `orchestrationMcp.ts lifecycleStateForRuntime`: after the error, `processActive=false`, `streamPhase='idle'` (`turn_completed` resets it), and `awaitingAssistant=false` (both `api_error` and `process_state` clear it). The child has no assistant entry and `inputReady` is true, so the result is `waiting`.
- `OrchestrationBridge.lifecycleWithPromptDelivery`: `waiting` plus `promptSubmissionCount>0` becomes `prompt_sent`, and nothing ever ends that.
- `errorSummary` is filled only from `runtime.processError`. The `process_state` handler resets that field to `null` on every event.

---

## 1. Corpus and counts

| Source | Scope | What was found |
|---|---|---|
| feed-debug (`~/.config/agent-code/feed-debug/*.jsonl`) | 103 session logs, 634 MB, 2026-09-14 → 19 | **27 SEM `api_error`** in 21 logs. **0 `stream_error`**. 30 `process_state` rows with `retry` (structured OpenCode). 246 rows with `retrying (attempt n)` in 4 logs (OpenCode Terminal). Provider-notice labels appear 86 times in RENDER rows (80 claude, 6 codex). |
| OpenCode DB (`~/.local/share/opencode/opencode.db`) | All assistant rows | Rows with an error, all time: APIError 33, ContextOverflowError 17 (all from March), UnknownError 6, MessageAbortedError 1495. Rows updated since 2026-09-16T23:06Z: 34 (15 APIError, 19 MessageAbortedError). **All 22 OpenCode `api_error` events matched a DB row within 338 ms.** |
| Proxy dumps (`~/.config/agent-code/proxy`, 4.1 GB) | Every `proxy-events.jsonl` | Codex `/v1/responses` non-2xx: **4**, all `429 usage_limit_reached`. Anthropic `/v1/messages` non-2xx: 27 (25×429, 2×400). |
| Codex rollouts (`~/.codex/sessions/2026`) | `task_complete.error` | usage_limit_exceeded **34** (12 in mid-turn, after at least one item). server_overloaded **15** (9 mid-turn). cyber_policy 21 (not analysed). No `stream_error` or `error` event_msg rows are persisted. |
| Claude transcripts (`~/.claude/projects`, files modified since 2026-08-20) | Non-sidechain `isApiErrorMessage:true` | **200 entries in 82 files.** By `error`: rate_limit 172, server_error 17, model_not_found 4, authentication_failed 3, unknown 2, invalid_request 2. By `apiErrorStatus`: 429×173, 502×4, 404×4, 400×1, 529×1, none×17. 21 of these are Claude **orchestration children**, and for 16 of them the error is their last assistant entry. |

### 1.1 Every recorded `api_error`, classified

| Provider / runtime | Events (sessions) | Real error (from DB or proxy) | Retries before the error | Error → idle | What happened next |
|---|---|---|---|---|---|
| OpenCode **structured** (`turn=msg_…`) | 6 (6) | APIError 429 `isRetryable:true`, "Usage limit reached for 5 hour. Your limit will reset at 2026-09-19 14:14:24" | 5 (`retry` status) over 80.5–95.6 s | idle after 4–9 ms, `turn_completed` after 7–19 ms | **Nothing (6/6)**. The parent saw `prompt_sent` until its wait timed out. |
| OpenCode **Terminal** (`turn=opencode-turn-…`) | 2 (2) | APIError 429 `isRetryable:true`: "The usage limit has been reached" (openai/gpt-5.6-sol) and "Usage limit reached for 5 hour…" (zai) | 5 (`retrying (attempt 1..5)`), turn age 75.8 s and 118.8 s | `turn_completed` after 135 / 261 ms, idle after 229 / 361 ms | Nothing (2/2). The zai case failed mid-turn, after an assistant tool-call row. |
| OpenCode Terminal | 4 (4) | APIError 403 `isRetryable:false`, "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode" | 0. Turn age 0.9–8.0 s | `turn_completed` after 3–132 ms, idle after 102–205 ms | 2 of 4: the **user** sent a new prompt 8.5 s / 13.3 s later. 2 of 4: nothing. |
| OpenCode Terminal | 10 (6) | **MessageAbortedError** "Aborted", from a user or app interrupt | 0 | `turn_completed` after 7–262 ms | Another user or goal-loop prompt followed 0.35–80.8 s later in 6 of 10. In the rest, nothing. |
| Codex (`src=proxy`) | 5 (5) | HTTP 429 `{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"pro","resets_at":…}}` with `x-codex-active-limit: premium` | 0. Turn age 0.16–1.07 s | rollout `turn_completed` after 33–675 ms, screen `process idle` after 2.5–3.1 s | Nothing within 120 s (5/5). |
| Claude | **0** | — (see §2.3; the failure shows up only on the committed plane) | — | — | — |

Two OpenCode Terminal **retry episodes ended without any `api_error`**
(53330d96 and 2aee6636 had retry labels but no error). The OpenCode rows for
them have `time.completed` set, no `error`, no `finish`, and 0 tokens. Both
stopped within 1.2 s of each other, which points to an external stop. See
`opencode-terminal-retry-in-flight.json`.

**Recovered after a retry: 0 recordings for any provider.**

---

## 2. Per-provider sequences

Times are relative to the prompt reaching the provider. The field names are
real `SessionRuntime` fields.

### 2.1 OpenCode, structured runtime (`packages/opencode-headless`). Fixture: `opencode-structured-usage-limit-terminal.json`

```
+0        JSONL user entry (handoff prompt)
+52 ms    process_state active 'busy'           processActive=true  activityStatus='busy'
+55 ms    SEM turn_started   (turn = user msg id)
+~9 s     process_state 'busy' -> 'retry'       ← attempt 1 failed (no api_error!)
          'busy' / 'retry' alternate 5 times, gaps 2.2, 4.7, 9.9, 19.5, 32.6 s
+80.5 s   SEM api_error      src=opencode-sse   (retries exhausted, session.error)
+4 ms     process_state idle ('idle')           processActive=false, awaitingAssistant=false
+7 ms     SEM turn_completed                    streamPhase -> 'idle'
          (nothing else)
```

- SRC (OpenCode binary 1.18.31, `SessionRetry`): `RETRY_MAX_RETRIES = 5`. The delay starts at `2000 * 2^(n-1)`, plus up to 25 % jitter. The 30 s cap applies **only when the provider sent no response headers**. zai sends headers, so the 5th wait was about 33 s. A 429 carrying `isRetryable:true` gets retried even when it is a 5-hour usage window.
- SRC (`SessionProcessor.halt`): sets `assistantMessage.error`, then `bus.publish(Session.Event.Error, {sessionID, error})`, then `status.set({type:'idle'})`. So the error always comes **before** idle. That matches the recordings (6/6).
- SRC exception: with auto-compaction on, a `ContextOverflowError` publishes the same `session.error` and **then keeps going into compaction** inside the same busy span, with no idle. No recording shows this.
- **Message text in the renderer: `"OpenCode session error"`** (DERIVED). `EventDispatcher.ts:289-296` reads `getString(payload, ['message','error.message'])`. The payload is `{sessionID, error:{name, data:{message, statusCode, isRetryable, responseHeaders, responseBody, metadata}}}`, so neither path exists. The whole payload travels as `event.error`, but `retainProviderError` keeps only top-level string and number fields, so it is dropped. The retained `SemanticErrorEntry` has no `errorType`, `status` or `retryAfterMs`.
- The retry reason (`session.status.retry.message`, which here would be the "Usage limit reached…" text) is also dropped. `handleSessionStatus` forwards only the status `type`.

### 2.2 OpenCode, Terminal runtime (`packages/opencode-terminal-headless`). Fixtures: `opencode-terminal-usage-limit-after-retries.json`, `opencode-terminal-nonretryable-and-abort.json`, `opencode-terminal-retry-in-flight.json`

```
retryable error (429):
  turn_started, 'requesting' ... 'retrying (attempt 1)' ... 'requesting' ... 'retrying (attempt 5)'   processActive=true throughout
  +75.8 s  SEM api_error   ->  +135 ms SEM turn_completed  ->  +229 ms process idle     (nothing after)

non-retryable (403):
  turn_started, 'requesting' ... +1.2..8 s SEM api_error -> +77..132 ms turn_completed -> idle

user abort (MessageAbortedError):
  ... 'running bash' ... SEM api_error -> (user prompt row) -> assistant+user rows -> turn_completed -> idle
```

- **Message text in the renderer is the real text** (SRC `LiveStateProjector.errorMessage`: `error.data.message ?? error.message ?? error.name`). Examples: "The usage limit has been reached", "Usage limit reached for 5 hour. Your limit will reset at 2026-09-19 14:14:24", "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode", and **"Aborted"**. `SessionSequencer.ts:254` forwards only `{type, turnId, message, source, ts}`, so there is no `errorType`, `name` or `status`.
- `activityStatus` carries the attempt number (`retrying (attempt n)`). The retry reason is not kept.
- The processes re-emit `process_state` about once per second while the label stays the same. The fixtures collapse those rows into `repeats` / `lastTMs`.

### 2.3 Claude. Fixture: `claude-usage-limit-terminal.json`

```
app submit:   STATE submit -> streamPhase 'submitting', awaitingAssistant=true, submittedAt
              process_state active 'Noodling…'
+2.5 s        JSONL assistant entry  isApiErrorMessage:true error:'rate_limit' apiErrorStatus:429 model:'<synthetic>'
              text "You've hit your session limit · resets 6:20pm (America/Los_Angeles)"
              RENDER: provider-notice "claude Usage limit reached"
+2.5 s later  process_state idle          (awaitingAssistant=false)
              streamPhase STAYS 'submitting' for the rest of the log (>170 s)   ← app-submit path only
```

- The 429 arrives **before any SSE**. The Claude proxy adapter emits **no** `api_error` and no `turn_started` (0 Claude SEM `api_error` in the whole corpus). `ClaudeProxyAdapter` only emits `api_error` for mid-stream SSE `error` frames, such as `overloaded_error`. In that case it also synthesizes `turn_stopped` and `turn_completed` straight away, and the Claude CLI may retry afterwards (SRC `withRetry`: up to 10 attempts, and overloaded errors are retried). **A Claude semantic `api_error` therefore does not mean the turn is over.** No recording of that case exists.
- The committed synthetic entry is written **after** Claude has used up its own retries. For example, the text "No response from API (waited 4m, then 10m on the retry)" says so. In 183 of 200 cases the next entry is a `system/turn_duration` child of the error entry, meaning the turn ended. The CLI's retry status messages (`system/api_error` with `retryInMs`/`retryAttempt`) are **never persisted**: 0 of them across all transcripts.
- What followed the 200 error entries: in 192, the next conversational entry is a user prompt, another error, or nothing. In 8, an assistant turn follows with no user row; 6 of those come within 200 s. Of those 6, 5 are explained by something outside the provider's retry loop: a scheduled-task prompt, `/login` followed by a "Continue from where you left off." meta prompt (×2), a task-notification "Continue from where you left off." prompt, or an automatic usage-reset continuation. One is unexplained: "went to sleep mid-response", then an assistant turn 13 s later. Separately, 19/200 have a `system/informational` "Usage limit reached · continuing automatically at 6:20pm" or "Usage limit reset · continuing automatically" after them. **Claude can resume a limited session by itself when the window resets**, hours later.
- Orchestration children are not submitted through `beginOptimisticSubmit` (`createBuiltInMcpServer` → `manager.deliverPromptToAgent` in main), so the stuck `'submitting'` phase shows up only for app-composer prompts. Current code (SRC) for a **Claude child** that hits a limit: the synthetic entry has `type:'assistant'`, so `hasAssistantOutput` is true and the child is reported **`completed`**, with `latestAssistantText` set to the limit text. It is not reported as failed. No parent-side recording of this exists. The 21 Claude orchestration-child transcripts show the child-side half.

### 2.4 Codex. Fixture: `codex-usage-limit-terminal.json`

```
(orchestration delivery; screen) process_state 'working… 1s' ... SEM stream_phase src=screen
+3.4 s    SEM turn_started src=rollout
+0.3 s    SEM api_error src=proxy        (HTTP 429 on /v1/responses, request req-4)
+0.7 s    SEM turn_completed src=rollout (turn_completed within 33–675 ms in 5/5)
+2.4 s    process_state idle            (screen-derived; processActive stays true until then)
visible pane: RENDER provider-notice "codex Usage limit reached", streamPhase -> idle at turn_completed
```

- Recorded wire: `status 429`. Headers include `x-codex-active-limit: premium` and `x-codex-primary-used-percent: 100`. There is no `retry-after`, no `x-premium-limit-name`, and no `x-codex-rate-limit-reached-type`. Body: `{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"pro","resets_at":1789843274,"resets_in_seconds":77349}}`.
- DERIVED semantic event from `classifyHttpFailure`: `{type:'api_error', requestId:'req-4', turnId:null, errorType:'usage_limit_reached', message:'The usage limit has been reached', status:429, resetsAt:1789843274, limitId:'premium', source:'proxy'}`. Note that the existing `testing/fixtures/provider-usage-limits/cases.json` fixture was derived from source and uses different text ("You've hit your usage limit. Try again later.").
- The rollout records the same failure durably: `task_complete {last_agent_message:null, error:{message:"You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 19th, 2026 11:41 AM.", codex_error_info:"usage_limit_exceeded"}}`. Nothing in `src/` or `packages/codex-headless` reads `task_complete.error` except the provider-switch cyber-policy code.
- **`runtime.limitHit` does not survive for Codex.** The `api_error` sets it, and the rollout `turn_completed` that arrives 33–675 ms later sets it back to `null` (`useIpcSubscriptions.ts`, the `nextLimitHit` branch). This happened in 5/5 recordings. `limitHit` cannot serve as the failure signal.
- SRC (codex-rs `CodexErr::is_retryable`): `UsageLimitReached`, `ServerOverloaded`, `QuotaExceeded`, `UsageNotIncluded`, `InvalidRequest` and `ContextWindowExceeded` are **not retried**. `RateLimitExceeded` (a plain 429), `InternalServerError`, `UnexpectedStatus`, `Stream`, `Timeout` and `ConnectionFailed` **are** retried (`request_max_retries` 4, `stream_max_retries` 5). The proxy emits one `api_error` per failed HTTP attempt, so a retried 5xx would show up as `api_error` while the turn stays open. No recording of that exists.
- REC (rollouts): all 15 `server_overloaded` failures ("Selected model is at capacity. Please try a different model.") **ended the turn**. **`isOverloaded` does not mean Codex will retry.** Across all 49 usage/overloaded failures, the next `task_started` came at least 27 s later, which means a new prompt; 31 of 49 have no later turn in the file.

---

## 3. What separates a finished failure from a retry, in fields the runtime already has

| Signal | Available as | Tells us |
|---|---|---|
| The provider is still working | `processActive===true`, `streamPhase!=='idle'`, `awaitingAssistant`, `sessionStatus==='running'`, `semantic.currentTurn!==null` | Still going: retrying, compacting, or answering. The current `running` check already covers this. |
| OpenCode is retrying | `activityStatus==='retry'` (structured) or `/^retrying \(attempt \d+\)$/` (Terminal), with `processActive===true` | A retry is in progress. **No `api_error` is emitted while OpenCode retries.** It can last about 75–120 s (5 attempts). |
| Provider failure | `semantic.errors[]` entry with `kind:'api_error'` (OpenCode source `opencode-sse`, Codex source `proxy`). For Claude, a `runtime.entries` item with `type:'assistant' && isApiErrorMessage===true` | The request failed. It is only final once the provider is idle. |
| Order of events | error first, then idle: 27/27 (OpenCode idle 4–361 ms later, Codex `turn_completed` 33–675 ms and `processActive=false` 2.5–3.1 s later, Claude idle about 2.5 s after the entry) | Once the runtime is idle, the error is already in state. A pure function of state is enough; no timer or debounce is needed. |
| `errorType` / `isOverloaded` / `retryAfterMs` | Codex only (`usage_limit_reached` in 5/5). OpenCode never sets these. Claude only has them on the SSE path, which was never recorded | **Not enough to decide.** `retryAfterMs` was missing from every recorded error. Codex `server_overloaded` is terminal. Claude `overloaded_error` gets retried. |

### 3.1 Proposed rule: stated in runtime fields

```
failureSignal(R, kind):
  kind ∈ {opencode}:  last e ∈ R.semantic.errors, e.kind==='api_error' && e.source==='opencode-sse'
  kind === 'codex':   last e ∈ R.semantic.errors, e.kind==='api_error' && e.source==='proxy'
  kind === 'claude':  last x ∈ R.entries, x.type==='assistant' && x.isApiErrorMessage===true && !x.isSidechain
                      (a Claude semantic api_error is NOT a failure signal; Claude may still retry)
  at(e) = e.observedAtMs ?? e.ts          at(x) = Date.parse(x.timestamp)

lastRealOutputAt(R) = max producer timestamp of R.entries items with type==='assistant'
                      && isApiErrorMessage!==true (Claude), plus "now" if
                      R.semantic.currentTurn?.text is non-empty

providerIdle(R) = !R.processActive && R.streamPhase==='idle' && !R.awaitingAssistant
                  && R.sessionStatus!=='running' && R.semantic.currentTurn===null

terminalFailure(R) = f=failureSignal(R) exists
                     && providerIdle(R)
                     && at(f) > lastRealOutputAt(R)      // a later answer or turn beats an old error
```

The order inside `lifecycleStateForRuntime` would become: `created` → (process `failed`) →
`closed` → `running` → **`failed` when `terminalFailure`** → `completed` when there
is durable output → `waiting`. Report `errorSummary = f.message` and a new
`failedAt = at(f)` on the record.

Main stage 2 (`lifecycleWithPromptDelivery`) needs the rule that `completedAt`
already has: **if `lastPromptSubmittedAt > failedAt`, report `prompt_sent`**.
Otherwise a re-prompted child shows its stale failure until the provider picks
the prompt up. Today `failed` passes through that function unchanged.

Why this rule, based on the recordings:

- It is `false` throughout every retry episode (processActive stays true: 10/10 OpenCode episodes). It becomes `true` in the same state update that makes the child idle.
- It checks the failure against the latest **real** output. That catches mid-turn failures that `hasAssistantOutput` would otherwise report as `completed`: cf497ac5 (OpenCode Terminal, assistant tool-call row before the error), 12/34 Codex usage-limit and 9/15 overloaded rollouts that failed after at least one item, and Claude, whose synthetic error entry is itself an `assistant` entry.
- It clears itself if the provider resumes (Claude "continuing automatically", a user re-prompt, or OpenCode compaction): activity flips it back to `running`, then real output newer than the failure flips it to `completed`.
- Use producer timestamps, not the order things arrived in. OpenCode Terminal committed `assistant` rows that were **created before** the error arrived 130–260 ms **after** the `api_error` (46179162, 6d6cac8c).

### 3.2 Gaps in the fields the rule needs

1. **Structured OpenCode message.** `EventDispatcher.ts:293` should read `error.data.message ?? error.message ?? error.name`, the same way `LiveStateProjector.errorMessage` does. Without that change the parent sees "OpenCode session error" instead of "Usage limit reached for 5 hour. Your limit will reset at 2026-09-19 14:14:24".
2. **Error class for OpenCode.** Neither runtime forwards `error.name` or `statusCode`. The rule does not need them to be correct: an aborted child is also idle and will not continue by itself, so it should not hang in `prompt_sent` either. They are needed for **labels**, to tell "Aborted" (10/22 OpenCode `api_error`s were user or app aborts) apart from provider failures, and to show `status` (429/403). Suggested fields: `errorType = error.name`, `status = error.data.statusCode`.
3. **Claude.** `lifecycleStateForRuntime` never looks at the error fields of an entry. Its only link to entries is `hasAssistantOutput`, which currently counts the synthetic error as output.
4. **Record shape.** `OrchestrationAgentRecord` has no `failedAt`, and `errorSummary` is filled only from `processError`.
5. **`limitHit`.** Not usable for Codex (see §2.4). It only covers usage limits anyway.
6. **Output-mode versus status-mode lifecycle.** Status mode uses `hasAssistantOutput`, which counts any assistant entry, including one with only a tool call. Output mode uses `Boolean(latestAssistantText)`, which counts text only. The same child can therefore show `completed` in `list/wait` and `waiting`/`prompt_sent` in `read`. The failure check should sit before both.

---

## 4. Message text available to report

| Provider | Renderer today (`SemanticErrorEntry.message` or entry text) | Richer text available elsewhere |
|---|---|---|
| OpenCode structured | `OpenCode session error` (DERIVED) | `session.error` payload `error.data.message` and DB `message.data.error.data.message`: "Usage limit reached for 5 hour. Your limit will reset at 2026-09-19 14:14:24" (zai `responseBody` code "1308", statusCode 429, isRetryable true) |
| OpenCode Terminal | the real `error.data.message`: "The usage limit has been reached" / "Usage limit reached for 5 hour. Your limit will reset at …" / "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode" / "Aborted" | the same, plus `statusCode`/`isRetryable` in the DB |
| Codex | "The usage limit has been reached", plus `errorType:'usage_limit_reached'`, `status:429`, `resetsAt` (Unix seconds), `limitId:'premium'` | rollout `task_complete.error.message`: "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 19th, 2026 11:41 AM." and "Selected model is at capacity. Please try a different model." (server_overloaded) |
| Claude | entry text, e.g. "You've hit your session limit · resets 6:20pm (America/Los_Angeles)", "You're out of usage credits. Run /usage-credits to keep using Fable 5.1 or /model to switch models.", "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?… · your weekly limit resets Sep 16 at 11pm (America/Los_Angeles)", "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment…", "API Error: This request would exceed your account's rate limit. Please try again later." (`error:'unknown'`, 429), "Login expired · Please run /login" | `apiErrorStatus`, `error` class; `system/informational` "continuing automatically at 6:20pm" |

---

## 5. Unknowns

1. **No recording of a retry that later succeeded**, for any provider. There are 10 OpenCode retry episodes: 8 ended in `api_error` and 2 ended with no error, no finish and 0 tokens. The cause of those 2 is unknown; they stopped 1.2 s apart, which suggests an app-driven stop or provider switch.
2. **Claude mid-stream `api_error`** (SSE `error` frame, e.g. `overloaded_error`) followed by the CLI's own retry: 0 recordings. It is unknown whether `processActive` stays true during Claude's backoff (the screen spinner) or drops to idle between attempts. If it drops, a Claude semantic error would look final, which is why the rule uses only the committed entry for Claude.
3. **Codex retryable `api_error`** (`rate_limited`, `retryable`, `stream`, 5xx): 0 recordings. The claim that the turn stays open and `processActive` stays true during codex-rs retries comes from source only.
4. **OpenCode `ContextOverflowError` with auto-compaction** (`session.error` while the turn continues): known from the binary only. The 17 DB rows are from March, before any feed-debug existed.
5. **Structured OpenCode message text** `"OpenCode session error"` is DERIVED. SEM rows carry the payload only when `AGENT_CODE_DEV_DEBUG` raw capture is on. A dev-debug recording would confirm it.
6. **What the parent sees for Claude children.** 21 child transcripts ended in API errors (16 of them on the error), but no parent tool result shows what orchestration reported. The `completed` reading with the limit text comes from source.
7. **What Claude's auto-continue should mean for orchestration.** "Continuing automatically at 6:20pm" was seen in 19/200 cases. The child is idle now but will resume without a prompt. `failed`, or a separate "waiting for reset" state, is a product decision.
8. **Durability across a renderer reload.** `semantic.errors` lives only in memory, and main's `promptDeliveries` too. After a reload the Codex and OpenCode failure evidence is gone from the runtime, while Claude's (JSONL), Codex's (rollout `task_complete.error`) and OpenCode's (DB `message.error`) survive on disk. Unknown whether a reloaded, failed child goes back to `prompt_sent`.
9. **Timestamps on mapped OpenCode Terminal and Codex entries**, needed for `lastRealOutputAt`: not checked. The rule assumes they are producer timestamps.
10. **The sessions named in the brief.** `5cf66257…` and `575880c6…` (and `9bb36de4…`) contain **no** "Usage limit" text in feed-debug (case-insensitive grep: 0 matches). Only screen, readiness, worktree and `provider_session_observed` rows. This could not be verified.
11. **Grok and other providers:** no recordings.
12. **Claude "went to sleep mid-response":** one case continued 13 s later with no user row. Whether that was an automatic resume is unknown.
