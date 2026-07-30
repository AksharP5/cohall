import { Config, ConfigProvider, Effect, Redacted, Schema } from "effect"

export const RelayConfiguration = Schema.Struct({
  host: Schema.NonEmptyString,
  port: Schema.Int,
  token: Schema.NonEmptyString,
  databasePath: Schema.NonEmptyString,
  webDirectory: Schema.NonEmptyString,
})
export interface RelayConfiguration extends Schema.Schema.Type<typeof RelayConfiguration> {}

export const loadConfiguration = Effect.gen(function* () {
  const host = yield* Config.string("COHALL_RELAY_HOST").pipe(Config.withDefault("127.0.0.1"))
  const port = yield* Config.int("COHALL_RELAY_PORT").pipe(Config.withDefault(8787))
  const token = yield* Config.redacted("COHALL_TOKEN").pipe(
    Config.withDefault(Redacted.make("cohall-local-dev")),
  )
  const dataDirectory = yield* Config.string("COHALL_DATA_DIR").pipe(Config.withDefault(".cohall"))
  const webDirectory = yield* Config.string("COHALL_WEB_DIR").pipe(
    Config.withDefault("apps/web/dist"),
  )

  return RelayConfiguration.make({
    host,
    port,
    token: Redacted.value(token),
    databasePath: `${dataDirectory.replace(/\/+$/, "")}/cohall.db`,
    webDirectory,
  })
})

export const loadEnvironmentConfiguration = loadConfiguration.pipe(
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
)
