# Codex: pre-trust the spawn folder on disk

Fixes #714. Package half: codex-headless PR #45 (`ensureCodexProjectTrust`).

## Problem

Driving Codex's trust dialog with keystrokes produced four production failures
in one day (#705 #711 #712 #713): inverted accept bytes, invisibly refused
clicks, the wake readiness timeout killing a live CLI that was waiting on its
own dialog, and an app-hostage modal. One root: the dialog exists at all for
sessions the app spawns into a folder the user explicitly chose.

## Design

The user's folder choice IS the trust decision. Record it where Codex records
it — `[projects."<path>"] trust_level = "trusted"` in `$CODEX_HOME/config.toml`
(format verified against the live config and codex-rs `set_project_trust_level`)
— BEFORE the PTY spawns, so the dialog never appears.

The knowledge lives in codex-headless (`ensureCodexProjectTrust`: append-only,
existing entries never modified, inline `projects = {}` stands down, never
throws — the dialog condition/modal stay as fallback). agent-code calls it once
in `CodexSession.start()`, early in the start attempt (well before the
"config/read must remain the final await before spawn" invariant), covering
fresh spawns, recover/wake respawns, orchestration children, and worktree cwds
at the single spawn site. The result is deliberately not allowed to block or
fail the spawn.

## Out of scope

- Claude parity (`hasTrustDialogAccepted` in `~/.claude.json`) — follow-up per
  #714's note; the #705 dialog driver keeps Claude covered meanwhile.
- #711/#712/#713 remain open for the dialog-fallback path (externally created
  configs, inline-table users); this feature makes them unreachable for the
  normal case rather than fixing the fallback's own defects.

## Verification

Package: 196/196 + contract + typecheck (PR #45). Parent: tsc node + web,
codex runtime suites under NODE_ENV=development.
