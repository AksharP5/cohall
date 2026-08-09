import { execFile, type ExecFileException } from "node:child_process"
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { packageInstallation, type CommandResult, type CommandRunner } from "./upgrade.ts"

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
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`

export const deviceServicePlan = (options: {
  readonly platform: NodeJS.Platform
  readonly entrypoint: string
  readonly home: string
  readonly uid?: number
}): DeviceServicePlan => {
  if (options.platform === "linux") {
    const path = join(options.home, ".config", "systemd", "user", "cohall-device.service")
    return {
      file: {
        path,
        mode: 0o600,
        content: `[Unit]\nDescription=Cohall device agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nEnvironment=PATH=%h/.local/bin:%h/.npm-global/bin:%h/.bun/bin:%h/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin\nExecStart=${systemdArgument(options.entrypoint)} device\nRestart=always\nRestartSec=3\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=default.target\n`,
      },
      commands: [
        { command: "systemctl", arguments: ["--user", "daemon-reload"] },
        { command: "systemctl", arguments: ["--user", "enable", "--now", "cohall-device.service"] },
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
        content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${label}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${xml(options.entrypoint)}</string>\n    <string>device</string>\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>\n  </dict>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <dict>\n    <key>NetworkState</key>\n    <true/>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>\n  <key>ThrottleInterval</key>\n  <integer>3</integer>\n  <key>ProcessType</key>\n  <string>Background</string>\n</dict>\n</plist>\n`,
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
  run: (command, arguments_, timeoutMs = 60_000) =>
    new Promise((resolve) => {
      execFile(
        command,
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
    }),
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
  } = {},
): Promise<{ readonly installed: string; readonly note?: string }> => {
  const entrypoint = await realpath(options.entrypoint ?? process.argv[1] ?? "")
  packageInstallation(entrypoint)
  const platform = options.platform ?? process.platform
  const runner = options.runner ?? defaultRunner
  if (platform === "win32") {
    const script = join(dirname(dirname(entrypoint)), "deploy", "windows", "install-device.ps1")
    await checked(runner, "powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
    ])
    return { installed: "scheduled-task:Cohall Device" }
  }
  const uid = options.uid ?? process.getuid?.()
  const plan = deviceServicePlan({
    platform,
    entrypoint,
    home: options.home ?? homedir(),
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
  if (platform === "linux") {
    const service = "cohall-device.service"
    const check = await runner.run("systemctl", ["--user", "is-active", "--quiet", service], 10_000)
    if (check.exitCode !== 0) {
      return { running: false, restarted: false }
    }
    await checked(runner, "systemctl", ["--user", "restart", service])
    return { running: true, restarted: true, service }
  }
  if (platform === "darwin") {
    const service = "com.cohall.device"
    const target = `gui/${options.uid ?? process.getuid?.() ?? 0}/${service}`
    const check = await runner.run("launchctl", ["print", target], 10_000)
    if (check.exitCode !== 0) {
      return { running: false, restarted: false }
    }
    await checked(runner, "launchctl", ["kickstart", "-k", target])
    return { running: true, restarted: true, service }
  }
  if (platform === "win32") {
    const service = "Cohall Device"
    const check = await runner.run("schtasks.exe", ["/Query", "/TN", service], 10_000)
    if (check.exitCode !== 0) {
      return { running: false, restarted: false }
    }
    await checked(runner, "schtasks.exe", ["/End", "/TN", service], true)
    await checked(runner, "schtasks.exe", ["/Run", "/TN", service])
    return { running: true, restarted: true, service }
  }
  return { running: false, restarted: false }
}
