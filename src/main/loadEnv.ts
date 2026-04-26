import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Load a project-root `.env` file into process.env before any other
// module reads environment flags.
//
// WHY this exists: electron-vite's Vite layer only exposes `*_VITE_`
// prefixed variables via `import.meta.env`. Unprefixed flags like
// `CC_SHELL_PERF` never reach `process.env` in the main process, so
// modules that gate on them at import time (see
// `@main/performance/PerformanceService.ts`) would always see them
// as unset no matter what `.env` contained.
//
// Keep this parser minimal — we only need KEY=VALUE lines, optional
// surrounding quotes, and comment lines. No variable interpolation,
// no multiline values. If we ever need more, pull in `dotenv`; until
// then, zero dependencies and ~20 lines is cheaper than a package.
//
// Must be imported at the VERY TOP of `src/main/index.ts`, before any
// other import, because ES module imports are hoisted in source
// order — downstream modules (e.g. PerformanceService) read
// `process.env` in class-field initializers at module load.

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  const eq = trimmed.indexOf('=')
  if (eq === -1) return null
  const key = trimmed.slice(0, eq).trim()
  let value = trimmed.slice(eq + 1).trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  }
  return [key, value]
}

function loadEnvFile(path: string): void {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of contents.split(/\r?\n/)) {
    const parsed = parseEnvLine(line)
    if (!parsed) continue
    const [key, value] = parsed
    // Don't clobber an explicit shell export — CLI-set values win
    // so a `CC_SHELL_PERF=0 npm run dev` turns telemetry off even
    // if `.env` has it enabled.
    if (process.env[key] !== undefined) continue
    process.env[key] = value
  }
}

// `process.cwd()` during `electron-vite dev` is the project root,
// which is where the user's `.env` lives. In packaged builds, the
// working directory is the app's resource dir; we still look for a
// `.env` there so users can drop one next to the app to flip
// telemetry on without rebuilding.
loadEnvFile(resolve(process.cwd(), '.env'))
