# Plan: a terminal's last-used time that survives restarts (#1178)

## Problem
`terminalForeground.changedAt` is the only "last active" a shell has. It is in
memory, and it is stamped `now` on the first foreground observation after any
(re)attach, so every terminal reads "just now" after a restart. Close Old Agents
therefore cannot find old terminals, and quick commands and typing never count.

## Change
1. `SessionMeta.lastUsedAt` (terminals): persisted with the workspace.
2. Stamped by one pure helper, `withTerminalLastUsed`, on:
   - the user typing or pasting into the terminal (`TerminalLeaf`, the only
     input path for plain shells);
   - a REAL foreground transition (a command started or finished, a `cd`) —
     never the first observation after attach;
   - the first sighting of a terminal that has no record yet, as a floor: "not
     used since at least now". Without it a terminal nobody touches after the
     upgrade would stay "unknown activity" forever and could never be closed as
     old, which is the case this fix exists for.
   Throttled to one write per minute per terminal so typing does not autosave on
   every key; the Close Old threshold is minutes at its finest.
3. Readers: Close Old Agents and Agent Activity use `lastUsedAt` for terminals.
   `changedAt` keeps its other jobs (unread on busy→idle, status).

## Not in scope
tmux `session_activity`: only covers tmux-backed shells, and it counts output as
activity (a prompt clock or a tail -f would keep a shell "used" forever).

## Verification
Unit tests for the helper; renderer tests that a reload's snapshot does not
refresh an old record, that a real transition does, and that Close Old Agents
lists a terminal whose record is old even though its runtime was just rebuilt.
