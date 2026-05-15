# opencode-headless

Planned third headless wrapper — a sibling to `claude-code-headless`
and `codex-headless` — that will let Agent Code drive **OpenCode** as
an addon provider. Claude Code and Codex stay primary.

## Status: research only

Not implemented. No `src/`, nothing imported, nothing ships from `main`.

The full research bundle lives on a dedicated branch:

```
research/opencode-headless
```

On that branch, `packages/opencode-headless/research/` contains:

- `00-brief.md` — the research brief
- `01-process-and-cli.md` … `09-tools-mcp-plugins.md` — ten parallel
  topic deep-dives (process/CLI, server & wire protocol, SDKs,
  SDK-vs-TUI gap, provider abstraction, session persistence, TUI
  surface, approvals, tools/MCP/plugins)
- `10-architecture-proposal.md` — the architecture proposal the
  implementation session builds from

To read it:

```
git checkout research/opencode-headless
# or, without switching:
git show research/opencode-headless:packages/opencode-headless/research/10-architecture-proposal.md
```
