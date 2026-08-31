# Claude trust dialog: highlight-aware accept

Fixes #705. Package half: claude-code-headless PR (branch `fix/trust-dialog-highlight-aware-accept`).

## Problem

Claude Code 2.1.251 changed the folder-trust dialog. The old dialog was a numbered
list with "Yes, I trust this folder" first and pre-highlighted (`❯ 1. Yes, I trust
this folder`), so a bare Enter accepted. The new dialog is unnumbered, lists
**"No, exit" first, and pre-highlights it**:

```
 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
```

Every accept path we own writes a bare `'\r'` on the explicit assumption that Yes
is highlighted (`TrustDialogParser.TRUST_DIALOG_ACCEPT_KEYS`, the
`claude.trust-dialog` condition action, `TrustDialogModal`, and the legacy
`trust_dialog` event's `accept`, whose `reject` also writes a now-meaningless
`'2\r'`). Result recorded in debug bundle `2026-08-30T23-51-06-471-9bd68e14`:
clicking "trust this folder" confirms *No, exit*, the CLI exits ~300ms later,
trust never persists, and the dialog returns on every start. Downstream, every
send fails with "Cannot deliver prompt: … is not a live agent session".

## Design: act on what is on screen, never on an assumed layout

The keystrokes stop being static data. Accept becomes a **custom condition
action** resolved by a headless driver (same architecture as AskUserQuestion's
`resolve` slot): observe the live screen, move the highlight to the target if
needed, verify each step, then confirm — and **fail closed** (no blind Enter)
whenever the highlight cannot be proven, because a wrong Enter is session-fatal.

### claude-code-headless

1. `parsers/TrustDialogParser.ts` — extract the real on-screen option rows:
   order, label (tolerating the legacy `N. ` numbering prefix), and which row
   carries the `❯` highlight pointer. `TrustDialogState.options` becomes
   `{ key, label, highlighted }[]` in screen order (keys stay positional for
   wire compat). Delete `TRUST_DIALOG_ACCEPT_KEYS` — a constant accept keystroke
   is the defect.
2. New `conditions/trustDialogDriver.ts` — `driveTrustDialog(intent, ctx)`
   mirroring the AUQ driver: re-detect from `ctx.snapshotPlain()`; if the target
   ("Yes, I trust this folder") is highlighted, write `'\r'`; else write one
   arrow key toward it, poll until the parser proves the highlight moved, then
   `'\r'`; finally poll until the dialog is gone. Structured failures
   (`option-not-found` / `timeout` / `aborted`) conforming to the existing
   `DriveResult` union; decline writes `'\x1b'` (the dialog states "Esc to
   cancel"; upstream maps cancel to exit).
3. `conditions/trustDialog.ts` — accept action becomes
   `{ kind: 'custom', id: 'accept', name: 'claude.trust-dialog.accept' }`;
   decline stays pty `'\x1b'`; module gains `resolve` routing that name to the
   driver.
4. `ClaudeCodeHeadless.ts` — legacy `trust_dialog` event callbacks route through
   the same driver (accept) and `'\x1b'` (reject, replacing `'2\r'`).

Tests are built from the recorded screens: the 2.1.251 dialog captured in the
incident bundle (path swapped for a neutral one) and the legacy numbered layout
already present in `ScreenParser.composer.test.ts`. Driver tests pin write
*order* against scripted screen sequences: never `'\r'` while "No, exit" is
highlighted; arrow-then-Enter on the new layout; Enter-only on the old; no
writes at all when no highlight is provable.

### agent-code

1. Bump the `packages/claude-code-headless` gitlink; resync `package-lock.json`
   (file: dep embeds the package tree).
2. `TrustDialogModal.tsx` — buttons stop synthesizing raw bytes; props become
   `onAccept`/`onDecline` and `views.tsx` dispatches the condition actions
   (custom accept → `session:resolveCondition` → headless driver; pty Esc for
   decline) through the existing outlet dispatch.
3. `providerConditions.ts` — `ClaudeTrustDialogState.options` gains the optional
   `highlighted` field to match the parser.
4. Renderer test pinning that accept dispatches the custom action and never a
   raw `'\r'`.

## Out of scope

- #706 (never-owned sends to restored sessions — composer-send wake) is a
  separate branch/PR.
- Permission/resume prompts still use static keystrokes; no evidence they
  regressed on 2.1.251 (their layouts still parse), but they inherit the same
  risk class. Noted in #705; not changed here.

## Verification

- Package: `npx tsc --noEmit` + vitest suite.
- Parent: `npx tsc -p tsconfig.node.json --noEmit` and `-p tsconfig.web.json`
  (build/vitest do not typecheck), targeted renderer/conditions suites.
