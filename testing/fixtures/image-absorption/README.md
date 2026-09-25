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

Two of the three image deliveries in that bundle, from **one pane and one
session**, 2 m 17 s apart, recorded as real `baseline`/`after` pairs —
`baseline` is the last screen sample before Agent Code wrote the prompt, and
`after` is the frame whose composer the absorption poll was reading. (The third
delivery, 22:06:40.807, never reached absorption: it was refused
`not-ready/before-write` in 18 ms because a draft was already in the composer.)

| delivery | composer `after` | `submit.result` |
|---|---|---|
| `wrapped` | `❯ … opencode [Image` ⏎ `  #1]` | `absorption-timeout`, `bodyWritten: true`, `enterWritten: false`, `retryable: false`, 5027 ms |
| `unwrapped` | `  [Image #2]` on its own line | `ok: true`, `acceptance: "queue"`, 160 ms |

The pill has exactly one internal space, and that is the only place a soft wrap
can break it. In `wrapped` it broke there; in `unwrapped` it did not.

Be precise about what else differs, because an earlier version of this file
claimed "nothing" and a review disproved it point by point:

- the prompts take **different routes** — `wrapped`'s is 51 chars (written raw,
  no text-absorption poll, plus a separator), `unwrapped`'s is 120 (bracketed
  paste through `pollPasteAbsorbed`, no separator);
- Claude was **idle** for `wrapped` and **mid-turn** for `unwrapped`, which is
  why the latter was accepted as `queue` rather than `user`;
- the pane was **resized from 64 to 120 columns** at 22:08:45, between the two.

What that leaves is still the point: both deliveries got their text into the
composer, so the stage that decided their fate was image absorption alone, and
there the only difference was where the space fell. The resize actually
strengthens it — at 120 columns the same stranded `[Image #1]` renders
unwrapped, which is the bug's whole shape in one pane.

That is why the failure looked intermittent rather than like a broken feature,
and why these two frames are kept together: a fix that only handles `unwrapped`
is the bug.

The *text* half of the same protocol was only half-immune, and an earlier
version of this file got that wrong: `pasteAbsorbedVia`'s inline-tail branch
normalized, so INLINED pastes survived a wrap, but its placeholder branch
matched the raw screen exactly as the image counter did — so a **collapsed**
paste could be lost the same way. #1113 normalizes both counters. The inline
tail has a different, still-open weakness (hard wraps inside long tokens):
#1118.
