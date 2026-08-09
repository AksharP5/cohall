import { exchangePairing } from "@cohall/client"
import { type Provider as ProviderName } from "@cohall/protocol"
import { Effect } from "effect"
import { hostname } from "node:os"
import { Writable } from "node:stream"
import { createInterface } from "node:readline/promises"
import {
  StoredConfiguration,
  credentialsForRelay,
  makeStoredConfiguration,
  normalizeRelayUrl,
  readStoredConfiguration,
  writeStoredConfiguration,
} from "./config.ts"

export interface JoinOptions {
  readonly relayUrl: string
  readonly token: string
  readonly clientOnly: boolean
  readonly deviceName?: string
  readonly workspaces?: ReadonlyArray<string>
  readonly providers?: ReadonlyArray<ProviderName> | "auto"
}

export interface JoinResult {
  readonly configuration: StoredConfiguration
  readonly roles: ReadonlyArray<"client" | "device">
}

export const joinRelay = async (options: JoinOptions): Promise<JoinResult> => {
  const draft = await makeStoredConfiguration({
    relayUrl: options.relayUrl,
    ...(options.deviceName === undefined ? {} : { deviceName: options.deviceName }),
    ...(options.workspaces === undefined ? {} : { workspaces: options.workspaces }),
    ...(options.providers === undefined ? {} : { providers: options.providers }),
  })
  if (!options.clientOnly && draft.workspaces.length === 0) {
    throw new Error("At least one workspace is required when joining a device")
  }

  const paired = await Effect.runPromise(exchangePairing(draft.relayUrl, { token: options.token }))
  const clientToken = paired.credentials.find(
    (credential) => credential.session.role === "client",
  )?.token
  const deviceCredential = paired.credentials.find(
    (credential) => credential.session.role === "device",
  )
  if (options.clientOnly && clientToken === undefined) {
    throw new Error("The pairing credential did not include client access")
  }
  if (!options.clientOnly && deviceCredential === undefined) {
    throw new Error("The pairing credential did not include device access")
  }

  const {
    clientToken: _retainedClientToken,
    deviceToken: _retainedDeviceToken,
    ...configurationDraft
  } = draft
  const configuration = StoredConfiguration.make({
    ...configurationDraft,
    deviceId: options.clientOnly
      ? configurationDraft.deviceId
      : (deviceCredential?.session.deviceId ?? configurationDraft.deviceId),
    ...(clientToken === undefined ? {} : { clientToken }),
    ...(options.clientOnly || deviceCredential === undefined
      ? {}
      : { deviceToken: deviceCredential.token }),
  })
  await writeStoredConfiguration(configuration)
  return {
    configuration,
    roles: options.clientOnly
      ? paired.credentials
          .map((credential) => credential.session.role)
          .filter((role) => role === "client")
      : paired.credentials.map((credential) => credential.session.role),
  }
}

export interface Prompter {
  readonly answer: (label: string, fallback: string) => Promise<string>
  readonly secret: (label: string) => Promise<string>
  readonly close: () => void
}

export const terminalPrompter = (): Prompter => {
  let muted = false
  const output = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      if (!muted) {
        process.stderr.write(chunk)
      }
      callback()
    },
  })
  const terminal = createInterface({ input: process.stdin, output, terminal: true })
  return {
    answer: async (label, fallback) => {
      const value = (await terminal.question(`${label} [${fallback}]: `)).trim()
      return value || fallback
    },
    secret: async (label) => {
      const pending = terminal.question(`${label}: `)
      muted = true
      try {
        return (await pending).trim()
      } finally {
        muted = false
        process.stderr.write("\n")
      }
    },
    close: () => terminal.close(),
  }
}

export interface GuidedSetupOptions {
  readonly relayUrl?: string
  readonly token?: string
  readonly clientOnly: boolean
  readonly deviceName?: string
  readonly workspaces: ReadonlyArray<string>
  readonly providers?: string
  readonly cwd: string
}

export interface GuidedSetupInput {
  readonly relayUrl: string
  readonly token?: string
  readonly deviceName?: string
  readonly workspaces: ReadonlyArray<string>
  readonly providers: string
  readonly reusedConfiguration: boolean
}

export const guidedSetupInput = async (
  options: GuidedSetupOptions,
  prompter: Prompter,
): Promise<GuidedSetupInput> => {
  const existing = await readStoredConfiguration()
  const relayUrl = normalizeRelayUrl(
    options.relayUrl ??
      (await prompter.answer("Relay URL", existing?.relayUrl ?? "http://127.0.0.1:8787")),
  )
  const credentials = credentialsForRelay(existing, relayUrl)
  const hasRequiredCredentials =
    credentials.clientToken !== undefined &&
    (options.clientOnly || credentials.deviceToken !== undefined)
  const workspaces = options.clientOnly
    ? (existing?.workspaces ?? [])
    : options.workspaces.length > 0
      ? options.workspaces
      : [await prompter.answer("Workspace root", existing?.workspaces[0] ?? options.cwd)]
  const deviceName = options.clientOnly
    ? undefined
    : (options.deviceName ??
      (await prompter.answer("Device name", existing?.deviceName ?? hostname())))
  const providers =
    options.providers ??
    (options.clientOnly
      ? "auto"
      : await prompter.answer("Providers", existing?.providers?.join(",") ?? "auto"))
  const token =
    options.token ?? (hasRequiredCredentials ? undefined : await prompter.secret("Pairing token"))
  if (!hasRequiredCredentials && (token === undefined || token.length === 0)) {
    throw new Error("A pairing token is required")
  }
  if (token !== undefined && new TextEncoder().encode(token).byteLength > 256) {
    throw new Error("Pairing token exceeds 256 bytes")
  }
  return {
    relayUrl,
    ...(token === undefined ? {} : { token }),
    ...(deviceName === undefined ? {} : { deviceName }),
    workspaces,
    providers,
    reusedConfiguration: hasRequiredCredentials && token === undefined,
  }
}
