# Provider switches survive pasted images — host plan

**Date:** 2026-09-18
**Branch:** `fix/provider-switch-image-attachments`
**Issues:** #998 (Claude → OpenCode switch fails with `ConversationUnfittableError`),
#999 (OpenCode → Claude switch writes a foreign `file` block, Claude API 400).
**Parser work:** Juliusolsson05/agent-transcript-parser#28, #29 (fixed), #30
(follow-up), on the parser branch of the same name. Its plan is
`packages/agent-transcript-parser/docs/plans/2026-09-18-provider-switch-image-attachments.md`.
**Status:** Implemented, reviewed, tests green. The submodule pointer moves to parser #31's merge commit as the last step before this PR merges.

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
2. Submodule pointer bump for `packages/agent-transcript-parser`: first to the
   parser PR's branch tip so CI exercises the real change, then to parser #31's
   merge commit once it lands (the repository merges with merge commits, so the
   SHA changes). **No lockfile resync**, contrary to this plan's first draft:
   the parser's `package.json` is unchanged, so the tree embedded in the root
   lockfile is still in sync and `npm ci` is satisfied. A trial
   `npm install --package-lock-only` only wanted to drop the nested vitest
   esbuild entries that `859a9f78` deliberately kept, so it was reverted.
3. `src/main/providerSwitch/switchProvider.ts`
   - `describeShrink` reports the new counter as
     `N attachment(s) omitted` so the toast never hides an image loss.
   - `truncatedBeforeSwitch` counts `clearedAttachments` among "the ladder
     removed anything"; the WHY comment that enumerates the rungs is updated
     for the renumbering (attachments are rung 3, inputs rung 4, drop rung 5)
     and for the protection lift.
   - Tests in `switchProvider.test.ts`: `describeShrink` wording, order and
     pluralisation, and one switch through the REAL planner whose only loss is
     an old pasted image (`strategy: 'shrunk'`, `truncatedBeforeSwitch: true`,
     `1 attachment omitted …`) — the only state where `clearedAttachments`
     alone carries the flag, and the only end-to-end proof the host reads the
     planner's new field.
4a. As built after review — the renderer DOES change, contrary to "Out of
   scope" below as first written: the success toast used the two-second
   default and clamps to three lines with the new clauses last, so the
   disclosure this fix adds was unreadable. Lossy switch toasts (pane and bulk)
   now use `LOSSY_SWITCH_TOAST_MS` (10 s), and `describeShrink` leads with what
   the user must act on (`N attachments omitted`, `newest turns trimmed`) before
   the counts in ladder order. All clauses singularise.
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
- Renderer plumbing. The failure already surfaces as a toast with the error
  message; after the fix the same toast carries the shrink summary. (Only the
  toast's duration changed; see 4a.)

## Review round

Two read-only reviewers per PR. No blocking findings. Fixed from the host
reviews: the unreadable toast (duration, clause order), the missing
attachment-only switch test, pluralisation, a stale comment about a
"parenthesized sum", an impossible example report in a test, this plan's
lockfile and status lines, and the documentation gaps — the design doc now
covers the Claude image re-encoding, lists the unproven live behaviour, adds
"never copy a foreign attachment part verbatim" to its warnings, and narrows
the failure-policy bullet; the 2026-09-05 spec gained As-built item 11 because
the parser header cites it. Parser-side findings are recorded in the parser
plan. Merge order is fixed by the pointer: parser #31 first, with a merge
commit, then this PR.

## Verification

- `npx tsc -b tsconfig.node.json` then `npx tsc -p tsconfig.web.json --noEmit`
  (node first; see the verification memory).
- `NODE_ENV=test npx vitest run src/main/providerSwitch` (host suite against the
  bumped parser source through the vitest alias).
- Parser suite green on its own branch (`npm run check`).
- The recorded transcript replayed through the host planner path returns
  `shrunk` under the 288,000 budget (scratch script, not committed).
