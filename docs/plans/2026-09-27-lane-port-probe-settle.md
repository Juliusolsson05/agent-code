# Lane port watcher: stop probing short-lived test servers (#1409)

## Problem

`LanePortWatcher` probes, with one `GET /`, every TCP listener it finds in a
watched lane's process tree. It does this on the FIRST scan that sees the
listener (`LanePortWatcher.runScan` → `probeOnce` → `lanePortsIo.probe`).
Agents run test suites inside their lanes, so test suites' loopback servers
get an unsolicited request. Tests that count requests flake, only on developer
machines: CI has no watching app. #1187/#1406 is the confirmed case. The
runtime harness saw `GET /` with `user-agent: node` about 1.6 s after its
server started. #1406 excused "any `GET /`" in that one harness, and the
comment it left admits the residual: a runtime escape that requests exactly
`GET /` is excused too.

## Evidence this plan rests on

- **Every exposed listener in #1409's inventory binds port 0:**
  - `serviceLanListener.test.ts:40`
  - `proxy-harness.mts:136`
  - `netFetch.test.ts:25,165`
  - `netPolicy.test.ts:43`
  - `playwrightActions.system.test.ts:18`
  - `record-fixtures.mts:164`
  - `runtimeHarness.ts:87`

  They all live for one test or one harness run.
- **The recorded machine** (`__fixtures__/*.agents-and-tmux-terminal.*`,
  replayed through `attributePorts`) has four attributed listeners:
  - 4173 and 5292: vite, fixed ports;
  - 62678: the recorder's own page server, `listen(0)`;
  - 62679: the tmux pane's Python server, which is also ephemeral.

## Rejected directions

- **Skip ephemeral ports (≥ 49152 on macOS).** This would hide the recorded
  tmux dev server (62679) and real tools that fall back to a random free port
  (`serve` does, when 3000 is busy). It trades a test flake for a product
  miss.
- **`HEAD` or another path.** It still reaches test handlers (#1409).
- **Read process command lines to spot test runners.** That undoes the
  watcher's privacy rule: `ps` reads PID/PPID only.
- **Test-side excuses only.** They fix only the tests we know about. Every
  future counting test inside a lane would rediscover the flake.

## Change

1. **Settle before probing (product).** The watcher records when it first saw
   each `pid:port`. It probes, and lists, a listener only once it has been
   listening for `PROBE_SETTLE_MS` (5 s). The first-seen entry is dropped when
   the listener disappears, just as the probe cache already is.
   - A test server that lives for less than the window is never contacted.
   - A dev server's chip appears one or two scans later: about 6–9 s after
     start at the 3 s scan floor, instead of about 0–3 s.
   - Side benefit: short-lived test servers no longer flash chips in the lane
     header.
   - **UNCONFIRMED product call:** 5 s, and hiding a listener until it
     settles. The alternative would be listing it unprobed as `other` at
     once. That brings back the chip flicker, so I rejected it.
   - Scheduling: while any listener is unsettled, the next scan runs at
     `max(SCAN_FLOOR_MS, time until the earliest one settles)` instead of the
     full back-off. Without that, a slow machine's 20 × back-off could delay
     a chip for a minute.
2. **The probe identifies itself (product plus tests).**
   - `lanePortsIo.probe` sends `User-Agent: AgentCode-LanePortProbe/1`, from
     one exported constant (`LANE_PORT_PROBE_USER_AGENT`).
   - A long-lived counting test that outlives the window can then excuse
     exactly the probe, not "any `GET /`" or "any node fetch".
   - A developer who sees the request in their server log can tell what sent
     it.
3. **Tests that count requests (test side).** Each excuses exactly the probe's
   User-Agent:
   - `runtimeHarness.ts` is DEFERRED to a follow-up once #1436 merges. #1436
     also edits that file, and #1406's `GET /` excuse already keeps the
     harness green. The follow-up narrows the excuse to `GET /` AND the probe
     UA, closing #1406's documented residual.
   - `serviceLanListener.test.ts` is NOT changed (decided during the fix).
     Each of its servers lives for one test, far under the window. The LAN
     listener also forwards only an allow-list of headers
     (`LAN_FORWARDED_HEADERS`, no `user-agent`), and that is correct product
     behavior, so a forwarded probe could not be told apart upstream anyway.
     The settle window is its fix.
   - `scripts/proxy-harness.mts` (`requestCount`).

   The latent listeners (netFetch/netPolicy, LanTransport/Cloudflared) count
   nothing and stay unchanged.

## Test plan (fail-first from recorded data)

- New `LanePortWatcher` tests use the recorded listeners.
  - The recorder's `listen(0)` page server (62678) appears in one scan and is
    gone by the next. It must never be probed. On main it is probed on the
    first scan, so this test fails there.
  - A recorded dev server (4173) is not probed before the window and is
    probed and listed after it.
  - While a listener is unsettled, the next scan is scheduled for when it
    settles, not after the back-off.
- Existing tests that expect a chip after one scan now advance the fake clock
  past the window and scan again. Their assertions stay the same.
- A `lanePortsIo.probe` test against a real loopback server: the request
  carries the probe UA.
- (Follow-up after #1436) runtimeHarness: an untagged `GET /` IS counted,
  extending #1406's positive control.

## Review round 1 (a, b): what changed and what was corrected

- **Corrected claim (b):** the settle window is a MITIGATION, not a guarantee.
  Test servers and dev servers both live for arbitrary lengths, and a stalled
  run can hold a test server past 5 s. Counting tests therefore get
  deterministic guards as well:
  - `serviceLanListener.test.ts` DOES change, reversing the earlier decision
    above. Its upstream ignores exactly `GET /`, and `send()` never uses `/`.
    A probe forwarded through the LAN listener loses its User-Agent, so shape
    is the only thing the upstream can check. A real-socket test replays that
    sequence.
  - `proxy-harness.mts` excuses `GET /` plus the UA, not the UA alone, so a
    `POST /responses` carrying that UA is still counted and forwarded.
- **Window timing (a):**
  - The age now starts when lsof returned the listener, not at scan start.
    Otherwise a slow lsof, or a scan straddling a plan change, shortened the
    window.
  - An empty plan and `stop()` forget ages and probe answers.
  - A failed lsof (timeout, signal, missing binary) throws instead of reading
    as empty, so a settled chip is not pruned and hidden for another window.
  - Known limit, documented at `PROBE_SETTLE_MS`: a close and rebind on the
    same pid:port BETWEEN scans is invisible to sampling.
- **Escalated product alternative (b), OWNER/MANAGER DECISION:** stop
  automatic HTTP probes entirely. Publish owned listening ports unverified,
  and request a port only when the user clicks it or an agent opens it. That
  gives zero unsolicited requests and immediate discovery. The costs: the
  html/other classification the chip relies on (`LanePortChip` shows html
  ports only), and non-page listeners shown as candidates, which the settle
  window could still debounce. It is out of scope here: it changes what the
  chip shows.
