# Plan: Bulletproof Claude & Codex Proxy Resilience

Fixes #1552

## Problem

Agent Code optionally routes Claude (via per-session `mitmdump`) and Codex (via local `ResponsesProxy`) through local proxies to obtain richer semantic streaming events. Today both proxy paths fail closed or misconfigure user environments in common real-world setups:

1. **Claude (`ClaudeSession`)**
   - Unconditionally spawns `mitmdump` when `useProxy: true` even when the user's environment is incompatible (corporate `HTTPS_PROXY`/`HTTP_PROXY`, non-Anthropic cloud backends like Bedrock/Vertex/Foundry, or a local/plain-HTTP `ANTHROPIC_BASE_URL`).
   - Overwrites user `NO_PROXY`/`no_proxy` instead of merging loopback hosts, breaking internal/corporate bypass lists.
   - Overwrites user `NODE_EXTRA_CA_CERTS` instead of merging the user's CA bundle with the mitmproxy CA cert, breaking corporate TLS roots.
   - Fails closed if `resolveBundledTool('mitmdump')`, `createProxyServer`, or `proxy.start()` throws, aborting Claude spawn instead of degrading to direct spawn.
2. **Codex (`CodexSession`)**
   - Unconditionally starts `ResponsesProxy` when `useProxy: true` even when a corporate proxy env var is set (Node's `fetch()` in `ResponsesProxy` ignores `HTTPS_PROXY`), when `$CODEX_HOME/config.toml` sets a non-`openai` `model_provider`, or when auth mode cannot be determined (e.g. macOS Keychain / `keyring` / `auto` store or not-yet-logged-in user, where guessing `api.openai.com` causes 401s).
   - Does not honor `openai_base_url` from `$CODEX_HOME/config.toml` or `OPENAI_BASE_URL` when forwarding upstream, nor preserve/merge `NO_PROXY`/`no_proxy` with loopback hosts.
   - Fails closed if `allocateProxyEventsFile` or `ResponsesProxy.create` throws, aborting Codex spawn instead of spawning directly.
3. **Terminal-mode panes (`session.ts` & `rehydrate.ts`)**
   - Passes `useProxy: true` even when the pane's effective view mode (`meta?.agentViewModeOverride ?? settings.agentViewMode`) is hard `'terminal'`, spinning up unnecessary proxy processes for raw-PTY panes.

## Scope & Design

All changes live in the main `agent-code` repository (`src/`) so this lands as a single PR without modifying git submodules.

### 1. Shared proxy environment hygiene (`src/providers/shared/runtime/proxyEnv.ts`)
- `hasCorporateProxyEnv(env)` — detects non-empty `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, or `http_proxy`.
- `mergeNoProxy(env, requiredHosts)` — merges `localhost,127.0.0.1,::1` into any existing `NO_PROXY` / `no_proxy` entries without duplicates or clobbering.

### 2. Claude fail-open & env hygiene (`src/providers/claude/runtime/claudeProxyPolicy.ts`, `claudeSession.ts`)
- `evaluateClaudeProxyCompatibility(cleanEnv)` skips local mitmproxy when:
  - corporate proxy env vars are set;
  - `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, or `CLAUDE_CODE_USE_FOUNDRY` is truthy;
  - `ANTHROPIC_BASE_URL` uses `http://` or targets loopback (`localhost`, `127.0.0.1`, `::1`, `[::1]`, `*.localhost`).
- `buildClaudeProxyEnv(cleanEnv, proxyInfo)` merges `NO_PROXY`/`no_proxy` and, when `cleanEnv.NODE_EXTRA_CA_CERTS` is set, combines it with `proxyInfo.caCertPath` into `combined-extra-ca-certs.pem` inside `proxyInfo.workDir` (throwing on unreadable/unwritable paths so the fail-open wrapper falls back cleanly).
- `ClaudeSession.start()` wraps proxy resolution, creation, startup, and env construction in `try/catch`; on any failure it tears down any started proxy, logs a warning, emits a non-fatal `transcript-diagnostic`, sets `effectiveUseProxy = false`, and spawns Claude directly without the proxy.

### 3. Codex fail-open & config/auth/env hygiene (`src/providers/codex/runtime/codexProxyPolicy.ts`, `codexSession.ts`)
- `resolveCodexProxyDecision(cleanEnv)` inspects `cleanEnv`, `$CODEX_HOME/config.toml` (parsed via `@iarna/toml`), and `$CODEX_HOME/auth.json` before starting `ResponsesProxy`:
  - Skips if corporate proxy env vars are set.
  - Skips if `config.toml` sets `model_provider` to anything other than `"openai"`, sets `profile`, sets `chatgpt_base_url`, sets `cli_auth_credentials_store = "keyring"`, or cannot be parsed.
  - Uses `config.toml`'s `openai_base_url` as `upstreamBaseUrl` after validating it as an `http:`/`https:` URL (does NOT consult `env.OPENAI_BASE_URL`, which Codex CLI TUI ignores).
  - Otherwise inspects `$CODEX_HOME/auth.json` only (does NOT infer `apikey` from `env.OPENAI_API_KEY`, which Codex CLI TUI ignores and which would misroute Keychain ChatGPT users):
    - ChatGPT-family `auth_mode` (`chatgpt`, `chatgptAuthTokens`, `headers`, `agentIdentity`, `personalAccessToken`) or `tokens` without `OPENAI_API_KEY` → `authMode: 'chatgpt'`.
    - `auth_mode === 'apikey'` or `OPENAI_API_KEY` present in `auth.json` → `authMode: 'apikey'`.
    - Otherwise (missing/indeterminate auth, e.g., Keychain/keyring or not logged in) → skip proxy.
- When `ResponsesProxy` is used, merges `localhost,127.0.0.1,::1` into `cleanEnv.NO_PROXY` and `cleanEnv.no_proxy`.
- Wraps `resolveCodexProxyDecision`, `allocateProxyEventsFile`, and `ResponsesProxy.create` in `try/catch`; on any failure stops any locally created proxy, re-checks `isStartAttemptActive(attempt)` before mutating shared fields or falling through to `ptySpawn`, logs a warning, emits a non-fatal `transcript-diagnostic`, omits `--config openai_base_url=...`, and spawns Codex directly.

### 4. Skip proxy for Terminal-mode panes (`agentDisplayMode.ts`, `session.ts`, `rehydrate.ts`)
- Add `shouldUseProxyForSession({ kind, useProxyStreaming, globalMode, override })` in `src/renderer/src/workspace/agentDisplayMode.ts`: returns `false` when `resolveConfiguredAgentViewMode(globalMode, override) === 'terminal'`.
- Wire it into `spawn`, `ensureSessionLive`, `reloadAgentSessions` in `src/renderer/src/workspace/hook/actions/session.ts` and `rehydrateWorkspace` in `src/renderer/src/workspace/hook/persistence/rehydrate.ts`.

### 5. Verification
- Fail-first unit tests for:
  - `proxyEnv.ts` (`hasCorporateProxyEnv`, `mergeNoProxy`)
  - `claudeProxyPolicy.ts` (env compatibility, CA cert merging, unreadable CA fallback) and `ClaudeSession` fail-open direct spawn
  - `codexProxyPolicy.ts` (corporate proxy, `config.toml` `model_provider` & `openai_base_url`, `OPENAI_BASE_URL`, `auth.json` modes, indeterminate auth skip) and `CodexSession` fail-open direct spawn
  - `shouldUseProxyForSession` and terminal-mode proxy suppression in renderer session actions / rehydrate
- `npm run typecheck` and targeted vitest suites.

## Review Disposition

| Finding | Severity | Disposition | Resolution |
| --- | --- | --- | --- |
| Cancelled `CodexSession` start attempt could clear a newer generation's `proxyServer` or fall through to `ptySpawn` in the proxy `catch` block | Blocking | Fixed | Stop any locally created proxy, return early when `!this.isStartAttemptActive(attempt)` before touching `this.proxyServer` / emitting `codex-proxy-fallback` / spawning PTY, and clear `this.proxyServer` only by identity match (`codexSession.ts`). Added regression test. |
| `codexProxyPolicy` consulted `env.OPENAI_BASE_URL` and `env.OPENAI_API_KEY`, which Codex CLI TUI ignores (risking 401s for Keychain ChatGPT users who export `OPENAI_API_KEY` for other tools) | Blocking | Fixed | Removed `env.OPENAI_BASE_URL` and `env.OPENAI_API_KEY` inference from `resolveCodexProxyDecision` (`codexProxyPolicy.ts`). Updated unit tests. |
| Validate `config.toml` `openai_base_url` and skip proxy on `profile`, `chatgpt_base_url`, or `cli_auth_credentials_store = "keyring"` | Non-blocking | Fixed | Added `http:`/`https:` URL validation and conservative skips for `profile`, `chatgpt_base_url`, and `keyring` store (`codexProxyPolicy.ts`). Added unit tests. |
| Stale comment on `ClaudeSessionEvents['transcript-diagnostic']` claiming Claude never emits diagnostics | Non-blocking | Fixed | Updated comment in `claudeSession.ts` to document non-fatal proxy skip/fallback diagnostics. |
