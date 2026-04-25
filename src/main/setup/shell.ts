import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const LOGIN_SHELL = process.env.SHELL || '/bin/zsh'

export type LoginShellResult = {
  stdout: string
  stderr: string
}

export async function runLoginShell(
  script: string,
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<LoginShellResult> {
  const { stdout, stderr } = await execFileAsync(
    LOGIN_SHELL,
    ['-lc', script],
    {
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      env: process.env,
    },
  )
  return {
    stdout: String(stdout ?? ''),
    stderr: String(stderr ?? ''),
  }
}

