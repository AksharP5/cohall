import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { deviceServicePlan, restartDeviceService } from "./service.ts"
import type { CommandRunner } from "./upgrade.ts"

describe("device service plans", () => {
  it("uses the exact global executable in a Linux user service", () => {
    const plan = deviceServicePlan({
      platform: "linux",
      entrypoint: "/home/user/.local/lib/node_modules/@akshar5/cohall/bin/cohall.js",
      home: "/home/user",
    })

    expect(plan.file.path).toBe("/home/user/.config/systemd/user/cohall-device.service")
    expect(plan.file.content).toContain(
      'ExecStart="/home/user/.local/lib/node_modules/@akshar5/cohall/bin/cohall.js" device',
    )
    expect(plan.commands).toEqual([
      { command: "systemctl", arguments: ["--user", "daemon-reload"] },
      {
        command: "systemctl",
        arguments: ["--user", "enable", "--now", "cohall-device.service"],
      },
    ])
  })

  it("escapes a macOS executable path and targets the user launch domain", () => {
    const plan = deviceServicePlan({
      platform: "darwin",
      entrypoint: "/Users/A & B/bin/cohall",
      home: "/Users/A & B",
      uid: 501,
    })

    expect(plan.file.content).toContain("/Users/A &amp; B/bin/cohall")
    expect(plan.commands.at(-1)).toEqual({
      command: "launchctl",
      arguments: ["kickstart", "-k", "gui/501/com.cohall.device"],
    })
  })

  it("rejects unsupported automatic service targets", () => {
    expect(() =>
      deviceServicePlan({
        platform: "win32",
        entrypoint: "C:\\cohall.cmd",
        home: "C:\\Users\\user",
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
