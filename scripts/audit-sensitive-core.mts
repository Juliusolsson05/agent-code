// tsx bridge: run the repo's CANONICAL key-based sensitive-value gate over
// arbitrary parsed fixture roots and print the survivors as JSON.
//
// WHY a tsx bridge instead of a key-regex copy in audit-rendering-fixture.mjs:
// SENSITIVE_KEY (rendering/model/unknowns.ts) is the single source of truth
// for "which object keys carry a secret", and findSensitiveSurvivors
// (rendering/replay/redact.ts) is the supported walker over it — the same
// gate that refuses to emit a leaky recording fixture. A private regex copy
// in the audit script is exactly the drift the redaction module warns about:
// the audit could pass `authorization: "Bearer …"` that the extraction gate
// would refuse. So the .mjs shells to this bridge, which imports the ONE
// implementation. This mirrors how extract-rendering-recordings.mjs shells to
// extract-recording-core.mts for the same reason.
//
// WHY the bridge does its own collect() walk IN ADDITION to calling
// findSensitiveSurvivors: the canonical gate returns survivor PATHS only, and
// its path syntax is ambiguous to parse back (fixture keys can contain
// literal dots, e.g. `cache_creation.ephemeral_1h_input_tokens` in provider
// usage blocks), so the audit cannot resolve a path back to a value to decide
// severity. The audit NEEDS the value TYPE: this corpus is full of integer
// token-usage counters (`input_tokens`, `output_tokens`, …) whose keys match
// /token/ but which cannot carry a secret — flagging thousands of ints as
// review findings would rot the verdict signal (the same failure mode as
// flagging every absolute path). collect() therefore mirrors the gate's
// semantics (same key regex, same skip set: the ⟨redacted⟩ placeholder, null/
// undefined, empty string) while ALSO recording valueType/chars/hash — and the
// drift check below asserts, per root, that collect() found the exact same
// path list as the canonical findSensitiveSurvivors. If redact.ts ever changes
// its semantics, this bridge fails loudly instead of silently under-reporting.
//
// Protocol (kept dumb on purpose — the .mjs owns all file IO and reporting):
//   stdin:  JSON array of { source: string, value: unknown } parsed roots
//   stdout: JSON array of { source, path, valueType, chars, hash }
// Exits non-zero (reason on stderr) on protocol errors or gate drift.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { findSensitiveSurvivors } from '../src/renderer/src/rendering/replay/redact.ts'
import { SENSITIVE_KEY } from '../src/renderer/src/rendering/model/unknowns.ts'

// Mirrors redact.ts's un-exported REDACTED_VALUE. A drift here (redact.ts
// changing its placeholder) is caught by the path-list assertion below, so
// this copy cannot silently diverge.
const REDACTED_VALUE = '⟨redacted⟩'

type Survivor = {
  source: string
  path: string
  /** typeof of the surviving value, with 'array' split out — the audit
   *  treats number/boolean as usage-counter noise and everything else as a
   *  review finding. */
  valueType: string
  chars: number
  /** sha256 prefix of the value so the audit can point AT a survivor without
   *  ever printing it (the survivor may literally be the secret). */
  hash: string
}

function collect(node: unknown, path: string, out: Omit<Survivor, 'source'>[]): void {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((v, i) => collect(v, `${path}[${i}]`, out))
    return
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const here = path ? `${path}.${k}` : k
    // Same predicate as findSensitiveSurvivors — asserted identical below.
    if (SENSITIVE_KEY.test(k) && v !== REDACTED_VALUE && v != null && v !== '') {
      const json = typeof v === 'string' ? v : (JSON.stringify(v) ?? '')
      out.push({
        path: here,
        valueType: Array.isArray(v) ? 'array' : typeof v,
        chars: json.length,
        hash: createHash('sha256').update(json).digest('hex').slice(0, 12),
      })
    }
    collect(v, here, out)
  }
}

let roots: { source: string; value: unknown }[]
try {
  roots = JSON.parse(readFileSync(0, 'utf8'))
} catch (err) {
  console.error(`audit-sensitive-core: failed to parse stdin as JSON: ${err}`)
  process.exit(2)
}

const survivors: Survivor[] = []
for (const { source, value } of roots) {
  const collected: Omit<Survivor, 'source'>[] = []
  collect(value, '', collected)

  // Drift check: the typed walk above must agree exactly (paths AND order —
  // both walks follow Object.entries order) with the canonical gate. A
  // mismatch means redact.ts changed semantics out from under this bridge;
  // fail loudly rather than let the audit under- or over-report.
  const canonical = findSensitiveSurvivors(value)
  const mine = collected.map(c => c.path)
  if (JSON.stringify(canonical) !== JSON.stringify(mine)) {
    console.error(
      `audit-sensitive-core: DRIFT between findSensitiveSurvivors and the typed walk ` +
        `for ${source}: canonical=${canonical.length} paths, typed=${mine.length} paths. ` +
        `redact.ts semantics changed — update this bridge before trusting audit output.`,
    )
    process.exit(3)
  }

  for (const c of collected) survivors.push({ source, ...c })
}

process.stdout.write(JSON.stringify(survivors))
