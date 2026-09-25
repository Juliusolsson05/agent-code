# Agent Code 0.1.0 — release notes

The first **stable** Agent Code release: signed, notarized, and published as
`releases/latest` rather than as a prerelease.

The previous public build was the **0.0.2-beta.1** prerelease. Around sixty
pull requests separate the two, so these notes group by what changed for a
user rather than listing them. Everything below is merged to `main`.

---

## The workspace is one stage now

**#1013** replaced tabs-of-tile-trees with a single workspace: lanes, rows and
a session pool, with projects as first-class containers. Sessions live in the
pool and appear in lanes, so an agent is no longer owned by the geometry it
happens to sit in.

Consequences you will notice:

- **Boot starts only the focused lane's agent.** Everything else hibernates
  until you look at it. Faster, quieter startup; the cost is that a restart
  no longer has every agent running (see *Known gaps*).
- Some advanced commands were retired with the tile tree. **#1046** promoted
  the nine that survived into the default command picker.
- **#914** reuses an open project tab on New Tab and adds Merge Project Tabs.
- **#909** scopes Switch Agents and Close Old Agents to the project tab.
- **#939** can auto-follow whichever agents are working.

## A fourth provider, and two that grew up

- **Grok is a supported provider** (**#844**), with its own runtime, conditions
  and transcript handling.
- **OpenCode ships as a managed runtime binary** (**#1002**) — no separate
  install — and its Terminal runtime gained Jump to Latest (**#1043**), DEC
  mode restoration on replay (**#1041**), transcript read commands
  (**#972**), and a permission modal that shows what it is actually asking
  for (**#1026**).
- **Provider switching survives pasted images in both directions** (**#1000**)
  and lands on the model you last used rather than the catalog's first row
  (**#1034**). A duplicated or rewound OpenCode session keeps its own model
  *and* effort level, including on its next prompt (**#1051**).

## Goal Loop

A harness-owned loop that keeps an agent working until its goal is complete
(**#1003**), with the pane strip, MCP capability and per-agent command that go
with it (**#1005**, **#1008**, **#1045**), plus an agent **Goal** with its own
MCP capability and ⌘G peek (**#946**).

The loop's turn boundary is the provider's own Stop hook, never a stream phase
(**#1028**) — stream phases go idle in the middle of a Claude turn whenever a
subagent flow streams, which delivered continuations mid-turn. **#1050** adds
the delivery gate: what to do when *another* configured Stop hook keeps the
turn going, when the provider queues a continuation instead of starting it,
and when a signal gets stuck. The loop no longer pauses itself on a prompt it
actually delivered (**#1053**).

## Remote control, rebuilt

**#997** is a ground-up rebuild of the phone client, with **#1023** putting
every chrome band on the feed gutter and **#911** stopping a stale session list
from severing a mounted transcript view. **#1056** fixes the agent index
flashing and reordering while agents work: the list was rebuilt at stream
frame rate (sixty rebuilds for sixty frames), rows sorted with no tiebreak,
and two different clocks were compared in one sort key.

## Performance, visible

A monitor that attributes memory and CPU to individual agents (**#986**,
**#955**), bounded baseline evidence collected for every run (**#953**,
**#949**), local history and profiling (**#958**), and **Agent Analytics** —
working time per project (**#968**). **#967** stops the turn clock counting
laptop sleep and seals the streams a sleep severed.

## TLDR and reporting

Turn-hook enforced TLDR reporting with history (**#932**), theme-correct
peeks (**#957**), freshness on reload (**#912**), and a latch that owns input
only while its overlay is actually mounted (**#1036**).

## Setup and first run

**#1047**: a fresh install always reaches a workspace, and no provider CLI is
required to get there. Installation diagnoses GitHub rate limits instead of
surfacing a bare 403 (**#981**), authenticates through the GitHub CLI
(**#983**), and ships Nord, global Dispatch and public-release defaults
(**#988**).

## Reliability

- **#945**: cancelling Quit no longer leaves services stopped.
- **#935**: a session keeps receiving its own prompts across window
  transitions.
- **#931**: one documented owner for session operations and recovery.
- **#933**: workspace recovery preserves saved tmux sessions;
  **#1048**: a corrupt workspace file is no longer read as an empty one, and a
  hibernated terminal's tmux dies with it.
- **#1044**: an orchestration child whose provider turn failed reports failed.
- **#1039**: one shared IPC listener per pane channel.
- **#1057**: a stream that dies mid-answer now says so, on the desktop and on
  the phone, instead of leaving an unexplained half-response — including when
  the machine sleeps through it.
- **#1058**: a closed terminal's shell is reaped once its undo window has
  passed. Closing a terminal deliberately leaves its tmux session alive so
  Undo Close can re-attach the same scrollback; nothing ever killed it
  afterwards, so they accumulated until the next launch.

## Security

- **#1049**: invisible and reordering Unicode is made visible
  everywhere you authorise something — provider approvals, close and delete
  confirmations, skill installs, extension consent, bulk provider switches.
  A command that *reads* as `./check.sh` and *runs* as something else is the
  whole point.
- **#1053**: Claude wraps a pasted prompt in its own `<pasted_content>`
  envelope, which broke prompt-acceptance matching and reported delivered
  prompts as failures — including every goal-loop continuation.
- **#1060**: the same envelope was also being *shown* to you, and replayed.
  The feed painted `❯ <pasted_content id="…"> …`; pane titles for a pasted
  prompt started with the tag; ⌘↑ put it back in the composer, where sending it
  again made Claude wrap the already-wrapped text, one envelope deeper each
  time; Rewind both showed it and re-sent it; and View Prompts and the
  conversations picker **dropped** pasted prompts entirely, so a session of
  them read "No visible user prompts found" while the feed showed them.
- **#1042**: dependency security updates.
- **#1049** also closes a quieter gap: installing an extension that requests
  no capabilities used to happen in silence, so nothing ever showed you the
  repository you were about to run code from. A first install always asks now;
  an update of something already installed still does not.

## Release plumbing

A tested rolling nightly (**#1012**) and a stable channel that becomes
`releases/latest` (**#1035**) — this release is the first to use it. The app
icon sits on Apple's grid, so it stops rendering oversized in the Dock on
macOS 12–15 (**#1054**).

---

## Known gaps, stated plainly

- After a restart the phone lists only agents with a running process, and
  cannot wake one (#1031).
- The OpenCode Terminal live compatibility suite times out waiting for a
  permission condition on every version tested (#1009).
- Bury notes from pre-#1013 workspaces are not carried forward (#1030): v3
  has no parked-note surface to show them on yet.
- macOS only. The build is signed and notarized for Apple silicon and Intel;
  there is no Windows or Linux build.
