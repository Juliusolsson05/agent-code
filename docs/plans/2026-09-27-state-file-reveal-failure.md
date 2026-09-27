# Recovery-state actions say when they did not work (#1250 row 14)

Short plan: a bug with a known root cause. The row comes from `temp/quality-loop/hunt-c3.md` (row 14, P3). #1250 is a batch issue, so this PR is `Refs #1250`.

## Outcome
When an Agent Code-managed skill state file is unreadable, three surfaces show a recovery panel with **Reveal State File** and **Reset State**: Settings → Skills (`SkillsGrid`), Conventions, and Custom Skills. A reveal that main refuses (`{ ok: false, message }`, e.g. "No managed skill recovery file exists." once the file is gone), or an IPC that rejects, now shows a message in the panel's row. Today the result is dropped. Reset in Conventions and Custom Skills also gains a rejection handler.

## Root cause (verified in source, origin/main)
- All three Reveal buttons: `void window.api.reveal…RecoveryFile()`, with the `{ ok, message }` answer ignored.
- Conventions / Custom Skills Reset: `void window.api.reset…Recovery().then(applyResult)`. A rejection is unhandled. (`SkillsGrid`'s reset goes through its `run`, which already catches.)
- Main's refusal messages are fixed, curated strings (`src/main/ipc/agentCode{Conventions,CustomSkills,InstalledSkills}.ts`).

## Design (contract)
- **Reveal:** on `{ ok: false }`, the row's existing error state shows main's `message`, or "Couldn't reveal the state file." when it has none. On a rejection, it shows the same fixed sentence. On success, the error is cleared.
- **Reset** (Conventions, Custom Skills): on a rejection, "Couldn't reset the state. Try again." (fixed words; the rejection text is IPC text, q22).
- Each row already renders its `error` as an alert; no new surface.

## Tests (red on main)
- **`AgentCodeConventionsRow.renderer.test.tsx`:** with a recovery snapshot, a refused reveal shows main's message; a rejected reset shows the fixed sentence.
- **`AgentCodeCustomSkillsRow.renderer.test.tsx`:** a refused reveal shows main's message.
- **`Skills.renderer.test.tsx`:** a refused installed-skills reveal shows main's message.

## Out of scope
- #1250's other rows.
- The existing `cause.message` displays elsewhere in these rows (a separate q22 sweep).
