# ClaudePasteDetection Dev-Debug Module — Implementation Plan

> **For agentic workers:** Execute INLINE (no implementation subagents). Steps use checkbox (`- [ ]`) syntax. Issue: **#90** (prompt-submit timing). Framework: **#101** (Dev Debug Panel, already merged via PR #112).

**Goal:** A `ClaudePasteDetection` dev-debug module that makes the #90 prompt-submit race observable: a **submit-timeline / latency analyzer** over the per-paste journals already on disk, plus a **live submit-detection regex workbench** against the live screen — so we can finally see the issued→detected latency distribution and which submits get stuck.

**Architecture:** A renderer-only dev module on the existing #101 framework, plus ONE new read-back IPC so the module can pull the `paste-debug/*.paste.jsonl` journals (currently write-only). All heavy timing logic is a pure reducer (`events[] → SubmitLifecycle[]`). No changes to the submit path itself — this is pure instrumentation.

**Tech Stack:** React renderer module, Electron IPC, the existing `pasteDebugJournal` (main), TypeScript.

**Testing note (repo convention):** No new persistent test files / `test:*` scripts. Verify with `npx tsc -b tsconfig.web.json` (baseline 4 errors, filter `TS6305`) + manual: enable the module under `AGENT_CODE_DEV_DEBUG=1`, repro a submit, watch the timeline populate. Temporary throwaway fixtures only, deleted before PR.

---

## Design recap (what the module shows)

```
┌── Claude Paste / Submit Detection ─────────────── claude · <sessionId> ──┐
│ LIVE DETECTION                                streamPhase: requesting    │
│   /\[Pasted text #\d+/   plain ● match @142   md ○ no-match              │
│   spinner  /^\s*[^\w\s⏺]\s+(\S+)…/  plain ○    md ○                       │
│                                                                          │
│ SUBMIT TIMELINE (last 20)                  p50 38ms · p95 410ms · 2 stuck│
│  pasteId   issued→placeholder  →submit-cr  outcome     len   strategy    │
│  3f9c…     34ms                +6ms        ✓ cleared    1.2k  event      │
│  a071…     —                   —           ✗ STUCK      8.4k  event      │
│  b3d2…     402ms               +9ms        ✓ cleared    240   plain      │
│  …                                                                       │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Live detection pane:** runs the real submit-detection regexes against `runtime.screen` / `runtime.screenMarkdown` each render + shows current `runtime.streamPhase`. Reuses the `HeadlessSnapshotProbe` MatchCard idiom.
- **Submit timeline pane:** reads recent paste journals, reconstructs each submit's lifecycle + latency + outcome, shows a table + summary stats (p50/p95 issued→detected, stuck count).

---

## File Structure

**New:**
- `src/renderer/src/features/debug/devModules/ClaudePasteDetection/module.tsx` — descriptor + Component (the two panes).
- `src/renderer/src/features/debug/devModules/ClaudePasteDetection/timeline.ts` — pure reducer: `PasteDebugEvent[]` grouped by pasteId → `SubmitLifecycle[]` (latency + outcome + stats).

**Modify:**
- `src/renderer/src/features/debug/devModules/registry.ts` — register the module.
- `src/main/pasteDebugJournal.ts` — add `readRecentPasteSessions(limit)` (list + parse recent `*.paste.jsonl`).
- `src/main/ipc/devDebug.ts` — add `dev-debug:read-paste-events` handler.
- `src/preload/api/devDebug.ts` — add `readPasteEvents`.
- `src/preload/api/types.ts` — `PasteDebugSession` / `PasteDebugEvent` read-back types (reuse existing `PasteDebugLayer`).

---

## Task 1: Read-back of paste journals (main)

**Files:**
- Modify: `src/main/pasteDebugJournal.ts`
- Modify: `src/preload/api/types.ts`

- [ ] **Step 1: add the read-back shape to types** (`src/preload/api/types.ts`) — reuse the existing `PasteDebugLayer`:

```typescript
/** One recorded paste-debug event (as persisted in <pasteId>.paste.jsonl). */
export type PasteDebugEvent = {
  ts: number
  tMs: number
  layer: PasteDebugLayer
  event: string
  data?: Record<string, unknown>
}

/** All events for one submit (one pasteId / one journal file). */
export type PasteDebugSession = {
  pasteId: string
  startedAt: number          // file mtime or first event ts
  events: PasteDebugEvent[]
}
```

- [ ] **Step 2: add a reader to `pasteDebugJournal.ts`** — list the most recent journal files and parse them. Mirror the existing dir constant (`~/.config/agent-code/paste-debug/`):

```typescript
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { PasteDebugEvent, PasteDebugSession } from '@preload/api/types.js'

/** Read the N most-recently-modified paste journals, newest first. Tolerant:
 *  skips malformed lines/files so the dev panel never crashes on a partial
 *  write that's still being appended. */
export async function readRecentPasteSessions(limit = 30): Promise<PasteDebugSession[]> {
  let files: string[]
  try {
    files = (await readdir(PASTE_DEBUG_DIR)).filter(f => f.endsWith('.paste.jsonl'))
  } catch {
    return [] // dir not created until first paste
  }
  const withMtime = await Promise.all(
    files.map(async f => {
      try {
        return { f, mtime: (await stat(join(PASTE_DEBUG_DIR, f))).mtimeMs }
      } catch {
        return { f, mtime: 0 }
      }
    }),
  )
  withMtime.sort((a, b) => b.mtime - a.mtime)
  const out: PasteDebugSession[] = []
  for (const { f, mtime } of withMtime.slice(0, limit)) {
    const pasteId = f.replace(/\.paste\.jsonl$/, '')
    let events: PasteDebugEvent[] = []
    try {
      events = (await readFile(join(PASTE_DEBUG_DIR, f), 'utf8'))
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => JSON.parse(l) as PasteDebugEvent)
    } catch {
      /* keep partial */
    }
    out.push({ pasteId, startedAt: events[0]?.ts ?? mtime, events })
  }
  return out
}
```

> **Impl note:** confirm the exact exported name/const for the paste-debug directory in `pasteDebugJournal.ts` (the reader cited `~/.config/agent-code/paste-debug/<pasteId>.paste.jsonl`). Use that const rather than re-deriving the path.

- [ ] **Step 3: typecheck** — `npx tsc -b tsconfig.web.json 2>&1 | grep -v TS6305 | tail -10`. Expected: no new errors.
- [ ] **Step 4: commit**

```bash
git add src/main/pasteDebugJournal.ts src/preload/api/types.ts
git commit -m "feat(paste-debug): readRecentPasteSessions + read-back types"
```

---

## Task 2: IPC + preload for read-back

**Files:**
- Modify: `src/main/ipc/devDebug.ts`
- Modify: `src/preload/api/devDebug.ts`

- [ ] **Step 1: add the handler** in `src/main/ipc/devDebug.ts` (alongside `dev-debug:get-config`):

```typescript
import { readRecentPasteSessions } from '../pasteDebugJournal.js'
// inside registerDevDebugIpc():
  ipcMain.handle('dev-debug:read-paste-events', (_evt, limit?: number) =>
    readRecentPasteSessions(typeof limit === 'number' ? limit : 30),
  )
```

- [ ] **Step 2: expose it in preload** (`src/preload/api/devDebug.ts`):

```typescript
import type { DevDebugConfig, PasteDebugSession } from '@preload/api/types.js'
// inside devDebugApi:
  readPasteEvents: (limit?: number): Promise<PasteDebugSession[]> =>
    ipcRenderer.invoke('dev-debug:read-paste-events', limit),
```

- [ ] **Step 3: typecheck + commit**

```bash
npx tsc -b tsconfig.web.json 2>&1 | grep -v TS6305 | tail -10
git add src/main/ipc/devDebug.ts src/preload/api/devDebug.ts
git commit -m "feat(dev-debug): read-paste-events IPC"
```

---

## Task 3: Pure submit-timeline reducer

**Files:**
- Create: `src/renderer/src/features/debug/devModules/ClaudePasteDetection/timeline.ts`

This is the brain — pure, no React/IPC — so it's trivially correct.

- [ ] **Step 1: write it**

```typescript
import type { PasteDebugEvent, PasteDebugSession } from '@preload/api/types'

export type SubmitOutcome = 'cleared' | 'stuck' | 'partial' | 'pending' | 'unknown'

export type SubmitLifecycle = {
  pasteId: string
  startedAt: number
  /** ms from keydown:enter to the [Pasted text #N] placeholder, or null. */
  issuedToPlaceholderMs: number | null
  /** ms from placeholder to the submit \r write, or null. */
  placeholderToSubmitMs: number | null
  outcome: SubmitOutcome
  composerLen: number | null
  strategy: string | null // 'event' | 'plain' | 'image' | … from write:submit-cr data
}

function findEvent(events: PasteDebugEvent[], layer: string, prefix: string): PasteDebugEvent | undefined {
  return events.find(e => e.layer === layer && e.event.startsWith(prefix))
}

export function buildLifecycle(session: PasteDebugSession): SubmitLifecycle {
  const ev = session.events
  const enter = findEvent(ev, 'RENDER', 'keydown:enter')
  const placeholder = findEvent(ev, 'SCREEN', 'placeholder:appeared')
  const submitCr = findEvent(ev, 'IPC', 'write:submit-cr')
  const cleared = findEvent(ev, 'OUTCOME', 'composer-cleared')
  const stuck = findEvent(ev, 'OUTCOME', 'composer-stuck') ?? findEvent(ev, 'OUTCOME', 'stuck')
  const errored = ev.find(e => e.layer === 'ERROR')

  const outcome: SubmitOutcome = errored
    ? 'partial'
    : stuck
      ? 'stuck'
      : cleared
        ? 'cleared'
        : submitCr
          ? 'pending'
          : 'unknown'

  return {
    pasteId: session.pasteId,
    startedAt: session.startedAt,
    issuedToPlaceholderMs:
      enter && placeholder ? placeholder.ts - enter.ts : null,
    placeholderToSubmitMs:
      placeholder && submitCr ? submitCr.ts - placeholder.ts : null,
    outcome,
    composerLen:
      typeof enter?.data?.composerLen === 'number' ? enter.data.composerLen : null,
    strategy:
      typeof submitCr?.data?.strategy === 'string' ? submitCr.data.strategy : null,
  }
}

export type TimelineStats = {
  count: number
  stuck: number
  p50Ms: number | null
  p95Ms: number | null
}

export function buildStats(rows: SubmitLifecycle[]): TimelineStats {
  const lat = rows
    .map(r => r.issuedToPlaceholderMs)
    .filter((n): n is number => typeof n === 'number')
    .sort((a, b) => a - b)
  const pct = (p: number): number | null =>
    lat.length === 0 ? null : lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))]
  return {
    count: rows.length,
    stuck: rows.filter(r => r.outcome === 'stuck' || r.outcome === 'partial').length,
    p50Ms: pct(50),
    p95Ms: pct(95),
  }
}
```

> **Impl note:** confirm the exact `OUTCOME` event names (`composer-cleared` / `composer-stuck`) and the `write:submit-cr` `data.strategy` key against `claudePaste.ts` / `useComposerKeybinds.ts` during impl — adjust the `startsWith` prefixes to match. The reader confirmed `RENDER:keydown:enter`, `SCREEN:placeholder:appeared`, `IPC:write:submit-cr`, and `OUTCOME` layer exist.

- [ ] **Step 2: typecheck + commit**

```bash
npx tsc -b tsconfig.web.json 2>&1 | grep -v TS6305 | tail -10
git add src/renderer/src/features/debug/devModules/ClaudePasteDetection/timeline.ts
git commit -m "feat(paste-detection): pure submit-lifecycle + stats reducer"
```

---

## Task 4: The module component (two panes)

**Files:**
- Create: `src/renderer/src/features/debug/devModules/ClaudePasteDetection/module.tsx`

- [ ] **Step 1: write it** (live regex pane reuses HeadlessSnapshotProbe's idiom; timeline pane polls the read-back IPC):

```tsx
import { useEffect, useMemo, useState } from 'react'
import type { DevDebugModule, DevDebugModuleProps } from '@renderer/features/debug/devModules/types'
import type { PasteDebugSession } from '@preload/api/types'
import { buildLifecycle, buildStats } from './timeline'

// The real submit-detection rules from claude-code-headless, mirrored here so
// we can watch them fire live against the same screen the parser sees.
const DETECT_RULES: { label: string; pattern: string; flags: string }[] = [
  { label: 'pasted-placeholder', pattern: '\\[Pasted text #\\d+', flags: 'i' },
  { label: 'spinner-activity', pattern: '^\\s*[^\\w\\s⏺]\\s+(\\S+)…', flags: 'm' },
]

export const claudePasteDetectionModule: DevDebugModule = {
  id: 'claude-paste-detection',
  title: 'Claude Paste / Submit Detection',
  description: 'Live submit-detection regexes + issued→detected latency timeline (#90).',
  Component: ClaudePasteDetection,
}

function match(value: string, pattern: string, flags: string): boolean {
  try {
    return new RegExp(pattern, flags).test(value)
  } catch {
    return false
  }
}

function ClaudePasteDetection({ sessionId, runtime, kind }: DevDebugModuleProps) {
  const plain = runtime.screen ?? ''
  const markdown = runtime.screenMarkdown ?? ''
  const [sessions, setSessions] = useState<PasteDebugSession[]>([])

  // Poll the read-back IPC. 1s is plenty — the journal flushes every 100ms and
  // we're surfacing history, not racing the live submit.
  useEffect(() => {
    let alive = true
    const tick = () =>
      void window.api.readPasteEvents(20).then(s => { if (alive) setSessions(s) }).catch(() => {})
    tick()
    const h = setInterval(tick, 1000)
    return () => { alive = false; clearInterval(h) }
  }, [])

  const rows = useMemo(() => sessions.map(buildLifecycle), [sessions])
  const stats = useMemo(() => buildStats(rows), [rows])

  return (
    <div className="border border-border bg-[#101010]">
      <div className="border-b border-border px-3 py-2 flex items-center justify-between">
        <div className="text-[10px] text-red-300 uppercase tracking-[0.12em]">claude paste / submit detection</div>
        <div className="text-[10px] text-muted">{kind} · {sessionId} · phase {String(runtime.streamPhase)}</div>
      </div>

      <div className="p-3 flex flex-col gap-3">
        {/* Live detection */}
        <section className="grid grid-cols-2 gap-2">
          {DETECT_RULES.map(r => (
            <div key={r.label} className="border border-border bg-canvas px-2 py-1">
              <div className="text-[9px] text-muted uppercase tracking-[0.12em]">{r.label}</div>
              <div className="mt-1 flex gap-3 text-[10px]">
                <span className={match(plain, r.pattern, r.flags) ? 'text-green-400' : 'text-red-400'}>
                  plain {match(plain, r.pattern, r.flags) ? '●' : '○'}
                </span>
                <span className={match(markdown, r.pattern, r.flags) ? 'text-green-400' : 'text-red-400'}>
                  md {match(markdown, r.pattern, r.flags) ? '●' : '○'}
                </span>
              </div>
            </div>
          ))}
        </section>

        {/* Timeline stats */}
        <div className="text-[10px] text-muted tabular-nums">
          {stats.count} submits · p50 {stats.p50Ms ?? '—'}ms · p95 {stats.p95Ms ?? '—'}ms ·{' '}
          <span className={stats.stuck > 0 ? 'text-red-400' : 'text-muted'}>{stats.stuck} stuck</span>
        </div>

        {/* Timeline table */}
        <div className="overflow-auto max-h-[260px] border border-[#222] bg-[#0b0b0b]">
          <table className="w-full text-[10px] tabular-nums">
            <thead className="text-muted">
              <tr>
                <th className="text-left px-2 py-1">pasteId</th>
                <th className="text-right px-2 py-1">issued→ph</th>
                <th className="text-right px-2 py-1">ph→cr</th>
                <th className="text-left px-2 py-1">outcome</th>
                <th className="text-right px-2 py-1">len</th>
                <th className="text-left px-2 py-1">strategy</th>
              </tr>
            </thead>
            <tbody className="text-ink-dim">
              {rows.map(r => (
                <tr key={r.pasteId}>
                  <td className="px-2 py-0.5">{r.pasteId.slice(0, 6)}</td>
                  <td className="px-2 py-0.5 text-right">{r.issuedToPlaceholderMs ?? '—'}</td>
                  <td className="px-2 py-0.5 text-right">{r.placeholderToSubmitMs ?? '—'}</td>
                  <td className={`px-2 py-0.5 ${r.outcome === 'stuck' || r.outcome === 'partial' ? 'text-red-400' : r.outcome === 'cleared' ? 'text-green-400' : 'text-muted'}`}>
                    {r.outcome}
                  </td>
                  <td className="px-2 py-0.5 text-right">{r.composerLen ?? '—'}</td>
                  <td className="px-2 py-0.5">{r.strategy ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
```

> **Impl note:** confirm `runtime.screen` / `runtime.screenMarkdown` / `runtime.streamPhase` field names against `workspaceState.ts` (HeadlessSnapshotProbe reads `runtime.screen` + `runtime.screenMarkdown`, so those are correct). Verify `window.api.readPasteEvents` exists after Task 2.

- [ ] **Step 2: typecheck + commit**

```bash
npx tsc -b tsconfig.web.json 2>&1 | grep -v TS6305 | tail -10
git add src/renderer/src/features/debug/devModules/ClaudePasteDetection/module.tsx
git commit -m "feat(paste-detection): dev module — live regexes + submit timeline"
```

---

## Task 5: Register the module

**Files:**
- Modify: `src/renderer/src/features/debug/devModules/registry.ts`

- [ ] **Step 1: register**

```typescript
import { claudePasteDetectionModule } from '@renderer/features/debug/devModules/ClaudePasteDetection/module'

export const devDebugModules: DevDebugModule[] = [
  headlessSnapshotProbeModule,
  claudePasteDetectionModule,
]
```

- [ ] **Step 2: typecheck + commit**

```bash
npx tsc -b tsconfig.web.json 2>&1 | grep -v TS6305 | tail -10
git add src/renderer/src/features/debug/devModules/registry.ts
git commit -m "feat(paste-detection): register module in dev-debug registry"
```

---

## Task 6: Manual acceptance + PR

- [ ] **Step 1: full typecheck** — `npx tsc -b tsconfig.web.json 2>&1 | grep -v TS6305 | tail -20`. Expected: only the 4 baseline errors.
- [ ] **Step 2: manual acceptance** (run with `AGENT_CODE_DEV_DEBUG=1`):
  1. Command palette → "Dev Debug Panel" → enable "Claude Paste / Submit Detection".
  2. Paste a medium prompt into a Claude pane, submit. Watch the live regex panes toggle as `[Pasted text #N]` appears; `streamPhase` advances.
  3. The timeline table gains a row with `issued→ph` latency + outcome `cleared`.
  4. Force a stuck submit (large paste under load) → row shows `stuck` in red; stuck count increments; p95 reflects the tail.
  5. Disable the module → panel empties; no residual cost.
- [ ] **Step 3: push + PR** (worktree + branch; switch gh account first)

```bash
gh auth switch --user Juliusolsson05
git push -u origin feat/claude-paste-detection-devmodule
gh pr create --title "feat(debug): ClaudePasteDetection dev module for #90" \
  --body "Adds a #101-framework dev module to diagnose #90: live submit-detection regexes against the screen + an issued→detected latency timeline read back from the existing paste journals. Closes #90 investigation tooling; instrumentation only, no submit-path changes."
```

- [ ] **Step 4: report the PR URL. Do NOT merge.**

---

## Self-review (against #90 + #101)

- **#90 "capture timing pairs (submit-issued → submit-detected)… latency distribution"** → Task 3 reducer (`issuedToPlaceholderMs`) + Task 4 stats (p50/p95) ✓
- **#90 "log screen-state + regex match results of submit-detection rules"** → Task 4 live-detection pane against `runtime.screen` ✓
- **#101 framework contract** (`DevDebugModule` descriptor + registry + renderer-only + add-IPC-if-needed) → Tasks 1–5 follow it exactly; one IPC added per the framework's documented escape hatch ✓
- **No submit-path changes** (instrumentation only) → confirmed; only read-back + a renderer module ✓
- **Ship-safe** → gated by `AGENT_CODE_DEV_DEBUG`; zero cost when the module is off (the 1s poll only runs while the component is mounted, i.e. enabled) ✓
- **Type consistency** → `PasteDebugEvent`/`PasteDebugSession` defined once in `preload/api/types.ts` (Task 1), consumed by reducer (Task 3) + module (Task 4); `SubmitLifecycle` fields flow reducer→table unchanged ✓

**Open items to confirm during impl (flagged inline):** exact paste-debug dir const name; exact `OUTCOME`/`write:submit-cr` event + `data` key names; `runtime` field names for screen/streamPhase.
