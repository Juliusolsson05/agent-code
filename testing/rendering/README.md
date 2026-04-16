# Rendering Harness

Standalone Electron harness for cc-shell's renderer feed.

Purpose:
- isolate transcript/feed rendering from PTYs, providers, and workspace boot
- reproduce visual regressions with stable fixtures
- compare Claude and Codex rendering paths quickly

Commands:
- `npm run testing:rendering`
- `npm run testing:rendering:build`
- `npm run testing:rendering:preview`

Current scope:
- renders the shared `Feed` component directly
- includes fixture-driven Claude, Codex-compaction, and streaming cases
- exposes theme and custom-render toggles for quick visual checks

Deliberate non-goals for v1:
- no live provider sessions
- no transcript import UI yet
- no PTY or workspace persistence
