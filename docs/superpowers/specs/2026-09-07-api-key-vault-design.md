# API Key Vault + Session Text Delivery — Design

**Status:** approved design, 2026-09-07
**Issues:** #830 (session text delivery), #831 (API key vault)
**Plan:** `docs/superpowers/plans/2026-09-07-api-key-vault.md`

## Problem

1. Models routinely need third-party API keys (Brave Search, OpenAI, …). Users paste them straight into prompts because they are low-stakes, but every use means a round-trip to the provider dashboard to copy the key again.
2. Prompt templates only target agent composers (`targetSession.ts` returns null for terminal-kind sessions), so templates — and any future key-insertion feature — are useless in plain terminal panes where users run unsupported agent harnesses, and in agent panes switched to terminal view.

## Requirements (confirmed with user)

- Vault: user-created providers (empty start, no seed list), each holding keys with name + secret + note.
- Encryption at rest via the existing safeStorage discipline (`src/main/dictation/apiKeyStore.ts`).
- Unlock gate: Touch ID / Mac login-password prompt once per app launch; "Lock now" re-arms; cancel/unavailable fails closed.
- Consumption: insert into focused pane (composer or any PTY), copy to clipboard, and `{{key:Provider/Key}}` references in prompt templates.
- Terminal delivery is always paste-without-submit (review then Enter), mirroring the templates' "prefill, don't replay" contract.

## Decisions

### D1 — Per-key safeStorage blobs + plaintext metadata index (chosen over whole-vault blob / native Keychain items)

`STATE_DIR/key-vault/index.json` carries providers, key names, notes, timestamps, and last-4 hints (non-secret). Each secret lives in `keys/<keyId>.bin` as its own safeStorage ciphertext. Rationale identical to `apiKeyStore.ts:27-35`: a corrupt blob after a Keychain reset costs exactly one key, never the vault; the provider list renders without touching decryption; edits rewrite one blob, not a monolith. Whole-vault encryption hides metadata but bricks everything on one decrypt failure. Native Keychain items per key were rejected: ACL prompts fire unpredictably and conflict with the once-per-launch gate.

### D2 — Unlock gate in main via `systemPreferences.promptTouchID`, once per run

Every secret-leaving path (reveal, copy, template ref resolution) funnels through one `ensureUnlocked()`. Electron 43.1.0's `promptTouchID` uses `SecAccessControlUserPresence`; unlike `canPromptTouchID`, it is not a biometric-only capability check. Attempt the supported macOS API and fail closed on rejection. The OS authentication UI still needs manual verification on signed/unsigned builds and password-only Macs. Concurrent requests share one prompt. Lock invalidates pending auth and disk reads and broadcasts cache invalidation to all windows. Metadata CRUD/list IPC is gated too.

The vault encrypts stored key values, not the prompt pipeline. Inserted keys follow normal draft autosave into plaintext `workspace.json`, terminal scrollback, and provider transcript retention after submission; copying puts the value on the system clipboard. The modal explicitly discloses this boundary. Names and notes are plaintext metadata; short values do not get a hint that would expose the entire secret. No export, transparent secret-token draft system, or general transcript redaction is promised.

### D3 — Renderer-owned `deliverTextToSession` (chosen over main-owned paste IPC)

One helper dispatches by normalized session kind and effective surface. Rendered panes edit the existing draft; bare key insertion concatenates text, while templates retain their append/replace policy. Terminal insertion uses the mounted leaf's paste target, respecting visibility, attach/replay state and xterm's current bracketed-paste mode. Single-line text works without bracketed-paste support; multiline text is refused unless the program has enabled that mode. Embedded control sequences are refused. No Enter is added, and rejected writes keep the picker open rather than silently retrying into a replacement backend. Wake never follows a disposed or changed terminal target.

### D4 — Template key references by name, resolved at insertion

`{{key:Provider Name/Key Name}}` is disjoint from ordinary `{{variable}}` fields. The fill pane retains the dynamic or saved body with unresolved key references, then `prepareTemplateText` fills ordinary variables and resolves keys only at final insertion. Cancellation or a missing key aborts insertion. Capture the original session, reject changes during asynchronous preparation, and never deliver after closing the palette. Provider/key names exclude syntax delimiters. Renaming breaks references loudly. The external control template API remains a draft-only API and does not expose the vault.

## Rejected / out of scope

- Auto-submit after terminal paste (user review required before execution).
- Remote phone client vault access; MCP/agent access to keys; export/import or cross-device migration (safeStorage blobs are device-scoped by design).
- Seeded provider lists (go stale; user creates what they need).

## Testing

- Unit: vault store (file discipline, corrupt-blob isolation), service (gate semantics, CRUD rules, fail-closed), key-reference collect/resolve/abort.
- Renderer: delivery helper dispatch matrix with stubbed `window.api.sendInput`.
- Manual smoke: Touch ID cancel path, insert into composer vs terminal, template ref resolution in a raw terminal.

## Risks

- `promptTouchID` behavior on unsigned builds: password fallback expected to work; if a platform ever cannot prompt, the vault degrades to unusable-but-safe (fail closed), surfaced in the modal status line.
- Programs without bracketed-paste support cannot safely receive multiline templates; the helper refuses rather than risking shell execution.
- Renaming vault providers/keys breaks template references by design; failures are loud, never silent.
