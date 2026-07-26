/**
 * Static gate for built-in command keybindings. Runs inside `npm run check`.
 *
 * WHY a repository script when Settings already validates at edit time: the two
 * answer different questions. Settings validates the CURRENT PROFILE — one
 * user's overrides plus their dictation hotkey. This validates what we SHIP,
 * on a machine with no profile at all, so a bad default cannot reach a release
 * merely because no reviewer happened to be running a clean install.
 *
 * CRITICAL: it consumes the exact same normalizer, reservation registry, and
 * overlap matrix as the runtime. A script with its own parallel notion of
 * "valid" would create a false guarantee — green in CI, broken in the app —
 * which is worse than having no script. If you find yourself adding a rule
 * here, add it to the shared library and call it from here.
 *
 * Run: npx tsx --tsconfig tsconfig.web.json scripts/check-command-keybindings.mts
 */
import {
  builtInCommandCatalog,
  findCatalogDefects,
} from '../src/renderer/src/features/command-palette/catalog'
import {
  buildDefaultKeybindings,
  contextsOverlap,
} from '../src/renderer/src/features/command-keybindings/defaults'
import {
  RESERVED_INTERACTIONS,
  findBindingCollisions,
  listApprovedOverlaps,
} from '../src/renderer/src/features/command-keybindings/reservations'
import { normalizeKeybinding } from '../src/renderer/src/features/command-keybindings/normalize'
import { DEFAULT_DICTATION_HOTKEY } from '../src/renderer/src/lib/hotkeyBinding'

const failures: string[] = []
const fail = (message: string) => failures.push(message)

const defaults = buildDefaultKeybindings()
const catalogIds = new Set(builtInCommandCatalog.map(command => command.id))

// --- 1. Grammar -------------------------------------------------------------
// Every shipped binding must parse AND already be in canonical form. Accepting
// a non-normalized spelling here would mean the string in the source and the
// string used for collision comparison differ, so two chords that are really
// the same could both be "free".
for (const entry of defaults) {
  for (const binding of entry.bindings) {
    try {
      const normalized = normalizeKeybinding(binding)
      if (normalized !== binding) {
        fail(`${entry.commandId}: "${binding}" is not canonical (expected "${normalized}")`)
      }
    } catch (error) {
      fail(`${entry.commandId}: "${binding}" is not a valid binding — ${(error as Error).message}`)
    }
  }
}

// --- 2. Duplicates within one command ---------------------------------------
for (const entry of defaults) {
  const seen = new Set<string>()
  for (const binding of entry.bindings) {
    if (seen.has(binding)) fail(`${entry.commandId}: duplicate binding "${binding}"`)
    seen.add(binding)
  }
}

// --- 3. One default entry per command ---------------------------------------
const entriesByCommand = new Map<string, number>()
for (const entry of defaults) {
  entriesByCommand.set(entry.commandId, (entriesByCommand.get(entry.commandId) ?? 0) + 1)
}
for (const [commandId, count] of entriesByCommand) {
  if (count > 1) fail(`${commandId}: declared ${count} times in the default set`)
}

// --- 4. Defaults must name a real, executable command -----------------------
// A default for an id nobody ships is a chord the user can never trigger and
// never discover — and, worse, one that silently reserves the key against
// every other command.
for (const entry of defaults) {
  if (!catalogIds.has(entry.commandId)) {
    fail(`${entry.commandId}: has a shipped binding but is not in the command catalog`)
  }
}

// --- 4b. Catalog integrity -------------------------------------------------
// Delegated to the shared validator rather than reimplemented. Without it this
// gate happily passed a catalog with duplicate ids, which makes command lookup
// ambiguous — and a binding pointing at an ambiguous id is worse than one
// pointing at nothing.
for (const defect of findCatalogDefects(builtInCommandCatalog)) {
  fail(`catalog: ${defect}`)
}

// --- 5. Collisions ----------------------------------------------------------
// Checks the shipped defaults against reserved interactions, native/menu roles,
// editor-native keys, and the DEFAULT dictation hotkey. Settings additionally
// checks the user's current dictation binding and overrides; same function,
// different inputs.
const collisions = findBindingCollisions({
  commandDefaults: defaults,
  reserved: RESERVED_INTERACTIONS,
  dictationBinding: DEFAULT_DICTATION_HOTKEY,
})
for (const collision of collisions) {
  const owners = collision.owners.map(owner => `${owner.id} [${owner.context}]`).join(' vs ')
  fail(`${collision.binding}: unapproved overlap — ${owners}`)
}

// --- 6. Approved overlaps must stay justified -------------------------------
// An approved overlap is a promise that some handler resolves the ambiguity
// before either owner runs. An entry with no stated reason is a promise nobody
// can check, and a stale one is a promise that has quietly become false.
for (const approved of listApprovedOverlaps()) {
  if (approved.reason.trim().length < 40) {
    fail(`${approved.binding}: approved overlap has no substantive reason`)
  }
  if (approved.owners.length < 2) {
    fail(`${approved.binding}: approved overlap names fewer than two owners`)
  }
}

// --- 7. Display metadata must not come back ---------------------------------
// The audit's core keybinding finding was that `CommandDef.shortcut` was a
// display string with no relationship to the code that ran, so the palette
// could advertise a chord the editor implemented and a user's Settings edit
// would change nothing.
//
// The migration deleted the field; `ResolvedCommand.shortcut` is now DERIVED
// from effective bindings at resolve time. This was a soft note while the 22
// legacy strings still existed (a hard failure would have blocked the very
// commits that removed them). Now that they are gone it is a hard failure,
// because reintroducing an authored `shortcut` would rebuild exactly the drift
// this whole phase existed to eliminate.
const withLegacyShortcut = builtInCommandCatalog.filter(
  command => 'shortcut' in command,
)
for (const command of withLegacyShortcut) {
  fail(
    `${command.id}: declares an authored \`shortcut\` field. Display chords are `
    + 'derived from defaultKeybindings — an authored string is a second source of '
    + 'truth that cannot stay in sync with the router.',
  )
}

// --- 8. Context sanity ------------------------------------------------------
// A default whose context overlaps nothing would be unreachable by the checker
// and could hide a real clash.
for (const entry of defaults) {
  if (!contextsOverlap(entry.context, entry.context)) {
    fail(`${entry.commandId}: context "${entry.context}" does not overlap itself`)
  }
}

if (failures.length > 0) {
  console.error('\ncheck:keybindings FAILED\n')
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error(
    `\n${failures.length} problem(s). Bindings are shared state: two owners for one chord means `
    + 'the winner is decided by registration order, which is an accident rather than a policy.\n',
  )
  process.exit(1)
}

console.log(
  `check:keybindings OK — ${defaults.length} command binding sets, `
  + `${RESERVED_INTERACTIONS.length} reserved interactions, `
  + `${listApprovedOverlaps().length} approved overlap(s).`,
)
