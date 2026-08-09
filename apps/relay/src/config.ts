import { Effect, Schema } from "effect"
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir, platform } from "node:os"
import { join, resolve } from "node:path"

export const RelayConfiguration = Schema.Struct({
  host: Schema.NonEmptyString,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  token: Schema.String.check(Schema.isMinLength(32)),
  dataDirectory: Schema.NonEmptyString,
  databasePath: Schema.NonEmptyString,
  allowRemote: Schema.Boolean,
  historyTaskLimit: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 100_000 })),
})
export interface RelayConfiguration extends Schema.Schema.Type<typeof RelayConfiguration> {}

const defaultDataDirectory = (): string => {
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Cohall")
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "Cohall", "relay")
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "cohall")
}

const generatedToken = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("")

const tokenFrom = async (path: string): Promise<string> => {
  if (
    await access(path)
      .then(() => true)
      .catch(() => false)
  ) {
    return (await readFile(path, "utf8")).trim()
  }
  const token = generatedToken()
  await writeFile(path, `${token}\n`, { mode: 0o600 })
  if (platform() !== "win32") {
    await chmod(path, 0o600)
  }
  return token
}

const booleanEnvironment = (name: string): boolean => {
  const value = process.env[name]
  if (value === undefined || value === "false" || value === "0") {
    return false
  }
  if (value === "true" || value === "1") {
    return true
  }
  throw new Error(`${name} must be true or false`)
}

const isLoopback = (host: string): boolean =>
  host === "127.0.0.1" || host === "localhost" || host === "::1"

export const loadEnvironmentConfiguration = Effect.tryPromise({
  try: async () => {
    const host = process.env.COHALL_RELAY_HOST ?? "127.0.0.1"
    const port = Number(process.env.COHALL_RELAY_PORT ?? "8787")
    const allowRemote = booleanEnvironment("COHALL_RELAY_ALLOW_REMOTE")
    if (!isLoopback(host) && !allowRemote) {
      throw new Error(
        "Remote relay binding is disabled. Use a private network or TLS reverse proxy, then set COHALL_RELAY_ALLOW_REMOTE=true.",
      )
    }
    const dataDirectory = resolve(process.env.COHALL_DATA_DIR ?? defaultDataDirectory())
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
    if (platform() !== "win32") {
      await chmod(dataDirectory, 0o700)
    }
    const token = process.env.COHALL_TOKEN ?? (await tokenFrom(join(dataDirectory, "owner-token")))
    if (token.length < 32) {
      throw new Error("The Cohall relay owner token must be at least 32 characters")
    }
    const historyTaskLimit = Number(process.env.COHALL_HISTORY_TASK_LIMIT ?? "1000")
    return Schema.decodeUnknownSync(RelayConfiguration)({
      host,
      port,
      token,
      dataDirectory,
      databasePath: join(dataDirectory, "cohall.db"),
      allowRemote,
      historyTaskLimit,
    })
  },
  catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
})
