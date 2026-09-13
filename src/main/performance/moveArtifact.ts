import { copyFile, rename, rm } from 'node:fs/promises'

/** Move a finished capture from an app-owned scratch root to the user's
 * chosen destination.
 *
 * WHY scratch lives in app state instead of beside the destination: a quit or
 * crash mid-capture used to strand `*.tmp` files in the user's own folders.
 * The cost is that scratch and destination can be on different volumes, where
 * rename fails with EXDEV; copying and then removing keeps the destination
 * untouched until a complete artifact exists. Deliberately free of Electron
 * imports so the utility-process report writer can share it. */
export async function moveArtifact(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await copyFile(source, destination)
    await rm(source, { force: true })
  }
}
