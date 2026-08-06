import { Schema } from "effect"
import { execFile, type ExecFileException } from "node:child_process"
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { platform as operatingSystem } from "node:os"
import { configurationPath } from "./config.ts"

const packageName = "@akshar5/cohall"
const semanticVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export const PackageManager = Schema.Literals(["npm", "bun", "pnpm"])
export type PackageManager = typeof PackageManager.Type
export type ServiceManager = "launchd" | "scheduled-task" | "systemd-system" | "systemd-user"

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly error?: string
}

export interface CommandRunner {
  readonly run: (
    command: string,
    arguments_: ReadonlyArray<string>,
    timeoutMs?: number,
  ) => Promise<CommandResult>
}

export interface PackageInstallation {
  readonly manager: PackageManager
  readonly prefix?: string
  readonly entrypoint: string
}

export interface ManagedService {
  readonly id: string
  readonly label: string
  readonly manager: ServiceManager
  readonly device: boolean
  readonly check: CommandInvocation
  readonly activeOutput?: RegExp
  readonly restart: ReadonlyArray<CommandInvocation>
}

export interface CommandInvocation {
  readonly command: string
  readonly arguments: ReadonlyArray<string>
  readonly allowFailure?: boolean
}

const RestartReceipt = Schema.Struct({
  version: Schema.String,
  fromVersion: Schema.String,
  packageManager: PackageManager,
  pendingServices: Schema.Array(Schema.String),
  restartedServices: Schema.Array(Schema.String),
})
interface RestartReceipt extends Schema.Schema.Type<typeof RestartReceipt> {}

export interface UpgradeOptions {
  readonly currentVersion: string
  readonly target?: string
  readonly restart: boolean
  readonly dryRun: boolean
  readonly entrypoint?: string
  readonly platform?: NodeJS.Platform
  readonly uid?: number
  readonly statePath?: string
  readonly delegated?: boolean
  readonly runner?: CommandRunner
}

export interface UpgradeResult {
  readonly upgraded: boolean
  readonly from_version: string
  readonly installed_version: string
  readonly requested_version: string
  readonly package_manager: PackageManager
  readonly services_restarted: ReadonlyArray<string>
  readonly services_pending_restart: ReadonlyArray<string>
  readonly resumed_after_restart: boolean
  readonly dry_run: boolean
}

const normalizePath = (path: string): string => path.replaceAll("\\", "/")

export const normalizeUpgradeTarget = (target: string | undefined): string => {
  if (target === undefined || target === "latest") {
    return "latest"
  }
  const normalized = target.startsWith("v") ? target.slice(1) : target
  if (!semanticVersion.test(normalized)) {
    throw new Error("--to must be latest or an exact semantic version")
  }
  return normalized
}

export const packageInstallation = (
  canonicalEntrypoint: string,
  entrypoint = canonicalEntrypoint,
): PackageInstallation => {
  const path = normalizePath(canonicalEntrypoint)
  const marker = `/node_modules/${packageName}/`
  const packageIndex = path.lastIndexOf(marker)
  if (packageIndex === -1) {
    throw new Error(
      "cohall upgrade requires a global npm, Bun, or pnpm installation; package-runner and source-checkout executions cannot upgrade themselves",
    )
  }
  if (
    path.includes("/.npm/_npx/") ||
    path.includes("/.bunx/") ||
    path.includes("/pnpm/dlx/") ||
    path.includes("/dlx/")
  ) {
    throw new Error(
      "This Cohall process is running from a temporary package-runner cache; install it globally before using cohall upgrade",
    )
  }
  if (path.includes("/.bun/install/global/node_modules/")) {
    return { manager: "bun", entrypoint }
  }
  if (path.includes("/pnpm/global/") || path.includes("/.pnpm/")) {
    return { manager: "pnpm", entrypoint }
  }

  const nodeModulesParent = path.slice(0, packageIndex)
  const prefix = nodeModulesParent.endsWith("/lib")
    ? nodeModulesParent.slice(0, -"/lib".length)
    : nodeModulesParent
  return { manager: "npm", prefix, entrypoint }
}

export const packageInstallCommand = (
  installation: PackageInstallation,
  target: string,
): CommandInvocation => {
  const specification = `${packageName}@${target}`
  switch (installation.manager) {
    case "bun":
      return { command: "bun", arguments: ["add", "--global", specification] }
    case "pnpm":
      return { command: "pnpm", arguments: ["add", "--global", specification] }
    case "npm":
      return {
        command: "npm",
        arguments: [
          "install",
          "--global",
          ...(installation.prefix === undefined ? [] : ["--prefix", installation.prefix]),
          specification,
        ],
      }
  }
}

export const serviceCandidates = (
  runtimePlatform: NodeJS.Platform,
  uid: number | undefined,
): ReadonlyArray<ManagedService> => {
  if (runtimePlatform === "linux") {
    const systemd = (
      manager: "systemd-user" | "systemd-system",
      unit: string,
      device: boolean,
    ): ManagedService => {
      const user = manager === "systemd-user" ? ["--user"] : []
      return {
        id: `${manager}:${unit}`,
        label: unit,
        manager,
        device,
        check: { command: "systemctl", arguments: [...user, "is-active", "--quiet", unit] },
        restart: [{ command: "systemctl", arguments: [...user, "restart", unit] }],
      }
    }
    return [
      systemd("systemd-user", "cohall-relay.service", false),
      systemd("systemd-system", "cohall-relay.service", false),
      systemd("systemd-user", "cohall-device.service", true),
    ]
  }

  if (runtimePlatform === "darwin") {
    const domain = `gui/${uid ?? 0}`
    const launchd = (label: string, device: boolean): ManagedService => ({
      id: `launchd:${label}`,
      label,
      manager: "launchd",
      device,
      check: { command: "launchctl", arguments: ["print", `${domain}/${label}`] },
      activeOutput: /\bstate\s*=\s*running\b/,
      restart: [{ command: "launchctl", arguments: ["kickstart", "-k", `${domain}/${label}`] }],
    })
    return [launchd("com.cohall.relay", false), launchd("com.cohall.device", true)]
  }

  if (runtimePlatform === "win32") {
    return [
      {
        id: "scheduled-task:Cohall Device",
        label: "Cohall Device",
        manager: "scheduled-task",
        device: true,
        check: {
          command: "powershell.exe",
          arguments: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "if ((Get-ScheduledTask -TaskName 'Cohall Device' -ErrorAction SilentlyContinue).State -eq 'Running') { exit 0 } else { exit 1 }",
          ],
        },
        restart: [
          {
            command: "schtasks",
            arguments: ["/End", "/TN", "Cohall Device"],
            allowFailure: true,
          },
          { command: "schtasks", arguments: ["/Run", "/TN", "Cohall Device"] },
        ],
      },
    ]
  }

  return []
}

const defaultRunner: CommandRunner = {
  run: (command, arguments_, timeoutMs = 300_000) =>
    new Promise((resolve) => {
      execFile(
        command,
        [...arguments_],
        { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: timeoutMs, windowsHide: true },
        (error: ExecFileException | null, stdout, stderr) => {
          resolve({
            exitCode: typeof error?.code === "number" ? error.code : error === null ? 0 : 1,
            stdout,
            stderr,
            ...(error === null ? {} : { error: error.message }),
          })
        },
      )
    }),
}

const checked = async (
  runner: CommandRunner,
  invocation: CommandInvocation,
  timeoutMs?: number,
): Promise<CommandResult> => {
  const result = await runner.run(invocation.command, invocation.arguments, timeoutMs)
  if (result.exitCode === 0 || invocation.allowFailure === true) {
    return result
  }
  const detail = (
    result.stderr.trim() ||
    result.stdout.trim() ||
    result.error ||
    "unknown error"
  ).slice(0, 16_384)
  throw new Error(
    `${invocation.command} ${invocation.arguments.join(" ")} failed with status ${result.exitCode}: ${detail}`,
  )
}

const activeServices = async (
  runner: CommandRunner,
  candidates: ReadonlyArray<ManagedService>,
): Promise<ReadonlyArray<ManagedService>> => {
  const active: Array<ManagedService> = []
  for (const service of candidates) {
    const result = await runner.run(service.check.command, service.check.arguments, 10_000)
    if (
      result.exitCode === 0 &&
      (service.activeOutput === undefined ||
        service.activeOutput.test(`${result.stdout}\n${result.stderr}`))
    ) {
      active.push(service)
    }
  }
  return active
}

const readReceipt = async (path: string): Promise<RestartReceipt | undefined> =>
  readFile(path, "utf8")
    .then((content) => Schema.decodeUnknownOption(RestartReceipt)(JSON.parse(content)))
    .then((decoded) => (decoded._tag === "Some" ? decoded.value : undefined))
    .catch(() => undefined)

const writeReceipt = async (path: string, value: RestartReceipt): Promise<void> => {
  const directory = dirname(path)
  const temporary = `${path}.${process.pid}.tmp`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (operatingSystem() !== "win32") {
    await chmod(directory, 0o700)
  }
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

const installedVersion = async (entrypoint: string): Promise<string> => {
  const canonicalEntrypoint = await realpath(entrypoint)
  const metadata: unknown = JSON.parse(
    await readFile(join(dirname(dirname(canonicalEntrypoint)), "package.json"), "utf8"),
  )
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("name" in metadata) ||
    metadata.name !== packageName ||
    !("version" in metadata) ||
    typeof metadata.version !== "string"
  ) {
    throw new Error(`Could not verify the installed ${packageName} version`)
  }
  return metadata.version
}

const restartReceiptPath = (): string => join(dirname(configurationPath()), "upgrade-restart.json")

const restartServices = async (
  runner: CommandRunner,
  services: ReadonlyArray<ManagedService>,
  statePath: string,
  state: RestartReceipt,
): Promise<RestartReceipt> => {
  let current = state
  for (const service of services) {
    for (const invocation of service.restart) {
      await checked(runner, invocation, 60_000)
    }
    current = {
      ...current,
      pendingServices: current.pendingServices.filter((id) => id !== service.id),
      restartedServices: [...current.restartedServices, service.id],
    }
    await writeReceipt(statePath, current)
  }
  return current
}

export const upgrade = async (options: UpgradeOptions): Promise<UpgradeResult> => {
  const runner = options.runner ?? defaultRunner
  const runtimePlatform = options.platform ?? process.platform
  const uid = options.uid ?? process.getuid?.()
  const candidates = serviceCandidates(runtimePlatform, uid)
  const statePath = options.statePath ?? restartReceiptPath()
  const previous = await readReceipt(statePath)

  if (previous?.version === options.currentVersion) {
    const byId = new Map(candidates.map((service) => [service.id, service]))
    const pending = previous.pendingServices.flatMap((id) => {
      const service = byId.get(id)
      return service === undefined ? [] : [service]
    })
    const active = await activeServices(runner, pending)
    if (options.dryRun || !options.restart) {
      return {
        upgraded: previous.fromVersion !== previous.version,
        from_version: previous.fromVersion,
        installed_version: previous.version,
        requested_version: previous.version,
        package_manager: previous.packageManager,
        services_restarted: previous.restartedServices,
        services_pending_restart: active.map((service) => service.id),
        resumed_after_restart: false,
        dry_run: options.dryRun,
      }
    }
    const activeIds = new Set(active.map((service) => service.id))
    const completedByRestart =
      options.delegated === true
        ? pending.filter((service) => service.device && activeIds.has(service.id))
        : []
    const completedIds = new Set(completedByRestart.map((service) => service.id))
    const remaining = active.filter((service) => !completedIds.has(service.id))
    let resumed: RestartReceipt = {
      ...previous,
      pendingServices: previous.pendingServices.filter((id) => !completedIds.has(id)),
      restartedServices: [
        ...previous.restartedServices,
        ...completedByRestart.map((service) => service.id),
      ],
    }
    if (remaining.length > 0) {
      await writeReceipt(statePath, resumed)
      resumed = await restartServices(runner, remaining, statePath, resumed)
    }
    await rm(statePath, { force: true })
    return {
      upgraded: previous.fromVersion !== previous.version,
      from_version: previous.fromVersion,
      installed_version: previous.version,
      requested_version: previous.version,
      package_manager: previous.packageManager,
      services_restarted: resumed.restartedServices,
      services_pending_restart: [],
      resumed_after_restart: true,
      dry_run: false,
    }
  }

  await rm(statePath, { force: true })

  const target = normalizeUpgradeTarget(options.target)
  const entrypoint = options.entrypoint ?? process.argv[1]
  if (entrypoint === undefined) {
    throw new Error("Could not resolve the Cohall executable path")
  }
  const installation = packageInstallation(await realpath(entrypoint), entrypoint)
  const install = packageInstallCommand(installation, target)
  const services = await activeServices(runner, candidates)

  if (options.dryRun) {
    return {
      upgraded: false,
      from_version: options.currentVersion,
      installed_version: options.currentVersion,
      requested_version: target,
      package_manager: installation.manager,
      services_restarted: [],
      services_pending_restart: options.restart ? services.map((service) => service.id) : [],
      resumed_after_restart: false,
      dry_run: true,
    }
  }

  await checked(runner, install)
  const nextVersion = await installedVersion(entrypoint)
  if (target !== "latest" && nextVersion !== target) {
    throw new Error(`Installed Cohall ${nextVersion}, expected ${target}`)
  }
  const upgraded = nextVersion !== options.currentVersion

  if (!upgraded || !options.restart || services.length === 0) {
    return {
      upgraded,
      from_version: options.currentVersion,
      installed_version: nextVersion,
      requested_version: target,
      package_manager: installation.manager,
      services_restarted: [],
      services_pending_restart:
        upgraded && !options.restart ? services.map((service) => service.id) : [],
      resumed_after_restart: false,
      dry_run: false,
    }
  }

  const initial: RestartReceipt = {
    version: nextVersion,
    fromVersion: options.currentVersion,
    packageManager: installation.manager,
    pendingServices: services.map((service) => service.id),
    restartedServices: [],
  }
  await writeReceipt(statePath, initial)
  const completed = await restartServices(runner, services, statePath, initial)
  await rm(statePath, { force: true })
  return {
    upgraded: true,
    from_version: options.currentVersion,
    installed_version: nextVersion,
    requested_version: target,
    package_manager: installation.manager,
    services_restarted: completed.restartedServices,
    services_pending_restart: [],
    resumed_after_restart: false,
    dry_run: false,
  }
}
