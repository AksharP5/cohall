import { RelayClient, exchangePairing } from "@cohall/client"
import { AuthSessionId, Provider, TaskId, ThreadId, makeDeviceId, version } from "@cohall/protocol"
import * as Providers from "@cohall/providers"
import { Effect, Schema } from "effect"
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import skill from "../../../skills/cohall/SKILL.md" with { type: "text" }
import {
  StoredConfiguration,
  configurationPath,
  credentialsForRelay,
  loadClientConfiguration,
  loadOwnerConfiguration,
  makeStoredConfiguration,
  normalizeRelayUrl,
  parseProviders,
  parseWorkspaces,
  readStoredConfiguration,
  writeStoredConfiguration,
} from "./config.ts"
import {
  createDelegation,
  followTaskTrace,
  taskResult,
  threadContext,
  waitForTask,
} from "./delegation.ts"
import { deviceVersionWarning, upgrade } from "./upgrade.ts"

interface Arguments {
  readonly options: ReadonlyMap<string, ReadonlyArray<string> | true>
  readonly positionals: ReadonlyArray<string>
}

const valueOptions = new Set([
  "context",
  "context-file",
  "label",
  "model",
  "name",
  "prompt",
  "prompt-file",
  "provider",
  "providers",
  "relay",
  "sandbox",
  "target",
  "thread",
  "timeout",
  "token-file",
  "to",
  "workspace",
])
const flagOptions = new Set(["client-only", "dry-run", "follow", "no-restart", "no-wait"])
const aliases = new Map([
  ["-c", "context"],
  ["-p", "prompt"],
  ["-t", "target"],
  ["-T", "thread"],
  ["-w", "workspace"],
])

const help = `Cohall connects agents running on your own devices.

Usage:
  cohall join --relay <url> --workspace <path> [--providers list] [--token-file <path>]
  cohall configure [--relay url] [--name name] [--workspace path]
                   [--providers codex,opencode|auto] [--model id]
  cohall config
  cohall devices
  cohall delegate [prompt] [--target @device] [--provider provider]
                  [--context text] [--thread uuid] [--workspace path]
                  [--timeout seconds] [--no-wait]
  cohall status <task-id>
  cohall trace <task-id> [--follow]
  cohall wait <task-id> [--timeout seconds]
  cohall cancel <task-id>
  cohall thread <thread-id>
  cohall pair [--label name] [--client-only]
  cohall sessions
  cohall revoke <session-id>
  cohall doctor
  cohall upgrade [--to version|latest] [--no-restart] [--dry-run]
  cohall device
  cohall relay
  cohall mcp
  cohall skill [install [agents|claude|opencode|all]]
  cohall integrations

Providers: codex, claude-code, opencode.
Configuration is stored per user; environment variables override it.`

const parseArguments = (values: ReadonlyArray<string>): Arguments => {
  const options = new Map<string, ReadonlyArray<string> | true>()
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
    const previous = options.get(name)
    options.set(name, previous === undefined || previous === true ? [value] : [...previous, value])
    if (inline === undefined) {
      index += 1
    }
  }
  return { options, positionals }
}

const values = (arguments_: Arguments, name: string): ReadonlyArray<string> => {
  const option = arguments_.options.get(name)
  if (option === true) {
    throw new Error(`--${name} requires a value`)
  }
  return option ?? []
}
const option = (arguments_: Arguments, name: string): string | undefined => {
  const found = values(arguments_, name)
  if (found.length > 1 && name !== "workspace") {
    throw new Error(`--${name} may only be specified once`)
  }
  return found[0]
}
const allowOptions = (arguments_: Arguments, names: ReadonlyArray<string>): void => {
  const allowed = new Set(names)
  for (const name of arguments_.options.keys()) {
    if (!allowed.has(name)) {
      throw new Error(`--${name} is not valid for this command`)
    }
  }
}
const noPositionals = (arguments_: Arguments, command: string): void => {
  if (arguments_.positionals.length > 0) {
    throw new Error(`${command} does not accept positional arguments`)
  }
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
const print = (value: unknown): void => console.log(JSON.stringify(value, null, 2))
const printLine = (value: unknown): void => console.log(JSON.stringify(value))

const readInput = async (
  arguments_: Arguments,
  name: "prompt" | "context",
): Promise<string | undefined> => {
  const direct = option(arguments_, name)
  const path = option(arguments_, `${name}-file`)
  if (direct !== undefined && path !== undefined) {
    throw new Error(`Use either --${name} or --${name}-file, not both`)
  }
  if (path !== undefined) {
    if (
      !(await access(path)
        .then(() => true)
        .catch(() => false))
    ) {
      throw new Error(`File does not exist: ${path}`)
    }
    if ((await stat(path)).size > 131_072) {
      throw new Error(`${name} file exceeds 128 KiB`)
    }
    return readFile(path, "utf8")
  }
  const result = direct === "-" ? await readStdin(131_072, name) : direct
  if (result !== undefined && result.length > 131_072) {
    throw new Error(`${name} exceeds 128 KiB`)
  }
  return result
}

const readStdin = async (limit: number, label: string): Promise<string> => {
  const chunks: Array<Buffer> = []
  let size = 0
  for await (const chunk of process.stdin) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > limit) {
      throw new Error(`${label} exceeds ${Math.floor(limit / 1024)} KiB`)
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size).toString("utf8")
}

const timeout = (arguments_: Arguments): number => {
  const seconds = Number(option(arguments_, "timeout") ?? "900")
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 86_400) {
    throw new Error("--timeout must be an integer between 5 and 86400")
  }
  return seconds
}

const pairingToken = async (arguments_: Arguments): Promise<string> => {
  const path = option(arguments_, "token-file")
  if (
    path !== undefined &&
    !(await access(path)
      .then(() => true)
      .catch(() => false))
  ) {
    throw new Error(`Pairing token file does not exist: ${path}`)
  }
  if (path !== undefined && (await stat(path)).size > 512) {
    throw new Error("Pairing token file exceeds 512 bytes")
  }
  const token = (
    path === undefined ? await readStdin(512, "Pairing token") : await readFile(path, "utf8")
  ).trim()
  if (token.length === 0 || new TextEncoder().encode(token).byteLength > 256) {
    throw new Error("Provide a pairing token on stdin or with --token-file")
  }
  return token
}

const client = async () => {
  const configuration = await Effect.runPromise(loadClientConfiguration)
  return {
    configuration,
    relay: RelayClient.make({ baseUrl: configuration.relayUrl, token: configuration.token }),
  }
}

const ownerClient = async () => {
  const configuration = await Effect.runPromise(loadOwnerConfiguration)
  return {
    configuration,
    relay: RelayClient.make({ baseUrl: configuration.relayUrl, token: configuration.token }),
  }
}

const installSkill = async (target: string): Promise<ReadonlyArray<string>> => {
  const roots = {
    agents: join(homedir(), ".agents", "skills", "cohall", "SKILL.md"),
    claude: join(homedir(), ".claude", "skills", "cohall", "SKILL.md"),
    opencode: join(homedir(), ".config", "opencode", "skills", "cohall", "SKILL.md"),
  } as const
  const selected =
    target === "all"
      ? Object.values(roots)
      : target in roots
        ? [roots[target as keyof typeof roots]]
        : undefined
  if (selected === undefined) {
    throw new Error("Skill target must be agents, claude, opencode, or all")
  }
  for (const path of selected) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, skill)
  }
  return selected
}

export const printHelp = (): void => console.log(help)
export const printSkill = (): void => console.log(skill.trimEnd())

export const runCli = async (command: string, raw: ReadonlyArray<string>): Promise<void> => {
  const arguments_ = parseArguments(raw)

  if (command === "upgrade") {
    allowOptions(arguments_, ["dry-run", "no-restart", "to"])
    noPositionals(arguments_, command)
    const target = option(arguments_, "to")
    print(
      await upgrade({
        currentVersion: version,
        ...(target === undefined ? {} : { target }),
        restart: !arguments_.options.has("no-restart"),
        dryRun: arguments_.options.has("dry-run"),
        delegated: process.env.COHALL_PROVIDER !== undefined,
      }),
    )
    return
  }

  if (command === "join") {
    allowOptions(arguments_, [
      "client-only",
      "name",
      "providers",
      "relay",
      "token-file",
      "workspace",
    ])
    noPositionals(arguments_, command)
    const token = await pairingToken(arguments_)
    const relayUrl = normalizeRelayUrl(option(arguments_, "relay") ?? "http://127.0.0.1:8787")
    const existing = await readStoredConfiguration()
    const suppliedWorkspaces = values(arguments_, "workspace")
    const workspaces = suppliedWorkspaces.length === 0 ? existing?.workspaces : suppliedWorkspaces
    const deviceName = option(arguments_, "name")
    const providerInput = option(arguments_, "providers")
    const providers =
      providerInput === undefined
        ? undefined
        : providerInput === "auto"
          ? "auto"
          : parseProviders(providerInput)
    if (!arguments_.options.has("client-only") && (workspaces?.length ?? 0) === 0) {
      throw new Error("At least one --workspace is required when joining a device")
    }
    const draft = await makeStoredConfiguration({
      relayUrl,
      ...(deviceName === undefined ? {} : { deviceName }),
      ...(workspaces === undefined ? {} : { workspaces }),
      ...(providers === undefined ? {} : { providers }),
    })
    const paired = await Effect.runPromise(exchangePairing(relayUrl, { token }))
    const clientToken = paired.credentials.find(
      (credential) => credential.session.role === "client",
    )?.token
    const deviceToken = paired.credentials.find(
      (credential) => credential.session.role === "device",
    )?.token
    const deviceId = paired.credentials.find((credential) => credential.session.role === "device")
      ?.session.deviceId
    if (!arguments_.options.has("client-only") && deviceToken === undefined) {
      throw new Error("The pairing credential did not include device access")
    }
    const configuration = StoredConfiguration.make({
      ...draft,
      deviceId: deviceId ?? draft.deviceId,
      ...(clientToken === undefined ? {} : { clientToken }),
      ...(deviceToken === undefined ? {} : { deviceToken }),
    })
    await writeStoredConfiguration(configuration)
    print({
      configured: true,
      config_path: configurationPath(),
      relay_url: configuration.relayUrl,
      device_id: configuration.deviceId,
      roles: paired.credentials.map((credential) => credential.session.role),
      workspaces: configuration.workspaces,
    })
    return
  }

  if (command === "config") {
    allowOptions(arguments_, [])
    noPositionals(arguments_, command)
    const configuration = await readStoredConfiguration()
    print({
      config_path: configurationPath(),
      configured: configuration !== undefined,
      ...(configuration === undefined
        ? {}
        : {
            relay_url: configuration.relayUrl,
            device_id: configuration.deviceId,
            device_name: configuration.deviceName,
            workspaces: configuration.workspaces,
            client_credential: configuration.clientToken !== undefined,
            device_credential: configuration.deviceToken !== undefined,
            providers: configuration.providers ?? "auto",
            model: configuration.model,
            sandbox: configuration.sandbox,
          }),
    })
    return
  }

  if (command === "configure") {
    allowOptions(arguments_, ["model", "name", "providers", "relay", "sandbox", "workspace"])
    noPositionals(arguments_, command)
    const existing = await readStoredConfiguration()
    const relayUrl = normalizeRelayUrl(
      option(arguments_, "relay") ?? existing?.relayUrl ?? "http://127.0.0.1:8787",
    )
    const supplied = values(arguments_, "workspace")
    const workspaces =
      supplied.length === 0
        ? (existing?.workspaces ?? [])
        : await Effect.runPromise(parseWorkspaces("", JSON.stringify(supplied)))
    const sandbox = option(arguments_, "sandbox")
    const model = option(arguments_, "model") ?? existing?.model
    const providerInput = option(arguments_, "providers")
    const providers =
      providerInput === undefined
        ? existing?.providers
        : providerInput === "auto"
          ? undefined
          : parseProviders(providerInput)
    const configuration = StoredConfiguration.make({
      version: 1,
      relayUrl,
      deviceId: existing?.deviceId ?? makeDeviceId(),
      deviceName: option(arguments_, "name") ?? existing?.deviceName ?? "cohall-device",
      workspaces,
      ...credentialsForRelay(existing, relayUrl),
      ...(providers === undefined ? {} : { providers }),
      ...(model === undefined ? {} : { model }),
      ...((sandbox ?? existing?.sandbox) === undefined
        ? {}
        : {
            sandbox: Schema.decodeUnknownSync(
              Schema.Literals(["read-only", "workspace-write", "danger-full-access"]),
            )(sandbox ?? existing?.sandbox),
          }),
    })
    await writeStoredConfiguration(configuration)
    print({ configured: true, config_path: configurationPath() })
    return
  }

  if (command === "skill") {
    allowOptions(arguments_, [])
    if (arguments_.positionals.length === 0) {
      printSkill()
      return
    }
    if (arguments_.positionals[0] !== "install" || arguments_.positionals.length > 2) {
      throw new Error("Usage: cohall skill [install [agents|claude|opencode|all]]")
    }
    print({ installed: await installSkill(arguments_.positionals[1] ?? "all") })
    return
  }

  if (command === "integrations") {
    allowOptions(arguments_, [])
    noPositionals(arguments_, command)
    print({
      cli_skill: "npx -y @akshar5/cohall skill install all",
      codex_mcp: "codex mcp add cohall -- npx -y @akshar5/cohall mcp",
      claude_mcp:
        "claude mcp add --transport stdio --scope user cohall -- npx -y @akshar5/cohall mcp",
      stdio_config: {
        command: "npx",
        args: ["-y", "@akshar5/cohall", "mcp"],
      },
      opencode_mcp: {
        type: "local",
        command: ["npx", "-y", "@akshar5/cohall", "mcp"],
        enabled: true,
      },
    })
    return
  }

  if (command === "doctor") {
    allowOptions(arguments_, [])
    noPositionals(arguments_, command)
    const configuration = await readStoredConfiguration()
    const relayUrl = normalizeRelayUrl(
      process.env.COHALL_RELAY_URL ?? configuration?.relayUrl ?? "http://127.0.0.1:8787",
    )
    const storedCredentials = credentialsForRelay(configuration, relayUrl)
    const response = await fetch(`${relayUrl}/api/health`, {
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined)
    const providerInput = process.env.COHALL_DEVICE_PROVIDERS
    const selectedProviders =
      providerInput === undefined
        ? configuration?.providers
        : providerInput === "auto"
          ? undefined
          : parseProviders(providerInput)
    const providerExecutables = Object.fromEntries(
      Provider.literals.map((provider) => [
        provider,
        Providers.findExecutable(provider === "claude-code" ? "claude" : provider) ?? "not found",
      ]),
    )
    const clientToken = process.env.COHALL_CLIENT_TOKEN ?? storedCredentials.clientToken
    const hasDeviceCredential =
      process.env.COHALL_DEVICE_TOKEN !== undefined || storedCredentials.deviceToken !== undefined
    const deviceId = process.env.COHALL_DEVICE_ID ?? configuration?.deviceId
    const currentDevice =
      response?.ok !== true || clientToken === undefined || deviceId === undefined
        ? undefined
        : await Effect.runPromise(
            RelayClient.make({ baseUrl: relayUrl, token: clientToken }).devices(),
          )
            .then((devices) => devices.find((device) => device.id === deviceId))
            .catch(() => undefined)
    const versionWarning = deviceVersionWarning(version, currentDevice?.version)
    const warnings = [
      ...(response?.ok === true ? [] : ["Relay is unreachable"]),
      ...(versionWarning === undefined ? [] : [versionWarning]),
      ...(hasDeviceCredential &&
      response?.ok === true &&
      currentDevice?.status !== "online" &&
      currentDevice?.status !== "busy"
        ? [
            clientToken === undefined
              ? "Device status cannot be checked without a client credential"
              : "Device daemon is not connected or is not registered with the relay",
          ]
        : []),
      ...(selectedProviders?.flatMap((provider) =>
        providerExecutables[provider] === "not found"
          ? [`Configured provider ${provider} is not installed or not on PATH`]
          : [],
      ) ?? []),
    ]
    print({
      version,
      relay: response?.ok === true ? "reachable" : "unreachable",
      relay_url: relayUrl,
      config_path: configurationPath(),
      client_credential:
        process.env.COHALL_CLIENT_TOKEN !== undefined ||
        storedCredentials.clientToken !== undefined,
      device_credential: hasDeviceCredential,
      workspaces: configuration?.workspaces ?? [],
      providers: providerExecutables,
      provider_selection: selectedProviders ?? "auto",
      provider_authentication: "checked when delegated work starts",
      device_status:
        hasDeviceCredential === false ? "not configured" : (currentDevice?.status ?? "unknown"),
      device_version: currentDevice?.version,
      warnings,
    })
    return
  }

  if (command === "pair" || command === "sessions" || command === "revoke") {
    const { configuration, relay } = await ownerClient()
    if (command === "pair") {
      allowOptions(arguments_, ["client-only", "label"])
      noPositionals(arguments_, command)
      const roles = arguments_.options.has("client-only")
        ? (["client"] as const)
        : (["client", "device"] as const)
      const credential = await Effect.runPromise(
        relay.createPairing({ label: option(arguments_, "label") ?? "Cohall device", roles }),
      )
      print({
        relay_url: configuration.relayUrl,
        pairing_token: credential.token,
        expires_at: credential.expiresAt,
        roles,
      })
      return
    }
    if (command === "sessions") {
      allowOptions(arguments_, [])
      noPositionals(arguments_, command)
      print(await Effect.runPromise(relay.authSessions()))
      return
    }
    allowOptions(arguments_, [])
    print(
      await Effect.runPromise(
        relay.revokeAuthSession(
          Schema.decodeUnknownSync(AuthSessionId)(identifier(arguments_, "session id")),
        ),
      ),
    )
    return
  }

  const { configuration, relay } = await client()
  if (command === "devices") {
    allowOptions(arguments_, [])
    noPositionals(arguments_, command)
    print(await Effect.runPromise(relay.devices()))
    return
  }
  if (command === "delegate") {
    allowOptions(arguments_, [
      "context",
      "context-file",
      "no-wait",
      "prompt",
      "prompt-file",
      "provider",
      "target",
      "thread",
      "timeout",
      "workspace",
    ])
    if (option(arguments_, "prompt") === "-" && option(arguments_, "context") === "-") {
      throw new Error("Only one of --prompt and --context may read from stdin")
    }
    const suppliedPrompt = await readInput(arguments_, "prompt")
    const prompt = suppliedPrompt ?? arguments_.positionals.join(" ")
    if (prompt.trim().length === 0) {
      throw new Error("A prompt is required")
    }
    if (suppliedPrompt !== undefined && arguments_.positionals.length > 0) {
      throw new Error("Use either a positional prompt or --prompt, not both")
    }
    const context = await readInput(arguments_, "context")
    const target = option(arguments_, "target")
    const thread = option(arguments_, "thread")
    const workspace = option(arguments_, "workspace")
    const provider = option(arguments_, "provider")
    const task = await Effect.runPromise(
      createDelegation(relay, configuration, {
        prompt,
        ...(target === undefined ? {} : { target }),
        ...(context === undefined ? {} : { context }),
        ...(thread === undefined ? {} : { threadId: Schema.decodeUnknownSync(ThreadId)(thread) }),
        ...(workspace === undefined ? {} : { workspace }),
        ...(provider === undefined
          ? {}
          : { provider: Schema.decodeUnknownSync(Provider)(provider) }),
      }),
    )
    print(
      taskResult(
        arguments_.options.has("no-wait")
          ? task
          : await Effect.runPromise(waitForTask(relay, task, timeout(arguments_))),
      ),
    )
    return
  }
  if (command === "status") {
    allowOptions(arguments_, [])
    const id = Schema.decodeUnknownSync(TaskId)(identifier(arguments_, "task id"))
    print(taskResult(await Effect.runPromise(relay.getTask(id))))
    return
  }
  if (command === "trace") {
    allowOptions(arguments_, ["follow"])
    const id = Schema.decodeUnknownSync(TaskId)(identifier(arguments_, "task id"))
    if (arguments_.options.has("follow")) {
      await Effect.runPromise(followTaskTrace(relay, id, printLine))
      return
    }
    print(await Effect.runPromise(relay.traceTask(id)))
    return
  }
  if (command === "wait") {
    allowOptions(arguments_, ["timeout"])
    const id = Schema.decodeUnknownSync(TaskId)(identifier(arguments_, "task id"))
    const task = await Effect.runPromise(relay.getTask(id))
    print(taskResult(await Effect.runPromise(waitForTask(relay, task, timeout(arguments_)))))
    return
  }
  if (command === "cancel") {
    allowOptions(arguments_, [])
    const id = Schema.decodeUnknownSync(TaskId)(identifier(arguments_, "task id"))
    print(taskResult(await Effect.runPromise(relay.cancelTask(id))))
    return
  }
  if (command === "thread") {
    allowOptions(arguments_, [])
    const id = Schema.decodeUnknownSync(ThreadId)(identifier(arguments_, "thread id"))
    print(await Effect.runPromise(threadContext(relay, id)))
    return
  }
  throw new Error(`Unknown Cohall command: ${command}`)
}
