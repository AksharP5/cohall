import { Schema } from "effect"
import { execa } from "execa"
import { constants } from "node:fs"
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { platform as operatingSystem } from "node:os"
import { configurationPath } from "./config.ts"

const packageName = "@akshar5/cohall"
const minimumBunLookupVersion = "1.2.15"
const semanticVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

const parseVersion = (value: string) => {
  const [, major, minor, patch, prerelease] = semanticVersion.exec(value) ?? []
  if (major === undefined || minor === undefined || patch === undefined) return undefined
  const identifiers = prerelease?.split(".") ?? []
  if (identifiers.some((part) => /^0\d+$/.test(part))) return undefined
  return {
    core: [BigInt(major), BigInt(minor), BigInt(patch)],
    prerelease: identifiers,
  }
}

const compareVersions = (left: string, right: string): number => {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) {
    throw new Error(`Could not safely compare Cohall versions ${left} and ${right}`)
  }
  for (const [index, part] of a.core.entries()) {
    const other = b.core[index]
    if (other !== undefined && part !== other) return part > other ? 1 : -1
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Number(b.prerelease.length > 0) - Number(a.prerelease.length > 0)
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const part = a.prerelease[index]
    const other = b.prerelease[index]
    if (part === undefined) return -1
    if (other === undefined) return 1
    if (part === other) continue
    const numeric = /^\d+$/.test(part)
    const otherNumeric = /^\d+$/.test(other)
    if (numeric !== otherNumeric) return numeric ? -1 : 1
    return numeric ? (BigInt(part) > BigInt(other) ? 1 : -1) : part > other ? 1 : -1
  }
  return 0
}

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
    environment?: Readonly<Record<string, string>>,
  ) => Promise<CommandResult>
}

export interface PackageInstallation {
  readonly manager: PackageManager
  readonly prefix?: string
  readonly globalDir?: string
  readonly entrypoint: string
}

export interface ManagedService {
  readonly id: string
  readonly label: string
  readonly manager: ServiceManager
  readonly device: boolean
  readonly check: CommandInvocation
  readonly activeOutput?: RegExp
  readonly entrypoint?: {
    readonly inspect: CommandInvocation
    readonly parse: (output: string) => string | undefined
  }
  readonly restart: ReadonlyArray<CommandInvocation>
}

export interface CommandInvocation {
  readonly command: string
  readonly arguments: ReadonlyArray<string>
  readonly allowFailure?: boolean
  readonly environment?: Readonly<Record<string, string>>
}

const RestartReceipt = Schema.Struct({
  version: Schema.String,
  fromVersion: Schema.String,
  packageManager: PackageManager,
  pendingServices: Schema.Array(Schema.String),
  restartedServices: Schema.Array(Schema.String),
  restartingService: Schema.optionalKey(Schema.String),
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
  readonly resolveExecutable?: (command: string) => Promise<string>
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

const pnpmEnvironment = () =>
  Object.fromEntries<string>([
    ["COREPACK_ENABLE_PROJECT_SPEC", "0"],
    // pnpm 11 uses its own namespace; pnpm 10 reads npm's configuration namespace.
    ...(["GLOBAL_DIR", "GLOBAL_BIN_DIR", "STORE_DIR"] as const).flatMap((name) => {
      const value = process.env[`COHALL_PNPM_${name}`]
      return value === undefined
        ? []
        : ([
            [`npm_config_${name.toLowerCase()}`, value],
            [`pnpm_config_${name.toLowerCase()}`, value],
          ] as const)
    }),
  ])

const normalizePath = (path: string): string => path.replaceAll("\\", "/")
const pnpmGlobalDirectory = /^(.*\/global\/v?\d+)\//

export const normalizeUpgradeTarget = (target: string | undefined): string => {
  if (target === undefined || target === "latest") {
    return "latest"
  }
  const normalized = target.startsWith("v") ? target.slice(1) : target
  if (parseVersion(normalized) === undefined) {
    throw new Error("--to must be latest or an exact semantic version")
  }
  return normalized
}

export const deviceVersionWarning = (
  cliVersion: string,
  deviceVersion: string | undefined,
): string | undefined =>
  deviceVersion === undefined || deviceVersion === cliVersion
    ? undefined
    : `Running device daemon uses Cohall ${deviceVersion}, while this CLI is ${cliVersion}. Run upgrade through the executable configured by the device service.`

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
    [path, normalizePath(entrypoint)].some(
      (candidate) =>
        candidate.includes("/.npm/_npx/") ||
        candidate.includes("/.bunx/") ||
        candidate.includes("/dlx/"),
    )
  ) {
    throw new Error(
      "This Cohall process is running from a temporary package-runner cache; install it globally before using cohall upgrade",
    )
  }
  if (path.includes("/.bun/install/global/node_modules/")) {
    return { manager: "bun", entrypoint }
  }
  if (
    pnpmGlobalDirectory.test(path) ||
    /\/v\d+\/links\//.test(path) ||
    path.includes("/node_modules/.pnpm/") ||
    pnpmGlobalDirectory.test(normalizePath(entrypoint))
  ) {
    return { manager: "pnpm", entrypoint }
  }

  const nodeModulesParent = path.slice(0, packageIndex)
  const prefix = nodeModulesParent.endsWith("/lib")
    ? nodeModulesParent.slice(0, -"/lib".length)
    : nodeModulesParent
  return { manager: "npm", prefix, entrypoint }
}

export const resolvePackageInstallation = async (
  entrypoint: string,
  options: {
    readonly runner?: CommandRunner
    readonly resolveExecutable?: (command: string) => Promise<string>
  } = {},
) => {
  const canonicalEntrypoint = await realpath(entrypoint)
  const installation = packageInstallation(canonicalEntrypoint, resolve(entrypoint))
  if (installation.manager !== "pnpm")
    return {
      ...installation,
      canonicalEntrypoint,
      pnpmExecutable: undefined,
      globalRoot: undefined,
    }

  const lexicalPath = normalizePath(installation.entrypoint)
  const globalRoot =
    lexicalPath.match(pnpmGlobalDirectory)?.[1] ?? lexicalPath.match(/^(.*\/v?\d+)\//)?.[1]
  const globalEntrypointError = () =>
    new Error(
      "This operation requires a global pnpm entrypoint; project-local and shared-store executions cannot select a global installation. Run the global cohall command.",
    )
  if (globalRoot === undefined) throw globalEntrypointError()
  const selectedManager = process.env.COHALL_PNPM_EXECUTABLE ?? "pnpm"
  const pnpmExecutable =
    options.resolveExecutable === undefined
      ? await trustedExecutable(selectedManager, { preserveSymlink: true })
      : await options.resolveExecutable(selectedManager)
  const result = await checked(
    options.runner ?? defaultRunner,
    {
      command: pnpmExecutable,
      arguments: ["root", "--global"],
      environment: pnpmEnvironment(),
    },
    10_000,
  )
  const reported = normalizePath(result.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? "")
  const root = reported.endsWith("/node_modules") ? dirname(reported) : reported
  const selected = resolve(globalRoot)
  const configured = isAbsolute(root) ? resolve(root) : undefined
  if (
    configured === undefined ||
    (process.platform === "win32"
      ? selected.toLowerCase() !== configured.toLowerCase()
      : selected !== configured)
  )
    throw globalEntrypointError()
  const packageEntry = (root: string) => join(root, "node_modules", packageName, "bin", "cohall.js")
  const entries = await readdir(globalRoot, { withFileTypes: true })
  const candidates = [
    packageEntry(globalRoot),
    ...entries
      .filter((entry) => entry.isSymbolicLink())
      .map((entry) => packageEntry(join(globalRoot, entry.name))),
  ]
  for (const candidate of candidates) {
    if ((await realpath(candidate).catch(() => undefined)) === canonicalEntrypoint)
      return {
        ...installation,
        entrypoint: candidate,
        canonicalEntrypoint,
        globalDir: dirname(globalRoot),
        globalRoot,
        pnpmExecutable,
      }
  }
  throw new Error(
    "Could not find a stable pnpm global executable for this installation. Run the global cohall command, then use cohall service install before upgrading.",
  )
}

export const pnpmServiceDirectories = async (
  executable: string,
  globalRoot: string,
  runner: CommandRunner = defaultRunner,
) => {
  const query = async (arguments_: ReadonlyArray<string>): Promise<string> => {
    const result = await checked(
      runner,
      { command: executable, arguments: arguments_, environment: pnpmEnvironment() },
      10_000,
    )
    const directory = result.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? ""
    if (!isAbsolute(directory))
      throw new Error(`pnpm ${arguments_.join(" ")} did not report an absolute directory`)
    return directory
  }
  const [bin, store] = await Promise.all([
    query(["bin", "--global"]),
    query(["--dir", globalRoot, "--ignore-workspace", "store", "path"]),
  ])
  return { bin, store }
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
      return {
        command: "pnpm",
        arguments: [
          "add",
          "--global",
          ...(installation.globalDir === undefined ? [] : ["--global-dir", installation.globalDir]),
          ...(process.env.COHALL_PNPM_GLOBAL_BIN_DIR === undefined
            ? []
            : ["--global-bin-dir", process.env.COHALL_PNPM_GLOBAL_BIN_DIR]),
          specification,
        ],
        environment: pnpmEnvironment(),
      }
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

const executableNames = (command: string): ReadonlyArray<string> => {
  if (operatingSystem() !== "win32" || extname(command).length > 0) {
    return [command]
  }
  return (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((extension) => `${command}${extension.toLowerCase()}`)
}

const containsPath = (root: string, path: string): boolean => {
  const child = relative(root, path)
  return child === "" || (!child.startsWith("..") && !isAbsolute(child))
}

const linuxSystemExecutableRoots = [
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/lib/node_modules",
  "/usr/share/nodejs",
  "/nix/store",
]
const macosHomebrewRoots = ["/opt/homebrew", "/usr/local"]
const macosAdminGroup = 80

export const isTrustedSystemPath = (platform: NodeJS.Platform, path: string): boolean =>
  platform === "linux" &&
  (path === "/home" ||
    linuxSystemExecutableRoots.some((root) => containsPath(root, path) || containsPath(path, root)))

export const isTrustedGroupWritablePath = (options: {
  readonly platform: NodeJS.Platform
  readonly canonical: string
  readonly writableRoot: string | undefined
  readonly path: string
  readonly uid: number | undefined
  readonly ownerUid: number
  readonly ownerGid: number
}): boolean => {
  const writableRoot = options.writableRoot
  return (
    options.platform === "darwin" &&
    writableRoot !== undefined &&
    options.uid !== undefined &&
    options.ownerUid === options.uid &&
    options.ownerGid === macosAdminGroup &&
    macosHomebrewRoots.some((root) => containsPath(root, writableRoot)) &&
    containsPath(writableRoot, options.canonical) &&
    containsPath(writableRoot, options.path)
  )
}

const validateExecutable = async (
  candidate: string,
  installationRoot: string | undefined,
  preserveSymlink = false,
): Promise<string> => {
  const canonical = await realpath(candidate)
  if (operatingSystem() === "win32") {
    return preserveSymlink ? resolve(candidate) : canonical
  }
  const uid = process.getuid?.()
  const writableRoot = installationRoot === undefined ? undefined : await realpath(installationRoot)
  for (const executablePath of preserveSymlink ? [canonical, resolve(candidate)] : [canonical]) {
    for (let path = executablePath; ; path = dirname(path)) {
      const metadata = await stat(path)
      // Homebrew's shared prefix is admin-group writable. Local administrators are already inside
      // the OS trust boundary; arbitrary shared Unix groups remain rejected.
      const trustedGroupWritablePath = isTrustedGroupWritablePath({
        platform: operatingSystem(),
        canonical,
        writableRoot,
        path,
        uid,
        ownerUid: metadata.uid,
        ownerGid: metadata.gid,
      })
      if (
        (metadata.mode & 0o002) !== 0 ||
        ((metadata.mode & 0o020) !== 0 && !trustedGroupWritablePath)
      ) {
        throw new Error(`Refusing executable beneath group- or world-writable path ${path}`)
      }
      // User namespaces can hide host-root ownership. Only fixed OS paths are trusted this way;
      // user-installed executables and their private ancestors must still belong to this user.
      if (
        uid !== undefined &&
        metadata.uid !== 0 &&
        metadata.uid !== uid &&
        !isTrustedSystemPath(operatingSystem(), path)
      ) {
        throw new Error(`Refusing executable owned by another user at ${path}`)
      }
      const parent = dirname(path)
      if (parent === path) {
        break
      }
    }
  }
  return preserveSymlink ? resolve(candidate) : canonical
}

export const trustedExecutable = async (
  command: string,
  options: { readonly writableRoot?: string; readonly preserveSymlink?: boolean } = {},
): Promise<string> => {
  const candidates = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .flatMap((directory) => executableNames(command).map((name) => join(directory, name)))
  let failure: unknown
  for (const path of candidates) {
    const available = await access(
      path,
      operatingSystem() === "win32" ? constants.F_OK : constants.X_OK,
    )
      .then(() => true)
      .catch(() => false)
    if (!available) continue
    try {
      return await validateExecutable(path, options.writableRoot, options.preserveSymlink)
    } catch (cause) {
      failure ??= cause
    }
  }
  throw failure ?? new Error(`Could not find ${command} on PATH`)
}

const trustedServices = async (
  services: ReadonlyArray<ManagedService>,
  resolveExecutable: (command: string) => Promise<string>,
): Promise<ReadonlyArray<ManagedService>> => {
  const resolved = new Map<string, Promise<string>>()
  const invocation = async (value: CommandInvocation): Promise<CommandInvocation> => {
    let command = resolved.get(value.command)
    if (command === undefined) {
      command = resolveExecutable(value.command)
      resolved.set(value.command, command)
    }
    return { ...value, command: await command }
  }
  const secured: Array<ManagedService> = []
  for (const service of services) {
    let check: CommandInvocation
    try {
      check = await invocation(service.check)
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith("Could not find ")) {
        continue
      }
      throw cause
    }
    secured.push({
      ...service,
      check,
      ...(service.entrypoint === undefined
        ? {}
        : {
            entrypoint: {
              ...service.entrypoint,
              inspect: await invocation(service.entrypoint.inspect),
            },
          }),
      restart: await Promise.all(service.restart.map(invocation)),
    })
  }
  return secured
}

const ScheduledTaskAction = Schema.Struct({
  Execute: Schema.NonEmptyString,
  Arguments: Schema.NonEmptyString,
})
const powershellLiteral = "(?:[^'\\r\\n]|'')+"
const scheduledTaskBootstrap = new RegExp(
  [
    "^\\$ErrorActionPreference = 'Stop'",
    `\\$env:COHALL_CONFIG = '${powershellLiteral}'`,
    `(?:\\$env:PNPM_HOME = '${powershellLiteral}'\\r?\\n\\$env:PATH = '${powershellLiteral}' \\+ ';' \\+ \\$env:PATH\\r?\\n)?(?:\\$env:COHALL_PNPM_EXECUTABLE = '${powershellLiteral}'\\r?\\n)?(?:\\$env:COHALL_PNPM_STORE_DIR = '${powershellLiteral}'\\r?\\n)?(?:\\$env:COHALL_PNPM_GLOBAL_DIR = '${powershellLiteral}'\\r?\\n)?(?:\\$env:COHALL_PNPM_GLOBAL_BIN_DIR = '${powershellLiteral}'\\r?\\n\\$env:PATH = '${powershellLiteral}' \\+ ';' \\+ \\$env:PATH\\r?\\n)?\\$env:PATH = '${powershellLiteral}' \\+ ';' \\+ \\$env:PATH`,
    `& '(${powershellLiteral})' '(${powershellLiteral})' device`,
    "exit \\$LASTEXITCODE(?:\\r?\\n)?$",
  ].join("\\r?\\n"),
)

const scheduledTaskEntrypoint = (output: string): string | undefined => {
  let value: unknown
  try {
    value = JSON.parse(output) as unknown
  } catch {
    return undefined
  }
  const decoded = Schema.decodeUnknownOption(ScheduledTaskAction)(value)
  if (decoded._tag === "None") return undefined
  const action = decoded.value
  if (!/(?:^|[/\\])(?:powershell|pwsh)\.exe$/i.test(action.Execute)) return undefined
  const encoded =
    /^-NoLogo\s+-NoProfile\s+-NonInteractive\s+-EncodedCommand\s+([A-Za-z0-9+/]+={0,2})\s*$/i.exec(
      action.Arguments,
    )?.[1]
  if (encoded === undefined) return undefined
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.length % 2 !== 0 || bytes.toString("base64") !== encoded) return undefined
  // Recognize the complete installer bootstrap without executing the saved script.
  const bootstrap = scheduledTaskBootstrap.exec(bytes.toString("utf16le"))
  const node = bootstrap?.[1]?.replaceAll("''", "'")
  if (node === undefined || !/(?:^|[/\\])node\.exe$/i.test(node)) return undefined
  return bootstrap?.[2]?.replaceAll("''", "'")
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
        entrypoint: {
          inspect: {
            command: "systemctl",
            arguments: [...user, "show", "--property=ExecStart", "--value", unit],
          },
          parse: (output) => output.match(/\bpath=(.*?)\s*;/)?.[1]?.trim(),
        },
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
      entrypoint: {
        inspect: { command: "launchctl", arguments: ["print", `${domain}/${label}`] },
        parse: (output) => output.match(/^\s*program\s*=\s*(.+)$/m)?.[1]?.trim(),
      },
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
        entrypoint: {
          inspect: {
            command: "powershell.exe",
            arguments: [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "@((Get-ScheduledTask -TaskName 'Cohall Device' -TaskPath '\\' -ErrorAction Stop).Actions) | Select-Object Execute, Arguments | ConvertTo-Json -Compress",
            ],
          },
          parse: scheduledTaskEntrypoint,
        },
        restart: [
          {
            command: "schtasks.exe",
            arguments: ["/End", "/TN", "Cohall Device"],
            allowFailure: true,
          },
          { command: "schtasks.exe", arguments: ["/Run", "/TN", "Cohall Device"] },
        ],
      },
    ]
  }

  return []
}

const defaultRunner: CommandRunner = {
  run: async (command, arguments_, timeoutMs = 300_000, environment) => {
    const result = await execa(command, arguments_, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
      stdin: "ignore",
      ...(environment === undefined ? {} : { env: environment }),
      reject: false,
      stripFinalNewline: false,
    })
    return {
      exitCode: result.failed ? result.exitCode || 1 : 0,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.shortMessage === undefined ? {} : { error: result.shortMessage.slice(0, 16_384) }),
    }
  },
}

const checked = async (
  runner: CommandRunner,
  invocation: CommandInvocation,
  timeoutMs?: number,
): Promise<CommandResult> => {
  const result = await runner.run(
    invocation.command,
    invocation.arguments,
    timeoutMs,
    invocation.environment,
  )
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

const assertServiceInstallations = async (
  runner: CommandRunner,
  services: ReadonlyArray<ManagedService>,
  installation: Awaited<ReturnType<typeof resolvePackageInstallation>>,
): Promise<void> => {
  for (const service of services) {
    if (service.entrypoint === undefined) {
      continue
    }
    const result = await checked(runner, service.entrypoint.inspect, 10_000)
    const serviceEntrypoint = service.entrypoint.parse(`${result.stdout}\n${result.stderr}`)
    if (serviceEntrypoint === undefined) {
      throw new Error(
        `Could not determine the executable used by active ${service.label}${service.manager === "scheduled-task" ? ". Reinstall the task with cohall service install." : ""}`,
      )
    }
    const canonicalServiceEntrypoint = await realpath(serviceEntrypoint).catch((cause: unknown) => {
      throw new Error(
        `Could not resolve the executable used by active ${service.label}: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    })
    if (canonicalServiceEntrypoint === installation.canonicalEntrypoint) {
      const servicePath = resolve(serviceEntrypoint)
      const sameEntrypoint =
        service.manager === "scheduled-task"
          ? servicePath.toLowerCase() === installation.entrypoint.toLowerCase()
          : servicePath === installation.entrypoint
      if (installation.manager === "pnpm" && !sameEntrypoint)
        throw new Error(
          `Active ${service.label} is pinned to a pnpm package directory that changes during upgrades. ${
            service.device
              ? "Run cohall service install through the global cohall command before upgrading."
              : `Update the relay service executable to ${installation.entrypoint} before upgrading.`
          }`,
        )
      continue
    }
    throw new Error(
      `Active ${service.label} uses ${serviceEntrypoint}, but this Cohall CLI uses ${installation.entrypoint}. Run the service executable's upgrade command so its installation is updated before restart.`,
    )
  }
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
  preserveDeviceReceipt: boolean,
): Promise<RestartReceipt> => {
  let current = state
  for (const service of services) {
    current = { ...current, restartingService: service.id }
    await writeReceipt(statePath, current)
    try {
      for (const invocation of service.restart) {
        await checked(runner, invocation, 60_000)
      }
    } catch (cause) {
      current = {
        version: current.version,
        fromVersion: current.fromVersion,
        packageManager: current.packageManager,
        pendingServices: current.pendingServices,
        restartedServices: current.restartedServices,
      }
      await writeReceipt(statePath, current)
      throw cause
    }
    if (service.device && preserveDeviceReceipt) {
      // Some service managers return before terminating this process. The replacement task consumes the marker.
      return current
    }
    current = {
      version: current.version,
      fromVersion: current.fromVersion,
      packageManager: current.packageManager,
      pendingServices: current.pendingServices.filter((id) => id !== service.id),
      restartedServices: [...current.restartedServices, service.id],
    }
    await writeReceipt(statePath, current)
  }
  return current
}

const reportedRestartServices = (receipt: RestartReceipt): ReadonlyArray<string> =>
  receipt.restartingService === undefined ||
  receipt.restartedServices.includes(receipt.restartingService)
    ? receipt.restartedServices
    : [...receipt.restartedServices, receipt.restartingService]

export const upgrade = async (options: UpgradeOptions): Promise<UpgradeResult> => {
  const target = normalizeUpgradeTarget(options.target)
  const runner = options.runner ?? defaultRunner
  const resolveExecutable = options.resolveExecutable ?? trustedExecutable
  const runtimePlatform = options.platform ?? process.platform
  const uid = options.uid ?? process.getuid?.()
  const candidates = await trustedServices(
    serviceCandidates(runtimePlatform, uid),
    resolveExecutable,
  )
  const statePath = options.statePath ?? restartReceiptPath()
  const previous = await readReceipt(statePath)
  const entrypoint = options.entrypoint ?? process.argv[1]
  if (entrypoint === undefined) {
    throw new Error("Could not resolve the Cohall executable path")
  }
  const installation = await resolvePackageInstallation(entrypoint, {
    runner,
    ...(options.resolveExecutable === undefined ? {} : { resolveExecutable }),
  })

  if (
    previous?.version === options.currentVersion &&
    (target === "latest" || target === previous.version)
  ) {
    const pending = candidates.filter((service) => previous.pendingServices.includes(service.id))
    const active = await activeServices(runner, pending)
    await assertServiceInstallations(runner, active, installation)
    if (options.dryRun || !options.restart) {
      return {
        upgraded: previous.fromVersion !== previous.version,
        from_version: previous.fromVersion,
        installed_version: previous.version,
        requested_version: previous.version,
        package_manager: previous.packageManager,
        services_restarted: previous.restartedServices,
        services_pending_restart: previous.pendingServices,
        resumed_after_restart: false,
        dry_run: options.dryRun,
      }
    }
    const activeIds = new Set(active.map((service) => service.id))
    const completedByRestart = pending.filter(
      (service) =>
        options.delegated === true &&
        service.device &&
        service.id === previous.restartingService &&
        activeIds.has(service.id),
    )
    const completedIds = new Set(completedByRestart.map((service) => service.id))
    const remaining = active.filter((service) => !completedIds.has(service.id))
    let resumed: RestartReceipt = {
      version: previous.version,
      fromVersion: previous.fromVersion,
      packageManager: previous.packageManager,
      pendingServices: previous.pendingServices.filter((id) => !completedIds.has(id)),
      restartedServices: [
        ...previous.restartedServices,
        ...completedByRestart.map((service) => service.id),
      ],
    }
    if (remaining.length > 0) {
      await writeReceipt(statePath, resumed)
      resumed = await restartServices(
        runner,
        remaining,
        statePath,
        resumed,
        options.delegated === true,
      )
    } else if (completedIds.size > 0) {
      await writeReceipt(statePath, resumed)
    }
    if (resumed.pendingServices.length === 0) {
      await rm(statePath, { force: true })
    }
    return {
      upgraded: previous.fromVersion !== previous.version,
      from_version: previous.fromVersion,
      installed_version: previous.version,
      requested_version: previous.version,
      package_manager: previous.packageManager,
      services_restarted: reportedRestartServices(resumed),
      services_pending_restart: resumed.pendingServices.filter(
        (id) => id !== resumed.restartingService,
      ),
      resumed_after_restart: true,
      dry_run: false,
    }
  }

  const services = await activeServices(runner, candidates)
  await assertServiceInstallations(runner, services, installation)
  const pendingServices = [
    ...new Set([...(previous?.pendingServices ?? []), ...services.map((service) => service.id)]),
  ]

  const resolvePackageManager = (): Promise<string> => {
    if (installation.pnpmExecutable !== undefined)
      return Promise.resolve(installation.pnpmExecutable)
    return options.resolveExecutable === undefined
      ? trustedExecutable(
          installation.manager,
          installation.prefix === undefined ? {} : { writableRoot: installation.prefix },
        )
      : resolveExecutable(installation.manager)
  }
  let packageManagerExecutable: string | undefined
  let resolvedTarget = target
  if (target === "latest") {
    packageManagerExecutable = await resolvePackageManager()
    if (installation.manager === "bun") {
      const information = await checked(
        runner,
        { command: packageManagerExecutable, arguments: ["--version"] },
        10_000,
      )
      if (compareVersions(information.stdout.trim(), minimumBunLookupVersion) < 0) {
        throw new Error(
          `Latest upgrades require Bun ${minimumBunLookupVersion} or newer; upgrade Bun or use --to <exact-version>`,
        )
      }
    }
    const lookup = await checked(
      runner,
      {
        command: packageManagerExecutable,
        arguments: [
          ...(installation.manager === "bun" ? ["pm"] : []),
          "view",
          ...(installation.manager === "pnpm" ? [] : ["--global"]),
          ...(installation.prefix === undefined ? [] : ["--prefix", installation.prefix]),
          `${packageName}@latest`,
          "version",
          "--json",
        ],
        ...(installation.manager === "pnpm" ? { environment: pnpmEnvironment() } : {}),
      },
      30_000,
    )
    const latest: unknown = JSON.parse(lookup.stdout)
    if (typeof latest !== "string" || parseVersion(latest) === undefined) {
      throw new Error(`Could not resolve ${packageName}@latest to an exact semantic version`)
    }
    resolvedTarget = latest
  }
  let nextVersion = await installedVersion(installation.entrypoint).catch((cause: unknown) => {
    if (target === "latest") {
      throw new Error(
        "Could not verify the installed version before upgrading latest; use --to <version> to repair this installation",
        { cause },
      )
    }
    return undefined
  })
  if (
    target === "latest" &&
    (compareVersions(resolvedTarget, options.currentVersion) < 0 ||
      compareVersions(resolvedTarget, nextVersion ?? options.currentVersion) < 0)
  ) {
    return {
      upgraded: false,
      from_version: options.currentVersion,
      installed_version: nextVersion ?? options.currentVersion,
      requested_version: target,
      package_manager: installation.manager,
      services_restarted: [],
      services_pending_restart: [],
      resumed_after_restart: false,
      dry_run: options.dryRun,
    }
  }

  if (options.dryRun) {
    return {
      upgraded: false,
      from_version: options.currentVersion,
      installed_version: options.currentVersion,
      requested_version: target,
      package_manager: installation.manager,
      services_restarted: [],
      services_pending_restart: pendingServices,
      resumed_after_restart: false,
      dry_run: true,
    }
  }

  if (nextVersion === undefined || resolvedTarget !== nextVersion) {
    const install = packageInstallCommand(installation, resolvedTarget)
    const installExecutable = packageManagerExecutable ?? (await resolvePackageManager())
    await checked(runner, { ...install, command: installExecutable })
    nextVersion = await installedVersion(installation.entrypoint)
  }
  if (nextVersion !== resolvedTarget) {
    throw new Error(`Installed Cohall ${nextVersion}, expected ${resolvedTarget}`)
  }
  const upgraded = nextVersion !== options.currentVersion

  const initial: RestartReceipt = {
    version: nextVersion,
    fromVersion: options.currentVersion,
    packageManager: installation.manager,
    pendingServices,
    restartedServices: [],
  }
  if (initial.pendingServices.length > 0) {
    await writeReceipt(statePath, initial)
  }
  const completed = options.restart
    ? await restartServices(runner, services, statePath, initial, options.delegated === true)
    : initial
  if (completed.pendingServices.length === 0) {
    await rm(statePath, { force: true })
  }
  return {
    upgraded,
    from_version: options.currentVersion,
    installed_version: nextVersion,
    requested_version: target,
    package_manager: installation.manager,
    services_restarted: reportedRestartServices(completed),
    services_pending_restart: completed.pendingServices.filter(
      (id) => id !== completed.restartingService,
    ),
    resumed_after_restart: false,
    dry_run: false,
  }
}
