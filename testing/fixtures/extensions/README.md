# Extension manifest fixtures

Real manifests copied verbatim from published extension repositories. Do not
edit them. A fixture that has been adjusted to fit a test no longer tests what
real extensions ship.

| File | Source |
|---|---|
| `timer-0.3.1.agent-code.extension.json` | `Juliusolsson05/agent-code-timer` at `74de8c4c072292b59c39437103b7b2e08bdf7fee`, `agent-code.extension.json`. This is Timer's last API v1 release (0.4.0 moved to v2). It has one `panel` view and action commands (`timer.start` and others), so it drives the legacy cold-command path in `src/renderer/src/apps/host/derive.ts`. |
