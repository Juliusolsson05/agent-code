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
// THREE MODES:
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
//   3. OWNERS (--owners): the COMPREHENSIVE owner-attribution mode, and the one
//      that definitively cracked #288. SUMMARY ranks by self_size — "how big is
//      this one object" — which is useless when the leak is a small container
//      (a Map, a class instance) transitively pinning a huge subgraph: the Map
//      itself is a few KB of self_size and never shows up. OWNERS instead builds
//      the DOMINATOR TREE (Cooper-Harvey-Kennedy) of the whole reachable graph
//      and computes RETAINED size per node = "how much memory is freed if this
//      object is removed" = self_size of everything this node alone keeps alive.
//      It then prints (a) the top individual retainers by retained size with
//      their `type:name`, and (b) retained size aggregated by constructor/owner
//      name. Running this on the #288 dump is what printed `SubAgentWatcher` ×7 =
//      263 MB / 88% of the reachable heap — a result no self_size ranking could
//      ever surface, because each watcher's own object is tiny; it's the
//      entriesByAgent Map → entry → message.content → huge string subgraph it
//      DOMINATES that is the 263 MB. Use this mode for any "what truly owns the
//      heap" / leak-hunt investigation (#288-class). It is the heaviest mode:
//      O(nodes+edges) for the postorder/predecessor/idom passes, plus a few
//      Typed Arrays sized to node/edge count.
//
// MEMORY: for the large dumps you MUST raise the old-space cap, e.g.
//   node --max-old-space-size=8192 scripts/analyze-heapsnapshot.mjs <file>
// The watchdog auto-summary (PART B) spawns us with --max-old-space-size=4096,
// which is plenty for the summary pass on a ~300 MB snapshot. --retain on a
// 300 MB snapshot wants the full 8192. --owners builds the dominator tree over
// the WHOLE graph and is the most memory-hungry mode — for the large forensic
// dumps run it with `node --max-old-space-size=12288`.
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
  let owners = false
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--top') {
      top = parseInt(argv[++i], 10) || 25
    } else if (a === '--retain') {
      retain = String(argv[++i] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else if (a === '--owners') {
      // Dominator-tree retained-size mode (see header, MODE 3). A boolean flag —
      // it analyzes the whole graph, so it takes no prefix/selector argument.
      owners = true
    }
  }
  return { file, top, retain, owners }
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
  const { file, top, retain, owners } = parseArgs(process.argv)
  if (!file) {
    // eslint-disable-next-line no-console
    console.error(
      'usage: node [--max-old-space-size=12288] analyze-heapsnapshot.mjs <file.heapsnapshot> [--top N] [--retain "prefix1,prefix2"] [--owners]',
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

  // OWNERS mode (#288, MODE 3): the dominator-tree retained-size report is a
  // standalone analysis that answers a fundamentally different question than the
  // SUMMARY pass (retained size vs self_size). Running both would just print the
  // big self_size table nobody needs when they asked "what truly owns the heap,"
  // and the dominator build is the heavy part — so when --owners is set we run
  // ONLY that report and return. --top still controls how many rows it prints.
  if (owners) {
    reportOwners({ snap, top })
    return
  }

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

// ---------------------------------------------------------------------------
// --owners mode: dominator tree + retained size per owner (#288, MODE 3)
// ---------------------------------------------------------------------------
//
// WHY retained size and not self_size: self_size is "how many bytes is THIS one
// object," which makes the SUMMARY pass blind to the real #288 leak — a handful
// of small container objects (7 SubAgentWatcher instances, a few KB each)
// transitively pinning a 263 MB subgraph. Retained size is "how much memory is
// reclaimed if this single object is freed," i.e. the self_size of everything
// the object DOMINATES — every node you can only reach by going through it. The
// dominator tree is what makes that computable: node D dominates node X iff every
// path from the GC root to X passes through D, and retained(D) = self(D) + sum of
// retained(children of D in the dominator tree). Aggregating retained size by the
// owner's `type:name` is what printed `SubAgentWatcher ×7 = 263 MB / 88%` and
// named the leak no self_size ranking could see.
//
// Algorithm (ported from the /tmp/heap-dom.mjs prototype that cracked #288):
//   1. iterative DFS from the synthetic GC root (node 0) → postorder numbering
//   2. reverse-CSR predecessor index (who points AT each node)
//   3. Cooper-Harvey-Kennedy iterative dominators over reverse-postorder
//      (simple, fast, and avoids Lengauer-Tarjan's bookkeeping; converges in a
//      few passes on real heap graphs)
//   4. retained size: seed each node with its self_size, then in postorder add
//      each node's retained total to its immediate dominator (children before
//      parents, so every node's subtree is summed before it rolls up)
//   5. report top individual retainers + retained aggregated by owner name
function reportOwners({ snap, top }) {
  const meta = snap.snapshot.meta
  const nodeFields = meta.node_fields
  const nodeTypes = meta.node_types[0]
  const edgeFields = meta.edge_fields
  const nodes = snap.nodes
  const edges = snap.edges
  const strings = snap.strings
  const NF = nodeFields.length
  const EF = edgeFields.length

  const idxType = nodeFields.indexOf('type')
  const idxName = nodeFields.indexOf('name')
  const idxSelfSize = nodeFields.indexOf('self_size')
  const idxEdgeCount = nodeFields.indexOf('edge_count')
  const eIdxTo = edgeFields.indexOf('to_node')

  const N = nodes.length / NF

  // Small accessors. `to_node` in the edge array is a byte-style offset into
  // `nodes` (a multiple of NF) per the V8 format, so divide by NF for an ordinal.
  const nm = (k) => strings[nodes[k * NF + idxName]] ?? ''
  const ty = (k) => nodeTypes[nodes[k * NF + idxType]] ?? `type#${nodes[k * NF + idxType]}`
  const selfSize = (k) => nodes[k * NF + idxSelfSize]
  const outCount = (k) => nodes[k * NF + idxEdgeCount]

  // firstEdge[k] = index (in edge units) of node k's first outgoing edge. The
  // per-node edge_count fields partition the flat edges array in node order, so a
  // single prefix sum gives every node's edge slice without a lookup table.
  const firstEdge = new Uint32Array(N)
  {
    let c = 0
    for (let k = 0; k < N; k++) {
      firstEdge[k] = c
      c += outCount(k)
    }
  }
  const edgeTo = (i) => edges[i * EF + eIdxTo] / NF

  // 1) iterative DFS from root → postorder. Iterative (explicit stack + a
  // per-node resume cursor) because a multi-million-node graph would blow the
  // call stack with recursion. `post[node]` is the postorder index; `order` is
  // its inverse (postorder index → node).
  const ROOT = 0
  const post = new Int32Array(N).fill(-1)
  const order = new Int32Array(N)
  let postN = 0
  {
    const stack = [ROOT]
    const iter = new Uint32Array(N) // resume edge index per node
    const seen = new Uint8Array(N)
    seen[ROOT] = 1
    while (stack.length) {
      const node = stack[stack.length - 1]
      const base = firstEdge[node]
      const cnt = outCount(node)
      let pushed = false
      while (iter[node] < cnt) {
        const c = edgeTo(base + iter[node])
        iter[node]++
        if (!seen[c]) {
          seen[c] = 1
          stack.push(c)
          pushed = true
          break
        }
      }
      if (!pushed) {
        post[node] = postN
        order[postN] = node
        postN++
        stack.pop()
      }
    }
  }
  const reachable = postN

  // 2) predecessors as a reverse CSR (inOff offsets + preds source-node array).
  // Built over ALL nodes; unreachable preds are simply skipped in step 3.
  const inOff = new Uint32Array(N + 1)
  for (let from = 0; from < N; from++) {
    const b = firstEdge[from]
    const c = outCount(from)
    for (let e = 0; e < c; e++) inOff[edgeTo(b + e) + 1]++
  }
  for (let k = 0; k < N; k++) inOff[k + 1] += inOff[k]
  const preds = new Uint32Array(inOff[N])
  {
    const cur = inOff.slice()
    for (let from = 0; from < N; from++) {
      const b = firstEdge[from]
      const c = outCount(from)
      for (let e = 0; e < c; e++) preds[cur[edgeTo(b + e)]++] = from
    }
  }

  // 3) Cooper-Harvey-Kennedy iterative dominators. intersect() walks two nodes up
  // the partially-built idom tree by postorder number until they meet — that meet
  // is their nearest common dominator. We sweep nodes in reverse postorder (root
  // highest) until no idom changes; real heap graphs settle in a handful of passes.
  const idom = new Int32Array(N).fill(-1)
  idom[ROOT] = ROOT
  const intersect = (a, b) => {
    while (a !== b) {
      while (post[a] < post[b]) a = idom[a]
      while (post[b] < post[a]) b = idom[b]
    }
    return a
  }
  let changed = true
  let passes = 0
  while (changed) {
    changed = false
    passes++
    for (let i = reachable - 1; i >= 0; i--) {
      const b = order[i]
      if (b === ROOT) continue
      let newIdom = -1
      for (let p = inOff[b]; p < inOff[b + 1]; p++) {
        const pr = preds[p]
        if (post[pr] === -1) continue // unreachable pred
        if (idom[pr] === -1) continue // not processed yet this round
        newIdom = newIdom === -1 ? pr : intersect(pr, newIdom)
      }
      if (newIdom !== -1 && idom[b] !== newIdom) {
        idom[b] = newIdom
        changed = true
      }
    }
  }

  // 4) retained size. Seed with self_size, then roll each node UP to its idom in
  // postorder so every subtree is fully summed before its dominator absorbs it.
  // Float64 because a 263 MB subtree summed in bytes exceeds a Uint32.
  const retained = new Float64Array(N)
  for (let k = 0; k < N; k++) retained[k] = selfSize(k)
  for (let i = 0; i < reachable; i++) {
    const n = order[i]
    if (n !== ROOT && idom[n] !== -1) retained[idom[n]] += retained[n]
  }

  // 5a) top individual retainers, named. Threshold at 1 MB retained so the list
  // is the actual heavyweights, not thousands of tiny leaves.
  let totalSelf = 0
  for (let k = 0; k < N; k++) totalSelf += selfSize(k)
  const ranked = []
  for (let k = 0; k < N; k++) if (retained[k] > 1024 * 1024) ranked.push(k)
  ranked.sort((a, b) => retained[b] - retained[a])

  // eslint-disable-next-line no-console
  console.log(
    `nodes=${N.toLocaleString()}  reachable=${reachable.toLocaleString()}  idom passes=${passes}`,
  )
  // eslint-disable-next-line no-console
  console.log(`total self_size=${fmtBytes(totalSelf)}  root retained=${fmtBytes(retained[ROOT])}`)
  // eslint-disable-next-line no-console
  console.log(`\nTOP INDIVIDUAL RETAINERS (retained = freed if this node is removed) — top ${top}:`)
  for (const k of ranked.slice(0, top)) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${pad(fmtBytes(retained[k]), 11)} ${pct(retained[k], totalSelf).padStart(6)}  ${ty(k)}:${
        nm(k) || '(anon)'
      }  [self ${fmtBytes(selfSize(k))}, node ${k}]`,
    )
  }

  // 5b) retained aggregated by OWNER name (constructor for objects, the closure
  // name, or the synthetic root group). We exclude the structural Object/Array
  // buckets — they are the generic containers a leak flows THROUGH, not the named
  // owner you act on. Summing per-instance retained double-counts nested
  // same-class instances, but for naming "which class owns the heap" that is
  // exactly what you want: it is how SubAgentWatcher's ×7 instances summed to the
  // 263 MB / 88% headline.
  const byName = new Map()
  for (let k = 0; k < N; k++) {
    const t = ty(k)
    if (t !== 'object' && t !== 'closure' && t !== 'synthetic') continue
    const name = nm(k) || (t === 'closure' ? '(closure)' : '(anon)')
    if (name === 'Object' || name === 'Array') continue
    const e = byName.get(name) || { ret: 0, cnt: 0 }
    e.ret += retained[k]
    e.cnt++
    byName.set(name, e)
  }
  // eslint-disable-next-line no-console
  console.log(
    `\nRETAINED by CONSTRUCTOR/owner name (sum over instances; nested same-name may double-count) — top ${top}:`,
  )
  const sortedByName = [...byName.entries()].sort((a, b) => b[1].ret - a[1].ret)
  for (const [name, e] of sortedByName.slice(0, top)) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${pad(fmtBytes(e.ret), 11)} ${pct(e.ret, totalSelf).padStart(6)}  x${pad(
        String(e.cnt),
        6,
      )}  ${name}`,
    )
  }
}

main()
