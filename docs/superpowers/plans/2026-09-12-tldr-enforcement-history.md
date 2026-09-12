# TLDR enforcement and per-agent history

Issue: #917

## Problem

TLDR reporting relies on agents following instructions, and they skip it —
most visibly the initial goal and the final outcome. Each update also overwrites
the last, so there is no record of how an agent's status evolved.

## Decisions already made with the user

- Block at turn end only when the TLDR was never written, or when the turn used
  tools and the TLDR was not updated since that turn's prompt. Never block a
  pure-chat turn. At most one block per turn.
- Claude and Codex now. OpenCode keeps instruction-only reporting.
- History ships in the same PR: newest 100 entries per agent, exact repeats of
  the latest entry skipped, opened by a View TLDR History command.

## Enforcement design

### One endpoint, two transports

The built-in MCP HTTP host gains `POST /hooks/tldr/<event>` for
`user-prompt-submit`, `post-tool-use` and `stop`. It authenticates with the same
per-session bearer registration as `/mcp`, so a hook can only ever read or
change its own session's enforcement state, and revocation on reload applies
exactly as it does to MCP writes. The body is the provider hook input; the
response is provider hook output JSON.

- Claude: native `http` hooks injected through the launch-only `--settings`
  source Agent Code already uses. The header reads the bearer from an env
  variable listed in `allowedEnvVars`, so it never appears in argv.
- Codex: a `command` hook running `curl -fsS -H @<0600 header file>
  --data-binary @- <url>`. The header file mirrors the private Claude MCP config
  file's lifecycle. `-f` makes endpoint failure fail-open: no output, no block.
  Chosen over an `mcp_tool` hook because hook-only tools would also be listed to
  the model.

### Codex trust without the global bypass

Codex runs a non-managed hook only when `hooks.state.<key>.trusted_hash` matches
its normalized hash, and it reads that state from the session-flags layer. Agent
Code injects both the hook and its trust entry through `--config`, computing the
hash exactly as `codex-rs/config/src/fingerprint.rs` does: sha256 over the
key-sorted JSON of `{event_name, hooks:[normalized handler]}`. It never passes
`--dangerously-bypass-hook-trust`, which would trust the user's own hooks too.

If Codex changes that normalization, the hook silently stops running. The health
signal below exists so that failure is visible instead of silent.

### Enforcement state and rules

Main keeps per-registration, in-memory state: prompt time, whether a tool ran
since that prompt, whether this turn already blocked, and when a hook last made
contact. The TLDR store supplies when the identity was last written.

- `user-prompt-submit`: record the prompt time and reset the per-turn flags. If
  the identity has never been written, return `additionalContext` asking for the
  session goal first.
- `post-tool-use`: mark tool use for this turn. Codex runs it async so tool calls
  never wait on it.
- `stop`: allow when `stop_hook_active` is set or this turn already blocked.
  Block when never written. Block when tools ran and the last write predates the
  prompt. Otherwise allow.

### Health signal

Main records hook contact per identity. The TLDR footer shows a small "Reporting
check inactive" note only for a TLDR-enabled Claude or Codex session that has
completed a turn without any hook contact. OpenCode shows nothing.

## History design

Each accepted write appends to a per-identity history file under the TLDR
directory, named by a hash of the identity. Separate small files keep each
update's atomic rewrite small; one shared document would grow to megabytes and
be rewritten on every update. The newest 100 entries are kept, an exact repeat
of the latest text is skipped, and a global cap on history files evicts the least
recently written. A read-only `tldr:history` IPC mirrors the existing window
validation. The command opens a surface in the same pattern as View Prompts.

## Skill

`TLDR_INSTRUCTIONS` adds: set the TLDR to the goal on the first substantive
prompt, before starting work. The managed-skill reconciler redeploys changed
markdown automatically.

## Verification

- Hook endpoint through the real HTTP host with real bearer scopes: each rule,
  cross-session isolation, revocation, and fail-open on bad input.
- Launch arguments for Claude and Codex, including no bearer in argv and no hooks
  without the TLDR domain.
- The Codex trust hash against a vector derived from the installed Codex binary.
- History bounds, deduplication, eviction, and the command and surface.
- Deliberate-regression checks for the block rules and the hash.
- Full `npm run check`, then review and CI.

## Constraints

Never launch the Agent Code app for verification. Never edit user or project hook
files. Never trust the user's hooks on their behalf. Do not merge without
authorization.
