# Align companion package pins with merged main revisions

Refs #786. Base: Agent Code main after #783 and #785.

## Scope and rationale

The owner requested current main and all companion packages. Fetching package
repositories is not equivalent to upgrading their gitlinks: reproducible builds
consume exact pins. Validate the upgrade separately so a newer dependency does
not silently replace the working integration underneath live direct-PTY agents.

Use only merged remote main heads: Claude 7148deb, Codex 4ff1fd9, parser
2fdfc09, voice 3c6f962, OpenCode 4f2ef5d, Workflow MCP 64ec5ea. The first three
have identical source trees to their current pins; voice changes development
dependencies. Workflow MCP has divergent/re-written history and substantive
service/lease/standalone changes, so commit ancestry alone cannot establish
compatibility. Its tracked node_modules symlink is a portability concern to
record and validate, not a reason to rewrite package history from this repo.

## Implementation and verification

- Initialize package submodules in this isolated worktree and pin exact heads.
- Do not alter vendor reference pins, install moving dependency versions, edit
  user settings/lockfile changes, or restart Agent Code/Bringdown.
- Review Workflow MCP exports and embedded-service defaults. Run clean host CI
  (type checks, core/system/renderer tests, coverage, packaged-output verifier)
  against the combined update. If an integration contract breaks, diagnose it
  before proposing the upgrade; do not disable assertions or checks.
- Keep the package bump in its own PR and report evidence and remaining risks.
  Main retains reviewed pins until the owner approves the upgrade merge.
