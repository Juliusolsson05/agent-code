# A Claude prompt Agent Code stranded in the native composer is reclaimed, not treated as a human draft (#1350)

## Problem
A Claude delivery writes the prompt text, then waits up to 5 s for it to become visible (absorption). While Claude is busy mid-turn it may not paint the composer. Absorption then times out, and `rollbackWrittenPrompt` watches for about 0.4 s to see our bytes before it may kill them. If it never sees them it returns `unrecoverable` (`rollback-unobserved`), and the delivery reports `absorption-timeout` / `do-not-retry` / "composer could not be recovered".

The bytes then paint. The gate (`claudeSession.derivePromptGateState`) reads any drafted composer as `occupied: human-draft`, deliberately with no timeout, so every later delivery is refused as "occupied by a human draft". The session is unreachable for orchestration until a human clears the composer. Nothing records that the "human draft" is our own stranded prompt.

## Evidence (recorded)
**Control history** (`~/.config/agent-code/control-history`):
- `c7eb1822`: session e41b2b15, absorption-timeout, `promptWritten: true`, "could not be recovered".
- Four `ac_agents_prompt` calls (`a0a85f4e`, `6bc085b8`, `d2ceab7a`, `5f9b16e0`) to session a835d518 were refused as "occupied by a human draft" over about 50 minutes. `draftGet` showed an empty Agent Code draft; `inputInspect` showed `nativeDraft.state: occupied`.

**Lifecycle journal** (`incidents/runs/.../events.jsonl`), three stranding incidents:
- **a835d518:** a 1,518-byte delivery write, no submit, at 02:04:05.9 (a goal-loop continuation; the loop paused with `consecutiveDeliveryFailures: 1`). Occupied from 02:04:11.5, never ready again.
- **e41b2b15:** a 180-byte write around 03:16:44.5; occupied at 03:16:53.9, 3.8 s after the failure returned.
- **3fbf42d1** (orchestration send-prompt): a 174-byte write at 02:01:29.9; failed 02:01:35.5; occupied at 02:01:36.2.

In all three, the composer turned occupied 0.7–3.8 s after the delivery gave up: the bytes painted after the ~0.4 s observe window.

**Paste-debug journals** (renderer-originated deliveries only): 7 `rollback-unobserved` out of 13 rollbacks.
- Plain (22–82 chars) and paste-like (145–380 chars) alike.
- Every one reached the unobserved verdict 5.6–5.7 s after the write (the 5 s absorption timeout plus the observe window).

## Decision: ownership proven structurally, never by comparing text
`rollbackWrittenPrompt` records why text matching cannot prove ownership (#679): the screen is viewport-clipped and wrap-lossy, and paste-like input collapses to `[Pasted text #N]`. The proof it uses instead is structural: while a delivery holds the reservation, no other writer can reach the PTY. This change extends that proof across the gap between two deliveries.
- **The mark.** `SessionManager` keeps a per-session "stranded delivery" mark. It is set when a delivery ends with `promptWritten: true, enterWritten: false` and not ok: our bytes are, or may soon be, in the native composer.
- **What clears the mark.** Every PTY writer goes through `recordInputWrite`. Any write whose origin is not `delivery` clears it: raw terminal typing, remote input, dictation, a condition answer. From then on the composer may hold someone else's text. The mark also clears on process exit or cleanup and on a successful delivery.
- **Reclaiming.** The next delivery gets `strandedComposer: true` while the mark stands. If Claude's gate then says `occupied`, the delivery holds the reservation, so nothing else can write, and everything in the composer is ours. It clears the composer with the existing verified kill loop: one Ctrl+U per PTY read, stopping on a verified-empty read, yanking back if it runs out. Then it re-awaits readiness and continues normally.
- **Fail closed.** If the kill loop cannot verify an empty composer, it yanks the text back, as the rollback does, and the delivery is refused with a message naming the stranded prompt rather than "a human draft".
- **Inspection.** `sessions.inputInspect`, via `ac_agents_input_inspect`, reports `nativeDraft.strandedDelivery: true` while the mark stands, so a caller can tell our stranded write from a human draft.
- **Out of scope.** The image-pill path still does not roll back (documented in `promptDelivery.ts`), and nothing is recovered for sessions stranded before this change.

## Tests
- **Delivery:** a stranded mark plus an occupied composer that clears under the kill loop leads to a successful delivery. Without the mark, the same state is refused as a human draft, as today. A composer the loop cannot clear is yanked back and refused with the stranded message.
- **SessionManager:**
  - A failed delivery with `promptWritten && !enterWritten` sets the mark, and the next delivery receives `strandedComposer: true`.
  - A raw `write()` in between clears it, as does exit.
  - `inputInspect` reports it.
- All red on main.

## Round 1 review decisions (#1358)
- **a (blocker, steering q75) and c: the mark was keyed by session id only.** A delivery to process A that failed after A exited, and B had taken the same id, marked B. The next delivery then cleared B's composer, possibly a human draft. The mark now names the registry entry the delivery captured. It is set only while that entry still owns the id, and honoured only for that same entry. Test: A exits, B holds a human draft, A fails late. B gets no mark and no kill. Red on `c41614b4`.
- **c: a delivery inside the paint lag skipped the reclaim.** The recorded paint lag is 0.7–3.8 s after the failure. A delivery starting inside it saw an empty, ready composer and wrote next to the late-painting bytes. While the mark stands, the delivery now polls, still holding its reservation, for up to 8 s after the strand. If the text appears it is reclaimed; otherwise nothing of ours is there. Test: the text paints 2 s into the next delivery and is cleared first. Red on `c41614b4`.
- **a and c: image deliveries.** Whether Ctrl+U removes an image pill is unobserved, so an image delivery that strands is not marked and never reclaimed. Test added. #1350 is narrowed to text strands; the image path is a linked follow-up issue.
- **Surviving mutants:** a thrown write that strands, and the exit clearing the mark, now have a test.
- **Suspicions kept as residuals:**
  - headless-internal writers (trust, resume, permission) that bypass `recordInputWrite`: no app consumer was found;
  - a mark set after a throw before any bytes crossed: harmless, since the next gate reads ready and nothing is killed.
