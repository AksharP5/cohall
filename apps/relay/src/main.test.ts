import { describe, expect, it } from "vitest"
import { makeDeviceId, makeAuthSessionId, now, AuthSession, AttachmentName } from "@cohall/protocol"
import { canDispatchTaskToDevice, canReadTaskAttachments, relayListenOptions } from "./main.ts"

const configuration = { host: "127.0.0.1", port: 8787 }

describe("relay listener", () => {
  it("uses the configured host and port without socket activation", () => {
    expect(relayListenOptions(configuration, {}, 100)).toEqual(configuration)
    expect(relayListenOptions(configuration, { LISTEN_PID: "99", LISTEN_FDS: "1" }, 100)).toEqual(
      configuration,
    )
  })

  it("accepts the systemd socket while the relay service restarts", () => {
    expect(
      relayListenOptions(
        configuration,
        { LISTEN_PID: "100", LISTEN_FDS: "1", LISTEN_FDNAMES: "cohall-relay" },
        100,
      ),
    ).toEqual({ fd: 3 })
    expect(
      relayListenOptions(
        configuration,
        {
          LISTEN_PID: "100",
          LISTEN_FDS: "2",
          LISTEN_FDNAMES: "metrics:cohall-relay",
        },
        100,
      ),
    ).toEqual({ fd: 4 })
  })

  it("rejects an ambiguous set of inherited sockets", () => {
    expect(() =>
      relayListenOptions(
        configuration,
        { LISTEN_PID: "100", LISTEN_FDS: "2", LISTEN_FDNAMES: "one:two" },
        100,
      ),
    ).toThrow("none was named cohall-relay")
  })
})

it("limits device file reads to its target tasks", () => {
  const targetDeviceId = makeDeviceId()
  const task = { targetDeviceId }
  const session = (role: "client" | "device", deviceId = targetDeviceId) =>
    AuthSession.make({
      id: makeAuthSessionId(),
      label: role,
      role,
      deviceId,
      createdAt: now(),
      lastSeenAt: now(),
      expiresAt: now(),
    })
  expect(canReadTaskAttachments("owner", task)).toBe(true)
  expect(canReadTaskAttachments(session("client", makeDeviceId()), task)).toBe(true)
  expect(canReadTaskAttachments(session("device"), task)).toBe(true)
  expect(canReadTaskAttachments(session("device", makeDeviceId()), task)).toBe(false)
})

it("holds attached work when a reconnected worker no longer advertises file support", () => {
  const task = { inputAttachmentNames: [AttachmentName.make("report.txt")] }
  const capable = { capabilities: [{ id: "task-attachments", label: "Task files" }] }
  const downgraded = { capabilities: [] }
  expect(canDispatchTaskToDevice(task, capable)).toBe(true)
  expect(canDispatchTaskToDevice(task, downgraded)).toBe(false)
  expect(canDispatchTaskToDevice(task, undefined)).toBe(false)
  expect(canDispatchTaskToDevice({ inputAttachmentNames: [] }, downgraded)).toBe(true)
})
