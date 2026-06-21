#!/usr/bin/env node
// scripts/analyze-heapsnapshot.mjs
//
// Standalone V8 .heapsnapshot analyzer — issue #288 (PART A).
//
// WHY this exists: the heap watchdog (#48, src/main/performance/heapWatchdog.ts)
// dumps a 120–300 MB raw .heapsnapshot the first time the main process crosses
// a near-OOM threshold. That artifact is forensic gold, but today the ONLY way
// to read it is to drag it into Chrome DevTools — which itself needs gigabytes
// of RAM to parse the bigger dumps and gives no scriptable, diffable, or
// CI-friendly output. This script makes the snapshot readable from the command
// line with zero dependencies (pure Node ESM), so future-you can answer
// "what is eating the heap?" in seconds without DevTools.
//
// It is the MEASURING INSTRUMENT for the rest of the #288 leak hunt: every
// subsequent fix should be validated by re-running this and watching the
// top retainers / duplicated-string buckets shrink.
//
// TWO MODES:
//
//   1. SUMMARY (default): exactly one streaming pass over the flat `nodes`
//      array. Reports totals, self_size by node type, the heaviest object
//      constructors, the most-duplicated string content patterns, the biggest
//      single strings, and a crude renderer-vs-main process fingerprint. This
//      mode deliberately does NOT build any reverse-edge index, because the
//      snapshots we analyze are precisely the ones that blew the heap — we keep
//      our own footprint to roughly one pass + a few small aggregation maps.
//
//   2. RETAIN (--retain "prefix1,prefix2"): the heavy mode. Builds a
//      compressed-sparse-row (CSR) reverse-edge index over ALL edges so we can
//      walk "who points at this node" one level up. For every STRING whose
//      content starts with one of the given prefixes, we attribute its bytes to
//      the owning `type:name .property` and print the top owners — i.e. WHO is
//      holding the duplicated strings. This costs O(edges) memory and time, so
//      it is opt-in only.
//
// MEMORY: for the large dumps you MUST raise the old-space cap, e.g.
//   node --max-old-space-size=8192 scripts/analyze-heapsnapshot.mjs <file>
// The watchdog auto-summary (PART B) spawns us with --max-old-space-size=4096,
// which is plenty for the summary pass on a ~300 MB snapshot. --retain on a
// 300 MB snapshot wants the full 8192.
//
// SNAPSHOT FORMAT (V8 "HeapSnapshot" JSON, the .heapsnapshot on-disk shape):
//   {
//     snapshot: { meta: { node_fields, node_types, edge_fields, edge_types }, node_count, edge_count },
//     nodes:    flat int array, node_fields.length ints per node,
//     edges:    flat int array, edge_fields.length ints per edge,
//     strings:  string[] (node/edge names are indices into this array)
//   }
// node_fields is ["type","name","id","self_size","edge_count","trace_node_id","detachedness"].
// node_types[0] is the enum of node type names (["hidden","array","string","object",...]).
// `name` for an object node is the constructor name (index into strings);
// for a string node it is the string content (also an index into strings).
// `edge_count` is how many of the flat `edges` belong to this node, in order —
// that adjacency is what lets us build the CSR index without a name lookup table.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

// ---------------------------------------------------------------------------
// arg parsing — keep it dumb and dependency-free
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const file = argv[2]
  let top = 25
  let retain = null
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--top') {
      top = parseInt(argv[++i], 10) || 25
    } else if (a === '--retain') {
      retain = String(argv[++i] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    }
  }
  return { file, top, retain }
}

function fmtBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${n} B`
}

function pct(part, whole) {
  if (!whole) return '0.0%'
  return `${((100 * part) / whole).toFixed(1)}%`
}

// Whitespace-normalize + truncate to a bucket key. We collapse all runs of
// whitespace (incl. newlines/tabs) to single spaces so that strings that
// differ only in indentation/line-wrapping bucket together, then take the
// first 100 chars. This is what surfaces "the same cwd path x4000" or
// "Read tool result blob xN" — the duplication that bloats the heap.
function bucketKey(s) {
  const norm = s.replace(/\s+/g, ' ').trim()
  return norm.length > 100 ? norm.slice(0, 100) : norm
}

function preview(s, n) {
  const norm = s.replace(/\s+/g, ' ').trim()
  return norm.length > n ? `${norm.slice(0, n)}…` : norm
}

// topN: return [key, value] pairs sorted by value desc, capped at n.
function topN(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
}

function pad(s, n) {
  return String(s).padStart(n)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const { file, top, retain } = parseArgs(process.argv)
  if (!file) {
    // eslint-disable-next-line no-console
    console.error(
      'usage: node [--max-old-space-size=8192] analyze-heapsnapshot.mjs <file.heapsnapshot> [--top N] [--retain "prefix1,prefix2"]',
    )
    process.exit(1)
  }

  // Parse the snapshot inside a helper that returns only the parsed object
  // (review fix #3): the .heapsnapshot is one JSON document and there is no
  // streaming JSON parser in core, so we must JSON.parse the whole ~300 MB
  // source string. The bug we are fixing is that the raw UTF-8 source used to
  // stay referenced (`const raw = ...`) for the entire run, so at peak we held
  // BOTH the ~300 MB source AND the parsed structure simultaneously. By doing
  // readFileSync + JSON.parse inside parseSnapshot() — whose only return is the
  // parsed object — the `raw` reference dies the moment that function returns,
  // letting V8 reclaim the source string before the heavy aggregation passes
  // (and well before the O(edges) CSR build in --retain). On the snapshots this
  // tool targets — the ones that already blew the heap — dropping the
  // source-vs-parsed peak is what keeps the analyzer from OOMing on itself.
  // The --max-old-space-size note in the header still applies to the parse
  // itself; this fix only shrinks the post-parse peak.
  const snap = parseSnapshot(file)

  const meta = snap.snapshot.meta
  const nodeFields = meta.node_fields
  const nodeTypes = meta.node_types[0] // enum of node type names
  const nodes = snap.nodes
  const strings = snap.strings
  const NF = nodeFields.length // ints per node (7 for the standard layout)

  const idxType = nodeFields.indexOf('type')
  const idxName = nodeFields.indexOf('name')
  const idxSelfSize = nodeFields.indexOf('self_size')

  const nodeCount = snap.snapshot.node_count ?? nodes.length / NF

  // The "object" type enum drives the constructor buckets below.
  const objectTypeId = nodeTypes.indexOf('object')

  // String-like node types (review fix #1): V8 snapshots represent string data
  // under THREE distinct node types, not just "string":
  //   - "string"              — a flat/external string
  //   - "concatenated string" — a cons-string (the result of `a + b` before
  //                             flattening); extremely common in real dumps
  //   - "sliced string"       — a substring view sharing a parent's backing
  // All three carry their resolved content via the `name` field (an index into
  // the strings array, exactly like a plain "string" node). The original code
  // only counted `stringTypeId`, which UNDERREPORTED string memory — fatal for
  // a #288 tool whose entire job is measuring the "84% strings" claim. We build
  // a Set of the string-like type ids and treat membership as "is a string"
  // everywhere strings are aggregated, bucketed, listed, or --retain-matched.
  // Using a Set (not 3 scalar compares) keeps the hot per-node loop branch-cheap
  // and means adding a future string subtype is a one-line change here.
  const stringTypeIds = stringLikeTypeIds(nodeTypes)

  // --- aggregation accumulators (all small relative to the snapshot) ---
  let totalSelf = 0
  let stringsSelf = 0
  const selfByType = new Map() // typeName -> bytes
  const ctorSelf = new Map() // constructor name -> bytes
  const strBuckets = new Map() // bucketKey -> { count, totalSize, sample }
  const bigStrings = [] // { size, content } for strings > BIG_STRING_BYTES

  const BIG_STRING_BYTES = 200 * 1024

  // -- SINGLE PASS over nodes --------------------------------------------
  // i indexes into the flat `nodes` array; each node is NF ints.
  for (let i = 0; i < nodes.length; i += NF) {
    const typeId = nodes[i + idxType]
    const nameIdx = nodes[i + idxName]
    const selfSize = nodes[i + idxSelfSize]

    totalSelf += selfSize

    const typeName = nodeTypes[typeId] ?? `type#${typeId}`
    selfByType.set(typeName, (selfByType.get(typeName) || 0) + selfSize)

    if (typeId === objectTypeId) {
      // For object nodes `name` is the constructor name.
      const ctor = strings[nameIdx] ?? '(anonymous)'
      ctorSelf.set(ctor, (ctorSelf.get(ctor) || 0) + selfSize)
    } else if (stringTypeIds.has(typeId)) {
      // string / concatenated string / sliced string all land here (fix #1):
      // their `name` indexes into the strings array for the resolved content,
      // so they bucket and aggregate identically to a plain string node.
      stringsSelf += selfSize
      const content = strings[nameIdx] ?? ''
      const key = bucketKey(content)
      const b = strBuckets.get(key)
      if (b) {
        b.count++
        b.totalSize += selfSize
      } else {
        strBuckets.set(key, { count: 1, totalSize: selfSize, sample: content })
      }
      if (selfSize >= BIG_STRING_BYTES) {
        bigStrings.push({ size: selfSize, content })
      }
    }
  }

  // --- report ------------------------------------------------------------
  const L = []
  L.push(`heap-snapshot analysis: ${basename(file)}`)
  L.push(
    `nodes=${nodeCount.toLocaleString()}  total self_size=${fmtBytes(totalSelf)}  strings=${fmtBytes(
      stringsSelf,
    )} (${pct(stringsSelf, totalSelf)} of total)`,
  )
  L.push('')

  L.push('self_size by node TYPE (top 12):')
  for (const [name, bytes] of topN(selfByType, 12)) {
    L.push(`  ${pad(fmtBytes(bytes), 11)} ${pct(bytes, totalSelf).padStart(6)}  ${name}`)
  }
  L.push('')

  L.push(`top OBJECT constructors by self_size (top ${top}):`)
  for (const [name, bytes] of topN(ctorSelf, top)) {
    L.push(`  ${pad(fmtBytes(bytes), 11)} ${pct(bytes, totalSelf).padStart(6)}  ${name}`)
  }
  L.push('')

  L.push(`top STRING content patterns by total size (top ${top}) — first 100 chars, ws-normalized:`)
  // Sort string buckets by totalSize; this is where duplication screams.
  const sortedBuckets = [...strBuckets.values()].sort((a, b) => b.totalSize - a.totalSize)
  for (const b of sortedBuckets.slice(0, top)) {
    L.push(
      `  ${pad(fmtBytes(b.totalSize), 11)} x${pad(String(b.count), 7)} ${JSON.stringify(
        preview(b.sample, 80),
      )}`,
    )
  }
  L.push('')

  L.push(`biggest single strings (> ${fmtBytes(BIG_STRING_BYTES)}):`)
  bigStrings.sort((a, b) => b.size - a.size)
  if (bigStrings.length === 0) {
    L.push('  (none)')
  } else {
    for (const s of bigStrings.slice(0, top)) {
      L.push(`  ${pad(fmtBytes(s.size), 11)}  ${JSON.stringify(preview(s.content, 140))}`)
    }
  }
  L.push('')

  // --- crude process fingerprint ----------------------------------------
  // A heap snapshot from the renderer and from the main process look very
  // different. We don't always know which process produced a given file, so we
  // probe for marker constructors that are characteristic of each side. This is
  // a heuristic — presence, not absence, is the signal.
  const RENDERER_MARKERS = ['Window', 'HTMLDivElement', 'FiberNode', 'HTMLElement', 'Document']
  const MAIN_MARKERS = ['Socket', 'process', 'Http2Session', 'ChildProcess', 'Pipe', 'TCP']
  const present = (m) => ctorSelf.has(m)
  const rFound = RENDERER_MARKERS.filter(present)
  const mFound = MAIN_MARKERS.filter(present)
  L.push('process fingerprint (object-constructor markers present):')
  L.push(`  renderer: ${rFound.length ? rFound.join(', ') : '(none)'}`)
  L.push(`  main:     ${mFound.length ? mFound.join(', ') : '(none)'}`)
  let guess = 'unknown'
  if (rFound.length && !mFound.length) guess = 'renderer'
  else if (mFound.length && !rFound.length) guess = 'main'
  else if (rFound.length && mFound.length) guess = 'mixed/ambiguous'
  L.push(`  => looks like: ${guess}`)
  L.push('')

  // eslint-disable-next-line no-console
  console.log(L.join('\n'))

  if (retain && retain.length) {
    reportRetainers({ snap, nodeFields, nodeTypes, strings, stringTypeIds, prefixes: retain, top })
  }
}

// parseSnapshot: read + JSON.parse in an isolated scope so the raw source
// string is unreferenced (and GC-eligible) the instant we return (review fix
// #3). See the long note at the call site for why this matters on the big dumps.
function parseSnapshot(file) {
  const raw = readFileSync(file, 'utf8')
  return JSON.parse(raw)
}

// stringLikeTypeIds: resolve the node_types enum indices for every string-like
// V8 node type (review fix #1). Returns a Set of numeric type ids. Any type the
// snapshot doesn't declare simply yields -1 from indexOf, which we drop — so on
// an exotic snapshot missing "sliced string" we just don't add a phantom id.
function stringLikeTypeIds(nodeTypes) {
  const ids = new Set()
  for (const name of ['string', 'concatenated string', 'sliced string']) {
    const id = nodeTypes.indexOf(name)
    if (id !== -1) ids.add(id)
  }
  return ids
}

// ---------------------------------------------------------------------------
// --retain mode: reverse-edge CSR index + 1-level owner attribution
// ---------------------------------------------------------------------------
//
// WHY CSR (compressed sparse row): edges in a V8 snapshot are stored as a flat
// array, grouped per source node in node order (each node "owns" the next
// `edge_count` edges). So we can compute, in one pass, the source node of every
// edge. To answer "who points at node X" we invert that into a reverse index:
//   revHead[X]   = start offset into revSrc for node X's incoming edges
//   revSrc[]     = the source node ordinal of each incoming edge
//   revEdgeName[]= the edge's name index (paired with revSrc)
// Building it is O(edges) time and memory, which is exactly why this is opt-in.
function reportRetainers({ snap, nodeFields, nodeTypes, strings, stringTypeIds, prefixes, top }) {
  const nodes = snap.nodes
  const edges = snap.edges
  const meta = snap.snapshot.meta
  const edgeFields = meta.edge_fields
  const edgeTypes = meta.edge_types[0]
  const NF = nodeFields.length
  const EF = edgeFields.length

  const idxType = nodeFields.indexOf('type')
  const idxName = nodeFields.indexOf('name')
  const idxSelfSize = nodeFields.indexOf('self_size')
  const idxEdgeCount = nodeFields.indexOf('edge_count')

  const eIdxType = edgeFields.indexOf('type')
  const eIdxName = edgeFields.indexOf('name_or_index')
  const eIdxTo = edgeFields.indexOf('to_node')

  const nodeCount = nodes.length / NF
  const edgeCount = edges.length / EF

  // Edge-count sanity check (review fix #4): the whole CSR build assumes the
  // per-node `edge_count` fields partition the flat `edges` array exactly — node
  // n owns the next edge_count[n] edges, in order. If a snapshot was truncated
  // mid-write or otherwise corrupted, the sum of edge_counts won't equal
  // edges.length / EF, and the `edgeCursor` walk above/below would read past the
  // intended boundaries and silently mis-attribute (or index OOB into) edges —
  // producing confident-but-wrong owner output, the worst failure mode for a
  // forensic tool. We can't cheaply repair it, so we just WARN loudly and let
  // the pass continue (a partial answer beats refusing on a slightly-off dump).
  // This is O(nodeCount) and runs once, so it's effectively free.
  let summedEdgeCount = 0
  for (let n = 0; n < nodeCount; n++) summedEdgeCount += nodes[n * NF + idxEdgeCount]
  if (summedEdgeCount !== edgeCount) {
    // eslint-disable-next-line no-console
    console.log(
      `[warn] snapshot edge counts inconsistent: sum(edge_count)=${summedEdgeCount.toLocaleString()} but edges.length/edge_field_count=${edgeCount.toLocaleString()} — retainer attribution may be wrong (truncated/corrupt snapshot?)`,
    )
  }

  // to_node in the edge array is the BYTE-style offset into `nodes` (a multiple
  // of NF), per the V8 format. Convert to a node ordinal by dividing by NF.
  const propertyEdgeType = edgeTypes.indexOf('property')

  // Pass 1: count incoming edges per target node so we can size the CSR arrays.
  // eslint-disable-next-line no-console
  console.log(`\n[--retain] building reverse-edge index over ${edgeCount.toLocaleString()} edges…`)
  const inCount = new Uint32Array(nodeCount)
  {
    let edgeCursor = 0
    for (let n = 0; n < nodeCount; n++) {
      const ec = nodes[n * NF + idxEdgeCount]
      for (let e = 0; e < ec; e++) {
        const base = (edgeCursor + e) * EF
        const toNode = edges[base + eIdxTo] / NF
        inCount[toNode]++
      }
      edgeCursor += ec
    }
  }

  // CSR offsets: revHead[i] = first slot for node i; revHead[nodeCount] = total.
  const revHead = new Uint32Array(nodeCount + 1)
  for (let i = 0; i < nodeCount; i++) revHead[i + 1] = revHead[i] + inCount[i]
  const totalIn = revHead[nodeCount]
  // For each incoming edge we store the SOURCE node and the edge name index.
  const revSrc = new Uint32Array(totalIn)
  const revEdgeName = new Int32Array(totalIn)
  const revEdgeType = new Uint8Array(totalIn)

  // Pass 2: fill. `fillPos` tracks the next free slot per target.
  const fillPos = revHead.slice(0, nodeCount)
  {
    let edgeCursor = 0
    for (let n = 0; n < nodeCount; n++) {
      const ec = nodes[n * NF + idxEdgeCount]
      for (let e = 0; e < ec; e++) {
        const base = (edgeCursor + e) * EF
        const toNode = edges[base + eIdxTo] / NF
        const slot = fillPos[toNode]++
        revSrc[slot] = n
        revEdgeName[slot] = edges[base + eIdxName]
        revEdgeType[slot] = edges[base + eIdxType]
      }
      edgeCursor += ec
    }
  }

  // For each prefix, walk string nodes, attribute bytes to their 1-level owner.
  for (const prefix of prefixes) {
    const owners = new Map() // "type:name .prop" -> { count, totalSize }
    let matchCount = 0
    let matchBytes = 0
    for (let n = 0; n < nodeCount; n++) {
      const off = n * NF
      // Match string / concatenated string / sliced string (fix #1): the prefix
      // attribution must cover the same node types the summary counts, or the
      // bytes reported here would disagree with the summary's strings total.
      if (!stringTypeIds.has(nodes[off + idxType])) continue
      const content = strings[nodes[off + idxName]] ?? ''
      if (!content.startsWith(prefix)) continue
      matchCount++
      const selfSize = nodes[off + idxSelfSize]
      matchBytes += selfSize
      // Attribute this string's bytes to every direct owner (usually 1).
      for (let s = revHead[n]; s < revHead[n + 1]; s++) {
        const src = revSrc[s]
        const srcOff = src * NF
        const srcType = nodeTypes[nodes[srcOff + idxType]] ?? '?'
        const srcName = strings[nodes[srcOff + idxName]] ?? '(anon)'
        let prop = ''
        if (revEdgeType[s] === propertyEdgeType) {
          const p = strings[revEdgeName[s]]
          if (p) prop = ` .${p}`
        }
        const key = `${srcType}:${srcName}${prop}`
        const rec = owners.get(key)
        if (rec) {
          rec.count++
          rec.totalSize += selfSize
        } else {
          owners.set(key, { count: 1, totalSize: selfSize })
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `\n[--retain] prefix ${JSON.stringify(prefix)}: ${matchCount.toLocaleString()} strings, ${fmtBytes(
        matchBytes,
      )} — top owners (1 level up):`,
    )
    const sorted = [...owners.entries()].sort((a, b) => b[1].totalSize - a[1].totalSize)
    if (sorted.length === 0) {
      // eslint-disable-next-line no-console
      console.log('  (no matching strings)')
    }
    for (const [key, rec] of sorted.slice(0, top)) {
      // eslint-disable-next-line no-console
      console.log(`  ${pad(fmtBytes(rec.totalSize), 11)} x${pad(String(rec.count), 7)}  ${key}`)
    }
  }
}

main()
