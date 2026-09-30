import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { promisify } from "node:util"

const execute = promisify(execFile)
const fingerprint = async (entrypoint: string) =>
  stat(entrypoint, { bigint: true })
    .then((file) => `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`)
    .catch(() => undefined)

export const createMcpBuildNotice = async (
  entrypoint: string | undefined,
  runningVersion: string,
  {
    checkIntervalMs = 60_000,
    probeTimeoutMs = 2_000,
    now = Date.now,
  }: {
    checkIntervalMs?: number
    probeTimeoutMs?: number
    now?: () => number
  } = {},
) => {
  let previous = entrypoint === undefined ? undefined : await fingerprint(entrypoint)
  let nextCheckAt = 0
  const reported = new Set<string>()

  return async (result: CallToolResult): Promise<CallToolResult> => {
    if (entrypoint === undefined || now() < nextCheckAt) return result
    nextCheckAt = now() + checkIntervalMs
    const current = await fingerprint(entrypoint)
    if (current === undefined || current === previous) return result

    // A replacement may still be in progress. Retry failed probes at the next interval.
    const installedVersion = await execute(process.execPath, [entrypoint, "--version"], {
      timeout: probeTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 4_096,
      windowsHide: true,
    })
      .then(({ stdout }) => stdout.trim())
      .catch(() => undefined)
    if (
      installedVersion === undefined ||
      !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(installedVersion)
    ) {
      return result
    }
    previous = current
    if (installedVersion === runningVersion || reported.has(installedVersion)) return result
    reported.add(installedVersion)
    return {
      ...result,
      content: [
        ...result.content,
        {
          type: "text",
          text: `Cohall MCP is still running ${runningVersion}; its executable is now ${installedVersion}. Restart the Cohall MCP connection in your agent host to load it.`,
        },
      ],
    }
  }
}
