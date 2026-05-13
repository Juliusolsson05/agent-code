# Reporting Issues

Agent Code lives in one main repo and four submodule packages. Where an
issue belongs depends on what it's about — the wrong-repo bounce is the
most common reason a bug report sits unanswered.

## Which repo

| Repo | What goes here |
|---|---|
| **[Juliusolsson05/agent-code](https://github.com/Juliusolsson05/agent-code)** | The Electron app — UI, tile-tree, dispatch, settings, system-perf, session management, IPC, all renderer + main-process behavior. **Default when in doubt — file here.** |
| **[claude-code-headless](https://github.com/Juliusolsson05/claude-code-headless)** | Bugs in how we drive the real `claude` CLI: TUI parsing, JSONL transcript handling, proxy/SSE streaming, slash-picker detection, permission-prompt detection. |
| **[codex-headless](https://github.com/Juliusolsson05/codex-headless)** | Same as above but for the `codex` CLI: rollout parsing, Responses API adapter, Codex screen parsing, approval overlays. |
| **[agent-transcript-parser](https://github.com/Juliusolsson05/agent-transcript-parser)** | Bidirectional Claude↔Codex transcript translation, ghost-entry primitives, rewind/clone helpers. |
| **[agent-voice-dictation](https://github.com/Juliusolsson05/agent-voice-dictation)** | Dictation recording, STT-provider clients (AssemblyAI, Deepgram, OpenAI, Gladia, ElevenLabs), OpenRouter polishing, composer integration. |

If you're unsure, **file in `agent-code`** — we'll move it if it belongs
downstream.

## Before you file

1. **Search open and closed issues** for your symptom. Many recurring
   issues already have context attached.
2. **Reproduce on the latest `main`** if you can. Many issues are
   fixed in unreleased builds.

## Bug reports

Open a bug as soon as you have enough info to write the four sections
below. Don't wait until you have a full repro — partial reports are
fine, just say so.

### Required sections

```markdown
### What happened
One or two sentences. The visible symptom.

### What you expected
What you thought would happen instead.

### Steps to reproduce
1. …
2. …
3. …

(If you can't reliably reproduce, say so. "Happens randomly during normal
use" is a valid description — see the performance section below.)

### Environment
- Agent Code version: (Settings → About, or `package.json` version)
- macOS version: (Apple menu → About This Mac)
- Provider: Claude / Codex / both / terminal
- Number of active panes at the time:
- Did the app crash, freeze, or just misbehave?
```

### What helps a lot

- **A screenshot or screen recording** if the symptom is visual.
- **A debug bundle** — Cmd+Shift+P → "Save Debug Bundle" → attach the
  resulting zip. It contains feed-debug logs, proxy events, workspace
  state, and the screen tail at crash time. Strip any session content
  you don't want to share before uploading.
- **The system-perf popover screenshot** for memory / freezing issues
  (click the heap badge in the header — only visible if
  `AGENT_CODE_PERF=1` is set).
- **The exact agent transcript path** if the issue is about a specific
  session. Don't paste the transcript itself; we can ask if we need it.

### What doesn't help

- "It's broken." (We can't act on this — describe the symptom.)
- "Same as #N." (Comment on #N instead. Or describe how it differs.)
- Stack traces without context. (Include what you were doing too.)

## Feature requests

Open a feature request issue (label `enhancement`). Lead with the
**problem you're solving**, not the implementation you have in mind:

```markdown
### Use case
What workflow you're trying to do that the current app makes hard.

### Concrete example
One scenario, end to end, with what you'd do today vs. what you wish
you could do.

### Why now
What's prompting this — is it daily friction, a one-off frustration, or
something you'd love to have eventually?

### (Optional) Implementation thoughts
Skip this unless you have specific ideas. The "use case" section is
what drives the design decision.
```

Single-sentence requests ("add Vim mode") are welcome but expect more
back-and-forth than reports with a use case attached.

## Performance / OOM / crash reports

These need different evidence than functional bugs. Please include:

- **System-perf popover screenshot** at the time of the issue (heap
  spaces, detached contexts, event-loop p99).
- **Heap snapshot** if available — `~/.config/agent-code/heap-snapshots/`
  contains `.heapsnapshot` files from manual captures and watchdog
  trips. Zip and attach. They can be large (100s of MB); using a
  cloud-share link is fine.
- **The fatal-error trace** if the app actually crashed — the terminal
  where you ran `npm start` will have a "FATAL ERROR: …" block. The
  V8 native frames are the most useful part.
- **Pattern of growth** — does the heap climb steadily, spike-and-drop,
  jump suddenly? "Random crashes during normal work" is a real pattern;
  say so explicitly.

## Security issues

**Don't file security issues on GitHub.** Email the maintainers
directly (see repo profile). We'll triage privately and credit you in
the fix.

## What not to file as an issue

- **Questions about how to use the app** → GitHub Discussions or chat.
- **Configuration help** ("how do I set my Claude API key") →
  Discussions.
- **Issues against a specific Claude / Codex CLI release** (e.g.
  "claude doesn't accept this flag") — those belong upstream, not in
  the Agent Code repos.

## Triage labels

Maintainers apply these. You don't need to:

- `bug` — confirmed defect, work scheduled.
- `enhancement` — feature request accepted.
- `needs-repro` — we couldn't reproduce. Add details if you can.
- `external` — issue belongs in a different repo; we'll link it.
- `wontfix` — design choice; we won't change it. Comes with a reason.
- `parked` — known, deferred. Re-open if you have new evidence.

## After you file

- We respond within ~3 days for triage. If we haven't responded in a
  week, ping the issue.
- Once labeled, the issue's status is set. Comment with new info as
  you find it — comments do not need to be in any specific format.
- PRs welcome but **open the issue first** for anything bigger than a
  typo. Five lines of design discussion beats fifty lines of
  back-and-forth on a PR.

---

Thanks for reporting. Good bug reports are how this app gets better.
