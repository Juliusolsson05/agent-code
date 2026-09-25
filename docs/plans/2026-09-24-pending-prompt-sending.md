# Lock the composer and show the prompt as "Sending…" in the feed

Issue: #1181

## Problem

Pressing Enter in an agent composer leaves the prompt sitting in the composer,
still editable, until the provider accepts it. For Claude that acceptance is
main seeing the prompt land in the JSONL transcript, which can take seconds. The
only signals that anything happened are the Send button turning into `…` and a
`Sending` chip. Claude also paints no user row until the committed transcript
row arrives, because it never had an optimistic row
(`usesOptimisticUserEcho: false`). The result reads as "my Enter did nothing",
and the editable draft invites a second Enter or edits to text that is already
on its way.

## Behavior

1. **Enter locks the composer.** While `promptDelivery.kind === 'sending'` the
   textarea is read-only and dimmed, and editing keys, history recall, slash
   mode, paste, type-to-focus and paste-to-focus are ignored. So are Escape and
   Ctrl+C: main refuses raw writes for the whole main-owned delivery, so they
   could not reach the agent anyway (review finding, see below).
2. **The text moves into the feed.** The composer VIEW is emptied on Enter (the
   draft stays in the store), and the prompt appears at once as a user row at reduced opacity with a
   `Sending…` caption. When the provider accepts it, the row goes to full
   opacity (echo providers) or is handed to the committed row (Claude).
3. **"Sent" means the provider accepted it** (decision A): Claude's JSONL
   acknowledgement, OpenCode's HTTP handoff, Codex's completed PTY writes. This
   matches the point where `promptDelivery` already leaves `sending`.
4. **Every provider** gets the pending row (decision B). Claude gets it from a
   new pending-only optimistic entry that lives exactly as long as the send.
5. **Queued behind a running turn** (decision C): the composer unlocks on the
   queue acceptance. For Claude the pending row is removed and Claude's own
   queue-operation strip shows the prompt. Codex and OpenCode already put
   mid-turn prompts in the queued strip instead of the feed, which is unchanged.
6. **Failure** puts the prompt back. On any failed send the pending row is
   removed and the lock lifts, which makes the still-stored draft (text and
   images) visible again. The existing `uncertain` banner still blocks a plain
   resend when something may have reached the provider.

## Design

- **Composer.** The draft stays in the store for the whole send. TileLeaf
  hides it from the composer view while locked, and on acceptance
  `draftAfterAcceptance` strips the sent prompt, keeping text another writer
  (dictation, templates, reply-to-selection) added at either end.
  `ComposerInput` gains an optional `locked` prop (the phone client does not
  pass it). `submitCurrentDraft` also refuses while `sending`, because the
  per-mount in-flight ref does not survive a remount.
  *Revised in review:* the first version cleared the store at Enter and
  restored it on failure. That lost the prompt on a renderer reload mid-send
  (autosave persists only `draftInput`), and restored a failed prompt into a
  retired session after a replacement (only current draft fields transfer).
- **Pending identity.** `promptDelivery.sending` carries the submission id
  (`pasteId`). The optimistic entry uuid becomes
  `optimistic-codex-user:<submissionId>` when a submission id exists, so the
  row that is still sending can be named exactly. Previously it was
  `Date.now()`, and nothing parsed the suffix.
- **Claude pending row.** New `addPendingPromptEntry` /
  `removePendingPromptEntry` actions append and remove a plain optimistic entry
  with that uuid. They deliberately do NOT reuse `addOptimisticCodexUserEntry`:
  its mid-turn branch writes `queuedMessages`, which for Claude is owned by the
  queue-operation reducer. The entry is removed on acceptance (any kind) and on
  failure.
- **Order barrier in main.** Claude's acceptance is main seeing the JSONL line,
  but that line waits in the JSONL coalescer until the next `setImmediate`,
  while the invoke reply resumes in a microtask. The `session:deliver-prompt`
  handler now calls `flushJsonl(sessionId)` before replying, so the committed
  row always reaches the renderer before the acceptance that removes the
  pending row. Without it, the prompt blinked out of the feed.
- **Painting.** Feed gets `pendingEntryUuid`, and the matching `entry` item is
  drawn at reduced opacity with a `Sending…` caption. Ledger rows, ordering and
  ownership are untouched by the pending flag, so the identity-cache contract
  (D11) holds.
- **Repeated-prompt ownership fix (in blast radius).** `userTextKeys` was a
  set, so a committed `continue` from an hour ago "owned" a new optimistic
  `continue`, and the new row vanished instantly. It becomes a map from key to
  the newest committed timestamp. An optimistic row is owned only by a committed
  user row at or after its submit time, minus a small clock tolerance. Rows
  without timestamps keep the old presence rule, which leaves Grok (whose
  mapper emits no timestamps) on the old behavior.
- **Pasted prompts.** A committed user row's ownership key is the inner text
  of Claude's `<pasted_content>` envelope (`unwrapClaudePastedContent`, the
  same strict unwrap main uses for acceptance), so a pasted prompt's pending
  row is owned by its committed twin instead of painting beside it.

## Not in scope

- The `Sending` WorkIndicator chip stays. It is driven by `streamPhase` and
  carries the elapsed clock, while the row caption is about the prompt itself.
- Remote-companion and MCP prompts go through main, not the composer, so they
  get no pending row.

## Verification

- Unit: `draftAfterFailure`, ownership (a repeated prompt is not owned by an
  older committed twin but is owned by a newer one).
- Renderer: the composer is read-only while sending, and the pending entry
  renders dimmed with the caption.
- `npx tsc -b`, then the full vitest run once at the end.
