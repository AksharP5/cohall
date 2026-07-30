import { DeviceId, makeDeviceId } from "@cohall/protocol"
import { Config, ConfigProvider, Effect, Redacted, Schema } from "effect"
import { mkdir } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { dirname, resolve } from "node:path"

export const DeviceConfiguration = Schema.Struct({
  relayUrl: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
  id: DeviceId,
  name: Schema.NonEmptyString,
  workspaces: Schema.Array(Schema.NonEmptyString),
  model: Schema.optionalKey(Schema.NonEmptyString),
  sandbox: Schema.optionalKey(
    Schema.Literals(["read-only", "workspace-write", "danger-full-access"]),
  ),
  mcpThreadId: Schema.optionalKey(Schema.String),
})
export interface DeviceConfiguration extends Schema.Schema.Type<typeof DeviceConfiguration> {}

const persistentId = (path: string): Effect.Effect<DeviceId, Error> =>
  Effect.tryPromise({
    try: async () => {
      const file = Bun.file(path)
      if (await file.exists()) {
        return DeviceId.make((await file.text()).trim())
      }
      const id = makeDeviceId()
      await mkdir(dirname(resolve(path)), { recursive: true })
      await Bun.write(path, id)
      return id
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })

const localToken = (path: string): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: async () => {
      const file = Bun.file(path)
      if (!(await file.exists())) {
        throw new Error(`COHALL_TOKEN is not set and no local relay token exists at ${path}`)
      }
      return (await file.text()).trim()
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })

const load = Effect.gen(function* () {
  const relayUrl = yield* Config.string("COHALL_RELAY_URL").pipe(
    Config.withDefault("http://127.0.0.1:8787"),
  )
  const configuredToken = yield* Config.option(Config.redacted("COHALL_TOKEN"))
  const dataDirectory = yield* Config.string("COHALL_DATA_DIR").pipe(Config.withDefault(".cohall"))
  const token =
    configuredToken._tag === "Some"
      ? Redacted.value(configuredToken.value)
      : yield* localToken(`${dataDirectory.replace(/\/+$/, "")}/token`)
  const explicitId = yield* Config.option(Config.string("COHALL_DEVICE_ID"))
  const statePath = yield* Config.string("COHALL_DEVICE_STATE").pipe(
    Config.withDefault(`${homedir()}/.local/state/cohall/device-id`),
  )
  const name = yield* Config.string("COHALL_DEVICE_NAME").pipe(Config.withDefault(hostname()))
  const workspaceList = yield* Config.string("COHALL_DEVICE_WORKSPACES").pipe(
    Config.withDefault(process.cwd()),
  )
  const model = yield* Config.option(Config.string("COHALL_CODEX_MODEL"))
  const sandbox = yield* Config.option(
    Config.schema(
      Schema.Literals(["read-only", "workspace-write", "danger-full-access"]),
      "COHALL_CODEX_SANDBOX",
    ),
  )
  const mcpThreadId = yield* Config.option(Config.string("COHALL_THREAD_ID"))
  const id =
    explicitId._tag === "Some" ? DeviceId.make(explicitId.value) : yield* persistentId(statePath)

  return DeviceConfiguration.make({
    relayUrl: relayUrl.replace(/\/+$/, ""),
    token,
    id,
    name,
    workspaces: workspaceList
      .split(",")
      .map((workspace) => resolve(workspace.trim()))
      .filter((workspace) => workspace.length > 0),
    ...(model._tag === "None" ? {} : { model: model.value }),
    ...(sandbox._tag === "None" ? {} : { sandbox: sandbox.value }),
    ...(mcpThreadId._tag === "None" ? {} : { mcpThreadId: mcpThreadId.value }),
  })
})

export const loadConfiguration = load.pipe(
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
)
