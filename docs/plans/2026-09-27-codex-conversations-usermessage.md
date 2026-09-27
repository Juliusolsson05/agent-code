# Codex 0.157 prompts survive the conversation catalog's no-index fallback (#1363)

## Evidence
- **The fallback reader.** Without a usable `state_N.sqlite` (missing, failing schema validation, or a rollout the index does not cover), `CodexConversationSource` reads each rollout's head with `readRolloutHead`. That took prompt text ONLY from `event_msg:{type:"user_message"}`.
- **What 0.157 writes instead.** 120 recent local 0.15x rollouts all carry `event_msg:item_completed` with `item.type: 'UserMessage'`: 149 items, each `content: [{type:'text', text, text_elements}]`. None carries a legacy `user_message`. The issue's census found 233 of 233 0.157.x files without the legacy event.
- **Effect.** Every 0.157 row on the degraded path had `userTexts: []`. It was classified `empty` and hidden from the default listing, or lost its label and user activity.

## Change
`readRolloutHead` also reads `UserMessage` items: the joined text parts, with their record timestamp as user activity.
- **Why the item, not the role-user `response_item`.** Codex builds the item only for what the user sent. The injected AGENTS.md and environment context are role-user response items too, and the item leaves them out, as the index does.
- **Why a file uses one carrier.** Legacy events and items are collected apart. A file with any legacy event uses those alone, so a rollout carrying both shapes never lists its prompt twice.

## Tests (`codex.userMessage0157.test.ts`)
The fixture `testing/fixtures/conversations/codex-0157/typed-prompt-head.json` is a real 0.157.1 rollout head: `session_meta`, three role-user response items (AGENTS.md, context, the prompt) and the first typed prompt's `UserMessage` item. Text is redacted to the same length. It runs through the real `CodexConversationSource`, with no index beside it.
1. The row's `userTexts` is exactly the typed prompt, not the injected context, and user activity is set. Red on main (`[]`).
2. The same head plus a legacy `user_message` for the same prompt lists it once. Listing both carriers fails this test.

## Reviews a and b (round 1)
- **Carriers merged, not "legacy wins".** A file with both carriers can hold a prompt only the items have. Both are read in file order, and the same prompt written by both counts once: each carrier consumes a pending match from the other. These are the two carriers Codex's own index reads (`rust-v0.157.1 state/src/extract.rs`).
- **Activity from the tail.** When the 200-record head is truncated, a bounded 512 KiB tail pass takes the newest user timestamp. In 33 of 61 local 0.157.0 files a later prompt lay past the head, one 46.8 h later. `headTruncated` is set as for Claude and Pi.
- **Text and images.** Parts are joined with no separator, as Codex's `UserMessageItem::message()` does. An image-only message reads `[Image]`, Codex's preview text.
- **Comment narrowed.** Older CLIs' UserMessage items can hold injected context or command wrappers. The index lists those too, and `firstUnwrappedPrompt` and classify decide what labels a row.
- **Fixture rebuilt as a CONTIGUOUS real head.** It holds all 10 records from `session_meta` through the first UserMessage of the one local 0.157 file whose first prompt is typed. The expected length and timestamp are recorded independently in the fixture. Composed cases say they are composed.
- **Filed, not fixed here (pre-existing):** #1418 (0.149–0.151 rollouts with no prompt event) and #1419 (search matches injected context).

## Verification a (round 2)
- **The tail pass missed prompts far back.** In 10 of 46 local 0.157 files with a prompt past the head, that prompt lay wholly before the last 512 KiB, and a record straddling the window's start was dropped. The reader now scans BACKWARD in 512 KiB chunks, carrying each cut line into the next (earlier) chunk, until it finds a user record. It is bounded at 32 MiB, runs only for truncated heads, and is cached by mtime.
- **De-duplication collapsed a prompt repeated in a later turn.** A cross-carrier pair is now matched only within 4 records, since Codex writes the two carriers of one prompt back to back. No local file has both carriers, so there was no recorded distance to calibrate against.
- **Fixture label.** The fixture's `session_meta.cli_version` is 0.157.0; the label is corrected.
- **Tests (red on the previous commit):** a prompt followed by 4 MiB of output; a prompt whose line straddles the last chunk boundary, laid out deterministically; a prompt repeated in a later turn. Dropping the carried partial line fails the straddle test.

## Verification a (round 3)
- **The exact reported repeat (two records on, 48 h later) still paired.** The pair window is now records AND time: at most 4 records apart and at most 5 s apart. One prompt's two carriers share its instant.
- **A user line longer than two read chunks was lost.** A window with no newline is all one line, so all of it is carried to the next, earlier chunk, and nothing is parsed or dropped.
- **One of 452 files has its newest prompt 55.8 MB from the end, past the 32 MiB bound. Kept by design.** This is the degraded no-index path, rollouts reach gigabytes, and an unbounded scan per discovery is exactly the store-sized cost the head limit prevents. The WHY comment says so.

## Verification b (at bb183091)
- **A pair crossed an intervening prompt** (`repeat`, `different`, `repeat`, seconds apart). Fixed: a carrier pairs only with the IMMEDIATELY previous user record, which must be the other carrier, within 4 records and 5 s. Test: `start, repeat, different, repeat` keeps all four. It is red on `456e6e1b`.
- **The 32 MiB residual** (the same one file) is the deliberate bound documented at `456e6e1b`.
