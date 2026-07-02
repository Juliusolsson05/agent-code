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

Agent Code is an open-source Electron-based AI-native IDE built around the real
Claude Code and Codex CLIs.

The point is not to replace Claude Code or Codex. The point is to keep their
native runtimes while moving the surrounding workspace into an environment that
developers can actually control: custom rendering, tiled sessions, provider
switching, orchestration, persistent terminals, transcript tooling, command
workflows, and local diagnostics.

Claude Code is an excellent agent runtime, but Anthropic is increasingly locking
OAuth usage into its own product ecosystem. That ecosystem is not especially
suited to developers who want deep customization or serious parallelization
unless they drop back to raw terminal management. Agent Code exists because the
real runtime is worth keeping, but the workspace around it should be programmable.

## The Core Mechanism

When you launch Claude in Agent Code, the app starts a headless Claude Code
runtime.

That runtime is not the Claude SDK, and it is not a reduced clone of Claude Code.
It is a standalone open-source package we built, `claude-code-headless`, which
launches the real Claude Code CLI in a PTY and wraps it in an API.

The same pattern exists for Codex through `codex-headless`.

Those headless packages are the important architectural layer. They are separate
from Agent Code on purpose: easier to maintain, easier to test, easier for
open-source contributors to understand, and useful in other projects that need
programmatic access to the real Claude Code or Codex CLIs.

Agent Code sits on top of them.

The headless package exposes the runtime state Agent Code needs: transcript
updates, screen state, permission prompts, compaction, trust dialogs, semantic
output, process state, terminal bytes, and provider conditions. Agent Code
consumes that API and turns it into a desktop IDE.

Because the headless runtime owns the process it launches, it can use strategies
normal wrappers cannot. It can run the real CLI in a controlled PTY, attach local
proxy/streaming adapters where supported, read durable JSONL transcripts, and
fall back to screen parsing for states that only exist in the terminal UI.

That is how Agent Code can reimplement Claude Code's rendering in React without
throwing away Claude Code itself.

The goal is 1:1 native behavior first: same runtime, same auth, same tool loop,
same permissions, same session behavior. Then Agent Code goes further: custom
rendering, tiled layouts, persistent terminals, provider switching,
orchestration, transcript tools, and full control over how the workspace behaves.

The motivation is practical. OpenCode and similar alternatives have already been
blocked from using Anthropic OAuth properly. The official Claude Code ecosystem
works, but it is not built for deep customization or serious parallelization
unless you manage everything manually in terminals.

Agent Code does not ask for Anthropic OAuth tokens. It does not replay
credentials. The headless runtime launches the already-authenticated Claude Code
CLI the user has installed, and Agent Code builds a better IDE around that real
process.

Because we control the runtime and the transcripts, Agent Code can also do
things like translate a Claude Code session into a Codex session, or Codex back
into Claude, letting you switch providers mid-task without starting over.

## Why This Exists

The strongest coding agents today live inside product-specific CLIs. Claude Code
and Codex are not just model endpoints: they include permission flows, tool
loops, compaction, resume behavior, slash commands, terminal UI state, transcript
formats, and provider-specific decisions that are constantly evolving.

Most wrappers throw that away. They call a thinner API, reuse brittle token
paths, or rebuild a small chat surface around a model response. That may look
clean, but it loses much of what makes the real products useful.

The alternative is to run everything manually in terminals. That keeps the full
runtime, but it leaves the developer managing panes, sessions, prompts, provider
limits, transcripts, worktrees, context handoffs, and background agents by hand.

Agent Code tries to avoid that tradeoff:

- run the real Claude Code and Codex CLIs
- preserve their native behavior
- expose their state programmatically
- build the missing IDE around them

## What Agent Code Does Differently

Agent Code treats Claude Code and Codex as runtimes, not as chat backends.

When you start an agent, Agent Code launches the real CLI inside a pseudo-terminal
and drives it through local headless control layers. The app observes semantic
events, screen state, provider conditions, terminal bytes, and durable transcript
updates, then renders that into a stronger workspace shell.

That means:

- Claude Code still behaves like Claude Code.
- Codex still behaves like Codex.
- New provider functionality remains available when it lands in the CLI.
- Agent Code can add higher-level workflows without replacing the underlying
  agent loop.

## Key Functionality

### Real Claude Code and Codex Sessions

Agent Code runs the actual `claude` and `codex` binaries in PTYs through:

- [`claude-code-headless`](https://github.com/Juliusolsson05/claude-code-headless)
- [`codex-headless`](https://github.com/Juliusolsson05/codex-headless)

These packages expose the terminal programs as structured event sources while
keeping the real CLI flows intact. They track semantic output, screen overlays,
conditions, process state, and committed transcript updates.

### Tiled Workspace

The workspace is built for running multiple live sessions in a real development
layout. You can split panes, open Claude, Codex, and terminal sessions side by
side, move focus directionally, normalize layouts, rotate layouts, and keep
different projects in tabs.

This is the basic difference from a single-agent product surface: Agent Code
assumes that serious work often spans multiple agents, terminals, worktrees, and
review loops at the same time.

### Dispatch

Dispatch is a workspace mode for managing agents outside the fixed pane grid.
Agents can be detached, pinned, attached back into the grid, or viewed through
global and tiled dispatch surfaces.

This is useful when agents should keep running without permanently occupying the
main layout.

### Provider Switching

Agent Code can switch a session between Claude Code and Codex by translating the
underlying transcript.

This is powered by
[`agent-transcript-parser`](https://github.com/Juliusolsson05/agent-transcript-parser),
which converts Claude JSONL and Codex rollout JSONL between provider formats.
The source transcript is not destroyed; Agent Code writes a translated session
and resumes the target provider from there.

Provider switching is available for individual agents and for batches of agents,
which matters when a provider limit makes a whole set of sessions unusable.

### Custom Rendering

Agent Code rewrites the agent surface in React instead of showing only the raw
terminal.

The renderer combines committed transcript entries, semantic streaming events,
tool calls, shell commands, provider conditions, optimistic prompts, and debug
state into a structured feed. This makes it easier to inspect what an agent did:
commands it ran, code it changed, tools it used, prompts it answered, and where
its current state came from.

The raw terminal is still available. Custom rendering adds control; it does not
remove the underlying process.

### Persistent Terminals

Agent Code supports normal terminal sessions alongside agent sessions. Terminals
are tmux-backed when available, so shell state can survive UI reloads and pane
changes instead of being tied to one React view.

### Built-In MCP

Agent Code includes a scoped built-in MCP host so agents can interact with the
workspace they are running inside.

Current built-in MCP domains include:

- **orchestration** — create, prompt, read, wait for, and close child agents
- **AI workspace** — collect files into a shared review workspace
- **agent transcripts** — read, search, and inspect bounded transcript projections
- **ping** — development smoke testing

These tools let a parent agent launch real Agent Code child agents and coordinate
their work through the same app model the user sees.

### Orchestrated Agents

Through the orchestration MCP tools, one agent can launch other Claude or Codex
agents, assign roles, send prompts, wait for completion, read outputs, and close
the run.

The children are not invisible subprocesses. They are real Agent Code sessions
with placement, status, transcripts, and UI visibility.

### Prompt and Transcript Workflows

Agent Code treats prompts and transcripts as development artifacts. It includes
commands for:

- viewing prompts
- searching conversation prompts
- rewinding to a prompt
- undoing rewinds
- duplicating agents
- copying resume commands
- copying assistant messages
- copying code blocks
- saving prompt templates

### Git, Worktrees, and Editor Surfaces

Agent Code includes supporting development surfaces around the agents:

- Git bar
- worktrees bar
- worktree badges
- global editor
- file tree
- Monaco editor
- AI workspaces for collecting files and review artifacts

The editor is not the center of the product. The agent runtime is. But the
editor surfaces are there when they improve the agent workflow.

### Voice Dictation

Agent Code integrates
[`agent-voice-dictation`](https://github.com/Juliusolsson05/agent-voice-dictation),
an open-source dictation package for agent composer UIs.

Dictated text can be wrapped in an explicit speech-to-text tag so the model can
interpret likely transcription mistakes with full conversation context.

### Diagnostics

Agent Code is process orchestration software, so observability matters. The app
includes status and debug surfaces for agent processes, transcripts, rendering,
proxy streams, performance, heap pressure, debug bundles, and incident
investigation.

This is not decoration. Long-running agent sessions fail in complicated ways:
provider exits, transcript drift, rendering disagreements, frozen UI paths,
missing sessions after reload, or native process memory issues. Agent Code keeps
local evidence so those problems can be debugged.

## Architecture

Agent Code is an Electron app with a React renderer and a Node main process.

At a high level:

1. The main process owns provider processes, PTYs, tmux terminals, transcript
   access, filesystem access, MCP hosting, and OS integrations.
2. The renderer owns workspace layout, panes, tabs, Dispatch, command palette,
   settings, and rendered agent UI.
3. Provider runtimes wrap the real Claude Code and Codex CLIs through headless
   packages.
4. IPC forwards terminal bytes, semantic events, screen snapshots, transcript
   entries, process state, provider conditions, and diagnostics into the UI.
5. Built-in MCP tools let agents coordinate other Agent Code sessions through the
   same workspace model.

## Companion Packages

Agent Code depends on several packages that are useful outside this app:

- [`claude-code-headless`](https://github.com/Juliusolsson05/claude-code-headless)
  — programmatic control of the real Claude Code CLI
- [`codex-headless`](https://github.com/Juliusolsson05/codex-headless)
  — programmatic control of the real Codex CLI
- [`agent-transcript-parser`](https://github.com/Juliusolsson05/agent-transcript-parser)
  — Claude/Codex transcript conversion, clone, rewind, and ghost-record helpers
- [`agent-voice-dictation`](https://github.com/Juliusolsson05/agent-voice-dictation)
  — dictation primitives for agent composer UIs

Agent Code is the desktop shell where those pieces come together.

## What This Is Not

Agent Code is not:

- a Claude Code theme
- a thin chat app
- a private OAuth-token wrapper
- a reimplementation of Claude Code or Codex
- an editor where agents are a side feature

It is an IDE around the real agent runtimes.

## Development

Requirements:

- Node 22
- Claude Code installed and available on `PATH`
- Codex installed and available on `PATH`

Run locally:

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
```

Package for macOS:

```bash
npm run dist:mac
```

Runtime helper verification:

```bash
npm run runtime:verify
```

## Project Structure

```text
src/main/       Electron main process: sessions, PTYs, IPC, MCP, storage
src/renderer/   React workspace UI, command palette, panes, rendering
src/providers/  Claude and Codex runtime adapters
src/mcp/        Built-in MCP host and tool definitions
src/shared/     Shared types and cross-process contracts
packages/       Headless runtimes and companion libraries
docs/           Architecture notes, plans, rendering docs, investigations
third_party/    Runtime artifact manifests for packaged tools
vendor/         Read-only upstream source references
```

## Status

Agent Code is active beta software. It already supports Claude Code sessions,
Codex sessions, terminal sessions, tiled layouts, Dispatch, provider switching,
transcript workflows, built-in MCP orchestration, tmux-backed terminals, custom
rendering, voice dictation, and diagnostics.

The upstream CLIs move quickly, so this project moves quickly too. The goal is
not to hide that complexity. The goal is to preserve the real runtimes while
building the developer-controlled workspace around them.

## License

[MIT](LICENSE)
