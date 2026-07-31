import { Config, ConfigProvider, Effect, Redacted, Schema } from "effect"
import { chmod, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

export const RelayConfiguration = Schema.Struct({
  host: Schema.NonEmptyString,
  port: Schema.Int,
  token: Schema.NonEmptyString,
  databasePath: Schema.NonEmptyString,
  webDirectory: Schema.NonEmptyString,
  allowedOrigins: Schema.Array(Schema.NonEmptyString),
})
export interface RelayConfiguration extends Schema.Schema.Type<typeof RelayConfiguration> {}

const generatedToken = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("")

const tokenFrom = (path: string): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: async () => {
      const file = Bun.file(path)
      if (await file.exists()) {
        return (await file.text()).trim()
      }
      const token = generatedToken()
      await mkdir(dirname(path), { recursive: true })
      await Bun.write(path, token)
      await chmod(path, 0o600)
      return token
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })

export const loadConfiguration = Effect.gen(function* () {
  const host = yield* Config.string("COHALL_RELAY_HOST").pipe(Config.withDefault("127.0.0.1"))
  const port = yield* Config.int("COHALL_RELAY_PORT").pipe(Config.withDefault(8787))
  const dataDirectory = yield* Config.string("COHALL_DATA_DIR").pipe(Config.withDefault(".cohall"))
  const configuredToken = yield* Config.option(Config.redacted("COHALL_TOKEN"))
  const token =
    configuredToken._tag === "Some"
      ? Redacted.value(configuredToken.value)
      : yield* tokenFrom(`${dataDirectory.replace(/\/+$/, "")}/token`)
  const webDirectory = yield* Config.string("COHALL_WEB_DIR").pipe(
    Config.withDefault("apps/web/dist"),
  )
  const allowedOrigins = yield* Config.string("COHALL_ALLOWED_ORIGINS").pipe(
    Config.withDefault(
      "http://127.0.0.1:5173,http://localhost:5173,tauri://localhost,http://tauri.localhost,https://tauri.localhost",
    ),
  )

  return RelayConfiguration.make({
    host,
    port,
    token,
    databasePath: `${dataDirectory.replace(/\/+$/, "")}/cohall.db`,
    webDirectory,
    allowedOrigins: allowedOrigins
      .split(",")
      .map((origin) => origin.trim().replace(/\/+$/, ""))
      .filter((origin) => origin.length > 0),
  })
})

export const loadEnvironmentConfiguration = loadConfiguration.pipe(
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
)
