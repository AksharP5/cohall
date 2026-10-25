#!/usr/bin/env node

import { version } from "@cohall/protocol/version"
import { printHelp } from "./help.ts"

const main = async (): Promise<void> => {
  const command = process.argv[2]
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    printHelp()
    return
  }
  if (command === "--version" || command === "version") {
    console.log(version)
    return
  }
  const commandArguments = process.argv.slice(3)
  if (
    commandArguments.length === 1 &&
    ["--help", "-h", "help"].includes(commandArguments[0] ?? "")
  ) {
    printHelp()
    return
  }
  if (["device", "mcp"].includes(command) && process.argv.length > 3) {
    throw new Error(`${command} does not accept arguments`)
  }
  if (command === "relay" && commandArguments.length === 0) {
    const { runRelay } = await import("@cohall/relay")
    await runRelay()
    return
  }
  if (command === "device") {
    const { Effect } = await import("effect")
    const { loadDeviceConfiguration } = await import("./config.ts")
    const { runDaemon } = await import("./daemon.ts")
    const configuration = await Effect.runPromise(loadDeviceConfiguration)
    const controller = new AbortController()
    const stop = () => controller.abort()
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
    try {
      await Effect.runPromise(runDaemon(configuration), { signal: controller.signal }).catch(
        (cause: unknown) => {
          if (!controller.signal.aborted) throw cause
        },
      )
    } finally {
      process.off("SIGINT", stop)
      process.off("SIGTERM", stop)
    }
    return
  }
  if (command === "mcp") {
    const { Effect } = await import("effect")
    const { loadClientConfiguration } = await import("./config.ts")
    const { runMcp } = await import("./mcp.ts")
    const configuration = await Effect.runPromise(loadClientConfiguration)
    await runMcp(configuration)
    return
  }
  const { runCli } = await import("./cli.ts")
  await runCli(command, commandArguments)
}

await main().catch((cause: unknown) => {
  console.error(
    JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }, null, 2),
  )
  process.exitCode = 1
})
