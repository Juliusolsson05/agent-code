# Agent Code 0.1.0 — release notes (DRAFT)

Draft for Stage 8. The version number is the ledger's default (0.1.0) and is
the owner's call. Everything below is merged to `main` unless marked PENDING;
the PENDING lines are the PRs still in review at the time of writing and must
be either merged or removed before this ships.

The previous public build was **0.0.2-beta.1**. Roughly forty-five pull
requests separate the two, so these notes group by what changed for a user
rather than listing them.

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
  (**#1034**). PENDING **#1051**: a duplicated or rewound OpenCode session
  keeps its own model *and* effort level, including on its next prompt.

## Goal Loop

A harness-owned loop that keeps an agent working until its goal is complete
(**#1003**), with the pane strip, MCP capability and per-agent command that go
with it (**#1005**, **#1008**, **#1045**), plus an agent **Goal** with its own
MCP capability and ⌘G peek (**#946**).

The loop's turn boundary is the provider's own Stop hook, never a stream phase
(**#1028**) — stream phases go idle in the middle of a Claude turn whenever a
subagent flow streams, which delivered continuations mid-turn. PENDING
**#1050** adds the delivery gate: what to do when *another* configured Stop
hook keeps the turn going, when the provider queues a continuation instead of
starting it, and when a signal gets stuck.

## Remote control, rebuilt

**#997** is a ground-up rebuild of the phone client, with **#1023** putting
every chrome band on the feed gutter and **#911** stopping a stale session list
from severing a mounted transcript view. PENDING **#1056** fixes the agent
index flashing and reordering while agents work.

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

## Security

- PENDING **#1049**: invisible and reordering Unicode is made visible
  everywhere you authorise something — provider approvals, close and delete
  confirmations, skill installs, extension consent, bulk provider switches.
  A command that *reads* as `./check.sh` and *runs* as something else is the
  whole point.
- **#1053**: Claude wraps a pasted prompt in its own `<pasted_content>`
  envelope, which broke prompt-acceptance matching and reported delivered
  prompts as failures — including every goal-loop continuation.
- **#1042**: dependency security updates.

## Release plumbing

A tested rolling nightly (**#1012**) and a stable channel that becomes
`releases/latest` (**#1035**). PENDING **#1054**: the app icon sits on Apple's
grid, so it stops rendering oversized in the Dock on macOS 12–15.

---

## Known gaps, stated plainly

- After a restart the phone lists only agents with a running process, and
  cannot wake one (#1031).
- The OpenCode Terminal live compatibility suite times out waiting for a
  permission condition on every version tested (#1009).
- Bury notes from pre-#1013 workspaces are not carried forward (#1030).
