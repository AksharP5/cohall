import { Device, DeviceId, Timestamp } from "@cohall/protocol"
import { describe, expect, it } from "vitest"
import { allDeviceHealth, deviceVersions } from "./device-overview.ts"

const device = Device.make({
  id: DeviceId.make("11111111-1111-4111-8111-111111111111"),
  name: "server",
  hostname: "server.local",
  platform: "linux",
  architecture: "x64",
  status: "online",
  providers: ["codex"],
  capabilities: [],
  workspaces: [{ path: "/srv/project", label: "project" }],
  version: "1.2.3",
  lastSeenAt: Timestamp.make("2026-08-09T12:00:00.000Z"),
})

describe("all-device summaries", () => {
  it("shows version drift without hiding device state", () => {
    expect(
      deviceVersions([device, Device.make({ ...device, name: "mac", version: "1.2.2" })], "1.2.3"),
    ).toMatchObject({ current: 1, different: 1 })
  })

  it("reports offline, provider, and version problems per device", () => {
    const result = allDeviceHealth(
      [Device.make({ ...device, status: "offline", providers: [], version: "1.2.2" })],
      "1.2.3",
    )

    expect(result).toMatchObject({ healthy: false, total: 1, offline: 1 })
    expect(result.devices[0]?.warnings).toEqual([
      "Device is offline",
      "No provider executable is available",
      "Running Cohall 1.2.2; local CLI is 1.2.3",
    ])
  })

  it("does not call an empty installation healthy", () => {
    expect(allDeviceHealth([], "1.2.3")).toMatchObject({
      healthy: false,
      warnings: ["No Cohall devices are registered"],
    })
  })
})
