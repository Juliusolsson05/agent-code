import ApplicationServices
import CoreGraphics
import Foundation

// This helper is copied in spirit from the standalone dictation app because
// bare Fn is not a normal Electron accelerator. Electron/Chromium often never
// delivers a renderer key event for Fn, and `globalShortcut` is shaped around
// command shortcuts rather than modifier-only press/release transitions. The
// product behavior we need is hold-to-talk: down starts recording, up stops it.
// macOS exposes that reliably through CGEventTap, so the native process owns
// only keyboard observation and sends tiny JSON events back to Electron.

let binding = CommandLine.arguments.dropFirst().joined(separator: " ")
let modifierNames: Set<String> = ["Cmd", "Ctrl", "Option", "Shift", "Fn"]
let parts = binding
  .split(separator: "+")
  .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
  .filter { !$0.isEmpty }

let requestedModifiers = Set(parts.filter { modifierNames.contains($0) })
let requestedKey = parts.last.flatMap { modifierNames.contains($0) ? nil : $0 }

// These names match cc-shell's stored binding vocabulary. They are intentionally
// physical-ish key names, not localized glyphs: a dictation trigger should not
// move just because the user has a Swedish/US/etc keyboard layout selected.
let keyCodes: [String: CGKeyCode] = [
  "A": 0x00, "S": 0x01, "D": 0x02, "F": 0x03, "H": 0x04, "G": 0x05,
  "Z": 0x06, "X": 0x07, "C": 0x08, "V": 0x09, "B": 0x0B,
  "Q": 0x0C, "W": 0x0D, "E": 0x0E, "R": 0x0F, "Y": 0x10, "T": 0x11,
  "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16,
  "5": 0x17, "EQUALS": 0x18, "9": 0x19, "7": 0x1A, "MINUS": 0x1B,
  "8": 0x1C, "0": 0x1D, "BRACKET_RIGHT": 0x1E, "O": 0x1F,
  "U": 0x20, "BRACKET_LEFT": 0x21, "I": 0x22, "P": 0x23,
  "RETURN": 0x24, "L": 0x25, "J": 0x26, "QUOTE": 0x27, "K": 0x28,
  "SEMICOLON": 0x29, "BACKSLASH": 0x2A, "COMMA": 0x2B,
  "FORWARD SLASH": 0x2C, "N": 0x2D, "M": 0x2E, "DOT": 0x2F,
  "TAB": 0x30, "SPACE": 0x31, "BACKTICK": 0x32, "BACKSPACE": 0x33,
  "ESCAPE": 0x35, "DELETE": 0x75, "HOME": 0x73, "END": 0x77,
  "PAGE UP": 0x74, "PAGE DOWN": 0x79, "LEFT ARROW": 0x7B,
  "RIGHT ARROW": 0x7C, "DOWN ARROW": 0x7D, "UP ARROW": 0x7E,
  "F1": 0x7A, "F2": 0x78, "F3": 0x63, "F4": 0x76, "F5": 0x60,
  "F6": 0x61, "F7": 0x62, "F8": 0x64, "F9": 0x65, "F10": 0x6D,
  "F11": 0x67, "F12": 0x6F, "F13": 0x69, "F14": 0x6B, "F15": 0x71,
  "F16": 0x6A, "F17": 0x40, "F18": 0x4F, "F19": 0x50, "F20": 0x5A
]

let requestedKeyCode = requestedKey.flatMap { keyCodes[$0] }
let modifierKeyCodes: [String: CGKeyCode] = [
  "Shift": 0x38,
  "Ctrl": 0x3B,
  "Option": 0x3A,
  "Cmd": 0x37,
  "Fn": 0x3F
]
var previousModifierMatch = false
var previousKeyMatch = false
var eventTap: CFMachPort?

func activeModifiers(_ flags: CGEventFlags) -> Set<String> {
  var result = Set<String>()
  if flags.contains(.maskCommand) { result.insert("Cmd") }
  if flags.contains(.maskControl) { result.insert("Ctrl") }
  if flags.contains(.maskAlternate) { result.insert("Option") }
  if flags.contains(.maskShift) { result.insert("Shift") }
  if flags.contains(.maskSecondaryFn) { result.insert("Fn") }
  return result
}

func emit(_ type: String, _ extra: String = "") {
  let suffix = extra.isEmpty ? "" : ",\(extra)"
  print("{\"type\":\"\(type)\",\"binding\":\"\(binding)\"\(suffix)}")
  fflush(stdout)
}

// Quieted: per-flagsChanged tracing was useful while we were proving the
// helper saw Fn at all, but it now floods the terminal at every Cmd press
// and buries the dictation logs the user actually cares about. Keep the
// function so the call sites still compile, but make it a no-op unless
// CC_SHELL_HOTKEY_HELPER_DEBUG is set in the environment. Re-enable by
// running `CC_SHELL_HOTKEY_HELPER_DEBUG=1 npm run dev` if you ever need
// the raw modifier stream again.
let helperDebugEnabled = ProcessInfo.processInfo.environment["CC_SHELL_HOTKEY_HELPER_DEBUG"] == "1"
func debug(_ message: String) {
  if !helperDebugEnabled { return }
  fputs("[cc-shell-hotkey-helper-debug] \(message)\n", stderr)
  fflush(stderr)
}

func keyMatches(_ event: CGEvent) -> Bool {
  guard let keyCode = requestedKeyCode else { return false }
  if event.getIntegerValueField(.keyboardEventKeycode) != Int64(keyCode) { return false }
  return activeModifiers(event.flags) == requestedModifiers
}

func modifierMatches(_ event: CGEvent) -> Bool {
  if requestedKey != nil { return false }
  return activeModifiers(event.flags) == requestedModifiers
}

func changedModifierName(_ event: CGEvent) -> String? {
  let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
  return modifierKeyCodes.first { $0.value == keyCode }?.key
}

if binding.isEmpty {
  fputs("[cc-shell-hotkey-helper] empty binding\n", stderr)
  exit(64)
}

debug("boot binding=\(binding) requestedModifiers=\(requestedModifiers.sorted().joined(separator: "+")) requestedKey=\(requestedKey ?? "nil")")

if requestedKey != nil && requestedKeyCode == nil {
  fputs("[cc-shell-hotkey-helper] unsupported key in binding: \(binding)\n", stderr)
  exit(65)
}

let promptOptions = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
if !AXIsProcessTrustedWithOptions(promptOptions) {
  fputs("[cc-shell-hotkey-helper] accessibility permission is required\n", stderr)
}

let callback: CGEventTapCallBack = { _, type, event, _ in
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if let eventTap {
      CGEvent.tapEnable(tap: eventTap, enable: true)
      emit("tap-reenabled")
    }
    return Unmanaged.passUnretained(event)
  }

  if type == .keyDown && keyMatches(event) && !previousKeyMatch {
    previousKeyMatch = true
    emit("hotkey-down")
    return nil
  }

  if type == .keyUp && previousKeyMatch {
    guard let keyCode = requestedKeyCode else { return Unmanaged.passUnretained(event) }
    if event.getIntegerValueField(.keyboardEventKeycode) == Int64(keyCode) {
      previousKeyMatch = false
      emit("hotkey-up")
      return nil
    }
  }

  if type == .flagsChanged {
    let changed = changedModifierName(event)
    debug("flagsChanged changed=\(changed ?? "nil") active=\(activeModifiers(event.flags).sorted().joined(separator: "+")) previousModifierMatch=\(previousModifierMatch)")

    if previousModifierMatch, requestedKey == nil, let changed, requestedModifiers.contains(changed) {
      let stillPressed = activeModifiers(event.flags).isSuperset(of: requestedModifiers)
      if !stillPressed || requestedModifiers.count == 1 {
        // Fn is not a normal key on macOS. On some keyboards the
        // `flagsChanged` payload for the release transition can still look
        // like the Fn flag is present, which means a strict "current flags no
        // longer equal requested flags" check misses release and the renderer
        // records forever. For modifier-only bindings, a second transition for
        // the same requested modifier after we emitted down is the release
        // edge. This keeps bare Fn hold-to-talk reliable while preserving the
        // strict full-modifier match for multi-modifier chords below.
        previousModifierMatch = false
        emit("hotkey-up")
        return nil
      }
    }

    let isMatch = modifierMatches(event)
    if isMatch && !previousModifierMatch {
      previousModifierMatch = true
      emit("hotkey-down")
      return nil
    }
    if !isMatch && previousModifierMatch {
      previousModifierMatch = false
      emit("hotkey-up")
      return nil
    }
  }

  return Unmanaged.passUnretained(event)
}

let mask = CGEventMask(
  (1 << CGEventType.keyDown.rawValue) |
  (1 << CGEventType.keyUp.rawValue) |
  (1 << CGEventType.flagsChanged.rawValue)
)

guard let tap = CGEvent.tapCreate(
  tap: .cgSessionEventTap,
  place: .headInsertEventTap,
  options: .defaultTap,
  eventsOfInterest: mask,
  callback: callback,
  userInfo: nil
) else {
  fputs("[cc-shell-hotkey-helper] failed to create event tap\n", stderr)
  exit(66)
}

eventTap = tap
let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
emit("ready")
CFRunLoopRun()
