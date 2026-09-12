# Auto-follow working agents

Status: Implemented. Refs #938; implementation and verification results are tracked in PR #939. The 79 focused tests, test contract, and keybinding checks pass.

Add `Auto-follow All Working Agents` beside the existing follow commands. This is a transient window-wide policy: eligibility changes with each agent's activity, without rewriting individual follow preferences. Starting work follows immediately; returning to idle releases the forced follow. Use the existing running-session or non-idle-stream signals, with exited/failed sessions excluded. Plain shells do not participate.

1. Add the transient UI-shell toggle and command context plumbing. Enabling either bulk-follow mode disables the other so choosing Working actually filters an existing All Visible policy.
2. Share effective agent-follow policy between rendered feeds, raw agent terminals, focused command state, and control preference reporting. Keep the existing subtree visibility masks and per-agent flags. Follow remains local to mounted views; do not enumerate, wake, or rearrange agents.
3. Add meaningful coverage for activity transitions, hidden/raw-terminal views, plain-shell exclusion, preserving individual preferences, mutually exclusive modes, and command/control reporting.
4. Run focused tests, keybinding/test contracts, type checks, and build verification; inspect the final diff and open a PR linked to #938. Do not merge.

No persistence migration or default shortcut is needed. Existing scroll restoration belongs to the feed/terminal follow implementations and remains the source of truth.
