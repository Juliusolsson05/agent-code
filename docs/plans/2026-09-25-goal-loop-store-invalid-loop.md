# One unreadable goal loop must not lose every loop (#1248)

## Verified failure
`GoalLoopStore.read()` rejected the whole document when any loop failed `validLoop`, for example a phase or reason this build does not know. It moved the file to `.corrupt` and threw. `GoalLoopService.start()` catches the throw and runs empty, and its next state write replaces the file, so every loop is lost from the active store. The existing test `rejects structurally invalid entries` pinned that behaviour.

The owner's real `goal-loop.json` holds 13 loops.

## Design
- **Unreadable loop:** set aside; every valid loop is read.
- **Preserved bytes:** the original file is COPIED to the existing `.corrupt` name. It is not moved, because the file still holds the loops just read, and the copy lands before the next write drops the unreadable loop. The single-name "newest wins" convention is unchanged.
- **Malformed container** (version, loops not an object, over the limit): still moves aside and throws, as before.

## Tests
- Two real loops (prompts redacted) with one given an unknown phase: the other survives read, write and reopen, and `.corrupt` holds the original bytes.
- The old whole-file test becomes a set-aside test.
- Red on main; the whole-file, no-copy and move-not-copy mutants all fail.
