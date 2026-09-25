# Terminal replay mode fixtures (#843)

| File | Source |
|---|---|
| `opencode-1.18.31-startup.json` | The first 6 s of PTY output from the installed OpenCode CLI (1.18.31), recorded on 2026-09-19. It was spawned under node-pty at 120×36 with `TERM=xterm-256color` in an empty folder. Each entry is `{ t, d }`: milliseconds since spawn, and the decoded chunk exactly as node-pty delivered it. The only edit replaces the user name with `user`. The TUI prints its working folder, a temporary scratch folder, wrapped across screen rows with cursor moves between the pieces, so no string replacement can match it; that non-sensitive path is left as recorded. |

The first chunk carries OpenCode's one-time terminal setup: `?1049h` (alternate screen), `?2004h`, `?1000h ?1002h ?1003h` (mouse), and `?1006h` (SGR encoding), along with capability queries. Later chunks are synchronized-output (`?2026h … ?2026l`) full-frame repaints of the start screen.

Re-record with the same method when OpenCode changes its setup sequence. Do not hand-edit the bytes.
