import { DeviceId, Provider, makeDeviceId } from "@cohall/protocol"
import { Effect, Schema } from "effect"
import { access, chmod, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { homedir, hostname, platform } from "node:os"
import { dirname, join, resolve } from "node:path"

const WorkspaceList = Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(64))
const Sandbox = Schema.Literals(["read-only", "workspace-write", "danger-full-access"])

export const StoredConfiguration = Schema.Struct({
  version: Schema.Literal(1),
  relayUrl: Schema.NonEmptyString,
  deviceId: DeviceId,
  deviceName: Schema.NonEmptyString,
  workspaces: WorkspaceList,
  clientToken: Schema.optionalKey(Schema.NonEmptyString),
  deviceToken: Schema.optionalKey(Schema.NonEmptyString),
  model: Schema.optionalKey(Schema.NonEmptyString),
  sandbox: Schema.optionalKey(Sandbox),
})
export interface StoredConfiguration extends Schema.Schema.Type<typeof StoredConfiguration> {}

export const ClientConfiguration = Schema.Struct({
  relayUrl: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
  mcpThreadId: Schema.optionalKey(Schema.String),
})
export interface ClientConfiguration extends Schema.Schema.Type<typeof ClientConfiguration> {}

export const DeviceConfiguration = Schema.Struct({
  relayUrl: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
  id: DeviceId,
  name: Schema.NonEmptyString,
  workspaces: WorkspaceList,
  model: Schema.optionalKey(Schema.NonEmptyString),
  sandbox: Schema.optionalKey(Sandbox),
})
export interface DeviceConfiguration extends Schema.Schema.Type<typeof DeviceConfiguration> {}

const defaultConfigDirectory = (): string => {
  if (platform() === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Cohall")
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "Cohall")
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cohall")
}

export const configurationPath = (): string =>
  resolve(process.env.COHALL_CONFIG ?? join(defaultConfigDirectory(), "config.json"))

export const normalizeRelayUrl = (input: string): string => {
  const url = new URL(input)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Relay URL must use http or https")
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("Relay URL cannot include credentials, a query, or a fragment")
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("Relay URL cannot include a path")
  }
  url.pathname = "/"
  return url.toString().replace(/\/$/, "")
}

export const parseWorkspaces = (
  workspaceList: string,
  workspaceJson?: string,
): Effect.Effect<ReadonlyArray<string>, Error> =>
  Effect.tryPromise({
    try: async () => {
      const values =
        workspaceJson === undefined
          ? workspaceList
              .split(",")
              .map((workspace) => workspace.trim())
              .filter((workspace) => workspace.length > 0)
          : Schema.decodeUnknownSync(WorkspaceList)(JSON.parse(workspaceJson))
      const canonical = await Promise.all(values.map((workspace) => realpath(resolve(workspace))))
      return [...new Set(canonical)]
    },
    catch: (cause) =>
      new Error(
        `Workspace roots must be existing paths; JSON input must be an array of paths: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  })

export const readStoredConfiguration = async (): Promise<StoredConfiguration | undefined> => {
  const path = configurationPath()
  if (
    !(await access(path)
      .then(() => true)
      .catch(() => false))
  ) {
    return undefined
  }
  if (platform() !== "win32") {
    await chmod(path, 0o600)
  }
  try {
    return Schema.decodeUnknownSync(StoredConfiguration)(JSON.parse(await readFile(path, "utf8")))
  } catch (cause) {
    throw new Error(`Invalid Cohall configuration at ${path}: ${String(cause)}`)
  }
}

export const writeStoredConfiguration = async (
  configuration: StoredConfiguration,
): Promise<void> => {
  const path = configurationPath()
  const directory = dirname(path)
  const temporary = `${path}.${process.pid}.tmp`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (platform() !== "win32") {
    await chmod(directory, 0o700)
  }
  await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
  if (platform() !== "win32") {
    await chmod(path, 0o600)
  }
}

export const makeStoredConfiguration = async (input: {
  readonly relayUrl: string
  readonly deviceName?: string
  readonly workspaces?: ReadonlyArray<string>
  readonly clientToken?: string
  readonly deviceToken?: string
}): Promise<StoredConfiguration> => {
  const existing = await readStoredConfiguration()
  const canonicalWorkspaces =
    input.workspaces === undefined
      ? (existing?.workspaces ?? [])
      : await Effect.runPromise(parseWorkspaces("", JSON.stringify(input.workspaces)))
  const clientToken = input.clientToken ?? existing?.clientToken
  const deviceToken = input.deviceToken ?? existing?.deviceToken
  return StoredConfiguration.make({
    version: 1,
    relayUrl: normalizeRelayUrl(input.relayUrl),
    deviceId: existing?.deviceId ?? makeDeviceId(),
    deviceName: input.deviceName ?? existing?.deviceName ?? hostname(),
    workspaces: canonicalWorkspaces,
    ...(clientToken === undefined ? {} : { clientToken }),
    ...(deviceToken === undefined ? {} : { deviceToken }),
    ...(existing?.model === undefined ? {} : { model: existing.model }),
    ...(existing?.sandbox === undefined ? {} : { sandbox: existing.sandbox }),
  })
}

const environmentWorkspaces = async (
  stored: StoredConfiguration | undefined,
): Promise<ReadonlyArray<string>> => {
  const list = process.env.COHALL_DEVICE_WORKSPACES
  const json = process.env.COHALL_DEVICE_WORKSPACES_JSON
  if (list === undefined && json === undefined) {
    return stored?.workspaces ?? []
  }
  return Effect.runPromise(parseWorkspaces(list ?? "", json))
}

const environmentProvider = (): string | undefined =>
  process.env.COHALL_MODEL ?? process.env.COHALL_CODEX_MODEL

const environmentSandbox = (): DeviceConfiguration["sandbox"] => {
  const value = process.env.COHALL_SANDBOX ?? process.env.COHALL_CODEX_SANDBOX
  return value === undefined ? undefined : Schema.decodeUnknownSync(Sandbox)(value)
}

const storedOrDefaults = async (): Promise<StoredConfiguration> => {
  const stored = await readStoredConfiguration()
  return (
    stored ??
    StoredConfiguration.make({
      version: 1,
      relayUrl: "http://127.0.0.1:8787",
      deviceId: makeDeviceId(),
      deviceName: hostname(),
      workspaces: [],
    })
  )
}

export const loadClientConfiguration = Effect.tryPromise({
  try: async () => {
    const stored = await storedOrDefaults()
    const token = process.env.COHALL_CLIENT_TOKEN ?? stored.clientToken
    if (token === undefined) {
      throw new Error(
        `No client credential. Run cohall join with a pairing token on stdin or set COHALL_CLIENT_TOKEN.`,
      )
    }
    return ClientConfiguration.make({
      relayUrl: normalizeRelayUrl(process.env.COHALL_RELAY_URL ?? stored.relayUrl),
      token,
      ...(process.env.COHALL_THREAD_ID === undefined
        ? {}
        : { mcpThreadId: process.env.COHALL_THREAD_ID }),
    })
  },
  catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
})

export const loadOwnerConfiguration = Effect.tryPromise({
  try: async () => {
    const stored = await storedOrDefaults()
    const token = process.env.COHALL_TOKEN
    if (token === undefined) {
      throw new Error("No owner credential. Set COHALL_TOKEN on the owner-authenticated machine.")
    }
    return ClientConfiguration.make({
      relayUrl: normalizeRelayUrl(process.env.COHALL_RELAY_URL ?? stored.relayUrl),
      token,
    })
  },
  catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
})

export const loadDeviceConfiguration = Effect.tryPromise({
  try: async () => {
    const stored = await storedOrDefaults()
    const token = process.env.COHALL_DEVICE_TOKEN ?? stored.deviceToken
    if (token === undefined) {
      throw new Error(
        `No device credential. Run cohall join with a pairing token on stdin or set COHALL_DEVICE_TOKEN.`,
      )
    }
    const workspaces = await environmentWorkspaces(stored)
    if (workspaces.length === 0) {
      throw new Error("No device workspace roots are configured")
    }
    const model = environmentProvider() ?? stored.model
    const sandbox = environmentSandbox() ?? stored.sandbox
    return DeviceConfiguration.make({
      relayUrl: normalizeRelayUrl(process.env.COHALL_RELAY_URL ?? stored.relayUrl),
      token,
      id:
        process.env.COHALL_DEVICE_ID === undefined
          ? stored.deviceId
          : DeviceId.make(process.env.COHALL_DEVICE_ID),
      name: process.env.COHALL_DEVICE_NAME ?? stored.deviceName,
      workspaces,
      ...(model === undefined ? {} : { model }),
      ...(sandbox === undefined ? {} : { sandbox }),
    })
  },
  catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
})

export const knownProviders = Provider.literals
