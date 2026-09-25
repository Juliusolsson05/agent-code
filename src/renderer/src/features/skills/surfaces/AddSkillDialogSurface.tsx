import { useEffect } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { refreshSkills, useSkillsStore } from '@renderer/features/skills/store'
import { AddSkillDialog } from '@renderer/features/skills/ui/AddSkillDialog'

// Mounted only while open so every opening starts from a fresh input; a
// half-reviewed source must never leak into the next "Add Skill…".
export function AddSkillDialogSurface() {
  const open = useAppStore(state => state.addSkillDialog !== null)
  const loaded = useSkillsStore(state => state.installed !== null)
  // "Add Skill…" can run before Settings → Skills was ever opened; the dialog
  // needs the revision and the provider columns main reports.
  useEffect(() => {
    if (open && !loaded) void refreshSkills()
  }, [open, loaded])
  if (!open) return null
  return <AddSkillDialog />
}
