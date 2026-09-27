# Claude proxy: the TLS key log is opt-in (#1380)

## Problem
claude-code-headless started mitmdump with `MITMPROXY_SSLKEYLOGFILE=<run dir>/sslkeylog.log`. Every TLS handshake appended its session secrets, nothing rotated the file, and debug retention skips a live run directory. So it grew for the life of every session (a recorded run: 48,777 bytes, 52 handshakes), as plaintext secrets on disk. Nothing in the package or the app reads it (`git grep sslkeylog`: the writer only).

## Decision
The issue's option (a): the key log only on an explicit opt-in. `createProxyServer({ sslKeyLog })` defaults to false, and an inherited `MITMPROXY_SSLKEYLOGFILE` is removed, so a shell export cannot re-enable it. Option (b), rotation, would keep the secrets on disk for no consumer.

## Where
The whole fix is in the package: claude-code-headless#67. The app's `claudeSession.ts` calls `createProxyServer` without the option, so the default is the fix, and the app PR is a submodule bump.

## Sequencing (no overlap with W4)
App `main` pins the package at `64fd0ea`; agent-code#1376 (W4) bumps it to the package's `main`, which includes #64/#65. This app PR is opened only after #1376 merges, pointing at #67's merge commit, so its bump carries only #67. #1382 (#1253) must likewise be re-pointed at claude-code-headless#66's merge commit.

## Tests
In the package: `proxyServer.sslKeyLog.test.ts`, covering the builder and the spawned-env call site; three mutations, each red.
