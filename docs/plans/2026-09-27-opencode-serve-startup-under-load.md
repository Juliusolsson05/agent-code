# OpenCode agents start under load: the serve readiness wait measures the right thing (#1355)

## Problem
`orchestration_create_agent` with kind `opencode` failed three times in about an hour on 2026-09-26/27, from three workers, with "Timed out waiting for …/opencode serve to report its URL". I also hit it on #1352's reviewer c. The load average was 40–70 each time.

The only deadline on this path is `SpawnedServer`'s `startupTimeoutMs`, a package default of 10 s. The app never passes one: `opencodeSession.ts` builds `OpencodeHeadless` without it, and nothing in the app wraps `headless.start()` in a deadline of its own.

## Evidence (reproduced on the real bundled binary, OpenCode 1.18.31)
Measured as time to the listen line, with `scratchpad/octime.mjs`: it spawns `opencode serve --hostname 127.0.0.1 --port 0` and times stdout.
- **Idle machine** (load average about 4): 0.57 s, 0.73 s, 0.86 s.
- **Under contention:** 16 CPU burners at nice 10, on a machine other workers were already loading: 43.1 s, 16.7 s, 18.3 s. **Every run became ready.**
- **Conclusion:** the server is healthy but CPU-starved. A fixed 10 s wall-clock deadline sized for an idle machine kills it.

A hung server (alive, never listening) has not been observed. The existing exit path already fails fast when the process dies (`serve exited before readiness`).

## Decision (defaults)
- **The app sets the readiness wait to 120 s** by passing `startupTimeoutMs` to `OpencodeHeadless`. The app spawns and owns the process, and the package takes the value as an option, so the fix belongs in the app and needs no package change.
  - **Why 120 s:** it is about 3× the worst measured healthy start under load (43 s). It still bounds an alive-but-never-listening server, so the ceiling only bites on a real hang.
  - A dead server still fails at once through the exit path, so a crash is not slowed down.
- **Considered and deferred:** a CPU-progress watchdog (fail when the child's CPU time stops rising). It would tell a hang from starvation sooner, but it needs a per-platform CPU probe of a child process (`ps` on macOS/Linux, something else on Windows) and would itself be slow under load. The fixed ceiling covers the observed failure; the watchdog is only worth building if a real hang is recorded.
- **Not the same cause:** #1009 (the opencode-terminal live suite waits for a permission condition) is a different wait.

## Tests
- **`opencodeSession`:** the spawned headless gets the load-tolerant `startupTimeoutMs`. A test double stands in for `opencode-headless`'s constructor, the true edge here. The package's `SpawnedServer.test.ts` already covers the option's behaviour.
- **Real mechanism:** an OpenCode session started against a stub `opencode` binary that reports its URL after 11 s (past the old deadline) reaches the server instead of rejecting.

## Round 1 review decisions (#1367)
- **a (major): orchestration still loses a start slower than 30 s.** The bridge rejects `create-agent` at 30 s with an unknown outcome. The late-adopted child never gets its bootstrap prompt. This is the orchestration bridge's own deadline, pre-existing and shared by every provider, so it is filed as #1370 and not changed here. Changing it means choosing between late bootstrap delivery and MCP-client timeouts. With this PR, starts that finish between 10 and 30 s now succeed through orchestration too; two of the three recorded contended starts took 16.7 and 18.3 s. So this PR is `Refs #1355`, and #1355 stays open until #1370 lands.
- **a (minor): the package's forwarding was untested.** A system test now goes through `OpencodeHeadless` (`resolveServerUrl` → `SpawnedServer`) with the app's option, and dropping the forwarding fails it.
- **a (surviving mutant): 44 s passed the margin check.** The test now requires at least twice the worst healthy start measured.
