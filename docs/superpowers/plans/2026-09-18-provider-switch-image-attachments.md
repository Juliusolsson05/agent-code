# Provider switches survive pasted images — host plan

**Date:** 2026-09-18
**Branch:** `fix/provider-switch-image-attachments`
**Issues:** #998 (Claude → OpenCode switch fails with `ConversationUnfittableError`),
#999 (OpenCode → Claude switch writes a foreign `file` block, Claude API 400).
**Parser work:** Juliusolsson05/agent-transcript-parser#28, #29 (fixed), #30
(follow-up), on the parser branch of the same name. Its plan is
`packages/agent-transcript-parser/docs/plans/2026-09-18-provider-switch-image-attachments.md`.
**Status:** In progress.

## What happened (from the 2026-09-18 debug bundle and incident log)

1. 20:26:50Z — OpenCode session switched to Claude. The pasted clipboard image
   travelled as an OpenCode `{type:'file', …, url:'data:image/png;base64,…'}`
   part and was written into the Claude transcript verbatim (#999).
2. 20:27:15Z — user submits a prompt with a fresh screenshot. Claude Code sends
   the whole history; the API answers
   `400 messages.985.content.1: Input tag 'file' found …`. The session is
   unusable from here on.
3. 20:28:21Z and 20:30:12Z — user switches back to OpenCode. The ladder clears
   256 tool outputs, trims 3 inputs, drops 15 turns and still has a 549,620-
   character final turn (a 15-character prompt plus the 549,526-character
   base64 screenshot), so it throws (#998).

Both defects live in `agent-transcript-parser`; this branch lands them in the
app and adjusts the one host surface that reads the shrink report.

## Scope of this branch

1. Plan (this file) as the first commit.
2. Submodule pointer bump for `packages/agent-transcript-parser` to the merged
   parser fix, with the lockfile resync the `file:` dependency requires
   (`NODE_ENV=development npm install --package-lock-only --include=dev`).
3. `src/main/providerSwitch/switchProvider.ts`
   - `describeShrink` reports the new counter as
     `N attachment(s) omitted` so the toast never hides an image loss.
   - `truncatedBeforeSwitch` counts `clearedAttachments` among "the ladder
     removed anything"; the WHY comment that enumerates the rungs is updated
     for the renumbering (attachments are rung 3, inputs rung 4, drop rung 5)
     and for the protection lift.
   - Tests in `switchProvider.test.ts`: `describeShrink` formatting for the
     new counter, and `truncatedBeforeSwitch` true when only attachments were
     cleared.
4. `docs/design/provider-switching.md` §"The shrink ladder": add the rung, the
   two-pass protection lift, and the report fields. The 2026-09-05 spec keeps
   its "As built" list as written; this is a later fix, not a build-time
   deviation.

## Out of scope

- Changing the character estimate for images (parser #30). Until it lands,
  every switch of a screenshot-bearing conversation to a 128k target will go
  through the ladder and drop the screenshot with a reported loss.
- Healing the already-broken Claude session `db56a074`. Its way out is the
  Claude → OpenCode switch this branch makes work.
- Renderer changes. The failure already surfaces as a toast with the error
  message; after the fix the same toast carries the shrink summary.

## Verification

- `npx tsc -b tsconfig.node.json` then `npx tsc -p tsconfig.web.json --noEmit`
  (node first; see the verification memory).
- `NODE_ENV=test npx vitest run src/main/providerSwitch` (host suite against the
  bumped parser source through the vitest alias).
- Parser suite green on its own branch (`npm run check`).
- The recorded transcript replayed through the host planner path returns
  `shrunk` under the 288,000 budget (scratch script, not committed).
