import { Provider, type Provider as ProviderName } from "@cohall/protocol"
import { Effect, Schema } from "effect"
import { accessSync, constants } from "node:fs"
import { platform } from "node:os"
import { delimiter, extname, isAbsolute, join } from "node:path"
import { spawn } from "node:child_process"
import type { Readable } from "node:stream"

export class ProviderUnavailableError extends Schema.TaggedErrorClass<ProviderUnavailableError>()(
  "CohallProvider.Unavailable",
  { provider: Provider, message: Schema.String },
) {}

export class ProviderRunError extends Schema.TaggedErrorClass<ProviderRunError>()(
  "CohallProvider.RunError",
  {
    provider: Provider,
    message: Schema.String,
    exitCode: Schema.optionalKey(Schema.Number),
  },
) {}

export type ProviderError = ProviderUnavailableError | ProviderRunError

export interface RunOptions {
  readonly provider: ProviderName
  readonly threadId: string
  readonly prompt: string
  readonly cwd: string
  readonly sessionId?: string
  readonly model?: string
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access"
}

export interface RunResult {
  readonly result: string
  readonly sessionId?: string
}

type JsonRecord = Readonly<Record<string, unknown>>

const executables = {
  codex: "codex",
  "claude-code": "claude",
  opencode: "opencode",
} as const satisfies Record<ProviderName, string>

const providerEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("COHALL_")))

const record = (value: unknown): JsonRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const executableCandidates = (command: string): ReadonlyArray<string> => {
  if (platform() !== "win32" || extname(command).length > 0) {
    return [command]
  }
  return (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((extension) => extension.length > 0)
    .map((extension) => `${command}${extension.toLowerCase()}`)
}

export const findExecutable = (command: string): string | undefined => {
  const paths =
    isAbsolute(command) || command.includes("/") || command.includes("\\")
      ? [""]
      : (process.env.PATH ?? "").split(delimiter)
  for (const directory of paths) {
    for (const candidate of executableCandidates(command)) {
      const path = directory.length === 0 ? candidate : join(directory, candidate)
      try {
        accessSync(path, platform() === "win32" ? constants.F_OK : constants.X_OK)
        return path
      } catch {
        continue
      }
    }
  }
  return undefined
}

export const available = (provider: ProviderName): boolean =>
  findExecutable(executables[provider]) !== undefined
export const availableProviders = (): ReadonlyArray<ProviderName> =>
  Provider.literals.filter(available)

const boundedText = (stream: Readable, limit: number, onOverflow: () => void): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    let size = 0
    const cleanup = (): void => {
      stream.off("data", onData)
      stream.off("end", onEnd)
      stream.off("error", onError)
    }
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk
      size += bytes.byteLength
      if (size <= limit) {
        chunks.push(bytes)
        return
      }
      cleanup()
      onOverflow()
      reject(new Error(`Provider output exceeded ${Math.floor(limit / 1024)} KiB`))
    }
    const onEnd = (): void => {
      cleanup()
      resolve(Buffer.concat(chunks, size).toString("utf8"))
    }
    const onError = (cause: Error): void => {
      cleanup()
      reject(cause)
    }
    stream.on("data", onData)
    stream.once("end", onEnd)
    stream.once("error", onError)
  })

const codexCommand = (options: RunOptions): ReadonlyArray<string> => {
  const common = [
    "--json",
    "-c",
    'approval_policy="never"',
    ...(options.model === undefined ? [] : ["--model", options.model]),
    ...(options.sandbox === undefined
      ? []
      : ["-c", `sandbox_mode=${JSON.stringify(options.sandbox)}`]),
  ]
  return options.sessionId === undefined
    ? ["codex", "exec", ...common, "-"]
    : ["codex", "exec", "resume", ...common, options.sessionId, "-"]
}

const claudeCommand = (options: RunOptions): ReadonlyArray<string> => [
  "claude",
  "-p",
  "--output-format",
  "json",
  ...(options.model === undefined ? [] : ["--model", options.model]),
  ...(options.sessionId === undefined ? [] : ["--resume", options.sessionId]),
]

const opencodeCommand = (options: RunOptions): ReadonlyArray<string> => [
  "opencode",
  "run",
  "--format",
  "json",
  ...(options.model === undefined ? [] : ["--model", options.model]),
  ...(options.sessionId === undefined ? [] : ["--session", options.sessionId]),
]

const command = (options: RunOptions): ReadonlyArray<string> => {
  switch (options.provider) {
    case "codex":
      return codexCommand(options)
    case "claude-code":
      return claudeCommand(options)
    case "opencode":
      return opencodeCommand(options)
  }
}

const parseCodex = (stdout: string, existingSession?: string): RunResult => {
  let result = ""
  let sessionId = existingSession
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) {
      continue
    }
    const event = record(JSON.parse(line) as unknown)
    if (event === undefined) {
      continue
    }
    if (text(event.type) === "thread.started") {
      sessionId = text(event.thread_id) ?? sessionId
    }
    if (text(event.type) !== "item.completed") {
      continue
    }
    const item = record(event.item)
    if (text(item?.type) === "agent_message") {
      result = text(item?.text) ?? text(item?.content) ?? result
    }
  }
  return {
    result: result || "Codex completed the task without a text response.",
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

const parseClaude = (stdout: string, existingSession?: string): RunResult => {
  const value = record(JSON.parse(stdout) as unknown)
  const result = text(value?.result) ?? text(value?.content)
  if (result === undefined) {
    throw new Error("Claude Code returned JSON without a result")
  }
  const sessionId = text(value?.session_id) ?? text(value?.sessionId) ?? existingSession
  return { result, ...(sessionId === undefined ? {} : { sessionId }) }
}

const textFromPart = (value: unknown): string | undefined => {
  const part = record(value)
  if (part === undefined) {
    return undefined
  }
  return text(part.text) ?? text(part.content) ?? text(record(part.part)?.text)
}

const parseOpenCode = (stdout: string, existingSession?: string): RunResult => {
  let result = ""
  let sessionId = existingSession
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) {
      continue
    }
    const event = record(JSON.parse(line) as unknown)
    if (event === undefined) {
      continue
    }
    sessionId =
      text(event.sessionID) ??
      text(event.sessionId) ??
      text(event.session_id) ??
      text(record(event.info)?.sessionID) ??
      sessionId
    const content = textFromPart(event.part) ?? textFromPart(event) ?? text(event.result)
    if (content !== undefined && content.length > 0) {
      result = content
    }
  }
  if (result.length === 0) {
    throw new Error("OpenCode completed without a text response")
  }
  return { result, ...(sessionId === undefined ? {} : { sessionId }) }
}

const parse = (options: RunOptions, stdout: string): RunResult => {
  switch (options.provider) {
    case "codex":
      return parseCodex(stdout, options.sessionId)
    case "claude-code":
      return parseClaude(stdout, options.sessionId)
    case "opencode":
      return parseOpenCode(stdout, options.sessionId)
  }
}

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength

export const run = (options: RunOptions): Effect.Effect<RunResult, ProviderError> =>
  Effect.tryPromise({
    try: async (signal) => {
      if (!available(options.provider)) {
        throw new ProviderUnavailableError({
          provider: options.provider,
          message: `${executables[options.provider]} is not available on this device`,
        })
      }

      const [executable, ...arguments_] = command(options)
      if (executable === undefined) {
        throw new ProviderRunError({
          provider: options.provider,
          message: `No command is configured for ${options.provider}`,
        })
      }
      const child = spawn(executable, arguments_, {
        cwd: options.cwd,
        env: {
          ...providerEnvironment(),
          COHALL_PROVIDER: options.provider,
          COHALL_THREAD_ID: options.threadId,
        },
        stdio: ["pipe", "pipe", "pipe"],
      })
      const exited = new Promise<number>((resolve, reject) => {
        child.once("error", reject)
        child.once("exit", (code) => resolve(code ?? 1))
      })
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const terminate = (): void => {
        if (child.exitCode !== null) {
          return
        }
        child.kill("SIGTERM")
        killTimer ??= setTimeout(() => {
          if (child.exitCode === null) {
            child.kill("SIGKILL")
          }
        }, 5_000)
        killTimer.unref()
      }
      signal.addEventListener("abort", terminate, { once: true })
      child.stdin.end(options.prompt)

      const [stdout, stderr, exitCode] = await Promise.all([
        boundedText(child.stdout, 1024 * 1024, terminate),
        boundedText(child.stderr, 64 * 1024, terminate),
        exited,
      ])
      signal.removeEventListener("abort", terminate)
      if (killTimer !== undefined && child.exitCode !== null) {
        clearTimeout(killTimer)
      }
      if (exitCode !== 0) {
        throw new ProviderRunError({
          provider: options.provider,
          message: (
            stderr.trim() || `${executables[options.provider]} exited with status ${exitCode}`
          ).slice(0, 16_384),
          exitCode,
        })
      }
      const result = parse(options, stdout)
      if (byteLength(result.result) > 131_072) {
        throw new ProviderRunError({
          provider: options.provider,
          message: "Provider result exceeded 128 KiB",
        })
      }
      if (result.sessionId !== undefined && byteLength(result.sessionId) > 4_096) {
        throw new ProviderRunError({
          provider: options.provider,
          message: "Provider session ID exceeded 4 KiB",
        })
      }
      return result
    },
    catch: (cause) => {
      if (cause instanceof ProviderUnavailableError || cause instanceof ProviderRunError) {
        return cause
      }
      return new ProviderRunError({
        provider: options.provider,
        message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 16_384),
      })
    },
  })
