# First-run recordings (#995)

Recorded by `testing/system/first-run/prerequisites.firstRun.test.ts`: the REAL
`checkPrerequisites()` from `src/main/setup/prerequisites.ts`, run with only the
machine's edges simulated (HOME, PATH, SHELL, and Electron's app path). Nothing
in these files was typed by hand.

Re-record on a Mac with:

```sh
RECORD_FIRST_RUN=1 npx vitest run --project system testing/system/first-run
```

| File | What it simulates |
|---|---|
| `clean-machine.json` | A fresh HOME, launchd's minimal PATH and `/bin/sh`: a Mac that never ran a provider installer, running a build without bundled OpenCode. |
| `clean-machine-packaged.json` | The same Mac running the packaged app, which ships OpenCode under `out/main/runtime/opencode` (#994). The binary is a stub at the path the real resolver computes, because the check only asks whether it exists. |
| `developer-machine.json` | The recording developer's real environment, with every provider CLI installed. It is machine-specific, so it is used only as policy input and never replayed live. |

## What the recordings show

- **The wall (baseline, recorded on main `82babd21` before any #995 change).** Both
  clean recordings report `ready: false, blocking: ["claude", "codex"]`. That
  includes the packaged one, where OpenCode is bundled and usable, and the Grok
  row, which is found. A machine with a working provider was locked out because
  it lacked two particular ones. `baseline-main-82babd21.json` keeps those
  verdicts verbatim.
- **The current result.** Each recording's `check` is the whole
  `SetupCheckResult`, with paths sanitized and `checkedAt` zeroed: exactly what
  the renderer receives. Renderer tests load it through
  `src/shared/setup/firstRunRecordings.testSupport.ts` instead of building a
  check by hand. The probe rows (`tools`) were re-recorded for this field and
  are identical to the baseline recording.
- **Machine-wide residue.** System locations outside HOME stay visible to the
  probes: `/usr/bin/git`, and Homebrew in `/opt/homebrew`. On the recording
  machine that includes `/opt/homebrew/bin/grok`, an npm-global install of
  `@xai-official/grok` under Homebrew's node. A factory-fresh Mac has none of
  them. They are recorded as-is:
  - The live drift check skips rows found at a machine-wide path.
  - The policy tests treat the clean recording as a "Grok is the only provider"
    machine. That is a real shape: before #995 it was also locked out.
  - The zero-provider case is covered by the macOS CI runner, which has no
    provider CLI and runs the same simulation live on every push. Tests that
    need it here use `withoutMachineWideInstalls()`, the one stated edit: it
    unsets those rows and re-derives readiness with the real policy.

Paths under the recording HOME are written as `~`, so the files carry no username.
