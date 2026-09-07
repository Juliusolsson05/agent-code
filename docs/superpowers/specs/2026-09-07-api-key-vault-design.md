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

Every secret-leaving path (reveal, copy, template ref resolution) funnels through one `ensureUnlocked()`. Production wires `promptAuth` to `systemPreferences.promptTouchID`, which presents Touch ID with the login-password fallback (the "mac password" requirement). Unsigned dev builds may skip biometry; the password path still works. If prompting is impossible, the vault fails closed — no secret leaves main. Snapshots never contain secrets; revealed plaintext exists only in ephemeral renderer component state.

### D3 — Renderer-owned `deliverTextToSession` (chosen over main-owned paste IPC)

One helper dispatches by session kind + effective surface (`getEffectiveAgentSurfaceForSession`): rendered agent panes append to the composer draft via `setDraftInput`; plain terminals and agent terminal views write a bracketed paste (`ESC[200~ … ESC[201~`, no Enter) through `window.api.sendInput` — the same channel both surfaces already use for keystrokes — after a lazy-wake when the backend is missing. The renderer owns focus/workspace/surface context; main stays provider-agnostic. Bracketed-paste markers keep shells from executing multi-line payloads; the trade-off (programs that never enabled the mode print the marker bytes) is accepted over raw newlines, which shells would run immediately.

### D4 — Template key references by name, resolved pre-fill

`{{key:Provider Name/Key Name}}` (grammar deliberately disjoint from `{{variable}}`, so refs never become fill-pane fields). Names over ids keep templates readable; renames break references loudly. Resolution happens before variable fill so secrets never render in the fill pane; any unresolved ref aborts insertion with a toast naming all failures. Renames of providers/keys are uniqueness-checked to keep references unambiguous.

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
- Bracketed paste into programs that never enable the mode shows marker bytes — documented trade-off (D3).
- Renaming vault providers/keys breaks template references by design; failures are loud, never silent.
