import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { execFile, type ExecFileException } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { deviceServicePlan, installDeviceService, restartDeviceService } from "./service.ts"
import type { CommandRunner } from "./upgrade.ts"

describe("device service plans", () => {
  it.skipIf(process.platform !== "win32")(
    "installs a Windows task with the selected runtime and configuration",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "cohall Windows ' & 100%-"))
      const entrypoint = join(directory, "cohall.cjs")
      const config = join(directory, "chosen config.json")
      const harness = join(directory, "scheduler-fixture.ps1")
      const powerShell = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
      try {
        await writeFile(
          entrypoint,
          `process.stdout.write(JSON.stringify({ config: process.env.COHALL_CONFIG, args: process.argv.slice(2), node: process.execPath, unrelated: process.env.COHALL_UNRELATED_SECRET })); process.exit(7)`,
        )
        await writeFile(
          harness,
          `param($Installer, $NodeExecutable, $Entrypoint, $Config)
$ErrorActionPreference = 'Stop'
function New-ScheduledTaskAction { param($Execute, $Argument) return @{ Execute = $Execute; Argument = $Argument } }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn, $User) return @{} }
function New-ScheduledTaskSettingsSet { param($ExecutionTimeLimit, $RestartCount, $RestartInterval, $MultipleInstances) return @{} }
function Register-ScheduledTask { param($TaskName, $Description, $Action, $Trigger, $Settings, [switch]$Force) $global:CohallTestAction = $Action }
function Stop-ScheduledTask { param($TaskName, $ErrorAction) $global:CohallTestStopped = $true }
function Start-ScheduledTask { param($TaskName) if (-not $global:CohallTestStopped) { throw 'Existing task was not stopped before restarting' } }
& $Installer -NodeExecutable $NodeExecutable -Entrypoint $Entrypoint -ConfigurationPath $Config | Out-Null
$global:CohallTestAction | ConvertTo-Json -Compress
`,
        )
        const installed = await promisify(execFile)(
          powerShell,
          [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            harness,
            "-Installer",
            resolve("deploy/windows/install-device.ps1"),
            "-NodeExecutable",
            process.execPath,
            "-Entrypoint",
            entrypoint,
            "-Config",
            config,
          ],
          { env: { ...process.env, COHALL_UNRELATED_SECRET: "not-service-state" } },
        )
        const action: unknown = JSON.parse(installed.stdout)
        if (
          typeof action !== "object" ||
          action === null ||
          !("Execute" in action) ||
          typeof action.Execute !== "string" ||
          !("Argument" in action) ||
          typeof action.Argument !== "string"
        ) {
          throw new Error("Installer did not register a runnable task")
        }
        expect(action.Execute.toLowerCase()).toBe(powerShell.toLowerCase())
        const executable = action.Execute
        const arguments_ = action.Argument.split(" ")
        const encoded = arguments_.at(-1)
        expect(encoded).toBeDefined()
        expect(Buffer.from(encoded ?? "", "base64").toString("utf16le")).not.toContain(
          "not-service-state",
        )
        const executed = await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
          (resolveResult) => {
            execFile(executable, arguments_, (error: ExecFileException | null, stdout, stderr) => {
              resolveResult({
                exitCode: typeof error?.code === "number" ? error.code : error === null ? 0 : 1,
                stdout,
                stderr,
              })
            })
          },
        )
        expect(executed.stderr).toBe("")
        expect(executed.exitCode).toBe(7)
        expect(JSON.parse(executed.stdout)).toEqual({
          config,
          args: ["device"],
          node: process.execPath,
        })
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
    30_000,
  )

  it.each(["linux", "darwin"] as const)(
    "keeps the selected configuration and Node runtime in an installed %s service",
    async (platform) => {
      const directory = await mkdtemp(join(tmpdir(), "cohall-service-context-"))
      const entrypoint = join(directory, "node_modules", "@akshar5", "cohall", "bin", "cohall.js")
      const config = join(directory, "selected", "config.json")
      const previousConfig = process.env.COHALL_CONFIG
      process.env.COHALL_CONFIG = config
      try {
        await mkdir(dirname(entrypoint), { recursive: true })
        await writeFile(entrypoint, "#!/usr/bin/env node\n")
        const result = await installDeviceService({
          platform,
          entrypoint,
          home: directory,
          uid: 501,
          runner: { run: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }) },
        })
        const content = await readFile(result.installed, "utf8")
        expect.soft(content).toContain("COHALL_CONFIG")
        expect.soft(content).toContain(config)
        expect.soft(content).toContain(dirname(process.execPath))
      } finally {
        if (previousConfig === undefined) delete process.env.COHALL_CONFIG
        else process.env.COHALL_CONFIG = previousConfig
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  it("uses the exact global executable in a Linux user service", () => {
    const plan = deviceServicePlan({
      platform: "linux",
      entrypoint: "/home/user/.local/lib/node_modules/@akshar5/cohall/bin/cohall.js",
      home: "/home/user",
      nodeExecutable: "/home/user/.nvm/versions/node/v24/bin/node",
      configPath: "/home/user/.config/cohall/config.json",
    })

    expect(plan.file.path).toBe("/home/user/.config/systemd/user/cohall-device.service")
    expect(plan.file.content).toContain(
      'ExecStart="/home/user/.local/lib/node_modules/@akshar5/cohall/bin/cohall.js" device',
    )
    expect(plan.commands).toEqual([
      { command: "systemctl", arguments: ["--user", "daemon-reload"] },
      {
        command: "systemctl",
        arguments: ["--user", "enable", "cohall-device.service"],
      },
      { command: "systemctl", arguments: ["--user", "restart", "cohall-device.service"] },
    ])
  })

  it("escapes a macOS executable path and targets the user launch domain", () => {
    const plan = deviceServicePlan({
      platform: "darwin",
      entrypoint: "/Users/A & B/bin/cohall",
      home: "/Users/A & B",
      nodeExecutable: "/Users/A & B/.nvm/versions/node/v24/bin/node",
      configPath: "/Users/A & B/selected/config.json",
      uid: 501,
    })

    expect(plan.file.content).toContain("/Users/A &amp; B/bin/cohall")
    expect(plan.file.content).toContain("/Users/A &amp; B/selected/config.json")
    expect(plan.commands.at(-1)).toEqual({
      command: "launchctl",
      arguments: ["kickstart", "-k", "gui/501/com.cohall.device"],
    })
  })

  it("keeps spaces, quotes, and systemd specifiers literal in service paths", () => {
    const plan = deviceServicePlan({
      platform: "linux",
      entrypoint: '/home/100%/bin/$cohall "cli"',
      home: "/home/100%",
      nodeExecutable: "/home/100%/node bin/node",
      configPath: '/home/100%/config "chosen"\nname.json',
    })

    expect(plan.file.content).toContain('Environment="PATH=/home/100%%/node bin:')
    expect(plan.file.content).toContain(
      'Environment="COHALL_CONFIG=/home/100%%/config \\"chosen\\"\\nname.json"',
    )
    expect(plan.file.content).toContain('ExecStart="/home/100%%/bin/$$cohall \\"cli\\"" device')
  })

  it("rejects unsupported automatic service targets", () => {
    expect(() =>
      deviceServicePlan({
        platform: "win32",
        entrypoint: "C:\\cohall.cmd",
        home: "C:\\Users\\user",
        nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
        configPath: "C:\\Users\\user\\config.json",
      }),
    ).toThrow("supports Linux and macOS")
  })

  it("restarts an active Linux device service", async () => {
    const invocations: Array<string> = []
    const runner: CommandRunner = {
      run: (command, arguments_) => {
        invocations.push([command, ...arguments_].join(" "))
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
      },
    }

    await expect(restartDeviceService({ platform: "linux", runner })).resolves.toEqual({
      running: true,
      restarted: true,
      service: "cohall-device.service",
    })
    expect(invocations).toEqual([
      "systemctl --user is-active --quiet cohall-device.service",
      "systemctl --user restart cohall-device.service",
    ])
  })

  it("does not start a stopped device service while changing relays", async () => {
    const runner: CommandRunner = {
      run: () => Promise.resolve({ exitCode: 3, stdout: "", stderr: "" }),
    }

    await expect(restartDeviceService({ platform: "linux", runner })).resolves.toEqual({
      running: false,
      restarted: false,
    })
  })

  it.skipIf(process.platform === "win32")(
    "rejects service managers found beneath writable directories",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "cohall-service-"))
      const executable = join(directory, "systemctl")
      const previousPath = process.env.PATH
      try {
        await writeFile(executable, "#!/bin/sh\nexit 0\n")
        await chmod(executable, 0o755)
        await chmod(directory, 0o777)
        process.env.PATH = directory
        await expect(restartDeviceService({ platform: "linux" })).rejects.toThrow(
          "group- or world-writable",
        )
      } finally {
        process.env.PATH = previousPath
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
})
