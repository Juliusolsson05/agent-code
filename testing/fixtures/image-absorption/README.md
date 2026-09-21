# image-absorption

Recorded Claude composer frames for image-attachment delivery, paired with the
`submit.result` Agent Code actually logged for them.

These exist because the absorption detectors read a **rendered terminal**, not a
data structure. The TUI reflows the composer to the pane width, so the literal
bytes that identify an attachment are not guaranteed to survive as a contiguous
substring — and no hand-written screen literal would ever have caught that,
because whoever writes the literal puts the pill on one line.

## `wrapped-image-pill-2026-09-21.json`

From debug bundle `2026-09-21T22-09-23-834-168b7a32` (the owner's note on it was
*"Sending logic broke"*), Claude Code 2.1.278.

Two image deliveries in **one pane, one session, at one terminal width**, ten
minutes apart, recorded as real `baseline`/`after` pairs — `baseline` is the last
screen sample before Agent Code wrote the prompt, `after` is the frame the
absorption poll was looking at when it decided.

| delivery | composer `after` | `submit.result` |
|---|---|---|
| `wrapped` | `❯ … opencode [Image` ⏎ `  #1]` | `absorption-timeout`, `bodyWritten: true`, `enterWritten: false`, `retryable: false`, 5027 ms |
| `unwrapped` | `  [Image #2]` on its own line | `ok: true`, `acceptance: "queue"`, 160 ms |

The pill has exactly one internal space, and a word wrap can only break there.
In `wrapped` it broke there; in `unwrapped` it did not. Nothing else differs —
same code path, same width, same attachment count. That is why the failure looked
intermittent rather than like a broken feature, and it is why these two frames
are kept together: a fix that only handles `unwrapped` is the bug.

`pasteAbsorbedVia` (the *text* half of the same protocol) has always compared
against `normalizeWhitespace(screen)`, which is precisely why wrapped text sends
never had this problem. `imagePlaceholderCount` did not, until #1113.
