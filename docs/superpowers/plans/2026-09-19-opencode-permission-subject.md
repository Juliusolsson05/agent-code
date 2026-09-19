# OpenCode permission and question subjects: plan

**Issue:** #878 (release blocker; OpenCode is bundled, so this is the default path).
**Branch:** `fix/opencode-permission-subject` from `origin/main`.
**Package half:** Juliusolsson05/opencode-headless#14, MERGED (`62440add`). It adds one
shared subject parser, tested on recorded 1.18.30 streams, and bash subjects show the
whole command.

## Problem

The structured runtime's permission modal read "OpenCode is requesting permission."
with no subject, so users approved `bash: ls -1` blind. The question modal showed no
question. The package fix restores both. The app then has to render them safely,
because they are now populated for the first time. The package PR's review found two
problems that only this app can fix:
1. **A long subject overflows the modal.** A heredoc or a long `python3 -c` command
   renders inline in a `<p>`, and `DialogContent` has no max height. The buttons go
   off-screen, and the auto-focused "Allow once" answers Enter.
2. **"Allow always" looks scoped to what is shown, but is not.** `edit`, `write` and
   MCP asks send `always: ["*"]`, so "Allow always" next to `edit: src/a.ts`
   actually allows every edit for the session. OpenCode's own UI confirms the scope;
   ours showed nothing.

## Change

- Bump `packages/opencode-headless` to `62440add`.
- `views.tsx`:
  - render the subject in a scroll-contained `<pre>`
    (`max-h-[40vh] overflow-auto whitespace-pre-wrap break-words`), untruncated,
    because this modal is the only place the user sees the command;
  - show what "Allow always" covers, from `metadata.always`, saying plainly when it
    is `*`.
- Out of scope: answering questions. Options are in
  `metadata.questions[].options`, but the only action is Reject; that is a follow-up
  issue.

## Test (fail-first, recorded input)

`opencodePermissionView.renderer.test.tsx` replays the RECORDED 1.18.30 stream
(`packages/opencode-terminal-headless/testing/fixtures/live/permission-once.json`)
through the real `EventDispatcher` from the bumped package, and renders the real
view with the resulting state. It asserts:
- the full subject is shown, inside the scroll container;
- the recorded `always` scope (`ls *`) is shown next to "Allow always";
- a derived long heredoc command (only `metadata.command` changed) is rendered in
  full inside the same container, never truncated.
