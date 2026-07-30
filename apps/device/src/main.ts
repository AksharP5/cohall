#!/usr/bin/env bun

import { Effect } from "effect"
import { printHelp, printSkill, runCli } from "./cli.ts"
import { loadConfiguration } from "./config.ts"
import { runDaemon } from "./daemon.ts"
import { runMcp } from "./mcp.ts"

const main = async (): Promise<void> => {
  const command = process.argv[2] ?? "device"
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp()
    return
  }
  if (command === "skill") {
    await printSkill()
    return
  }

  const configuration = await Effect.runPromise(loadConfiguration)
  if (command === "mcp") {
    await runMcp(configuration)
    return
  }
  if (command === "doctor") {
    const response = await fetch(`${configuration.relayUrl}/api/health`)
    console.log(
      JSON.stringify(
        {
          relay: response.ok ? "reachable" : "unhealthy",
          device: configuration.name,
          id: configuration.id,
          workspaces: configuration.workspaces,
          codex: Bun.which("codex") ?? "not found",
        },
        null,
        2,
      ),
    )
    return
  }
  if (command === "device") {
    console.log(`Starting Cohall device ${configuration.name}`)
    await Effect.runPromise(runDaemon(configuration))
    return
  }

  await runCli(command, process.argv.slice(3), configuration)
}

await main().catch((cause: unknown) => {
  console.error(
    JSON.stringify(
      {
        error: cause instanceof Error ? cause.message : String(cause),
      },
      null,
      2,
    ),
  )
  process.exitCode = 1
})
