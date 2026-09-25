# Agent Completion Indicator

Refs #1172.

## Goal

An on-by-default setting. When an agent finishes and you haven't looked at it yet, its pane
header is drawn with diagonal stripes in the accent (activity) colour. The stripes clear
once you've actually seen the pane.

## Decisions (agreed with the user, 2026-09-24)

- **"Seen" is not "focused".** The UI is navigated with arrow keys, so focus sweeps across
  panes constantly. Clearing on focus would wipe the indicator for every pane you pass.
  (`session-runtime/unread.ts` already refuses focus as a read signal for the same reason.)
- **The pane clears on either of two signals, whichever comes first:**
  - **Engagement.** Typing, clicking, pasting or scrolling in the pane, through the existing
    `acknowledgeSession` path.
  - **Dwell.** The pane stays focused **and** visible continuously for `SEEN_DWELL_MS`
    (1.5 s). Arrow-key hops take about 100–300 ms each, so passing through never clears.
    A pane that was already being watched when the turn ended clears immediately, with no
    flash.
- **One marker, not two.** The stripes render the existing unread marker (`unreadKind`),
  the same one behind the Dispatch NEW badge, so the grid and the list can't disagree.
  Consequence: the dwell now also clears NEW. That's intended, because staying on a
  visible pane is a real "I looked" signal, unlike passing through.

## Shape

- `TileLeaf/useAcknowledgeAfterDwell.ts`: the only new logic. It's called by the two agent
  surfaces (`TileLeaf`, `AgentTerminalLeaf`) with `focused && visible`, the unread flag,
  and their `acknowledgeSession`.
- `PaneHeader` gains a `completionUnseen` prop. It reads the setting from the store (no
  prop drilling through the eight layout components) and draws the stripes. A running agent
  never stripes, whether or not Status Mode is on ("finished" would be false). So the lit fill
  and the stripes never share a row. Shell `TerminalLeaf` doesn't pass the prop, so shells
  never stripe.
- Setting `showAgentCompletionIndicator`: type, default `true`, persistence coerced with
  `!== false` (absent → on, explicit off honoured), and a Settings → Workspace row. It gates
  the stripes only. The dwell is what "seen" now means, whether or not stripes are drawn.
- A `.pane-header-completion-stripes` CSS class next to the other theme-token animations.

## Tests

- Hook (fake timers): passing through doesn't acknowledge. Dwelling acknowledges at exactly
  1.5 s. An already-watched pane acknowledges at once. Losing focus or visibility cancels the
  dwell. Nothing happens with no unread marker.
- PaneHeader: stripes only when the setting is on, the pane is unseen, and the agent isn't
  running (with or without Status Mode). Surfaces that don't opt in, meaning shells, never stripe.
- Settings persistence: an absent key → on, and an explicit `false` → off.
