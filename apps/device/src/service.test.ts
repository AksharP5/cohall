import { describe, expect, it } from "vitest"
import { deviceServicePlan } from "./service.ts"

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
})
