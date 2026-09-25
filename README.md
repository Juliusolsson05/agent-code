<p align="center">
  <img src="build/icon.png" alt="Agent Code" width="128" />
</p>

<h1 align="center">Agent Code</h1>

<p align="center">
  Open-source Electron-based AI-native IDE built around the real Claude Code and Codex CLIs.
</p>

<p align="center">
  <a href="https://github.com/Juliusolsson05/agent-code/stargazers"><img src="https://img.shields.io/github/stars/Juliusolsson05/agent-code?style=flat" alt="Stars"></a>
  <a href="https://github.com/Juliusolsson05/agent-code/network/members"><img src="https://img.shields.io/github/forks/Juliusolsson05/agent-code?style=flat" alt="Forks"></a>
  <a href="https://github.com/Juliusolsson05/agent-code/issues"><img src="https://img.shields.io/github/issues/Juliusolsson05/agent-code?style=flat" alt="Issues"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Juliusolsson05/agent-code?style=flat" alt="License"></a>
  <a href="https://github.com/Juliusolsson05/agent-code/commits/main"><img src="https://img.shields.io/github/last-commit/Juliusolsson05/agent-code?style=flat" alt="Last commit"></a>
  <a href="https://github.com/Juliusolsson05/agent-code"><img src="https://img.shields.io/badge/github-agent--code-2D72D2?style=flat" alt="GitHub"></a>
</p>

---

Agent Code is an open-source Electron IDE for driving the real Claude Code and
Codex CLIs from a workspace built for multi-agent development.

<p align="center">
  <img src="docs/screenshots/tiled-workspace.png" alt="Agent Code tiled workspace with multiple Claude and Codex sessions running side by side across project tabs" />
</p>

## Why it exists

Claude Code and Codex are strong runtimes: real permission flows, tool loops,
compaction, resume behavior, and provider-specific decisions. Wrappers usually
throw that away — they call a thin API, reuse fragile token paths, or rebuild a
tiny chat surface. That may look clean, but it loses most of what makes the real
products useful.

At the same time, Anthropic is closing OAuth to non-official clients. OpenCode
and similar projects have already been blocked. The official Claude Code app
works, but it is not built for deep customization or serious parallelization —
running many agents means managing panes, prompts, transcripts, worktrees, and
provider limits manually in a terminal.

Agent Code takes a third route: keep the native runtimes, own the workspace
around them.

## How it works

Agent Code launches the user's already-installed `claude` and `codex` CLIs
through two standalone open-source packages:
[`claude-code-headless`](https://github.com/Juliusolsson05/claude-code-headless)
and [`codex-headless`](https://github.com/Juliusolsson05/codex-headless).

They wrap each CLI in a PTY and expose the runtime as an API — JSONL
transcripts, provider conditions, permission and trust prompts, semantic
streaming, and screen state for anything the CLI only shows in the terminal.
Agent Code consumes that API to rebuild the agent surface in React without
replacing the underlying agent loop. Same auth. Same tools. Same session
behavior.

Because Agent Code also owns transcript translation
([`agent-transcript-parser`](https://github.com/Juliusolsson05/agent-transcript-parser)),
a running session can move mid-task among Claude Code, Codex, and OpenCode.

## What you can do with it

- **Tiled workspace** — many agent and terminal sessions in a real pane layout.
- **Fleet management** — manage detached agents outside the fixed grid. Bulk
  actions cover the multi-project cases: closing agents that have been inactive
  across every project, pinning them for quick access, or reattaching them to
  the grid. **Close Idle Orchestration Agents** sweeps up the finished workers an
  orchestration run leaves behind, after confirming the list.

  <p align="center">
    <img src="docs/screenshots/close-old-agents.png" alt="Agent Code Close Old Agents modal — inactive-hours threshold, per-project scope, and a preview of the Claude and Codex agents that will be closed" />
  </p>

- **Provider switching** — choose Claude, Codex, OpenCode, or the managed
  OpenCode Terminal for one session, or move whole provider batches, without
  losing state.
- **Custom rendering** — React feed built from committed transcripts, semantic
  streams, tool calls, and provider conditions. The raw terminal stays available.
- **Persistent terminals** — tmux-backed shells that survive UI reloads.
- **Built-in MCP + agent control** — orchestration lets a parent create and
  coordinate real Agent Code children. The independently configurable Agent
  Management MCP can inventory every agent in the caller's project — on a
  lane or parked in the pool — expose transcript/activity evidence, read
  bounded outputs, and send follow-ups. Destructive close is restricted to an explicit current
  user request and refuses self-close or multi-session cascades.

  <p align="center">
    <img src="docs/screenshots/orchestration.png" alt="Agent Code agent index with orchestration MCP tool calls (send_prompt, wait_agents, read_agent, close_run) running in a live session" />
  </p>

- **MCP servers** — add any MCP server (stdio, HTTP or SSE) by pasting the
  config from its README, for example Beeper Desktop's, and choose per provider
  which ones new Claude and Codex agents get. **Settings → MCP** shows Agent
  Code's own MCP servers and yours in one grid with a column per provider, and
  **Agent MCP Servers…** changes one agent's set with a single reload. Tokens
  are stored encrypted and reach the server through environment variables,
  never a config file or the command line. Servers the CLIs already load from
  their own config are listed read-only and can be copied in.
- **TLDR peek** — turn on **TLDR** for an agent, then hold **Cmd+L** to
  see each visible agent’s latest short status centered over its pane.
  A small footer shows **Last active** and **Note written** independently, using
  relative times and calendar dates for older activity. Release to return. The
  **TLDR** palette command also opens the preview; Escape dismisses it. Reporting
  is off by default. MCP settings apply to new agents and existing agents on their
  next reload, including the managed reporting skill. Explicit per-agent choices
  in **Agent MCP Servers…** take priority; its Reset clears them and reloads the
  agent. Claude and Codex agents with TLDR are asked to set their goal on the
  first prompt (through Goal instead when Goal MCP is also on), and at turn end to update after work that used tools without a
  report; the footer notes when that check is not running. **View TLDR History**
  shows how an agent's status evolved. The editor keeps Cmd+L Select Line.
- **Goal peek** — turn on **Goal** for an agent, then hold **Cmd+G** to see
  what each visible agent’s work is for, next to the TLDR’s where-it-is status.
  Agents set a goal once they understand a task and change it only when the
  direction changes, so it stays meaningful while the TLDR moves. Goal has its
  own row in Settings → MCP, and works with or without TLDR; only the agent
  writes it. Claude and Codex agents with Goal are asked for one at the first
  prompt and at turn end if it is still missing. **View TLDR History** shows goal
  changes alongside status updates, and **View Goal History** shows the goals
  alone. The editor keeps Cmd+G Find Next.
  Once you accept an agent’s work (its PR merged, or you said it is done), the
  agent marks its goal **complete**; the peek shows it with the agent’s
  one-line summary. **Close Completed Agents…** lists every finished agent
  across projects and closes the ones you keep ticked, removing their lanes
  too if you want. Running agents stay open, and a new goal clears the
  completion.
- **Auto Title** — opt in per provider under **Settings → MCP**, or for one
  agent in **Agent MCP Servers…**. The agent sets a short title for its current
  substantive job and changes it when the job changes; routine progress stays
  in TLDR. Titles appear in the pane, Dispatch and conversation picker. A
  manually saved or cleared title takes priority until **Resume Auto Title**
  is chosen in **Set Title…**. Existing agents pick up the MCP tool and skill on
  their next reload. Claude and Codex receive a missing-title turn reminder;
  OpenCode and Pi receive the tool and managed skill without that reminder.
  Grok receives the tool and its description; its native skill discovery is not
  supported yet, so it cannot receive the managed skill or turn reminder.
- **Prompt and transcript tools** — search, rewind, duplicate, resume-command
  copy, prompt templates. Reader Mode gives a paginated, distraction-free view
  of long sessions for reviewing what an agent actually did.

  <p align="center">
    <img src="docs/screenshots/reader-mode.png" alt="Agent Code Reader Mode — paginated distraction-free view of a long agent session with Older/Newer navigation across project tabs" />
  </p>

- **Voice dictation** — via
  [`agent-voice-dictation`](https://github.com/Juliusolsson05/agent-voice-dictation).
- **Skills** — Settings → Skills lists every personal skill your agents can
  load, with a column per provider. Paste the `npx skills add owner/repo
  --skill name` line from a README or skills.sh, review the exact commit and
  its files, and Agent Code installs commit-pinned copies for the providers you
  choose. You can also write your own skills and see skills other tools
  installed. There is no limit on how many you keep. Agents can propose skills
  for your review. Ownership is collision-safe and deployment health is shown
  explicitly.
- **Diagnostics** — durable local evidence for provider exits, transcript
  drift, rendering issues, and near-OOM events.

## Getting started

Requires Node 22.12+ (CI builds on 24 — see `.nvmrc`), plus `claude` and `codex`
on `PATH`. The headless runtimes live as git submodules, so clone with them
included:

```bash
git clone --recurse-submodules https://github.com/Juliusolsson05/agent-code.git
cd agent-code
npm install
npm run dev
```

If you already cloned without `--recurse-submodules`, initialize them once:

```bash
git submodule update --init --recursive
```

**Submodules are load-bearing:** the dev build compiles the five package
submodules (`claude-code-headless`, `codex-headless`, `opencode-headless`,
`agent-transcript-parser`, `agent-voice-dictation`) straight from their
`src/` via Vite aliases, so `npm run dev` will not start without them
checked out. All submodule repos are public; no special access is needed
(CI's `SUBMODULE_PAT`/`SUBMODULE_SSH_KEY` plumbing predates them being
public and is kept for private forks).

To build distributable macOS DMG and ZIP artifacts for Apple Silicon and Intel:

```bash
npm run dist:mac
```

`dist:mac` fetches and verifies the pinned runtime tools before building, then
checks out unsigned development artifacts when no Developer ID identity is
configured. Public releases use `.github/workflows/release.yml`, which requires
a Developer ID Application certificate and Apple notarization credentials and
verifies both thin app bundles before upload. For day-to-day development, use
`npm run dev`.

## Companion packages

- [`claude-code-headless`](https://github.com/Juliusolsson05/claude-code-headless)
  — headless Claude Code control layer
- [`codex-headless`](https://github.com/Juliusolsson05/codex-headless)
  — headless Codex control layer
- [`agent-transcript-parser`](https://github.com/Juliusolsson05/agent-transcript-parser)
  — Claude/Codex/OpenCode transcript conversion and rewind
- [`agent-voice-dictation`](https://github.com/Juliusolsson05/agent-voice-dictation)
  — dictation primitives for agent composer UIs

## Status

Active beta. The upstream CLIs move quickly; so does this project.

## License

[MIT](LICENSE)
