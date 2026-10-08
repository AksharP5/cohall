import {
  AttachmentName,
  Bot,
  BotId,
  Device,
  DeviceId,
  makeDeviceId,
  now,
  version,
  maxAttachmentBytes,
  maxDevicePageResponseBytes,
  maxSocketPayloadBytes,
  AnswerTaskInput,
  RequestTaskInput,
  TaskProgressInput,
} from "@cohall/protocol"
import { Effect, ManagedRuntime, Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { Database } from "./database.ts"
import { canDispatchTaskToDevice, resolveDelegation } from "./main.ts"
import { RelayStore } from "./store.ts"

it("summarizes current work without transferring full rosters or including forgotten devices", async () => {
  const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const device = Device.make({
      id: makeDeviceId(),
      name: "worker",
      description: "iOS builds",
      hostname: "localhost",
      platform: "darwin",
      architecture: "arm64",
      status: "online",
      providers: ["codex", "grok-bot", "opencode"],
      bots: Array.from({ length: 64 }, (_, index) =>
        Bot.make({
          id: BotId.make(`bot-${index}`),
          name: `Bot ${index}`,
          description: "x".repeat(512),
        }),
      ),
      capabilities: [{ id: "task-clarification", label: "Clarification" }],
      workspaces: [],
      version,
      lastSeenAt: now(),
    })
    await Effect.runPromise(store.upsertDevice(device))
    const completed = await Effect.runPromise(
      store.createDelegation({ prompt: "Done" }, device.id, "owner"),
    )
    await Effect.runPromise(store.assignTask(completed.id))
    await Effect.runPromise(store.acceptTask(completed.id, device.id))
    await Effect.runPromise(store.finishTask(completed.id, device.id, "Done"))
    const paused = await Effect.runPromise(
      store.createDelegation({ prompt: "Ask" }, device.id, "owner"),
    )
    const assigned = await Effect.runPromise(store.assignTask(paused.id))
    await Effect.runPromise(store.acceptTask(paused.id, device.id))
    if (assigned.runId === undefined) throw new Error("Expected an assigned turn")
    await Effect.runPromise(
      store.pauseTaskForInput(
        paused.id,
        device.id,
        Schema.decodeUnknownSync(RequestTaskInput)({
          runId: assigned.runId,
          question: "Which branch?",
        }),
      ),
    )
    const active = await Effect.runPromise(
      store.createDelegation(
        { prompt: "Build", provider: "grok-bot", botId: BotId.make("bot-0") },
        device.id,
        "owner",
      ),
    )
    await Effect.runPromise(store.assignTask(active.id))
    const cancelling = await Effect.runPromise(
      store.createDelegation({ prompt: "Stop", provider: "opencode" }, device.id, "owner"),
    )
    await Effect.runPromise(store.assignTask(cancelling.id))
    await Effect.runPromise(store.acceptTask(cancelling.id, device.id))
    await Effect.runPromise(store.requestCancellation(cancelling.id))
    const queued = await Effect.runPromise(
      store.createDelegation({ prompt: "Later" }, device.id, "owner"),
    )
    await Effect.runPromise(store.createDelegation({ prompt: "Later still" }, device.id, "owner"))
    await Effect.runPromise(store.markDeviceOffline(device.id))
    const forgotten = Device.make({
      ...device,
      id: makeDeviceId(),
      name: "gone",
      status: "offline",
    })
    await Effect.runPromise(store.upsertDevice(forgotten))
    await Effect.runPromise(store.forgetDevice(forgotten.id))
    const overview = await Effect.runPromise(store.deviceOverview())
    expect(overview).toEqual([
      {
        id: device.id,
        name: device.name,
        description: device.description,
        status: "offline",
        version,
        lastSeenAt: expect.any(String),
        queued: 2,
        active: 1,
        needsInput: 1,
        cancelling: 1,
        oldestQueuedAt: queued.createdAt,
      },
    ])
    expect(Buffer.byteLength(JSON.stringify(overview))).toBeLessThan(1024)
    expect(Buffer.byteLength(JSON.stringify(device))).toBeGreaterThan(32 * 1024)
  } finally {
    await runtime.dispose()
  }
})

it("migrates old device records and retains editable descriptions across relay restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-device-description-"))
  const path = join(directory, "relay.db")
  const legacy = new Database(path)
  legacy.exec(`CREATE TABLE devices (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, hostname TEXT NOT NULL,
    platform TEXT NOT NULL, architecture TEXT NOT NULL, status TEXT NOT NULL,
    providers_json TEXT NOT NULL, capabilities_json TEXT NOT NULL,
    workspaces_json TEXT NOT NULL, version TEXT NOT NULL, last_seen_at TEXT NOT NULL,
    connected_at TEXT
  )`)
  legacy.close()
  const runtime = ManagedRuntime.make(RelayStore.layer(path))
  let restored: typeof runtime | undefined
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const device = Device.make({
      id: makeDeviceId(),
      name: "mac",
      hostname: "localhost",
      platform: "darwin",
      architecture: "arm64",
      status: "online",
      providers: ["codex"],
      capabilities: [],
      workspaces: [],
      version,
      lastSeenAt: now(),
    })
    await Effect.runPromise(store.upsertDevice(device))
    expect((await Effect.runPromise(store.listDevices()))[0]).not.toHaveProperty("description")
    await Effect.runPromise(store.upsertDevice({ ...device, description: "iOS builds" }))
    expect((await Effect.runPromise(store.listDevicePage())).devices[0]).toMatchObject({
      description: "iOS builds",
    })
    await runtime.dispose()
    restored = ManagedRuntime.make(RelayStore.layer(path))
    const recovered = await restored.runPromise(RelayStore.Service)
    expect((await Effect.runPromise(recovered.listDevices()))[0]).toMatchObject({
      description: "iOS builds",
    })
    await Effect.runPromise(recovered.upsertDevice(device))
    expect((await Effect.runPromise(recovered.listDevices()))[0]).not.toHaveProperty("description")
  } finally {
    await runtime.dispose()
    await restored?.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

const orderedDeviceId = (index: number) =>
  DeviceId.make(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`)

it("pages Bot rosters by UUID without skipping a renamed device", async () => {
  const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const description =
      "A research assistant for planning, documentation, review, and implementation. "
        .repeat(7)
        .slice(0, 512)
    const bots = Array.from({ length: 256 }, (_, index) =>
      Bot.make({ id: BotId.make(`agent-${index}`), name: `Agent ${index}`, description }),
    )
    const devices = Array.from({ length: 15 }, (_, index) =>
      Device.make({
        id: orderedDeviceId(index + 1),
        name: `workstation-${index + 1}`,
        hostname: "localhost",
        platform: "linux",
        architecture: "x64",
        status: "online",
        providers: ["grok-bot"],
        bots: [],
        capabilities: [],
        workspaces: [{ path: "/home/user/projects", label: "projects" }],
        version,
        lastSeenAt: now(),
      }),
    )
    for (const device of devices) {
      await Effect.runPromise(store.upsertDevice(device))
      await Effect.runPromise(store.heartbeat(device.id, "online", bots))
    }

    const first = await Effect.runPromise(store.listDevicePage())
    expect(first.devices).toHaveLength(14)
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(2 * 1024 * 1024)
    expect(first.nextCursor).toBe(first.devices.at(-1)?.id)

    const last = devices[14]
    if (last === undefined || first.nextCursor === undefined) throw new Error("Missing page cursor")
    await Effect.runPromise(store.upsertDevice(Device.make({ ...last, name: "Aardvark", bots })))
    const second = await Effect.runPromise(store.listDevicePage(first.nextCursor))
    expect(second.devices.map((device) => device.id)).toEqual([last.id])
    expect(second.nextCursor).toBeUndefined()
    expect((await Effect.runPromise(store.listDevices()))[0]?.name).toBe("Aardvark")
  } finally {
    await runtime.dispose()
  }
})

it("continues after one device merges near-limit hello and heartbeat frames", async () => {
  const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const first = Device.make({
      id: orderedDeviceId(1),
      name: "large",
      hostname: "localhost",
      platform: "linux",
      architecture: "x64",
      status: "online",
      providers: ["codex"],
      bots: [],
      capabilities: Array.from({ length: 64 }, (_, index) => ({
        id: `cap-${index}`,
        label: "x",
        detail: "\0".repeat(512),
      })),
      workspaces: Array.from({ length: 64 }, () => ({
        path: "\0".repeat(1951),
        label: "\0".repeat(256),
      })),
      version,
      lastSeenAt: now(),
    })
    const bots = Array.from({ length: 256 }, (_, index) =>
      Bot.make({
        id: BotId.make(`bot-${index}${"\0".repeat(36)}`),
        name: `x${"\0".repeat(127)}`,
        description: "\0".repeat(512),
      }),
    )
    expect(Buffer.byteLength(JSON.stringify({ _tag: "DeviceHello", device: first }))).toBeLessThan(
      maxSocketPayloadBytes,
    )
    expect(
      Buffer.byteLength(
        JSON.stringify({ _tag: "DeviceHeartbeat", deviceId: first.id, status: "online", bots }),
      ),
    ).toBeLessThan(maxSocketPayloadBytes)
    expect(Buffer.byteLength(JSON.stringify(Device.make({ ...first, bots })))).toBeGreaterThan(
      2 * 1024 * 1024 - 1024,
    )
    await Effect.runPromise(store.upsertDevice(first))
    await Effect.runPromise(store.heartbeat(first.id, "online", bots))
    const second = Device.make({
      ...first,
      id: orderedDeviceId(2),
      name: "small",
      bots: [],
      capabilities: [],
      workspaces: [],
    })
    await Effect.runPromise(store.upsertDevice(second))

    const page = await Effect.runPromise(store.listDevicePage())
    expect(page.devices.map((device) => device.id)).toEqual([first.id])
    expect(page.nextCursor).toBe(first.id)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(maxDevicePageResponseBytes)
    const finalPage = await Effect.runPromise(store.listDevicePage(page.nextCursor))
    expect(finalPage.devices.map((device) => device.id)).toEqual([second.id])
    expect(finalPage.nextCursor).toBeUndefined()
  } finally {
    await runtime.dispose()
  }
})

it.each([16, 32])("ends a device list on an exact %i-device page boundary", async (count) => {
  const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    for (let index = 1; index <= count; index++)
      await Effect.runPromise(
        store.upsertDevice(
          Device.make({
            id: orderedDeviceId(index),
            name: `device-${index}`,
            hostname: "localhost",
            platform: "linux",
            architecture: "x64",
            status: "online",
            providers: ["codex"],
            capabilities: [],
            workspaces: [],
            version,
            lastSeenAt: now(),
          }),
        ),
      )

    const first = await Effect.runPromise(store.listDevicePage())
    expect(first.devices).toHaveLength(16)
    if (count === 16) {
      expect(first.nextCursor).toBeUndefined()
      return
    }
    expect(first.nextCursor).toBe(first.devices.at(-1)?.id)
    const second = await Effect.runPromise(store.listDevicePage(first.nextCursor))
    expect(second.devices).toHaveLength(16)
    expect(second.nextCursor).toBeUndefined()
  } finally {
    await runtime.dispose()
  }
})

it.each([
  ["assigned", "disconnect"],
  ["running", "disconnect"],
  ["legacy running", "disconnect"],
  ["legacy assigned", "disconnect"],
  ["legacy assigned", "restart"],
  ["legacy assigned", "upgrade"],
  ["legacy assigned", "reconnect"],
  ["legacy running", "reconnect"],
] as const)(
  "waits for cancellation acknowledgement for %s coding work after %s",
  async (status, interruption) => {
    const database = new Database(":memory:")
    let runtime = ManagedRuntime.make(RelayStore.layerFromDatabase(database))
    try {
      let store = await runtime.runPromise(RelayStore.Service)
      const device = Device.make({
        id: makeDeviceId(),
        name: "interrupted-target",
        hostname: "localhost",
        platform: "linux",
        architecture: "x64",
        status: "online",
        providers: ["codex"],
        capabilities: [],
        workspaces: [],
        version,
        lastSeenAt: now(),
      })
      await Effect.runPromise(store.upsertDevice(device))
      const task = await Effect.runPromise(
        store.createDelegation({ prompt: "Working" }, device.id, "owner"),
      )
      const assigned = await Effect.runPromise(store.assignTask(task.id))
      if (status === "running" || status === "legacy running")
        await Effect.runPromise(store.acceptTask(task.id, device.id, assigned.runId))
      if (status === "legacy assigned" || status === "legacy running")
        database.query("UPDATE tasks SET run_id = NULL WHERE id = ?").run(task.id)
      if (interruption === "upgrade") {
        const unsent = await Effect.runPromise(
          store.createDelegation({ prompt: "Never assigned" }, device.id, "owner"),
        )
        database.query("UPDATE tasks SET status = 'queued' WHERE id = ?").run(task.id)
        await runtime.dispose()
        runtime = ManagedRuntime.make(RelayStore.layerFromDatabase(database))
        store = await runtime.runPromise(RelayStore.Service)
        expect((await Effect.runPromise(store.requestCancellation(unsent.id))).status).toBe(
          "cancelled",
        )
        await Effect.runPromise(store.acknowledgeCompletion(unsent.id, "owner"))
      } else {
        await Effect.runPromise(
          interruption === "restart" ? store.recover() : store.requeueTasksFor(device.id),
        )
      }
      const interrupted = await Effect.runPromise(store.getTask(task.id))
      if (interruption === "reconnect") {
        const reassigned = await Effect.runPromise(store.assignTask(task.id))
        expect(reassigned.runId).toBe(interrupted.runId)
      }
      const cancelling = await Effect.runPromise(store.requestCancellation(task.id))
      expect(cancelling.status).toBe("cancelling")
      expect(cancelling.runId).toBe(interrupted.runId)
      expect(cancelling.completedAt).toBeUndefined()
      expect(
        (await Effect.runPromise(store.pendingTasksFor(device.id))).map((item) => item.id),
      ).toContain(task.id)
      expect((await Effect.runPromise(store.inboxFor("owner"))).items).toEqual([])
      expect(
        await Effect.runPromise(
          store.acknowledgeCancellation(task.id, device.id, interrupted.runId),
        ),
      ).toMatchObject({ status: "cancelled" })
      expect(
        (await Effect.runPromise(store.inboxFor("owner"))).items.map((item) => item.id),
      ).toEqual([task.id])
    } finally {
      await runtime.dispose()
      database.close()
    }
  },
)

it.each(["disconnect", "restart"] as const)(
  "replays running work before an older answered clarification after %s",
  async (interruption) => {
    const database = new Database(":memory:")
    const runtime = ManagedRuntime.make(RelayStore.layerFromDatabase(database))
    try {
      const store = await runtime.runPromise(RelayStore.Service)
      const device = Device.make({
        id: makeDeviceId(),
        name: "replay-target",
        hostname: "localhost",
        platform: "linux",
        architecture: "x64",
        status: "online",
        providers: ["codex"],
        capabilities: [{ id: "task-clarification", label: "Clarification" }],
        workspaces: [],
        version,
        lastSeenAt: now(),
      })
      await Effect.runPromise(store.upsertDevice(device))
      const older = await Effect.runPromise(
        store.createDelegation({ prompt: "Ask before continuing" }, device.id, "owner"),
      )
      const firstTurn = await Effect.runPromise(store.assignTask(older.id))
      if (firstTurn.runId === undefined) throw new Error("Missing questioning turn")
      await Effect.runPromise(store.acceptTask(older.id, device.id, firstTurn.runId))
      database
        .query("UPDATE tasks SET created_at = ?, started_at = ? WHERE id = ?")
        .run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z", older.id)
      const question = await Effect.runPromise(
        store.requestTaskInput(
          older.id,
          device.id,
          Schema.decodeUnknownSync(RequestTaskInput)({
            runId: firstTurn.runId,
            question: "Which branch?",
          }),
        ),
      )
      await Effect.runPromise(
        store.finishTask(older.id, device.id, "Asked", undefined, undefined, firstTurn.runId),
      )
      const newer = await Effect.runPromise(
        store.createDelegation({ prompt: "Keep working" }, device.id, "owner"),
      )
      const active = await Effect.runPromise(store.assignTask(newer.id))
      if (active.runId === undefined) throw new Error("Missing active turn")
      await Effect.runPromise(store.acceptTask(newer.id, device.id, active.runId))
      const answered = await Effect.runPromise(
        store.answerTaskInput(
          older.id,
          "owner",
          Schema.decodeUnknownSync(AnswerTaskInput)({ requestId: question.id, answer: "main" }),
        ),
      )
      expect(answered.startedAt).toBe("2026-01-01T00:00:01.000Z")
      expect((await Effect.runPromise(store.assignTask(older.id))).status).toBe("queued")
      await Effect.runPromise(
        interruption === "restart" ? store.recover() : store.requeueTasksFor(device.id),
      )
      const pending = await Effect.runPromise(store.pendingTasksFor(device.id))
      expect(pending.map((task) => task.id)).toEqual([newer.id, older.id])
      for (const task of pending) await Effect.runPromise(store.assignTask(task.id))
      expect(
        await Effect.runPromise(store.acceptTask(newer.id, device.id, active.runId)),
      ).toMatchObject({
        status: "running",
        runId: active.runId,
      })
      expect(await Effect.runPromise(store.getTask(older.id))).toMatchObject({
        status: "queued",
        runId: answered.runId,
      })
      await Effect.runPromise(
        store.reportTaskProgress(
          newer.id,
          device.id,
          Schema.decodeUnknownSync(TaskProgressInput)({ note: "Still working" }).note,
        ),
      )
      expect(
        await Effect.runPromise(
          store.requestTaskInput(
            newer.id,
            device.id,
            Schema.decodeUnknownSync(RequestTaskInput)({
              runId: active.runId,
              question: "Which tests?",
            }),
          ),
        ),
      ).toMatchObject({ question: "Which tests?" })
    } finally {
      await runtime.dispose()
      database.close()
    }
  },
)

it("persists the latest progress, restricts its target, and clears it on recovery and completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-progress-"))
  const path = join(directory, "relay.db")
  const original = ManagedRuntime.make(RelayStore.layer(path))
  let restored: typeof original | undefined
  try {
    const store = await original.runPromise(RelayStore.Service)
    const device = Device.make({
      id: makeDeviceId(),
      name: "progress-target",
      hostname: "localhost",
      platform: "linux",
      architecture: "x64",
      status: "online",
      providers: ["codex"],
      capabilities: [],
      workspaces: [],
      version,
      lastSeenAt: now(),
    })
    await Effect.runPromise(store.upsertDevice(device))
    const task = await Effect.runPromise(
      store.createDelegation({ prompt: "Build" }, device.id, "owner"),
    )
    const first = Schema.decodeUnknownSync(TaskProgressInput)({ note: "Running tests" })
    const second = Schema.decodeUnknownSync(TaskProgressInput)({ note: "Building package" })
    await expect(
      Effect.runPromise(store.reportTaskProgress(task.id, device.id, first.note)),
    ).rejects.toMatchObject({ status: 409 })
    await Effect.runPromise(store.assignTask(task.id))
    await Effect.runPromise(store.acceptTask(task.id, device.id))
    await expect(
      Effect.runPromise(store.reportTaskProgress(task.id, makeDeviceId(), first.note)),
    ).rejects.toMatchObject({ status: 403 })
    await Effect.runPromise(store.reportTaskProgress(task.id, device.id, first.note))
    const latest = await Effect.runPromise(
      store.reportTaskProgress(task.id, device.id, second.note),
    )
    expect((await Effect.runPromise(store.getTask(task.id))).progress).toEqual(latest)
    expect((await Effect.runPromise(store.traceTask(task.id))).progress).toEqual(latest)
    await original.dispose()

    restored = ManagedRuntime.make(RelayStore.layer(path))
    const recovered = await restored.runPromise(RelayStore.Service)
    expect((await Effect.runPromise(recovered.getTask(task.id))).progress).toEqual(latest)
    await Effect.runPromise(recovered.recover())
    expect((await Effect.runPromise(recovered.getTask(task.id))).progress).toBeUndefined()
    await Effect.runPromise(recovered.assignTask(task.id))
    await Effect.runPromise(recovered.acceptTask(task.id, device.id))
    await Effect.runPromise(recovered.reportTaskProgress(task.id, device.id, first.note))
    await Effect.runPromise(recovered.requeueTasksFor(device.id))
    expect((await Effect.runPromise(recovered.getTask(task.id))).progress).toBeUndefined()
    await Effect.runPromise(recovered.assignTask(task.id))
    await Effect.runPromise(recovered.acceptTask(task.id, device.id))
    await Effect.runPromise(recovered.reportTaskProgress(task.id, device.id, first.note))
    await Effect.runPromise(recovered.finishTask(task.id, device.id, "Done"))
    expect((await Effect.runPromise(recovered.getTask(task.id))).progress).toBeUndefined()
    await expect(
      Effect.runPromise(recovered.reportTaskProgress(task.id, device.id, second.note)),
    ).rejects.toMatchObject({ status: 409 })
  } finally {
    await original.dispose()
    await restored?.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it("derives queue depth and oldest wait from tasks through dispatch and reconnect", async () => {
  const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
  vi.useFakeTimers({ toFake: ["Date"] })
  try {
    vi.setSystemTime(new Date("2026-09-30T00:00:00Z"))
    const store = await runtime.runPromise(RelayStore.Service)
    const device = Device.make({
      id: makeDeviceId(),
      name: "queue-target",
      hostname: "localhost",
      platform: "linux",
      architecture: "x64",
      status: "online",
      providers: ["codex"],
      capabilities: [],
      workspaces: [],
      version,
      lastSeenAt: now(),
    })
    const peer = Device.make({ ...device, id: makeDeviceId(), name: "queue-peer" })
    await Effect.runPromise(store.upsertDevice(device))
    await Effect.runPromise(store.upsertDevice(peer))
    const first = await Effect.runPromise(
      store.createDelegation({ prompt: "First" }, device.id, "owner"),
    )
    vi.setSystemTime(new Date("2026-09-30T00:01:00Z"))
    const second = await Effect.runPromise(
      store.createDelegation({ prompt: "Second" }, device.id, "owner"),
    )
    const other = await Effect.runPromise(
      store.createDelegation({ prompt: "Other" }, peer.id, "owner"),
    )
    const queue = async (id = device.id) =>
      (await Effect.runPromise(store.listDevices())).find((item) => item.id === id)?.queue

    expect(await queue()).toEqual({ queued: 2, oldestQueuedAt: first.createdAt })
    expect(await queue(peer.id)).toEqual({ queued: 1, oldestQueuedAt: other.createdAt })
    await Effect.runPromise(store.assignTask(first.id))
    expect(await queue()).toEqual({ queued: 1, oldestQueuedAt: second.createdAt })
    await Effect.runPromise(store.acceptTask(first.id, device.id))
    await Effect.runPromise(store.requestCancellation(first.id))
    await Effect.runPromise(store.requestCancellation(second.id))
    expect(await queue()).toEqual({ queued: 0 })

    await Effect.runPromise(store.assignTask(other.id))
    await Effect.runPromise(store.acceptTask(other.id, peer.id))
    expect(await queue(peer.id)).toEqual({ queued: 0 })
    await Effect.runPromise(store.requeueTasksFor(peer.id))
    await Effect.runPromise(store.markDeviceOffline(peer.id))
    expect(await queue(peer.id)).toEqual({ queued: 1, oldestQueuedAt: other.createdAt })
  } finally {
    vi.useRealTimers()
    await runtime.dispose()
  }
})

it("assigns queued followups with the session completed before a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-store-session-"))
  const databasePath = join(directory, "relay.db")
  const original = ManagedRuntime.make(RelayStore.layer(databasePath))
  let restored:
    | ManagedRuntime.ManagedRuntime<RelayStore.Service, RelayStore.PersistenceError>
    | undefined
  try {
    const store = await original.runPromise(RelayStore.Service)
    const device = Device.make({
      id: makeDeviceId(),
      name: "session-device",
      hostname: "localhost",
      platform: "linux",
      architecture: "x64",
      status: "online",
      providers: ["codex"],
      capabilities: [],
      workspaces: [],
      version,
      lastSeenAt: now(),
    })
    await Effect.runPromise(store.upsertDevice(device))
    const first = await Effect.runPromise(
      store.createDelegation({ prompt: "Start" }, device.id, "owner"),
    )
    await Effect.runPromise(store.assignTask(first.id))
    await Effect.runPromise(store.acceptTask(first.id, device.id))
    const followup = await Effect.runPromise(
      store.createDelegation({ prompt: "Continue", threadId: first.threadId }, device.id, "owner"),
    )
    expect((await Effect.runPromise(store.assignTask(followup.id))).status).toBe("queued")
    await Effect.runPromise(store.finishTask(first.id, device.id, "Answer", "completed-session"))
    await original.dispose()

    restored = ManagedRuntime.make(RelayStore.layer(databasePath))
    const recovered = await restored.runPromise(RelayStore.Service)
    await Effect.runPromise(recovered.recover())
    expect(await Effect.runPromise(recovered.assignTask(followup.id))).toMatchObject({
      status: "assigned",
      providerSessionId: "completed-session",
    })
  } finally {
    await original.dispose()
    await restored?.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it("attributes full-worker clients after registration and prefers a peer for delegation", async () => {
  const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const pairing = await Effect.runPromise(
      store.createPairing({ label: "Worker", roles: ["client", "device"] }),
    )
    const paired = await Effect.runPromise(store.exchangePairing(pairing.token))
    const client = paired.credentials.find(({ session }) => session.role === "client")
    const worker = paired.credentials.find(({ session }) => session.role === "device")
    if (client === undefined || worker?.session.deviceId === undefined) {
      throw new Error("Expected full-worker credentials")
    }
    expect(client.session.deviceId).toBe(worker.session.deviceId)
    const principal = await Effect.runPromise(store.authenticateSession(client.token, "client"))
    if (principal === undefined) throw new Error("Expected authenticated client")
    expect(principal.deviceId).toBe(worker.session.deviceId)
    const peer = Device.make({
      id: makeDeviceId(),
      name: "b-peer",
      hostname: "peer.local",
      platform: "linux",
      architecture: "x64",
      status: "online",
      providers: ["codex"],
      capabilities: [],
      workspaces: [],
      version,
      lastSeenAt: now(),
    })
    await Effect.runPromise(store.upsertDevice(peer))
    const early = await Effect.runPromise(
      store.createDelegation({ prompt: "Before registration" }, peer.id, principal),
    )
    expect(early.sourceDeviceId).toBeUndefined()
    await Effect.runPromise(
      store.upsertDevice({ ...peer, id: worker.session.deviceId, name: "a-source" }),
    )
    const { targetDeviceId: target } = await runtime.runPromise(
      resolveDelegation({ prompt: "Work on a peer" }, principal.deviceId),
    )
    expect(target).toBe(peer.id)
    const task = await Effect.runPromise(
      store.createDelegation({ prompt: "After registration" }, target, principal),
    )
    expect(task.sourceDeviceId).toBe(worker.session.deviceId)
    expect((await Effect.runPromise(store.threadContext(task.threadId))).messages[0]).toMatchObject(
      {
        authorName: "Remote agent",
        deviceId: worker.session.deviceId,
      },
    )

    const clientOnlyPairing = await Effect.runPromise(
      store.createPairing({ label: "Client", roles: ["client"] }),
    )
    const clientOnly = await Effect.runPromise(store.exchangePairing(clientOnlyPairing.token))
    expect(clientOnly.credentials[0]?.session.deviceId).toBeUndefined()
  } finally {
    await runtime.dispose()
  }
})

it("keeps completion inboxes private to each client and retains acknowledgements", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-inbox-"))
  const databasePath = join(directory, "relay.db")
  const original = ManagedRuntime.make(RelayStore.layer(databasePath))
  let restored: typeof original | undefined
  try {
    const store = await original.runPromise(RelayStore.Service)
    const device = Device.make({
      id: makeDeviceId(),
      name: "inbox-target",
      hostname: "localhost",
      platform: "linux",
      architecture: "x64",
      status: "online",
      providers: ["codex"],
      capabilities: [],
      workspaces: [],
      version,
      lastSeenAt: now(),
    })
    await Effect.runPromise(store.upsertDevice(device))
    const pair = async (label: string) => {
      const invite = await Effect.runPromise(store.createPairing({ label, roles: ["client"] }))
      const joined = await Effect.runPromise(store.exchangePairing(invite.token))
      const session = joined.credentials[0]?.session
      if (session === undefined) throw new Error("Expected client session")
      return session
    }
    const firstClient = await pair("First")
    const secondClient = await pair("Second")
    const completed = await Effect.runPromise(
      store.createDelegation({ prompt: "Find the cause" }, device.id, firstClient),
    )
    const pending = await Effect.runPromise(
      store.createDelegation({ prompt: "Still running" }, device.id, firstClient),
    )
    const failed = await Effect.runPromise(
      store.createDelegation({ prompt: "Other client's work" }, device.id, secondClient),
    )
    const ownerTask = await Effect.runPromise(
      store.createDelegation({ prompt: "Owner's work" }, device.id, "owner"),
    )
    await Effect.runPromise(store.finishTask(completed.id, device.id, "😀".repeat(600)))
    await Effect.runPromise(store.failTask(failed.id, device.id, "Provider failed"))
    await Effect.runPromise(store.requestCancellation(ownerTask.id))

    expect(await Effect.runPromise(store.inboxFor(firstClient))).toEqual({
      items: [
        expect.objectContaining({
          id: completed.id,
          status: "completed",
          promptPreview: "Find the cause",
          resultPreview: "😀".repeat(512),
        }),
      ],
      hasMore: false,
    })
    expect((await Effect.runPromise(store.inboxFor(secondClient))).items[0]?.id).toBe(failed.id)
    expect((await Effect.runPromise(store.inboxFor("owner"))).items[0]?.id).toBe(ownerTask.id)
    expect(pending.status).toBe("queued")
    await expect(
      Effect.runPromise(store.acknowledgeCompletion(completed.id, secondClient)),
    ).rejects.toMatchObject({ message: `Unknown inbox task ${completed.id}` })
    await Effect.runPromise(store.acknowledgeCompletion(completed.id, firstClient))
    await Effect.runPromise(store.acknowledgeCompletion(completed.id, firstClient))
    await original.dispose()

    restored = ManagedRuntime.make(RelayStore.layer(databasePath))
    const recovered = await restored.runPromise(RelayStore.Service)
    expect(await Effect.runPromise(recovered.inboxFor(firstClient))).toEqual({
      items: [],
      hasMore: false,
    })
    expect((await Effect.runPromise(recovered.inboxFor(secondClient))).items[0]?.id).toBe(failed.id)
  } finally {
    await original.dispose()
    await restored?.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it("reveals additional completions as older inbox entries are acknowledged", async () => {
  const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const device = Device.make({
      id: makeDeviceId(),
      name: "inbox-target",
      hostname: "localhost",
      platform: "linux",
      architecture: "x64",
      status: "online",
      providers: ["codex"],
      capabilities: [],
      workspaces: [],
      version,
      lastSeenAt: now(),
    })
    await Effect.runPromise(store.upsertDevice(device))
    for (let index = 0; index < 21; index += 1) {
      const task = await Effect.runPromise(
        store.createDelegation({ prompt: `Task ${index}` }, device.id, "owner"),
      )
      await Effect.runPromise(store.finishTask(task.id, device.id, "Done"))
    }
    const firstPage = await Effect.runPromise(store.inboxFor("owner"))
    expect(firstPage.items).toHaveLength(20)
    expect(firstPage.hasMore).toBe(true)
    const first = firstPage.items[0]
    if (first === undefined) throw new Error("Expected an inbox task")
    await Effect.runPromise(store.acknowledgeCompletion(first.id, "owner"))
    const nextPage = await Effect.runPromise(store.inboxFor("owner"))
    expect(nextPage.items).toHaveLength(20)
    expect(nextPage.hasMore).toBe(false)
    expect(nextPage.items).not.toContainEqual(expect.objectContaining({ id: first.id }))
  } finally {
    await runtime.dispose()
  }
})

it("bounds outstanding work, serial assignment, and thread context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-store-"))
  const runtime = ManagedRuntime.make(RelayStore.layer(join(directory, "relay.db")))
  const run = <A, E>(effect: Effect.Effect<A, E, RelayStore.Service>): Promise<A> =>
    runtime.runPromise(effect)
  try {
    const deviceId = DeviceId.make("11111111-1111-4111-8111-111111111111")
    await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        yield* store.upsertDevice(
          Device.make({
            id: deviceId,
            name: "bounded-device",
            hostname: "localhost",
            platform: "linux",
            architecture: "x64",
            status: "online",
            providers: ["codex"],
            capabilities: [],
            workspaces: [],
            version,
            lastSeenAt: now(),
          }),
        )
      }),
    )

    const first = await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        return yield* store.createDelegation(
          { prompt: "x".repeat(131_072), context: "y".repeat(131_072) },
          deviceId,
          "owner",
        )
      }),
    )
    const tasks = [first]
    for (let index = 1; index < 100; index += 1) {
      tasks.push(
        await run(
          Effect.gen(function* () {
            const store = yield* RelayStore.Service
            return yield* store.createDelegation(
              { threadId: first.threadId, prompt: `queued-${index}` },
              deviceId,
              "owner",
            )
          }),
        ),
      )
    }
    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.createDelegation({ prompt: "overflow" }, deviceId, "owner")
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("outstanding task limit") })

    const assigned = await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        return yield* store.assignTask(first.id)
      }),
    )
    const second = tasks[1]
    if (second === undefined) {
      throw new Error("Expected a second task")
    }
    const stillQueued = await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        return yield* store.assignTask(second.id)
      }),
    )
    expect(assigned.status).toBe("assigned")
    expect(stillQueued.status).toBe("queued")

    const trace = await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        yield* store.rollbackAssignment(first.id)
        yield* store.assignTask(first.id)
        yield* store.acceptTask(first.id, deviceId)
        yield* store.finishTask(first.id, deviceId, "done")
        return yield* store.traceTask(first.id)
      }),
    )
    expect(trace.events.map((event) => event.kind)).toEqual([
      "queued",
      "assigned",
      "requeued",
      "assigned",
      "running",
      "completed",
    ])
    expect(trace.targetDevice.id).toBe(deviceId)
    expect(trace.truncated).toBe(false)

    const context = await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        return yield* store.threadContext(first.threadId)
      }),
    )
    expect(context.truncated).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(context)).byteLength).toBeLessThan(1_100_000)
  } finally {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it("forgets only offline devices and revokes their registration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-store-forget-"))
  const databasePath = join(directory, "relay.db")
  const legacy = new Database(databasePath)
  legacy.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, hostname TEXT NOT NULL,
      platform TEXT NOT NULL, architecture TEXT NOT NULL, status TEXT NOT NULL,
      providers_json TEXT NOT NULL, capabilities_json TEXT NOT NULL,
      workspaces_json TEXT NOT NULL, version TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      connected_at TEXT
    )
  `)
  legacy.close()
  const runtime = ManagedRuntime.make(RelayStore.layer(databasePath))
  const run = <A, E>(effect: Effect.Effect<A, E, RelayStore.Service>): Promise<A> =>
    runtime.runPromise(effect)
  try {
    const paired = await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        const pairing = yield* store.createPairing({
          label: "stale device",
          roles: ["client", "device"],
        })
        return yield* store.exchangePairing(pairing.token)
      }),
    )
    const credential = paired.credentials.find(({ session }) => session.role === "device")
    const deviceId = credential?.session.deviceId
    if (credential === undefined || deviceId === undefined) {
      throw new Error("Expected a device credential")
    }
    const device = Device.make({
      id: deviceId,
      name: "stale-device",
      hostname: "localhost",
      platform: "linux",
      architecture: "x64",
      status: "offline",
      providers: ["codex"],
      capabilities: [],
      workspaces: [],
      version,
      lastSeenAt: now(),
    })

    const abandoned = await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        yield* store.upsertDevice(device)
        const operations = yield* store.createUpgradeOperations({ target: "latest", restart: true })
        yield* store.forgetDevice(deviceId)
        return operations[0]
      }),
    )
    if (abandoned === undefined) {
      throw new Error("Expected an abandoned operation")
    }
    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.listOperations()
        }),
      ),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: abandoned.id,
        status: "failed",
        error: "Target device was forgotten by the relay owner",
      }),
    )
    expect(
      await run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.listDevices()
        }),
      ),
    ).toEqual([])
    for (const pairedCredential of paired.credentials) {
      expect(
        await run(
          Effect.gen(function* () {
            const store = yield* RelayStore.Service
            return yield* store.authenticateSession(
              pairedCredential.token,
              pairedCredential.session.role,
            )
          }),
        ),
      ).toBeUndefined()
    }

    await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        yield* store.upsertDevice(Device.make({ ...device, status: "online" }))
      }),
    )
    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.forgetDevice(deviceId)
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("must be offline") })
  } finally {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it("prunes the oldest terminal task history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-store-history-"))
  const runtime = ManagedRuntime.make(RelayStore.layer(join(directory, "relay.db"), 2))
  const run = <A, E>(effect: Effect.Effect<A, E, RelayStore.Service>): Promise<A> =>
    runtime.runPromise(effect)
  try {
    const deviceId = DeviceId.make("33333333-3333-4333-8333-333333333333")
    await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        yield* store.upsertDevice(
          Device.make({
            id: deviceId,
            name: "history-device",
            hostname: "localhost",
            platform: "linux",
            architecture: "x64",
            status: "online",
            providers: ["codex"],
            capabilities: [],
            workspaces: [],
            version,
            lastSeenAt: now(),
          }),
        )
      }),
    )
    const tasks = []
    for (let index = 0; index < 3; index += 1) {
      tasks.push(
        await run(
          Effect.gen(function* () {
            const store = yield* RelayStore.Service
            const task = yield* store.createDelegation(
              { prompt: `task-${index}` },
              deviceId,
              "owner",
            )
            yield* store.assignTask(task.id)
            yield* store.acceptTask(task.id, deviceId)
            return yield* store.finishTask(task.id, deviceId, `result-${index}`)
          }),
        ),
      )
    }
    const oldest = tasks[0]
    const newest = tasks[2]
    if (oldest === undefined || newest === undefined) {
      throw new Error("Expected three completed tasks")
    }
    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.getTask(oldest.id)
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("Unknown task") })
    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.getTask(newest.id)
        }),
      ),
    ).resolves.toMatchObject({ result: "result-2" })
  } finally {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it("stores task files with completion, rejects invalid results atomically, and prunes files with tasks", async () => {
  const runtime = ManagedRuntime.make(RelayStore.layer(":memory:", 1))
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const device = Device.make({
      id: makeDeviceId(),
      name: "worker",
      hostname: "localhost",
      platform: "linux",
      architecture: "x64",
      status: "online",
      providers: ["codex"],
      capabilities: [],
      workspaces: [],
      version,
      lastSeenAt: now(),
    })
    await Effect.runPromise(store.upsertDevice(device))
    const task = await Effect.runPromise(
      store.createDelegation(
        {
          prompt: "Inspect screenshot",
          attachments: [{ name: "screen.png", data: Buffer.from("image").toString("base64") }],
        },
        device.id,
        "owner",
      ),
    )
    expect(task.inputAttachmentNames).toEqual(["screen.png"])
    expect(
      await Effect.runPromise(store.readAttachment(task.id, AttachmentName.make("screen.png"))),
    ).toEqual(new Uint8Array(Buffer.from("image")))
    expect(await Effect.runPromise(store.listAttachments(task.id))).toEqual([
      { name: "screen.png", direction: "input", bytes: 5 },
    ])
    await Effect.runPromise(store.assignTask(task.id))
    await Effect.runPromise(store.acceptTask(task.id, device.id))
    const output = [{ name: "report.txt" as const, data: Buffer.from("answer").toString("base64") }]
    await expect(
      Effect.runPromise(store.finishTask(task.id, makeDeviceId(), "Done", undefined, output)),
    ).rejects.toBeDefined()
    await expect(
      Effect.runPromise(
        store.finishTask(task.id, device.id, "Done", undefined, [
          { name: "oversized", data: Buffer.alloc(maxAttachmentBytes + 1).toString("base64") },
        ]),
      ),
    ).rejects.toBeDefined()
    expect((await Effect.runPromise(store.getTask(task.id))).status).toBe("running")
    await Effect.runPromise(store.finishTask(task.id, device.id, "Done", undefined, output))
    expect(await Effect.runPromise(store.listAttachments(task.id))).toEqual([
      { name: "screen.png", direction: "input", bytes: 5 },
      { name: "report.txt", direction: "output", bytes: 6 },
    ])
    await Effect.runPromise(
      store.finishTask(task.id, device.id, "Duplicate", undefined, [
        { name: "late.txt", data: Buffer.from("late").toString("base64") },
      ]),
    )
    expect(await Effect.runPromise(store.listAttachments(task.id))).toHaveLength(2)

    const next = await Effect.runPromise(
      store.createDelegation({ prompt: "Next" }, device.id, "owner"),
    )
    await Effect.runPromise(store.assignTask(next.id))
    await Effect.runPromise(store.acceptTask(next.id, device.id))
    await Effect.runPromise(store.finishTask(next.id, device.id, "Done"))
    await expect(Effect.runPromise(store.listAttachments(task.id))).rejects.toBeDefined()
    expect(await Effect.runPromise(store.listAttachments(next.id))).toEqual([])
  } finally {
    await runtime.dispose()
  }
})

it("fails queued attached work clearly after a worker reconnects without file support", async () => {
  const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const device = Device.make({
      id: makeDeviceId(),
      name: "worker",
      hostname: "localhost",
      platform: "linux",
      architecture: "x64",
      status: "online",
      providers: ["codex"],
      capabilities: [{ id: "task-attachments", label: "Task files" }],
      workspaces: [],
      version,
      lastSeenAt: now(),
    })
    await Effect.runPromise(store.upsertDevice(device))
    const task = await Effect.runPromise(
      store.createDelegation(
        {
          prompt: "Review",
          attachments: [{ name: "report.txt", data: Buffer.from("draft").toString("base64") }],
        },
        device.id,
        "owner",
      ),
    )
    const downgraded = Device.make({ ...device, capabilities: [] })
    await Effect.runPromise(store.upsertDevice(downgraded))
    expect(canDispatchTaskToDevice(task, (await Effect.runPromise(store.listDevices()))[0])).toBe(
      false,
    )
    const failed = await Effect.runPromise(
      store.failTask(
        task.id,
        device.id,
        "Target worker no longer supports task file attachments. Upgrade the worker and retry.",
      ),
    )
    expect(failed).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Upgrade the worker"),
    })
    expect(await Effect.runPromise(store.listAttachments(task.id))).toEqual([
      { name: "report.txt", direction: "input", bytes: 5 },
    ])
  } finally {
    await runtime.dispose()
  }
})

it("keeps input files across relay recovery before completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-attachments-restart-"))
  const databasePath = join(directory, "relay.db")
  const runtime = ManagedRuntime.make(RelayStore.layer(databasePath))
  let restored:
    | ManagedRuntime.ManagedRuntime<RelayStore.Service, RelayStore.PersistenceError>
    | undefined
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const device = Device.make({
      id: makeDeviceId(),
      name: "worker",
      hostname: "localhost",
      platform: "linux",
      architecture: "x64",
      status: "online",
      providers: ["codex"],
      capabilities: [],
      workspaces: [],
      version,
      lastSeenAt: now(),
    })
    await Effect.runPromise(store.upsertDevice(device))
    const task = await Effect.runPromise(
      store.createDelegation(
        {
          prompt: "Inspect",
          attachments: [{ name: "report.txt", data: Buffer.from("input").toString("base64") }],
        },
        device.id,
        "owner",
      ),
    )
    await Effect.runPromise(store.assignTask(task.id))
    await Effect.runPromise(store.acceptTask(task.id, device.id))
    await runtime.dispose()

    restored = ManagedRuntime.make(RelayStore.layer(databasePath))
    const recovered = await restored.runPromise(RelayStore.Service)
    await Effect.runPromise(recovered.recover())
    expect((await Effect.runPromise(recovered.getTask(task.id))).status).toBe("queued")
    expect(await Effect.runPromise(recovered.listAttachments(task.id))).toEqual([
      { name: "report.txt", direction: "input", bytes: 5 },
    ])
    await Effect.runPromise(recovered.assignTask(task.id))
    await Effect.runPromise(recovered.acceptTask(task.id, device.id))
    await Effect.runPromise(
      recovered.finishTask(task.id, device.id, "Done", undefined, [
        { name: "report.txt", data: Buffer.from("report").toString("base64") },
      ]),
    )
    expect(await Effect.runPromise(recovered.listAttachments(task.id))).toEqual([
      { name: "report.txt", direction: "input", bytes: 5 },
      { name: "report.txt", direction: "output", bytes: 6 },
    ])
    expect(
      await Effect.runPromise(recovered.readAttachment(task.id, AttachmentName.make("report.txt"))),
    ).toEqual(new Uint8Array(Buffer.from("report")))
    expect(
      await Effect.runPromise(
        recovered.readAttachment(task.id, AttachmentName.make("report.txt"), "input"),
      ),
    ).toEqual(new Uint8Array(Buffer.from("input")))
    await restored.dispose()
    restored = ManagedRuntime.make(RelayStore.layer(databasePath))
    const settled = await restored.runPromise(RelayStore.Service)
    await Effect.runPromise(settled.recover())
    expect((await Effect.runPromise(settled.getTask(task.id))).status).toBe("completed")
    expect(
      await Effect.runPromise(settled.readAttachment(task.id, AttachmentName.make("report.txt"))),
    ).toEqual(new Uint8Array(Buffer.from("report")))
  } finally {
    await runtime.dispose()
    await restored?.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it("includes more than 256 forgotten devices in retained usage", async () => {
  const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const devices = Array.from({ length: 257 }, (_, index) =>
      Device.make({
        id: orderedDeviceId(index + 1),
        name: `former-worker-${String(index).padStart(3, "0")}`,
        hostname: "localhost",
        platform: "linux",
        architecture: "x64",
        status: "offline",
        providers: ["codex"],
        capabilities: [],
        workspaces: [],
        version,
        lastSeenAt: now(),
      }),
    )
    for (const device of devices) {
      await Effect.runPromise(store.upsertDevice(device))
      const task = await Effect.runPromise(
        store.createDelegation({ prompt: "Historical work" }, device.id, "owner"),
      )
      await Effect.runPromise(store.requestCancellation(task.id))
      await Effect.runPromise(store.forgetDevice(device.id))
    }
    expect(await Effect.runPromise(store.listDevices())).toEqual([])
    expect(await Effect.runPromise(store.usage())).toMatchObject({
      retainedTasks: devices.length,
      byStatus: { cancelled: devices.length },
      byProvider: [{ provider: "codex", tasks: devices.length }],
      devices: devices.map((device) => ({
        deviceId: device.id,
        deviceName: device.name,
        tasks: 1,
        byStatus: { cancelled: 1 },
        byProvider: [{ provider: "codex", tasks: 1 }],
      })),
    })
  } finally {
    await runtime.dispose()
  }
})

it("summarizes retained work and runs typed upgrades across registered devices", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-store-operations-"))
  const runtime = ManagedRuntime.make(RelayStore.layer(join(directory, "relay.db")))
  const run = <A, E>(effect: Effect.Effect<A, E, RelayStore.Service>): Promise<A> =>
    runtime.runPromise(effect)
  try {
    const serverId = DeviceId.make("44444444-4444-4444-8444-444444444444")
    const laptopId = DeviceId.make("55555555-5555-4555-8555-555555555555")
    await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        for (const [id, name] of [
          [serverId, "server"],
          [laptopId, "laptop"],
        ] as const) {
          yield* store.upsertDevice(
            Device.make({
              id,
              name,
              hostname: `${name}.local`,
              platform: "linux",
              architecture: "x64",
              status: "online",
              providers: ["codex"],
              capabilities: [],
              workspaces: [],
              version,
              lastSeenAt: now(),
            }),
          )
        }
      }),
    )

    const laptopTask = await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        const completed = yield* store.createDelegation(
          { prompt: "completed", provider: "codex" },
          serverId,
          "owner",
        )
        yield* store.assignTask(completed.id)
        yield* store.acceptTask(completed.id, serverId)
        yield* store.finishTask(completed.id, serverId, "done")
        return yield* store.createDelegation(
          { prompt: "queued", provider: "claude-code" },
          laptopId,
          "owner",
        )
      }),
    )

    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.usage()
        }),
      ),
    ).resolves.toMatchObject({
      retainedTasks: 2,
      byStatus: { completed: 1, queued: 1 },
      byProvider: [
        { provider: "codex", tasks: 1 },
        { provider: "claude-code", tasks: 1 },
      ],
    })

    await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        yield* store.assignTask(laptopTask.id)
      }),
    )

    const operations = await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        return yield* store.createUpgradeOperations({ target: "1.2.3", restart: true })
      }),
    )
    expect(operations).toHaveLength(2)
    const serverOperation = operations.find((operation) => operation.targetDeviceId === serverId)
    const laptopOperation = operations.find((operation) => operation.targetDeviceId === laptopId)
    if (serverOperation === undefined || laptopOperation === undefined) {
      throw new Error("Expected one upgrade operation per device")
    }

    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.assignOperation(laptopOperation.id)
        }),
      ),
    ).resolves.toMatchObject({ status: "queued" })

    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          yield* store.assignOperation(serverOperation.id)
          yield* store.acceptOperation(serverOperation.id, serverId)
          yield* store.requeueOperationsFor(serverId)
          const completed = yield* store.finishOperation(
            serverOperation.id,
            serverId,
            '{"upgraded":true}',
          )
          const replayed = yield* store.assignOperation(serverOperation.id)
          return { completed, replayed }
        }),
      ),
    ).resolves.toMatchObject({
      completed: { status: "completed", result: '{"upgraded":true}' },
      replayed: { status: "completed", result: '{"upgraded":true}' },
    })

    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.createUpgradeOperations({ target: "latest", restart: true })
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("already has") })

    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.abandonOperation(laptopOperation.id)
        }),
      ),
    ).resolves.toMatchObject({ status: "failed", error: "Abandoned by the relay owner" })

    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.createUpgradeOperations({ target: "latest", restart: true })
        }),
      ),
    ).resolves.toHaveLength(2)
  } finally {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it("rejects all-device operations before every daemon supports them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-store-legacy-operation-"))
  const runtime = ManagedRuntime.make(RelayStore.layer(join(directory, "relay.db")))
  const run = <A, E>(effect: Effect.Effect<A, E, RelayStore.Service>): Promise<A> =>
    runtime.runPromise(effect)
  try {
    await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        yield* store.upsertDevice(
          Device.make({
            id: DeviceId.make("66666666-6666-4666-8666-666666666666"),
            name: "legacy",
            hostname: "legacy.local",
            platform: "linux",
            architecture: "x64",
            status: "online",
            providers: ["codex"],
            capabilities: [],
            workspaces: [],
            version: "0.4.10",
            lastSeenAt: now(),
          }),
        )
      }),
    )

    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.createUpgradeOperations({ target: "latest", restart: true })
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("Upgrade individually first") })
    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.listOperations()
        }),
      ),
    ).resolves.toEqual([])
  } finally {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
