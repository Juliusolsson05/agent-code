import assert from 'node:assert/strict'
import { basename, dirname } from 'node:path'

import { legacyDebugBundleBucketForPath } from '../src/main/storage/debugRetention'
import {
  AUTOSAVE_DEBUG_BUNDLE_DIR,
  DEBUG_BUNDLE_DIR,
  MANUAL_DEBUG_BUNDLE_DIR,
} from '../src/main/storage/paths'
import {
  AUTOSAVE_DEBUG_BUNDLE_LOG_FILE,
  DEBUG_BUNDLE_LOG_FILE,
  MANUAL_DEBUG_BUNDLE_LOG_FILE,
  debugBundleLogFileForBundlePath,
  debugBundleLogFileForReason,
  debugBundleRootForReason,
  isAutosaveDebugBundleReason,
} from '../src/main/storage/debugBundleLog'

assert.equal(debugBundleRootForReason('manual'), MANUAL_DEBUG_BUNDLE_DIR)
assert.equal(debugBundleRootForReason(undefined), MANUAL_DEBUG_BUNDLE_DIR)
assert.equal(debugBundleRootForReason(null), MANUAL_DEBUG_BUNDLE_DIR)
assert.equal(debugBundleRootForReason('autosave-enabled'), AUTOSAVE_DEBUG_BUNDLE_DIR)
assert.equal(debugBundleRootForReason('autosave-interval'), AUTOSAVE_DEBUG_BUNDLE_DIR)
assert.equal(debugBundleRootForReason('autosave-beforeunload'), AUTOSAVE_DEBUG_BUNDLE_DIR)

assert.equal(debugBundleLogFileForReason('manual'), MANUAL_DEBUG_BUNDLE_LOG_FILE)
assert.equal(debugBundleLogFileForReason('autosave-interval'), AUTOSAVE_DEBUG_BUNDLE_LOG_FILE)
assert.equal(debugBundleLogFileForBundlePath(`${MANUAL_DEBUG_BUNDLE_DIR}/bundle-a`), MANUAL_DEBUG_BUNDLE_LOG_FILE)
assert.equal(
  debugBundleLogFileForBundlePath(`${AUTOSAVE_DEBUG_BUNDLE_DIR}/bundle-a`),
  AUTOSAVE_DEBUG_BUNDLE_LOG_FILE,
)

assert.equal(isAutosaveDebugBundleReason('autosave-interval'), true)
assert.equal(isAutosaveDebugBundleReason('manual'), false)
assert.equal(isAutosaveDebugBundleReason('manual-autosave-note'), false)

assert.equal(dirname(MANUAL_DEBUG_BUNDLE_DIR), DEBUG_BUNDLE_DIR)
assert.equal(dirname(AUTOSAVE_DEBUG_BUNDLE_DIR), DEBUG_BUNDLE_DIR)
assert.equal(basename(MANUAL_DEBUG_BUNDLE_DIR), 'manual')
assert.equal(basename(AUTOSAVE_DEBUG_BUNDLE_DIR), 'autosave')

// WHY this explicitly checks the legacy constant: old troubleshooting notes may
// still point at debug-bundles/saved-debug-bundles.jsonl, but new manual saves
// must use debug-bundles/manual/saved-debug-bundles.jsonl. If these ever become
// equal again, the high-volume autosave ledger can bury user-authored incidents.
assert.notEqual(MANUAL_DEBUG_BUNDLE_LOG_FILE, DEBUG_BUNDLE_LOG_FILE)
assert.notEqual(AUTOSAVE_DEBUG_BUNDLE_LOG_FILE, DEBUG_BUNDLE_LOG_FILE)
assert.notEqual(MANUAL_DEBUG_BUNDLE_LOG_FILE, AUTOSAVE_DEBUG_BUNDLE_LOG_FILE)

const legacyManualPath = `${DEBUG_BUNDLE_DIR}/2026-05-19T09-03-10-738-21e655e8`
const legacyAutosavePath = `${DEBUG_BUNDLE_DIR}/2026-05-19T09-05-05-349-285663e4`
const manualLegacyPaths = new Set([legacyManualPath])
assert.equal(
  legacyDebugBundleBucketForPath(legacyManualPath, manualLegacyPaths),
  'debug-bundles-manual',
)
assert.equal(
  legacyDebugBundleBucketForPath(legacyAutosavePath, manualLegacyPaths),
  'debug-bundles-legacy',
)

console.log('debug bundle storage routing ok')
