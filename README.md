# cc-shell

`cc-shell` is an agent-first editor for heavy users of Claude Code and Codex.

The working name is `cc-shell`. The product is planned to be renamed to
**Agent Code**. Some repository paths, package names, and UI labels may still
use `cc-shell` during the transition.

This is not another "make Claude Code look nicer" wrapper. It is an
agentic development platform built on the opposite assumption: the agent
runtime is the product. The UI exists to make Claude Code and Codex more
powerful, not to replace them with a thin chat shell and a coat of glass.

## Why This Exists

A lot of people are building their own UI for Claude Code right now. Most
of them hit the same two failure modes:

1. They optimize for surface aesthetics instead of agent capability.
2. They bypass the real product by driving unofficial or reduced flows that
   throw away the logic Claude Code and Codex already have.

That leads to tools that look polished but are materially weaker.

`cc-shell` takes a harder line:

- Claude Code should still feel like Claude Code.
- Codex should still feel like Codex.
- The full command surface, prompts, tools, flows, and runtime behavior
  should still exist.
- The UI should add power for serious users, not abstract away the thing
  that already works.

## Core Thesis

The best agent editor is not a fake Claude Code UI.

The best agent editor is a platform that runs the real Claude Code and the
real Codex under the hood, preserves their behavior, and then layers better
workspace primitives on top for people who spend all day in agent loops.

That means `cc-shell` is built for:

- parallel agent work
- persistent sessions
- richer workspace orchestration
- multi-pane and multi-provider flows
- better tooling around transcripts, state, terminals, and code context

## Not OAuth Token Abuse

Many wrappers depend on reusing OAuth tokens from Claude or Codex and then
calling private or reduced interfaces around the actual product.

That approach is bad on two fronts:

- It cuts against platform policy.
- It throws away an enormous amount of product logic that already exists in
  Claude Code and Codex.

If you strip things down to "send message, get message back", you lose most
of what makes those tools good in practice.

`cc-shell` is explicitly trying not to do that.

## How It Works

`cc-shell` runs Claude Code and Codex headlessly under the hood.

But "headless" here does **not** mean using a minimal session API and
pretending that is the product.

It means using open source headless runtimes that emulate the actual CLI and
terminal behavior of Claude Code and Codex so the shell can expose the full
system programmatically.

The architecture combines:

- terminal emulation
- JSON/event parsing
- screen parsing
- transcript parsing
- session management

This lets `cc-shell` surface the real commands, flows, and tools from Claude
Code and Codex in an API-like way without collapsing them into a toy chat
interface.

In practice, the stack includes:

- `claude-code-headless`: headless control layer for Claude Code
- `codex-headless`: headless control layer for Codex
- `agent-transcript-parser`: translation layer between transcript formats
- Electron + React workspace shell on top

## What This Project Is

`cc-shell` is:

- an Electron desktop shell for agent-heavy development
- a multi-session workspace for Claude Code, Codex, and terminals
- a way to preserve nearly all of the real agent behavior while adding a
  stronger editor and workspace model around it

It is not:

- a "Claude Code but prettier" theme project
- a thin chat app with editor chrome
- a wrapper that replaces the underlying product with a reduced API

## Philosophy

The job is not to "macify" Claude Code.

The job is to build the editor serious agent users actually need:

- keep the underlying agents real
- preserve the capabilities that already exist
- expose more control, more observability, and more workspace power
- build for people who live in long-running, high-volume agent sessions

If the result ever looks nicer, that is incidental. Capability comes first.

## Status

This repository is an active build. The current app already contains the
foundation for:

- Claude Code sessions
- Codex sessions
- plain terminal sessions
- tabbed and tiled workspace UI
- provider-aware session handling
- transcript and runtime parsing
- local desktop hosting through Electron

## Development

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
```
