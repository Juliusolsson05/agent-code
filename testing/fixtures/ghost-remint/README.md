# ghost-remint (#730)

`claude-tool-use-remint.ghost.jsonl` holds every record, unedited, that one live Claude session wrote for a single ghost uuid (`g-msg_011CeqUioX694UZnQ6y1tC98-2`, a Bash `tool_use`). It was copied from `~/Library/Application Support/agent-code/ghost-logs/0219ff65-….ghost.jsonl` on 2026-09-25.

The timeline, from `_atp`:

| # | updatedAt offset | state |
|---|---|---|
| 1–3 | 0 / +164 ms / +617 ms | minted, then streamed input |
| 4 | +2.9 s | superseded by the committed JSONL entry |
| 5 | +8.9 s | minted AGAIN, with a fresh `createdAt` and no `supersededBy` |
| 6 | +38.9 s | orphaned (30 s TTL) |

Record 5 is the bug: `gcSupersededGhosts` evicted the superseded ghost 5 s after supersedure, while its turn was still `semantic.currentTurn` (the Bash tool was running). On the next semantic tick, `ghostsFromSemanticTurn` re-created it.

The same scan over all 1,955 logs on this machine found 3,231 such re-mints in 419 logs: 2,128 Codex and 1,103 Claude; 3,010 were `tool_use`. 3,226 of them were later orphaned. The minimum supersede-to-re-mint gap was 5,040 ms, which is the 5 s GC grace plus the 1 s sweep.
