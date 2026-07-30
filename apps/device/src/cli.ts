import { RelayClient } from "@cohall/client"
import { TaskId, ThreadId } from "@cohall/protocol"
import { Effect, Schema } from "effect"
import type { DeviceConfiguration } from "./config.ts"
import { createDelegation, taskResult, threadContext, waitForTask } from "./delegation.ts"

interface Arguments {
  readonly options: ReadonlyMap<string, string | true>
  readonly positionals: ReadonlyArray<string>
}

const valueOptions = new Set([
  "context",
  "context-file",
  "prompt",
  "prompt-file",
  "target",
  "thread",
  "timeout",
  "workspace",
])

const flagOptions = new Set(["no-wait"])

const aliases = new Map([
  ["-c", "context"],
  ["-p", "prompt"],
  ["-t", "target"],
  ["-T", "thread"],
  ["-w", "workspace"],
])

const help = `Cohall coordinates agents running on your own devices.

Usage:
  cohall devices
  cohall delegate [prompt] [--target @device] [--context text]
                  [--thread uuid] [--workspace path] [--timeout seconds]
                  [--no-wait]
  cohall status <task-id>
  cohall wait <task-id> [--timeout seconds]
  cohall cancel <task-id>
  cohall thread <thread-id>
  cohall doctor
  cohall device
  cohall mcp
  cohall skill

Delegate input:
  --prompt, -p <text>        Task to perform. Use - to read it from stdin.
  --prompt-file <path>       Read the task from a file.
  --context, -c <text>       Only the conversation context the worker needs.
  --context-file <path>      Read context from a file.
  --target, -t <device>      Device name, @name, hostname, or id.
  --thread, -T <uuid>        Continue an existing shared Cohall thread.
  --workspace, -w <path>     Workspace advertised by the target device.
  --timeout <seconds>        Wait for at most 5-3600 seconds (default: 900).
  --no-wait                  Return as soon as the task is queued.

All operational commands emit JSON. Run "cohall skill" for the complete
agent-oriented workflow and context rules.`

const parseArguments = (values: ReadonlyArray<string>): Arguments => {
  const options = new Map<string, string | true>()
  const positionals: Array<string> = []

  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index]
    if (argument === undefined) {
      break
    }
    if (argument === "--") {
      positionals.push(...values.slice(index + 1))
      break
    }
    if (!argument.startsWith("-")) {
      positionals.push(argument)
      continue
    }

    const separator = argument.indexOf("=")
    const rawName = separator === -1 ? argument : argument.slice(0, separator)
    const inline = separator === -1 ? undefined : argument.slice(separator + 1)
    const name = aliases.get(rawName) ?? rawName.replace(/^--/, "")
    if (flagOptions.has(name)) {
      if (inline !== undefined) {
        throw new Error(`--${name} does not accept a value`)
      }
      options.set(name, true)
      continue
    }
    if (!valueOptions.has(name)) {
      throw new Error(`Unknown option: ${argument}`)
    }

    const value = inline ?? values[index + 1]
    if (value === undefined || (inline === undefined && value.startsWith("-") && value !== "-")) {
      throw new Error(`${rawName} requires a value`)
    }
    options.set(name, value)
    if (inline === undefined) {
      index += 1
    }
  }

  return { options, positionals }
}

const option = (arguments_: Arguments, name: string): string | undefined => {
  const value = arguments_.options.get(name)
  if (value === true) {
    throw new Error(`--${name} requires a value`)
  }
  return value
}

const allowOptions = (arguments_: Arguments, names: ReadonlyArray<string>): void => {
  const allowed = new Set(names)
  for (const name of arguments_.options.keys()) {
    if (!allowed.has(name)) {
      throw new Error(`--${name} is not valid for this command`)
    }
  }
}

const readFile = async (path: string): Promise<string> => {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new Error(`File does not exist: ${path}`)
  }
  return file.text()
}

const input = async (
  arguments_: Arguments,
  name: "prompt" | "context",
): Promise<string | undefined> => {
  const direct = option(arguments_, name)
  const file = option(arguments_, `${name}-file`)
  if (direct !== undefined && file !== undefined) {
    throw new Error(`Use either --${name} or --${name}-file, not both`)
  }
  if (file !== undefined) {
    return readFile(file)
  }
  if (direct === "-") {
    return Bun.stdin.text()
  }
  return direct
}

const timeout = (arguments_: Arguments): number => {
  const raw = option(arguments_, "timeout") ?? "900"
  const seconds = Number(raw)
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) {
    throw new Error("--timeout must be an integer between 5 and 3600")
  }
  return seconds
}

const identifier = (arguments_: Arguments, label: string): string => {
  const value = arguments_.positionals[0]
  if (value === undefined) {
    throw new Error(`${label} is required`)
  }
  if (arguments_.positionals.length > 1) {
    throw new Error(`Unexpected arguments after ${label}`)
  }
  return value
}

const print = (value: unknown): void => {
  console.log(JSON.stringify(value, null, 2))
}

export const printHelp = (): void => {
  console.log(help)
}

export const printSkill = async (): Promise<void> => {
  const file = Bun.file(new URL("../../../skills/cohall/references/cli.md", import.meta.url))
  if (!(await file.exists())) {
    throw new Error("The bundled Cohall skill reference could not be found")
  }
  console.log(await file.text())
}

export const runCli = async (
  command: string,
  values: ReadonlyArray<string>,
  configuration: DeviceConfiguration,
): Promise<void> => {
  const arguments_ = parseArguments(values)
  const client = RelayClient.make({
    baseUrl: configuration.relayUrl,
    token: configuration.token,
  })

  if (command === "devices") {
    allowOptions(arguments_, [])
    if (arguments_.positionals.length > 0) {
      throw new Error("devices does not accept positional arguments")
    }
    const devices = await Effect.runPromise(client.devices())
    print(devices)
    return
  }

  if (command === "delegate") {
    allowOptions(arguments_, [
      "context",
      "context-file",
      "no-wait",
      "prompt",
      "prompt-file",
      "target",
      "thread",
      "timeout",
      "workspace",
    ])
    if (option(arguments_, "prompt") === "-" && option(arguments_, "context") === "-") {
      throw new Error("Only one of --prompt and --context may read from stdin")
    }
    const suppliedPrompt = await input(arguments_, "prompt")
    const prompt = suppliedPrompt ?? arguments_.positionals.join(" ")
    if (prompt.trim().length === 0) {
      throw new Error("A prompt is required as an argument, --prompt, or --prompt-file")
    }
    if (suppliedPrompt !== undefined && arguments_.positionals.length > 0) {
      throw new Error("Use either a positional prompt or --prompt, not both")
    }

    const context = await input(arguments_, "context")
    const target = option(arguments_, "target")
    const thread = option(arguments_, "thread")
    const workspace = option(arguments_, "workspace")
    const task = await Effect.runPromise(
      createDelegation(client, configuration, {
        prompt,
        ...(target === undefined ? {} : { target }),
        ...(context === undefined ? {} : { context }),
        ...(thread === undefined ? {} : { threadId: Schema.decodeUnknownSync(ThreadId)(thread) }),
        ...(workspace === undefined ? {} : { workspace }),
      }),
    )

    if (arguments_.options.has("no-wait")) {
      print(taskResult(task))
      return
    }
    print(taskResult(await Effect.runPromise(waitForTask(client, task, timeout(arguments_)))))
    return
  }

  if (command === "status") {
    allowOptions(arguments_, [])
    const taskId = Schema.decodeUnknownSync(TaskId)(identifier(arguments_, "task id"))
    print(taskResult(await Effect.runPromise(client.getTask(taskId))))
    return
  }

  if (command === "wait") {
    allowOptions(arguments_, ["timeout"])
    const taskId = Schema.decodeUnknownSync(TaskId)(identifier(arguments_, "task id"))
    const task = await Effect.runPromise(client.getTask(taskId))
    print(taskResult(await Effect.runPromise(waitForTask(client, task, timeout(arguments_)))))
    return
  }

  if (command === "cancel") {
    allowOptions(arguments_, [])
    const taskId = Schema.decodeUnknownSync(TaskId)(identifier(arguments_, "task id"))
    print(taskResult(await Effect.runPromise(client.cancelTask(taskId))))
    return
  }

  if (command === "thread") {
    allowOptions(arguments_, [])
    const threadId = Schema.decodeUnknownSync(ThreadId)(identifier(arguments_, "thread id"))
    print(await Effect.runPromise(threadContext(client, threadId)))
    return
  }

  throw new Error(`Unknown Cohall command: ${command}`)
}
