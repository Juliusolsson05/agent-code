# Recorded usage snapshot (#1339)

`snapshot-2026-09-27.json` is one raw `ac_usage_read` answer (root
management's `usage.read`), fetched by the manager (B6) on the owner's
machine at 2026-09-27T16:28:23Z, without `force`. It went through the same
sanitizing reader the `usage` MCP domain uses (`readUsageSnapshotForTools`).

It was read in full before it was committed. It holds:
- plan names, percentages, reset times and curated messages;
- source labels, which are `~`-abbreviated file names and never contents;
- no credentials, tokens or account ids.

It covers four sources. Claude, Codex and OpenCode z.ai answered; Grok is an
`error` row. That is the property the tool-boundary test pins: an error is
reported as an error, never as zero usage.
