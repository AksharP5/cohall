import { RelayClient } from "@cohall/client"
import { SocketEvent, Timestamp, version } from "@cohall/protocol"
import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite"
import { WebSocket } from "ws"
import {
  StoredConfiguration,
  normalizeRelayUrl,
  readStoredConfiguration,
  relayDataDirectory,
  writeStoredConfiguration,
} from "./config.ts"
import { restartDeviceService, type DeviceServiceRestart } from "./service.ts"

const sha256 = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/, { expected: "a lowercase SHA-256 digest" }),
)

const RelayBackupManifest = Schema.Struct({
  formatVersion: Schema.Literal(1),
  cohallVersion: Schema.NonEmptyString,
  createdAt: Timestamp,
  databaseSha256: sha256,
  ownerTokenSha256: sha256,
})
interface RelayBackupManifest extends Schema.Schema.Type<typeof RelayBackupManifest> {}

const exists = (path: string): Promise<boolean> =>
  access(path)
    .then(() => true)
    .catch(() => false)

const digest = async (path: string): Promise<string> => {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return hash.digest("hex")
}

const verifyBackupMember = async (path: string, maximumBytes?: number): Promise<void> => {
  const metadata = await lstat(path)
  if (!metadata.isFile()) {
    throw new Error(`Relay backup member must be a regular file: ${path}`)
  }
  if (maximumBytes !== undefined && metadata.size > maximumBytes) {
    throw new Error(`Relay backup member exceeds ${maximumBytes} bytes: ${path}`)
  }
}

const readManifest = async (path: string): Promise<RelayBackupManifest> => {
  await verifyBackupMember(path, 16_384)
  return Schema.decodeUnknownSync(RelayBackupManifest)(JSON.parse(await readFile(path, "utf8")))
}

const verifyBackupDestinationParent = async (path: string): Promise<void> => {
  if (process.platform === "win32") {
    return
  }
  for (let current = await realpath(path); ; current = dirname(current)) {
    const metadata = await stat(current)
    const writableByOthers = (metadata.mode & 0o022) !== 0
    const sticky = (metadata.mode & 0o1000) !== 0
    if (writableByOthers && !sticky) {
      throw new Error(
        `Backup destination ancestors must not be group- or world-writable unless they use the sticky bit: ${current}`,
      )
    }
    const parent = dirname(current)
    if (parent === current) {
      return
    }
  }
}

const ownerToken = async (dataDirectory: string): Promise<string> => {
  const path = join(dataDirectory, "owner-token")
  const configured = process.env.COHALL_TOKEN
  if (configured !== undefined) {
    return configured
  }
  if (!(await exists(path))) {
    throw new Error(`Relay owner token was not found at ${path}`)
  }
  if ((await stat(path)).size > 512) {
    throw new Error("Relay owner token file exceeds 512 bytes")
  }
  return (await readFile(path, "utf8")).trim()
}

const verifyDatabase = (path: string): void => {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const result = database.prepare("PRAGMA quick_check").get()
    if (result === undefined || Object.values(result)[0] !== "ok") {
      throw new Error(`SQLite integrity check failed for ${path}`)
    }
  } finally {
    database.close()
  }
}

export interface RelayBackupResult {
  readonly backup_directory: string
  readonly database: string
  readonly created_at: Timestamp
  readonly warning: string
}

export const backupRelay = async (destinationInput: string): Promise<RelayBackupResult> => {
  const sourceDirectory = relayDataDirectory()
  const sourceDatabase = join(sourceDirectory, "cohall.db")
  if (!(await exists(sourceDatabase))) {
    throw new Error(`Relay database was not found at ${sourceDatabase}`)
  }
  const destination = resolve(destinationInput)
  if (await exists(destination)) {
    throw new Error(`Backup destination already exists: ${destination}`)
  }
  await verifyBackupDestinationParent(dirname(destination))
  await mkdir(destination, { mode: 0o700 })
  try {
    const databasePath = join(destination, "cohall.db")
    const ownerTokenPath = join(destination, "owner-token")
    const database = new DatabaseSync(sourceDatabase, { readOnly: true })
    try {
      await sqliteBackup(database, databasePath)
    } finally {
      database.close()
    }
    verifyDatabase(databasePath)
    const token = await ownerToken(sourceDirectory)
    if (token.length < 32 || new TextEncoder().encode(token).byteLength > 512) {
      throw new Error("The relay owner token must contain between 32 and 512 bytes")
    }
    await writeFile(ownerTokenPath, `${token}\n`, { mode: 0o600 })
    await Promise.all([chmod(databasePath, 0o600), chmod(ownerTokenPath, 0o600)])
    const createdAt = Timestamp.make(new Date().toISOString())
    const manifest = RelayBackupManifest.make({
      formatVersion: 1,
      cohallVersion: version,
      createdAt,
      databaseSha256: await digest(databasePath),
      ownerTokenSha256: await digest(ownerTokenPath),
    })
    await writeFile(join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    })
    return {
      backup_directory: destination,
      database: databasePath,
      created_at: createdAt,
      warning:
        "This backup contains relay credentials and task history. Transfer and store it privately.",
    }
  } catch (cause) {
    await rm(destination, { recursive: true, force: true })
    throw cause
  }
}

export interface RelayRestoreResult {
  readonly restored: true
  readonly data_directory: string
  readonly backup_version: string
  readonly next: string
}

export const restoreRelay = async (sourceInput: string): Promise<RelayRestoreResult> => {
  const source = resolve(sourceInput)
  const sourceDatabase = join(source, "cohall.db")
  const sourceOwnerToken = join(source, "owner-token")
  const sourceManifest = join(source, "manifest.json")
  for (const path of [sourceDatabase, sourceOwnerToken, sourceManifest]) {
    if (!(await exists(path))) {
      throw new Error(`Relay backup is missing ${basename(path)}`)
    }
  }
  await Promise.all([
    verifyBackupMember(sourceDatabase),
    verifyBackupMember(sourceOwnerToken, 1_024),
    verifyBackupMember(sourceManifest, 16_384),
  ])

  const target = relayDataDirectory()
  if (await exists(target)) {
    throw new Error(
      `Relay data directory already exists: ${target}. Restore into a new COHALL_DATA_DIR.`,
    )
  }
  const parent = dirname(target)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(parent, `.${basename(target)}.restore-`))
  let backupVersion = ""
  try {
    await chmod(staging, 0o700)
    const databasePath = join(staging, "cohall.db")
    const ownerTokenPath = join(staging, "owner-token")
    const manifestPath = join(staging, "migration-manifest.json")
    await Promise.all([
      copyFile(sourceDatabase, databasePath),
      copyFile(sourceOwnerToken, ownerTokenPath),
      copyFile(sourceManifest, manifestPath),
    ])
    await Promise.all([
      chmod(databasePath, 0o600),
      chmod(ownerTokenPath, 0o600),
      chmod(manifestPath, 0o600),
    ])
    const manifest = await readManifest(manifestPath)
    if (
      (await digest(databasePath)) !== manifest.databaseSha256 ||
      (await digest(ownerTokenPath)) !== manifest.ownerTokenSha256
    ) {
      throw new Error("Relay backup checksum verification failed")
    }
    verifyDatabase(databasePath)
    const token = (await readFile(ownerTokenPath, "utf8")).trim()
    if (token.length < 32 || new TextEncoder().encode(token).byteLength > 512) {
      throw new Error("Relay backup contains an invalid owner token")
    }
    backupVersion = manifest.cohallVersion
    await rename(staging, target)
  } catch (cause) {
    await rm(staging, { recursive: true, force: true })
    throw cause
  }
  return {
    restored: true,
    data_directory: target,
    backup_version: backupVersion,
    next: "Start the relay at its new address, then run `cohall relay use <new-url>` on each client and device.",
  }
}

const websocketUrl = (relayUrl: string): string => {
  const url = new URL(relayUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = "/ws/device"
  return url.toString()
}

const isLoopback = (url: URL): boolean =>
  url.hostname === "localhost" ||
  url.hostname === "[::1]" ||
  /^127(?:\.\d{1,3}){3}$/.test(url.hostname)

const verifyClientCredential = async (relayUrl: string, token: string): Promise<void> => {
  await Effect.runPromise(RelayClient.make({ baseUrl: relayUrl, token }).devices())
}

const verifyDeviceCredential = (relayUrl: string, token: string): Promise<void> =>
  new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(websocketUrl(relayUrl), {
      handshakeTimeout: 10_000,
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
    })
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      socket.terminate()
      if (error === undefined) {
        resolvePromise()
        return
      }
      reject(error)
    }
    const timeout = setTimeout(
      () => finish(new Error("Timed out while verifying the device credential")),
      10_000,
    )
    socket.once("open", () => {
      socket.send(JSON.stringify(SocketEvent.make({ _tag: "Authenticate", token })))
    })
    socket.on("message", (data) => {
      try {
        const event = Schema.decodeUnknownSync(SocketEvent)(JSON.parse(data.toString()) as unknown)
        if (event._tag === "Connected") {
          finish()
        } else if (event._tag === "Error") {
          finish(new Error(event.message))
        }
      } catch (cause) {
        finish(new Error(`New relay returned an invalid device response: ${String(cause)}`))
      }
    })
    socket.once("error", (cause) => finish(cause))
    socket.once("close", () => finish(new Error("New relay rejected the stored device credential")))
  })

export interface RelaySwitchResult {
  readonly updated: boolean
  readonly relay_url: string
  readonly verified_roles: ReadonlyArray<"client" | "device">
  readonly service: DeviceServiceRestart
  readonly warning?: string
}

export const switchRelay = async (options: {
  readonly relayUrl: string
  readonly restart: boolean
  readonly allowHttp?: boolean
  readonly verifyClient?: (relayUrl: string, token: string) => Promise<void>
  readonly verifyDevice?: (relayUrl: string, token: string) => Promise<void>
  readonly restartService?: () => Promise<DeviceServiceRestart>
}): Promise<RelaySwitchResult> => {
  if (process.env.COHALL_RELAY_URL !== undefined) {
    throw new Error("Unset COHALL_RELAY_URL before changing the stored relay URL")
  }
  const configuration = await readStoredConfiguration()
  if (configuration === undefined) {
    throw new Error("This user has no stored Cohall configuration")
  }
  const relayUrl = normalizeRelayUrl(options.relayUrl)
  const parsedRelayUrl = new URL(relayUrl)
  if (
    parsedRelayUrl.protocol === "http:" &&
    !isLoopback(parsedRelayUrl) &&
    options.allowHttp !== true
  ) {
    throw new Error(
      "Refusing to send stored credentials over remote HTTP. Use HTTPS, or --allow-http only on an independently encrypted private network.",
    )
  }
  const clientTokens = [configuration.clientToken, process.env.COHALL_CLIENT_TOKEN].filter(
    (token): token is string => token !== undefined,
  )
  const deviceTokens = [configuration.deviceToken, process.env.COHALL_DEVICE_TOKEN].filter(
    (token): token is string => token !== undefined,
  )
  if (clientTokens.length === 0 && deviceTokens.length === 0) {
    throw new Error("This configuration has no client or device credentials to verify")
  }
  const roles: Array<"client" | "device"> = []
  if (clientTokens.length > 0) {
    for (const token of new Set(clientTokens)) {
      await (options.verifyClient ?? verifyClientCredential)(relayUrl, token)
    }
    roles.push("client")
  }
  if (deviceTokens.length > 0) {
    for (const token of new Set(deviceTokens)) {
      await (options.verifyDevice ?? verifyDeviceCredential)(relayUrl, token)
    }
    roles.push("device")
  }
  const updated = configuration.relayUrl !== relayUrl
  if (updated) {
    await writeStoredConfiguration(StoredConfiguration.make({ ...configuration, relayUrl }))
  }
  let service: DeviceServiceRestart = { running: false, restarted: false }
  let warning: string | undefined
  if (updated && options.restart && deviceTokens.length > 0) {
    service = await (options.restartService ?? restartDeviceService)().catch((cause: unknown) => {
      warning = `Relay URL changed, but the device service could not restart: ${cause instanceof Error ? cause.message : String(cause)}`
      return { running: true, restarted: false }
    })
  }
  return {
    updated,
    relay_url: relayUrl,
    verified_roles: roles,
    service,
    ...(warning === undefined ? {} : { warning }),
  }
}
