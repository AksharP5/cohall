import { execFile, type ExecFileException } from "node:child_process"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { configurationPath } from "./config.ts"
import {
  resolvePackageInstallation,
  serviceCandidates,
  trustedExecutable,
  type CommandResult,
  type CommandRunner,
} from "./upgrade.ts"

interface ServiceFile {
  readonly path: string
  readonly content: string
  readonly mode: number
}

export interface DeviceServicePlan {
  readonly file: ServiceFile
  readonly commands: ReadonlyArray<{
    readonly command: string
    readonly arguments: ReadonlyArray<string>
  }>
  readonly note?: string
}

const xml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")

const systemdArgument = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("\n", "\\n").replaceAll("\r", "\\r")}"`

const pnpmHomeDirectory = (platform: NodeJS.Platform, home: string): string => {
  if (process.env.PNPM_HOME) return process.env.PNPM_HOME
  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, "pnpm")
  if (platform === "darwin") return join(home, "Library", "pnpm")
  if (platform !== "win32") return join(home, ".local", "share", "pnpm")
  return process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "pnpm") : join(home, ".pnpm")
}

export const deviceServicePlan = (options: {
  readonly platform: NodeJS.Platform
  readonly entrypoint: string
  readonly home: string
  readonly nodeExecutable: string
  readonly pnpm?: { readonly home: string; readonly executable: string }
  readonly configPath: string
  readonly uid?: number
}): DeviceServicePlan => {
  const pnpmHome =
    options.pnpm?.home ??
    (options.platform === "darwin"
      ? join(options.home, "Library", "pnpm")
      : join(options.home, ".local", "share", "pnpm"))
  const servicePath = [
    dirname(options.nodeExecutable),
    join(options.home, ".local", "bin"),
    join(options.home, ".npm-global", "bin"),
    join(options.home, ".bun", "bin"),
    join(pnpmHome, "bin"),
    pnpmHome,
    ...(options.platform === "darwin" ? ["/opt/homebrew/bin"] : []),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":")
  if (options.platform === "linux") {
    const path = join(options.home, ".config", "systemd", "user", "cohall-device.service")
    return {
      file: {
        path,
        mode: 0o600,
        content: `[Unit]\nDescription=Cohall device agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nEnvironment=${systemdArgument(`PATH=${servicePath}`)}\nEnvironment=${systemdArgument(`COHALL_CONFIG=${options.configPath}`)}\n${options.pnpm === undefined ? "" : `Environment=${systemdArgument(`PNPM_HOME=${options.pnpm.home}`)}\nEnvironment=${systemdArgument(`COHALL_PNPM_EXECUTABLE=${options.pnpm.executable}`)}\n`}ExecStart=${systemdArgument(options.entrypoint)} device\nRestart=always\nRestartSec=3\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=default.target\n`,
      },
      commands: [
        { command: "systemctl", arguments: ["--user", "daemon-reload"] },
        { command: "systemctl", arguments: ["--user", "enable", "cohall-device.service"] },
        { command: "systemctl", arguments: ["--user", "restart", "cohall-device.service"] },
      ],
      note: "The device starts after login. Run loginctl enable-linger $USER if it must run before login.",
    }
  }
  if (options.platform === "darwin") {
    const label = "com.cohall.device"
    const path = join(options.home, "Library", "LaunchAgents", `${label}.plist`)
    const domain = `gui/${options.uid ?? 0}`
    return {
      file: {
        path,
        mode: 0o600,
        content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${label}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${xml(options.entrypoint)}</string>\n    <string>device</string>\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>${xml(servicePath)}</string>\n    <key>COHALL_CONFIG</key>\n    <string>${xml(options.configPath)}</string>\n${options.pnpm === undefined ? "" : `    <key>PNPM_HOME</key>\n    <string>${xml(options.pnpm.home)}</string>\n    <key>COHALL_PNPM_EXECUTABLE</key>\n    <string>${xml(options.pnpm.executable)}</string>\n`}  </dict>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <dict>\n    <key>NetworkState</key>\n    <true/>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>\n  <key>ThrottleInterval</key>\n  <integer>3</integer>\n  <key>ProcessType</key>\n  <string>Background</string>\n</dict>\n</plist>\n`,
      },
      commands: [
        { command: "launchctl", arguments: ["bootout", domain, path] },
        { command: "launchctl", arguments: ["bootstrap", domain, path] },
        { command: "launchctl", arguments: ["kickstart", "-k", `${domain}/${label}`] },
      ],
    }
  }
  throw new Error("Automatic device service installation supports Linux and macOS")
}

const defaultRunner: CommandRunner = {
  run: async (command, arguments_, timeoutMs = 60_000) => {
    const executable = await trustedExecutable(command)
    return new Promise((resolve) => {
      execFile(
        executable,
        [...arguments_],
        { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: timeoutMs, windowsHide: true },
        (error: ExecFileException | null, stdout, stderr) =>
          resolve({
            exitCode: typeof error?.code === "number" ? error.code : error === null ? 0 : 1,
            stdout,
            stderr,
            ...(error === null ? {} : { error: error.message }),
          }),
      )
    })
  },
}

const checked = async (
  runner: CommandRunner,
  command: string,
  arguments_: ReadonlyArray<string>,
  allowFailure = false,
): Promise<CommandResult> => {
  const result = await runner.run(command, arguments_, 60_000)
  if (result.exitCode === 0 || allowFailure) {
    return result
  }
  throw new Error(
    `${command} failed: ${result.stderr.trim() || result.stdout.trim() || result.error || `status ${result.exitCode}`}`,
  )
}

export const installDeviceService = async (
  options: {
    readonly entrypoint?: string
    readonly platform?: NodeJS.Platform
    readonly home?: string
    readonly uid?: number
    readonly runner?: CommandRunner
    readonly resolveExecutable?: (command: string) => Promise<string>
  } = {},
): Promise<{ readonly installed: string; readonly note?: string }> => {
  const { entrypoint, canonicalEntrypoint, pnpmExecutable } = await resolvePackageInstallation(
    options.entrypoint ?? process.argv[1] ?? "",
    {
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      ...(options.resolveExecutable === undefined
        ? {}
        : { resolveExecutable: options.resolveExecutable }),
    },
  )
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const pnpm =
    pnpmExecutable === undefined
      ? undefined
      : { home: pnpmHomeDirectory(platform, home), executable: pnpmExecutable }
  const runner = options.runner ?? defaultRunner
  if (platform === "win32") {
    const script = join(
      dirname(dirname(canonicalEntrypoint)),
      "deploy",
      "windows",
      "install-device.ps1",
    )
    await checked(runner, "powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-NodeExecutable",
      process.execPath,
      "-Entrypoint",
      entrypoint,
      "-ConfigurationPath",
      configurationPath(),
      ...(pnpm === undefined ? [] : ["-PnpmHome", pnpm.home, "-PnpmExecutable", pnpm.executable]),
    ])
    return { installed: "scheduled-task:Cohall Device" }
  }
  const uid = options.uid ?? process.getuid?.()
  const plan = deviceServicePlan({
    platform,
    entrypoint,
    home,
    nodeExecutable: process.execPath,
    configPath: configurationPath(),
    ...(pnpm === undefined ? {} : { pnpm }),
    ...(uid === undefined ? {} : { uid }),
  })
  await mkdir(dirname(plan.file.path), { recursive: true, mode: 0o700 })
  await writeFile(plan.file.path, plan.file.content, { mode: plan.file.mode })
  await chmod(plan.file.path, plan.file.mode)
  for (const [index, command] of plan.commands.entries()) {
    await checked(runner, command.command, command.arguments, platform === "darwin" && index === 0)
  }
  return {
    installed: plan.file.path,
    ...(plan.note === undefined ? {} : { note: plan.note }),
  }
}

export interface DeviceServiceRestart {
  readonly running: boolean
  readonly restarted: boolean
  readonly service?: string
}

export const restartDeviceService = async (
  options: {
    readonly platform?: NodeJS.Platform
    readonly uid?: number
    readonly runner?: CommandRunner
  } = {},
): Promise<DeviceServiceRestart> => {
  const platform = options.platform ?? process.platform
  const runner = options.runner ?? defaultRunner
  const service = serviceCandidates(platform, options.uid ?? process.getuid?.()).find(
    (candidate) => candidate.device,
  )
  if (service === undefined) return { running: false, restarted: false }

  const check = await runner.run(service.check.command, service.check.arguments, 10_000)
  if (
    check.exitCode !== 0 ||
    (service.activeOutput !== undefined &&
      !service.activeOutput.test(`${check.stdout}\n${check.stderr}`))
  ) {
    return { running: false, restarted: false }
  }
  for (const command of service.restart) {
    await checked(runner, command.command, command.arguments, command.allowFailure)
  }
  return { running: true, restarted: true, service: service.label }
}
