import { Provider, type Provider as ProviderName } from "@cohall/protocol"
import { Effect, Schema } from "effect"
import { accessSync, constants } from "node:fs"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, platform, tmpdir } from "node:os"
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

const providerEnvironment = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("COHALL_") || name === "COHALL_CONFIG",
    ),
  ),
  PATH: executableDirectories().join(delimiter),
})

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

const executableDirectories = (): ReadonlyArray<string> => {
  const home = homedir()
  const configured = (process.env.PATH ?? "").split(delimiter).filter(Boolean)
  const common =
    platform() === "win32"
      ? [
          process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, "npm"),
          process.env.LOCALAPPDATA === undefined
            ? undefined
            : join(process.env.LOCALAPPDATA, "pnpm"),
          join(home, ".bun", "bin"),
        ]
      : [
          join(home, ".local", "bin"),
          join(home, ".npm-global", "bin"),
          join(home, ".bun", "bin"),
          join(home, ".local", "share", "pnpm"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
        ]
  return [...new Set([...configured, ...common.filter((path) => path !== undefined)])]
}

export const findExecutable = (command: string): string | undefined => {
  const paths =
    isAbsolute(command) || command.includes("/") || command.includes("\\")
      ? [""]
      : executableDirectories()
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

interface CapturedText {
  readonly text: string
  readonly truncated: boolean
}

const captureText = (stream: Readable, limit: number): Promise<CapturedText> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    let captured = 0
    let truncated = false
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk
      const remaining = limit - captured
      if (remaining > 0) {
        const selected = bytes.byteLength <= remaining ? bytes : bytes.subarray(0, remaining)
        chunks.push(selected)
        captured += selected.byteLength
      }
      truncated ||= bytes.byteLength > remaining
    }
    const onEnd = (): void =>
      resolve({ text: Buffer.concat(chunks, captured).toString("utf8"), truncated })
    stream.on("data", onData)
    stream.once("end", onEnd)
    stream.once("error", reject)
  })

const failureMessage = (command: string, stderr: CapturedText, exitCode: number): string => {
  const fallback = `${command} exited with status ${exitCode}`
  const suffix = stderr.truncated ? "\n[stderr truncated after 64 KiB]" : ""
  const available = 16_384 - suffix.length
  return `${(stderr.text.trim() || fallback).slice(0, available)}${suffix}`
}

const codexCommand = (options: RunOptions): ReadonlyArray<string> => {
  const common = [
    "--json",
    "--skip-git-repo-check",
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

const opencodeCommand = (options: RunOptions, promptPath: string): ReadonlyArray<string> => [
  "opencode",
  "run",
  "--format",
  "json",
  ...(options.model === undefined ? [] : ["--model", options.model]),
  ...(options.sessionId === undefined ? [] : ["--session", options.sessionId]),
  "--file",
  promptPath,
  "Complete the task described in the attached Cohall prompt file.",
]

interface PreparedCommand {
  readonly command: ReadonlyArray<string>
  readonly input?: string
  readonly cleanup: () => Promise<void>
}

const prepareCommand = async (options: RunOptions): Promise<PreparedCommand> => {
  switch (options.provider) {
    case "codex":
      return {
        command: codexCommand(options),
        input: options.prompt,
        cleanup: () => Promise.resolve(),
      }
    case "claude-code":
      return {
        command: claudeCommand(options),
        input: options.prompt,
        cleanup: () => Promise.resolve(),
      }
    case "opencode": {
      const directory = await mkdtemp(join(tmpdir(), "cohall-opencode-"))
      const promptPath = join(directory, "prompt.md")
      try {
        if (platform() !== "win32") {
          await chmod(directory, 0o700)
        }
        await writeFile(promptPath, options.prompt, { mode: 0o600 })
        return {
          command: opencodeCommand(options, promptPath),
          cleanup: () => rm(directory, { recursive: true, force: true }),
        }
      } catch (cause) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined)
        throw cause
      }
    }
  }
}

const forEachJsonEvent = async (
  stdout: Readable,
  onEvent: (event: JsonRecord) => void,
): Promise<void> => {
  const limit = 1024 * 1024
  let chunks: Array<Buffer> = []
  let size = 0
  const append = (chunk: Buffer): void => {
    if (size + chunk.byteLength > limit) {
      throw new Error("Provider event exceeded 1024 KiB")
    }
    if (chunk.byteLength > 0) {
      chunks.push(chunk)
      size += chunk.byteLength
    }
  }
  const emit = (): void => {
    const line = Buffer.concat(chunks, size).toString("utf8")
    chunks = []
    size = 0
    if (line.trim().length === 0) {
      return
    }
    const event = record(JSON.parse(line) as unknown)
    if (event !== undefined) {
      onEvent(event)
    }
  }

  for await (const chunk of stdout) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    let start = 0
    for (let newline = bytes.indexOf(0x0a, start); newline !== -1; ) {
      append(bytes.subarray(start, newline))
      emit()
      start = newline + 1
      newline = bytes.indexOf(0x0a, start)
    }
    append(bytes.subarray(start))
  }
  if (size > 0) {
    emit()
  }
}

const parseCodex = async (stdout: Readable, existingSession?: string): Promise<RunResult> => {
  let result = ""
  let sessionId = existingSession
  await forEachJsonEvent(stdout, (event) => {
    if (text(event.type) === "thread.started") {
      sessionId = text(event.thread_id) ?? sessionId
    }
    if (text(event.type) !== "item.completed") {
      return
    }
    const item = record(event.item)
    if (text(item?.type) === "agent_message") {
      result = text(item?.text) ?? text(item?.content) ?? result
    }
  })
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

const openCodeError = (event: JsonRecord): string | undefined => {
  if (text(event.type) !== "error") {
    return undefined
  }
  const error = record(event.error)
  const name = text(error?.name)
  const message =
    text(record(error?.data)?.message) ??
    text(error?.message) ??
    text(event.message) ??
    text(event.error)
  if (name !== undefined && message !== undefined) {
    return `OpenCode ${name}: ${message}`
  }
  return message === undefined ? "OpenCode reported an error" : `OpenCode: ${message}`
}

const parseOpenCode = async (stdout: Readable, existingSession?: string): Promise<RunResult> => {
  let result = ""
  let sessionId = existingSession
  await forEachJsonEvent(stdout, (event) => {
    const failure = openCodeError(event)
    if (failure !== undefined) {
      throw new Error(failure)
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
  })
  if (result.length === 0) {
    throw new Error(
      "OpenCode produced no result; verify its authentication and use a supported project workspace",
    )
  }
  return { result, ...(sessionId === undefined ? {} : { sessionId }) }
}

const parse = async (
  options: RunOptions,
  stdout: Readable,
  onFailure: () => void,
): Promise<RunResult> => {
  try {
    switch (options.provider) {
      case "codex":
        return await parseCodex(stdout, options.sessionId)
      case "claude-code":
        return parseClaude(await boundedText(stdout, 1024 * 1024, onFailure), options.sessionId)
      case "opencode":
        return await parseOpenCode(stdout, options.sessionId)
    }
  } catch (cause) {
    onFailure()
    throw cause
  }
}

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength

export const run = (options: RunOptions): Effect.Effect<RunResult, ProviderError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const executable = findExecutable(executables[options.provider])
      if (executable === undefined) {
        throw new ProviderUnavailableError({
          provider: options.provider,
          message: `${executables[options.provider]} is not available on this device`,
        })
      }
      const prepared = await prepareCommand(options)
      const [, ...arguments_] = prepared.command
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
      child.stdin.end(prepared.input)

      try {
        const [result, stderr, exitCode] = await Promise.all([
          parse(options, child.stdout, terminate),
          captureText(child.stderr, 64 * 1024),
          exited,
        ])
        if (exitCode !== 0) {
          throw new ProviderRunError({
            provider: options.provider,
            message: failureMessage(executables[options.provider], stderr, exitCode),
            exitCode,
          })
        }
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
      } finally {
        signal.removeEventListener("abort", terminate)
        if (child.exitCode === null) {
          terminate()
          await exited.catch(() => undefined)
        }
        if (killTimer !== undefined) {
          clearTimeout(killTimer)
        }
        await prepared.cleanup()
      }
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
